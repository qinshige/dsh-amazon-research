import { readConfig, resolveOutputRoot } from './paths.js';
import { listRuns, readRun } from './runs.js';
import { selectCategory } from './category.js';
import { selectCategoryWeb } from './category-web.js';
import { selectCategoryTrendyol } from './category-trendyol.js';
import { getPlatform, providerSupportsPlatform, providersForPlatform, resolveSite } from './platforms/index.js';
import { judgeProfit, landedCost, pickTierPrice } from './sourcing/cost-model.js';
import { getFx } from './fx.js';
import { getFreight } from './sourcing/freight.js';
import { resolveCostProfile } from './sourcing/cost-profile.js';
import { buildSelectionPlan } from './selection/channels.js';
import { buildMacroPlan, runMacroAnalysis } from './market/macro.js';
import { parseCsv, screenCandidates } from './selection/pipeline.js';
import { productsToSelectionRows } from './selection/from-products.js';
import { attachToRun, beginSession, endSession, push as livePush } from './live.js';
import { join } from 'node:path';
import { saOnlyTools } from './market/sa-tools.js';

export function createTools(deps) {
  return saOnlyTools(createLegacyTools(deps), deps);
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
};

const LIVE_SESSION_DIR = '.live';

// Keep both cost tools' public contract and screen/collect forwarding identical.
const COST_PARAMETERS = {
  fx: { type: 'number', exclusiveMinimum: 0, description: '成本汇率的兼容别名（1 USD = ? CNY）；costFx 优先' },
  costFx: { type: 'number', exclusiveMinimum: 0, description: '手动成本汇率；不传则取实时值，失败回落 6.7' },
  settleFx: { type: 'number', exclusiveMinimum: 0, description: '手动结算汇率；不传则取实时值，失败回落 6.6' },
  liveFx: { type: 'boolean', default: true, description: '是否取实时汇率；来源与抓取时间随结果返回' },
  costProfile: {
    type: 'object',
    description: '用户成本口径：广告 10%、退货 5%、佣金 6%、其它 0；并非平台统一费率，Amazon 请按实际类目覆盖佣金',
    properties: {
      adRate: { type: 'number', minimum: 0, maximum: 1, default: 0.10 },
      returnRate: { type: 'number', minimum: 0, maximum: 1, default: 0.05 },
      referralRate: { type: 'number', minimum: 0, maximum: 1, default: 0.06 },
      otherUSD: { type: 'number', minimum: 0, default: 0 },
      freightMode: { type: 'string', enum: ['sea', 'air', 'express'] },
    },
    additionalProperties: false,
  },
  freightMode: { type: 'string', enum: ['sea', 'air', 'express'], description: '运输方式，优先于 costProfile.freightMode；默认 sea' },
  freightPerKgCNY: { type: 'number', exclusiveMinimum: 0, description: '用户确认的运价 CNY/kg，优先于实时接口；未取到不补零或估算' },
  freightApiUrl: { type: 'string', description: '货代运价接口 URL；不传则取插件 freight.apiUrl 配置，缺运价不计算净利' },
};

function costOptions(args, config) {
  const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  return {
    fx: positive(args?.fx),
    costFx: positive(args?.costFx) ?? positive(args?.fx),
    settleFx: positive(args?.settleFx),
    liveFx: args?.liveFx !== false,
    costProfile: args?.costProfile && typeof args.costProfile === 'object' && !Array.isArray(args.costProfile) ? args.costProfile : {},
    freightMode: asString(args?.freightMode) || undefined,
    freightPerKgCNY: positive(args?.freightPerKgCNY),
    freightApiUrl: asString(args?.freightApiUrl) || asString(config?.freight?.apiUrl) || undefined,
  };
}

/**
 * 跑一段会驱动浏览器的流程，并把过程写进实时会话（面板可实时看）。
 * 录屏默认关闭：record=true 才截 Chrome 窗口（只截窗口区域，不截整屏）。
 */
async function withLiveSession({ outputRoot, record = false, fps = 1, source = '' }, fn) {
  const sessionId = 'live-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const dir = join(outputRoot, LIVE_SESSION_DIR, sessionId);
  await beginSession({ runId: sessionId, dir, record, fps, source });
  let result;
  let error = null;
  try {
    result = await fn(sessionId);
  } catch (err) {
    error = err;
  } finally {
    const ended = await endSession({ status: error ? 'failed' : 'done' });
    if (result && result.dir && ended && ended.dir) {
      await attachToRun(result.dir, ended.dir);
    }
    if (ended && ended.video) {
      livePush({ phase: 'record', level: 'info', message: '录屏文件：' + ended.video });
    }
  }
  if (error) throw error;
  return result;
}

const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }];

function err(code, message, hint, extra = {}) {
  return { ok: false, error: { code, message, ...(hint ? { hint } : {}) }, ...extra };
}

/**
 * 清洗返回值：去掉 undefined、把非有限数字转成 null。
 *
 * 为什么需要：harness 的工具返回值校验要求「无损 JSON」往返，
 * 而 JSON.stringify 会**静默丢掉** undefined（对象属性直接消失），导致校验失败。
 * 实测：market.products[].seller 为 undefined → 工具报 "value is not lossless JSON"，
 * 而运行其实已经成功（产物已落盘），只是返回值没过桥。
 */
function jsonSafe(value, depth = 0) {
  if (depth > 12) return null;
  if (value === null) return null;
  const type = typeof value;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'undefined' || type === 'function' || type === 'symbol') return null;
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item, depth + 1));
  if (type === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      const cleaned = jsonSafe(value[key], depth + 1);
      if (cleaned !== null || value[key] === null) out[key] = cleaned;
    }
    return out;
  }
  return null;
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}


/**
 * 动态载入 1688 采价模块（host/sourcing/1688.js）。
 * 模块缺失或导出不全时返回结构化错误（code = SOURCING_UNAVAILABLE），不静默降级。
 */
async function loadSourcing() {
  let module;
  try {
    module = await import('./sourcing/1688.js');
  } catch (error) {
    return {
      error: err('SOURCING_UNAVAILABLE',
        '未找到 1688 采价模块 host/sourcing/1688.js：' + String(error?.message ?? error),
        '该模块缺失时无法采价；可先用 research_category_select 传 unitCost 做粗筛，或补齐 host/sourcing/1688.js 后重试。'),
    };
  }
  if (typeof module?.searchOffers !== 'function' || typeof module?.fetchOfferDetail !== 'function') {
    return {
      error: err('SOURCING_UNAVAILABLE', 'host/sourcing/1688.js 缺少 searchOffers / fetchOfferDetail 导出',
        '请检查 1688 采价模块是否按 CONTRACTS-2.md 第 1 节实现。'),
    };
  }
  return { module };
}
/**
 * 注册模型可见的工具。
 * @param {{ctx:any, dataDir:string, secrets:any, providers:any, version:string}} deps
 */
function createLegacyTools({ ctx, dataDir, secrets, providers, version }) {
  return [
    {
      name: 'research_provider_status',
      description: [
        '查询 Amazon / Trendyol 数据源的密钥配置或浏览器状态，并返回插件默认配置（站点/样本上限/输出目录）。',
        '调用时机：用户第一次做选品、报告失败提示鉴权、或想知道 key 是否配好时先调用。',
        '本工具不产生数据服务额度消耗（未配置 key 时不会发网络请求）。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: ['sellersprite', 'sellersprite-web', 'sorftime', 'trendyol-web', 'all'], description: '要检查的数据源，默认 all' },
        },
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderJson },
      isConcurrencySafe: () => true,
      async execute(args) {
        const config = await readConfig(dataDir);
        const requested = asString(args?.provider) || 'all';
        const ids = requested === 'all' ? Object.keys(providers.list().reduce((acc, p) => ({ ...acc, [p.id]: true }), {})) : [requested];
        const known = providers.list().map((p) => p.id);
        const targets = ids.filter((id) => known.includes(id));
        if (!targets.length) return err('INVALID_ARGS', '未知数据源: ' + requested, '可选值：sellersprite / sellersprite-web / sorftime / trendyol-web / all');
        const statuses = await Promise.all(targets.map((id) => providers.status(id).catch((error) => ({ id, ok: false, configured: false, lastError: String(error?.message ?? error) }))));
        // 浏览器驱动状态：只在真正会用到浏览器时查，避免拖慢纯 API 场景。
        let browser = null;
        if (requested === 'all' || requested === 'sellersprite-web' || requested === 'trendyol-web') {
          try {
            const { browserBackendInfo } = await import('./web/chrome.js');
            browser = await browserBackendInfo();
          } catch (error) {
            browser = { error: String(error?.message ?? error) };
          }
        }
        return {
          ok: true,
          version,
          providers: statuses,
          ...(browser ? { browser } : {}),
          config: {
            marketplace: config.marketplace,
            defaultLimit: config.defaultLimit,
            outputRoot: resolveOutputRoot(config),
            provider: config.provider,
            browser: config.browser,
          },
        };
      },
    },
    {
      name: 'research_category_select',
      description: [
        '品类选品（支持 Amazon / Trendyol）：取市场大盘与分布/商品数据 → 五维评分（92 分制归一化）→ 落盘 Markdown/CSV/HTML 报告。',
        '调用时机：用户说「分析 XX 品类 / 做品类选品 / 看看这个类目能不能进 / 蓝海选品」。',
        'platform=amazon（默认）｜provider=sellersprite：走卖家精灵 MCP，约 9~11 次调用（消耗额度），调用前先向用户说明次数。',
        'platform=amazon ｜provider=sellersprite-web：走用户 Chrome 里已登录的卖家精灵网页版，不消耗 MCP 额度但会占用网页端查询次数。',
        'platform=trendyol：走 Trendyol 网页抓取（provider=trendyol-web），无需密钥；支持 TR（土耳其，www.trendyol.com，TRY）与 SA（沙特阿拉伯，www.trendyol.sa/en，SAR），抓取前核验国家/币种；其余官网国家仅展示、尚未接通抓取；每次 pages（默认2，最多5）次搜索页 + detailTopN（默认5，最多5）次商品页，另可能打开国家选择页。',
        'Trendyol 不公布销量/销额：市场规模用「样本累计计数」代理（土耳其评论数，沙特评价数含仅评分、非文字评论）、增长潜力用「低计数商品数占比」，报告会显式标注口径差异。',
        '结果只返回摘要与产物路径；细节用 research_runs get 读取，不要把整表塞回上下文。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          platform: {
            type: 'string',
            enum: ['amazon', 'trendyol'],
            description: '平台，默认 amazon。trendyol 只支持 provider=trendyol-web（网页抓取），不需要密钥',

          },
          category: { type: 'string', description: '类目关键词（英文更准），如 "Cell Phones"、"Sofas"；Trendyol TR 用土耳其语如 "tencere"；SA 用英文如 "cup holder"' },
          nodeIdPath: { type: 'string', description: '类目节点路径，如 "11091801:11974521:8882489011"；知道节点时优先传，能避免类目搜错' },
          marketplace: { type: 'string', description: '国家代码；默认取当前平台配置。Trendyol 官网国家均可识别，当前抓取只接通 TR / SA，其他返回 UNSUPPORTED_SITE', enum: [...new Set(['amazon','trendyol'].flatMap(id => (getPlatform(id)?.sites || []).map(s => s.value)))] },
          limit: { type: 'integer', minimum: 10, maximum: 100, description: '样本商品数上限，默认 50；Trendyol 不是页数' },
          pages: { type: 'integer', minimum: 1, maximum: 5, description: 'Trendyol 搜索页数，默认2；Amazon 不使用' },
          detailTopN: { type: 'integer', minimum: 0, maximum: 5, description: 'Trendyol 商品详情请求上限，默认5，可设0' },
          month: { type: 'string', description: '数据月份 yyyyMM，默认最近自然月' },
          unitCost: { type: 'number', description: '单位采购+头程成本（USD/件），用于利润维度；不传则按价格带估算并标注「仅供初筛」' },
          costs: {
            type: 'array',
            description: '1688 采购成本（每个子市场一条）：{name, keyword, priceCNY, weightG, moq, offerUrl, verified, avgPriceUSD}。给了就把利润空间维度换成净利率口径，并在报告第八章输出逐子市场全成本测算（仅 sellersprite-web 链路支持）',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '子市场名称（与卖家精灵细分市场名对上，用于销量加权）' },
                keyword: { type: 'string', description: '1688 搜索关键词' },
                priceCNY: { type: 'number', description: '1688 采购价（CNY/件，阶梯价已选定）' },
                weightG: { type: 'number', description: '件重（克），用于头程与 FBA 档位' },
                moq: { type: 'number', description: '起批量' },
                offerUrl: { type: 'string', description: '1688 offer 链接' },
                verified: { type: 'boolean', description: '是否已进详情页验证' },
                avgPriceUSD: { type: 'number', description: '该子市场在 Amazon 的均价（USD）' },
                smallVolume: { type: 'boolean', description: '该细分是否小体量（100–200 单），true 时按「净利率 > 30%」判红线' },
                volumeUnits: { type: 'number', description: '该细分的单链接月销（≤ 200 视为小体量）' },
              },
              additionalProperties: true,
            },
          },
          outDir: { type: 'string', description: '报告输出根目录；建议传当前会话工作区下的 选品研究 目录（如 /path/to/workspace/选品研究）；不传则用插件配置的 outputRoot 或数据目录' },
          record: { type: 'boolean', description: '是否实时显示浏览器页面（只截 Chrome 窗口区域，不截整屏、不产出视频文件）。默认 false；实时事件流始终开启' },
          recordFps: { type: 'number', description: '实时画面刷新帧率，默认 2 fps（只保留最新一张，不落帧序列）' },
          provider: {
            type: 'string',
            enum: ['sellersprite', 'sellersprite-web', 'trendyol-web'],
            description:
              '数据源：sellersprite = 官方 MCP（消耗额度）；sellersprite-web = 用户 Chrome 里已登录的卖家精灵网页版（MCP 未开通时用）',

          },
        },
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderJson },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const config = await readConfig(dataDir);
        // 平台优先：不传默认 amazon（保持既有调用完全不变）
        const platformId = ((asString(args?.platform) || config.platform || 'amazon').toLowerCase()).toLowerCase();
        const platform = getPlatform(platformId);
        if (!platform) {
          return err('UNKNOWN_PLATFORM', '未知平台: ' + platformId, '可选值：' + ['amazon', 'trendyol'].join(' / '));
        }
        const provider = asString(args?.provider) || (providerSupportsPlatform(config.provider, platformId) ? config.provider : (platformId === 'trendyol' ? 'trendyol-web' : 'sellersprite'));
        if (!providerSupportsPlatform(provider, platformId)) {
          return err(
            'PROVIDER_PLATFORM_MISMATCH',
            '数据源 ' + provider + ' 不支持平台 ' + platform.label,
            '该平台可用数据源：' + providersForPlatform(platformId).join(' / '),
          );
        }
        const marketplace = (asString(args?.marketplace) || (platformId === (config.platform || 'amazon') ? config.marketplace : platform.defaultSite) || platform.defaultSite).toUpperCase();
        if (!resolveSite(platformId, marketplace)) return err('INVALID_SITE', platform.label + ' 不支持站点 ' + marketplace);
        const outputRoot = resolveOutputRoot(config, asString(args?.outDir));

        // Trendyol 走独立链路（网页抓取，无 MCP、无密钥）
        if (platformId === 'trendyol') {
          if (args?.nodeIdPath || args?.month || args?.unitCost != null || args?.costs != null) return err('INVALID_ARGS', 'Trendyol P1 不支持 Amazon 节点、月份或美元成本参数；请只传 category 搜索词');
          try {
            const result = await selectCategoryTrendyol({
              keyword: asString(args?.category),
              pages: args?.pages ?? 2,
              detailTopN: args?.detailTopN ?? 5,
              limit: args?.limit ?? config.defaultLimit ?? 50,
              outputRoot,
              dataDir,
              marketplace,
            });
            return jsonSafe({ ...result, outputRoot });
          } catch (error) {
            const code = typeof error?.code === 'string' ? error.code : 'SELECT_FAILED';
            const message = String(error?.message ?? error);
            const hint = code === 'CAPTCHA'
              ? 'Trendyol 触发了人机验证。请先在 Chrome 手动打开目标国家的 Trendyol 官网通过验证，再重试（插件不会绕过验证码）。'
              : code === 'COUNTRY_NO_ENTRY' || code === 'SESSION_NOT_READY'
                ? '土耳其请在 Chrome 打开 www.trendyol.com 并选择 Türkiye；沙特阿拉伯请打开 www.trendyol.sa/en 并选择 Saudi Arabia。不会自动抓取其他国家。'
                : code === 'EMPTY_RESULT'
                  ? '换一个土耳其语关键词重试（如 tencere / mutfak gereçleri / aydınlatma）。'
                  : undefined;
            return err(code, message, hint);
          }
        }
        const costRows = Array.isArray(args?.costs)
          ? args.costs
            .filter((item) => item && typeof item === 'object')
            .map((item) => ({
              name: asString(item.name),
              keyword: asString(item.keyword),
              priceCNY: typeof item.priceCNY === 'number' && Number.isFinite(item.priceCNY) ? item.priceCNY : null,
              weightG: typeof item.weightG === 'number' && Number.isFinite(item.weightG) ? item.weightG : null,
              moq: typeof item.moq === 'number' && Number.isFinite(item.moq) ? item.moq : null,
              offerUrl: asString(item.offerUrl),
              verified: item.verified === true,
              avgPriceUSD: typeof item.avgPriceUSD === 'number' && Number.isFinite(item.avgPriceUSD) ? item.avgPriceUSD : null,
              smallVolume: item.smallVolume === true,
              volumeUnits: typeof item.volumeUnits === 'number' && Number.isFinite(item.volumeUnits) ? item.volumeUnits : null,
            }))
          : [];
        if (provider === 'sellersprite-web') {
          try {
            const result = await withLiveSession({
              outputRoot,
              record: args?.record === true,
              fps: typeof args?.recordFps === 'number' ? args.recordFps : 2,
              source: '卖家精灵网页 · ' + (asString(args?.category) || asString(args?.nodeIdPath) || '类目'),
            }, () => selectCategoryWeb({
              marketplace,
              category: asString(args?.category) || undefined,
              nodeIdPath: asString(args?.nodeIdPath) || undefined,
              limit: asInt(args?.limit, config.defaultLimit || 50, 10, 100),
              unitCost: typeof args?.unitCost === 'number' && Number.isFinite(args.unitCost) ? args.unitCost : null,
              costs: costRows,
              outputRoot,
              dataDir,
            }));
            return jsonSafe({ ...result, outputRoot });
          } catch (error) {
            const code = typeof error?.code === 'string' ? error.code : 'SELECT_FAILED';
            const message = String(error?.message ?? error);
            const hint =
              code === 'NOT_LOGGED_IN'
                ? '请在 Chrome 里登录 www.sellersprite.com 后重试（插件会读取你已登录的页面）。'
                : code === 'NODE_NOT_FOUND'
                  ? '换英文类目词重试，或从卖家精灵类目页复制 nodeIdPath 直接传入。'
                  : undefined;
            return err(code, message, hint);
          }
        }
        try {
          const result = await selectCategory({
            providers,
            dataDir,
            outputRoot,
            provider,
            marketplace,
            category: asString(args?.category) || undefined,
            nodeIdPath: asString(args?.nodeIdPath) || undefined,
            limit: asInt(args?.limit, config.defaultLimit || 50, 10, 100),
            month: asString(args?.month) || undefined,
            unitCost: typeof args?.unitCost === 'number' && Number.isFinite(args.unitCost) ? args.unitCost : null,
            signal: exec?.signal,
          });
          if (costRows.length > 0) {
            const extra = ['本次传入的 1688 采购成本（costs）仅 sellersprite-web 链路支持，MCP 链路未接入；利润空间维度仍按 unitCost / 价格带口径评分'];
            result.warnings = [...(Array.isArray(result.warnings) ? result.warnings : []), ...extra];
          }
          return jsonSafe({ ...result, outputRoot });
        } catch (error) {
          const code = typeof error?.code === 'string' ? error.code : 'SELECT_FAILED';
          const message = String(error?.message ?? error);
          const hint =
            code === 'NO_CREDENTIAL'
              ? '打开左侧栏「选品研究」→ 设置页填写 Sellersprite Secret Key，或设置环境变量 SELLERSPRITE_SECRET_KEY。'
              : code === 'NODE_NOT_FOUND'
                ? '换英文类目词重试，或从卖家精灵类目页复制 nodeIdPath 后直接传。'
                : code === 'EMPTY_MARKET'
                  ? '换叶子类目/换月份重试；根节点统计为 0 属正常。'
                  : undefined;
          return err(code, message, hint, error?.usage ? { usage: error.usage } : {});
        }
      },
    },
    {
      name: 'research_runs',
      description: [
        '查看本插件历史运行与产物：action=list 列出最近的选品运行，action=get 读取某次运行的 manifest、评分、Markdown 报告与产物文件清单。',
        '调用时机：用户问「上次的选品报告在哪 / 把报告发我 / 重新解读一遍结果」，或工具返回 runId 后需要细节。',
        '本工具只读本地文件，不产生任何数据服务费用。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'get'], description: 'list 列出运行；get 读取指定运行' },
          runId: { type: 'string', description: 'action=get 时必填，来自 research_category_select 的返回或 list 结果' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'list 返回条数，默认 30' },
          outDir: { type: 'string', description: '报告根目录，默认取插件配置' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderJson },
      isConcurrencySafe: () => true,
      async execute(args) {
        const config = await readConfig(dataDir);
        const outputRoot = resolveOutputRoot(config, asString(args?.outDir));
        const action = asString(args?.action) || 'list';
        try {
          if (action === 'list') {
            const runs = await listRuns(outputRoot, { limit: asInt(args?.limit, 30, 1, 100) });
            return { ok: true, outputRoot, count: runs.length, runs };
          }
          const runId = asString(args?.runId);
          if (!runId) return err('INVALID_ARGS', 'action=get 需要 runId', '先 action=list 取 runId');
          const run = await readRun(outputRoot, runId);
          const reportMd = run.reportMd.length > 30000 ? run.reportMd.slice(0, 30000) + '\n\n…（已截断，完整报告见 run.dir/report.md）' : run.reportMd;
          return {
            ok: true,
            runId: run.runId,
            dir: run.dir,
            manifest: run.manifest,
            scores: run.scores,
            reportMd,
            artifacts: run.artifacts,
          };
        } catch (error) {
          return err(typeof error?.code === 'string' ? error.code : 'RUNS_FAILED', String(error?.message ?? error));
        }
      },
    },
    {
      name: 'research_unit_cost',
      description: [
        '1688 采价 + 全成本落地测算：按子市场关键词搜索 1688 货源、逐条进详情页验证采购价 / 阶梯价 / 起批量 / 件重，再按「采购 + 头程 + FBA + 佣金 + 广告 + 退货 + 其它」测算单件净利与净利率。',
        '⚠️ 会打开 1688 页面并消耗网页端查询次数：每个关键词 1 次搜索页，每个进详情页验证的 offer 再加 1 次页面请求。调用前请先向用户说明会占用网页端查询次数。',
        '利润口径 = 净利率（扣完佣金 / 广告 / 退货 / 其它），与上游五维的「毛利率」口径（只扣采购成本）不可直接比较；红线：净利率 > 25% 才考虑，体量小（100-200 单）需 > 30%，物流占售价 10%-15%、>20% 提示放弃。',
        '⚠️ 当前只支持 Amazon FBA 配送模型（FBA 配送费按件重档估算）；默认用户口径为佣金 6%、广告 10%、退货 5%、其它 0，不代表 Amazon 标准费率，请用 costProfile 按实际类目覆盖。TikTok Shop 请用 research_product_select 的 channel=tiktok-shop。',
        '调用时机：用户要做「全成本落地测算 / 净利率口径的利润维度评分」，或问「这个品到底赚不赚钱」时。',
        '输出 { ok, offers, profit, warnings, fetchedAt }；采购价只取 1688 页面真实文本（未进详情页的只给搜索页卡片价并标注），抓不到就写「未取到」，不做估算填充。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          ...COST_PARAMETERS,
          outDir: { type: 'string', description: '输出根目录；不传用插件配置' },
          category: { type: 'string', description: '类目关键词（中文或英文），仅作上下文标注' },
          subMarkets: {
            type: 'array',
            description: '要采价的子市场列表，每条一个 1688 搜索关键词；不传则用 category 兜底成一个子市场',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '子市场名称（中文/英文均可），会写进报告第八章' },
                keyword: { type: 'string', description: '1688 搜索关键词（越具体越好，如 furniture pads）' },
                avgPriceUSD: { type: 'number', description: '该子市场在 Amazon 的均价（USD），用于净利测算；不传则该子市场只出货源不测算' },
              },
              additionalProperties: true,
            },
          },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: '每个子市场最多取多少条货源卡片（默认 5）' },
          detailLimit: { type: 'integer', minimum: 0, maximum: 10, description: '每个子市场最多进几个详情页验证（默认 3；进详情页才拿得到阶梯价/起批量/件重）' },
          provider: {
            type: 'string',
            enum: ['1688'],
            default: '1688',
            description: '货源平台，目前只有 1688',
          },
        },
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderJson },
      isConcurrencySafe: () => false,
      async execute(args) {
        const config = await readConfig(dataDir);
        const limit = asInt(args?.limit, 5, 1, 20);
        const detailLimit = asInt(args?.detailLimit, 3, 0, 10);
        const category = asString(args?.category);
        const rawSubMarkets = Array.isArray(args?.subMarkets) ? args.subMarkets : [];
        const subMarkets = rawSubMarkets
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({
            name: asString(item.name) || asString(item.keyword) || '子市场',
            keyword: asString(item.keyword) || asString(item.name),
            avgPriceUSD: typeof item.avgPriceUSD === 'number' && Number.isFinite(item.avgPriceUSD) ? item.avgPriceUSD : null,
          }))
          .filter((item) => item.keyword !== '');
        if (subMarkets.length === 0 && category) {
          subMarkets.push({ name: category, keyword: category, avgPriceUSD: null });
        }
        if (subMarkets.length === 0) {
          return err('INVALID_ARGS', '需要 subMarkets（每条 {name, keyword, avgPriceUSD}）或 category',
            '例：subMarkets: [{ name: Furniture Pads, keyword: furniture pads, avgPriceUSD: 10.14 }]');
        }

        const sourcing = await loadSourcing();
        if (sourcing.error) return sourcing.error;
        const source = sourcing.module;

        const options = costOptions(args, config);
        const profileCfg = resolveCostProfile({
          ...options.costProfile,
          ...(options.freightMode ? { freightMode: options.freightMode } : {}),
        });
        const fxCfg = await getFx({ live: options.liveFx, costFx: options.costFx, settleFx: options.settleFx });
        const freightCfg = await getFreight({
          mode: options.freightMode || profileCfg.freightMode,
          perKgCNY: options.freightPerKgCNY,
          apiUrl: options.freightApiUrl,
          live: Boolean(options.freightApiUrl),
        });
        const offers = [];
        const profit = [];
        const warnings = [];
        if (!(freightCfg?.perKgCNY > 0)) warnings.push('头程运价未取到：请提供 freightPerKgCNY 或可用 freightApiUrl；不以零或估算值计算净利。');
        if (profileCfg.referralRate === 0.06) warnings.push('佣金 6% 为用户成本口径，不代表 Amazon 类目标准费率；请按实际费率覆盖 costProfile.referralRate。');
        const sourcingRoot = resolveOutputRoot(config, asString(args?.outDir));
        const sourcingSessionId = 'live-sourcing-' + Date.now();
        await beginSession({ runId: sourcingSessionId, dir: join(sourcingRoot, LIVE_SESSION_DIR, sourcingSessionId), record: false, source: '1688 采价' });
        for (const sub of subMarkets) {
          let search;
          try {
            search = await source.searchOffers({ keyword: sub.keyword, limit });
          } catch (error) {
            const code = typeof error?.code === 'string' ? error.code : 'SOURCING_FAILED';
            if (code === 'NOT_LOGGED_IN' || code === 'CAPTCHA') {
              return err(code, sub.name + '：' + String(error?.message ?? error),
                code === 'NOT_LOGGED_IN'
                  ? '请在 Chrome 里登录 1688.com 后重试。'
                  : '1688 出现验证码，已停止抓取（不绕过），请稍后重试或换关键词。');
            }
            warnings.push(sub.name + '：1688 搜索失败（' + code + '）' + String(error?.message ?? error));
            continue;
          }
          const rows = Array.isArray(search?.rows) ? search.rows : [];
          warnings.push(sub.name + '：搜索页取到 ' + rows.length + ' 条货源卡片（来源 ' + (search?.source ?? '未取到') + '）');
          for (const row of rows.slice(0, detailLimit)) {
            let detail = null;
            if (row?.url) {
              try {
                detail = await source.fetchOfferDetail({ url: row.url });
              } catch (error) {
                const code = typeof error?.code === 'string' ? error.code : 'DETAIL_FAILED';
                if (code === 'NOT_LOGGED_IN' || code === 'CAPTCHA') {
                  return err(code, sub.name + '：' + String(error?.message ?? error),
                    code === 'NOT_LOGGED_IN' ? '请在 Chrome 里登录 1688.com 后重试。' : '1688 出现验证码，已停止抓取（不绕过）。');
                }
                warnings.push(sub.name + ' / offer ' + (row.offerId ?? '未取到') + '：详情页抓取失败（' + code + '）' + String(error?.message ?? error));
              }
            }
            const tiers = pickTierPrice(detail?.priceTiers);
            const priceCNY = tiers ? tiers.priceCNY : (typeof row?.priceCNY === 'number' ? row.priceCNY : null);
            const priceSource = tiers ? '实测值（详情页阶梯价，取起批量对应档）'
              : (typeof row?.priceCNY === 'number' ? '搜索页卡片价（未进详情页，不是实际拿货价）' : '未取到');
            const weightG = typeof detail?.weightG === 'number' ? detail.weightG : null;
            const record = {
              subMarket: sub.name,
              keyword: sub.keyword,
              offerId: row?.offerId ?? detail?.offerId ?? null,
              title: row?.title ?? detail?.title ?? null,
              url: row?.url ?? detail?.url ?? null,
              priceCNY,
              priceSource,
              moq: detail?.moq ?? null,
              moqText: detail?.moqText ?? row?.moqText ?? null,
              material: detail?.material ?? null,
              weightG,
              packDimsCm: detail?.packDimsCm ?? null,
              supplier: detail?.supplier ?? row?.supplier ?? null,
              location: detail?.location ?? row?.location ?? null,
              onePieceDropship: detail?.onePieceDropship ?? null,
              monthlySales: detail?.monthlySales ?? row?.monthlySales ?? null,
              priceTiers: Array.isArray(detail?.priceTiers) ? detail.priceTiers : [],
              verified: Boolean(detail),
              cardSource: search?.source ?? null,
              fetchedAt: detail?.fetchedAt ?? search?.fetchedAt ?? null,
            };
            offers.push(record);

            if (sub.avgPriceUSD === null || priceCNY === null) {
              warnings.push(sub.name + ' / offer ' + (record.offerId ?? '未取到') + '：缺售价或采购价，未产出净利测算');
              continue;
            }
            const calc = landedCost({
              priceCNY,
              weightG,
              priceUSD: sub.avgPriceUSD,
              costFx: fxCfg.costFx,
              settleFx: fxCfg.settleFx,
              profile: profileCfg,
              freight: freightCfg,
              sources: {
                purchase: '实测值',
                weight: weightG === null ? '未取到' : '实测值',
                fba: '估算值',
                return: '估算值',
              },
              notes: ['采购价来源：' + priceSource],
            });
            if (calc === null) {
              warnings.push(sub.name + ' / offer ' + (record.offerId ?? '未取到') + '：无法测算全成本');
              continue;
            }
            const judge = judgeProfit({
              netMargin: calc.netMargin,
              logisticsRatio: calc.logisticsRatio,
              purchaseRatio: calc.purchaseRatio,
              priceUSD: calc.priceUSD,
              purchaseCNY: calc.priceCNY,
              fbaFeeUSD: calc.fbaFeeUSD,
            });
            profit.push({
              subMarket: sub.name,
              keyword: sub.keyword,
              offerId: record.offerId,
              offerUrl: record.url,
              priceUSD: calc.priceUSD,
              priceCNY: calc.priceCNY,
              purchaseUSD: calc.purchaseUSD,
              firstMileUSD: calc.firstMileUSD,
              fbaFeeUSD: calc.fbaFeeUSD,
              fbaEstimated: calc.fbaEstimated,
              referralUSD: calc.referralUSD,
              adUSD: calc.adUSD,
              returnUSD: calc.returnUSD,
              otherUSD: calc.otherUSD,
              totalCostUSD: calc.totalCostUSD,
              netProfitUSD: calc.netProfitUSD,
              netMargin: calc.netMargin,
              grossMargin: calc.grossMargin,
              logisticsRatio: calc.logisticsRatio,
              purchaseRatio: calc.purchaseRatio,
              verdict: judge.verdict,
              checks: judge.checks,
              notes: calc.notes,
            });
          }
        }

        await endSession({ status: 'done' });
        return {
          ok: true,
          offers,
          profit,
          costProfile: profileCfg,
          fx: fxCfg,
          freight: freightCfg,
          warnings,
          fetchedAt: new Date().toISOString(),
        };
      },
    },
    {
      name: 'research_product_select',
      description: [
        '选品全流程（四途径 → 九策略 → 十维 → 差异化）：action=plan 出路线图，action=screen 对候选 ASIN 做十维体检、一票否决、分档与差异化建议。',
        'action=plan：按站点/类目生成站内 7 个榜单入口（Best Sellers / New Releases / Movers / Most Wished For / Gift Ideas / Deals / 热搜词）、站外与软件渠道、九种选品策略的适用性与步骤、十维采集清单。免费，不取数。',
        'action=collect：走卖家精灵「查竞品」页抓该细分类目的 Top 商品，自动生成采集表行（ASIN/售价/月销/月销售额/评分数/评分/变体数/FBA费/毛利率/上架时间/商品重量/包装尺寸 + 类目集中度/新品占比/前十评价数），可直接喂给 action=screen。走网页登录态链路，占用卖家精灵网页查询次数，不消耗 MCP 额度。',
        'action=screen：接收采集表（rows 数组或 csv 文本，中英文列名均可），逐品输出 达标/警戒/不达标/未知、一票否决、一档/二档/三档/待复核/淘汰、全成本净利率、敏感性与差异化方向；报告开头是决策单（做/小批量测/先补数/不做、致命项、安全边际、首批资金与回本、可攻击面）+ 渠道对照（同一品在 amazon-fba / amazon-fbm / tiktok-shop 的净利率），beginner 保守档画像额外输出附录教练层。落盘 report.md / selection.csv / provenance.json（原始输入 + SHA-256 输入指纹 + 逐项判定），报告第八章给出每个 KPI 的输入列与来源。免费，不消耗数据服务额度。',
        '⚠️ 渠道决定生死：售价 $5.49 的小件在 Amazon FBA 因 $3.22 配送费必亏，在 TikTok Shop（佣金 6%、无 FBA 费）可赚。做 TK / 独立站必须传 channel=tiktok-shop。',
        '纪律：缺失字段记「未知」不计入命中率；采购价必须来自 1688 真实报价；榜单数字必须真实抓取，禁止用记忆补。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['plan', 'collect', 'screen'], description: 'plan=路线图（免费）；collect=自动采集采集表（走卖家精灵网页）；screen=体检候选品（免费）' },
          marketplace: { type: 'string', description: 'Amazon 站点，默认取插件配置（US）' },
          category: { type: 'string', description: '类目关键词或类目名（用于拼榜单链接与报告标题）' },
          nodeIdPath: { type: 'string', description: '类目节点路径（如 11091801:11974521:8882489011），用于拼榜单链接' },
          keyword: { type: 'string', description: '核心关键词（热搜词/ABA 路线用）' },
          signals: {
            type: 'object',
            description: '可选类目信号，用于判断九策略适用性：{brandCr3: 0~1, avgPrice: USD}',
            additionalProperties: true,
          },
          rows: {
            type: 'array',
            description: 'screen 用：候选品数组。列名支持模板中文名（ASIN/售价USD/采购价CNY/品牌集中度%/前10评价数…）或英文名',
            items: { type: 'object', additionalProperties: true },
          },
          csv: { type: 'string', description: 'screen 用：CSV 文本（与 rows 二选一），首行表头' },
          productLimit: { type: 'integer', minimum: 10, maximum: 100, description: 'collect 用：抓多少个 Top 商品，默认 50' },
          thenScreen: { type: 'boolean', description: 'collect 用：采集完直接体检并出报告（默认 true）' },
          ...COST_PARAMETERS,
          title: { type: 'string', description: '报告标题，默认用 category 或「选品体检」' },
          source: { type: 'string', description: '候选来源标注，如「BS 榜 / 竞品店铺 / 手动采集」' },
          channel: {
            type: 'string',
            enum: ['amazon-fba', 'amazon-fbm', 'tiktok-shop'],
            description: '销售渠道，决定利润模型：amazon-fba（FBA 配送费按件重档）｜amazon-fbm（自发货，无平台配送费）｜tiktok-shop（佣金 6%、无 FBA 费、跨境直发物流）。默认 amazon-fba。同一品换渠道结论可能相反，报告会给出渠道对照',
          },
          profile: {
            type: 'string',
            enum: ['beginner', 'operator', 'factory'],
            description: '卖家画像：beginner 保守档（资金<10万/无供应链，默认）｜operator 进阶｜factory 工厂型。画像决定售价带/重量/变体/认证/季节/利润红线的适配判断，并输出决策单与附录教练层',
          },
          reportStyle: { type: 'string', enum: ['data', 'full'], description: '报告版式：data（默认，只给表格与数字）｜full（完整版，含四途径/九策略/教练层/术语/免责声明）' },
          targetMonthlyUnits: { type: 'integer', minimum: 10, maximum: 100000, description: '目标月销单数，用于首批回本估算；不传用画像默认（保守档 100 / 进阶 300 / 工厂 500）' },
          outDir: { type: 'string', description: '报告输出根目录；不传用插件配置' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderJson },
      isConcurrencySafe: () => false,
      async execute(args) {
        const config = await readConfig(dataDir);
        const outputRoot = resolveOutputRoot(config, asString(args?.outDir));
        const marketplace = (asString(args?.marketplace) || config.marketplace || 'US').toUpperCase();
        const action = asString(args?.action) || 'plan';
        const category = asString(args?.category);
        const nodeIdPath = asString(args?.nodeIdPath);
        const keyword = asString(args?.keyword);
        const signals = args?.signals && typeof args.signals === 'object' ? args.signals : {};
        const planInput = { marketplace, category, nodeIdPath, keyword, signals };

        if (action === 'plan') {
          if (!category && !nodeIdPath && !keyword) {
            return err('INVALID_ARGS', 'plan 需要 category、nodeIdPath 或 keyword 之一', '例：{action:"plan", category:"vases", marketplace:"US"}');
          }
          return { ok: true, action, outputRoot, ...buildSelectionPlan(planInput) };
        }

        if (action === 'collect') {
          if (!category && !nodeIdPath) {
            return err('INVALID_ARGS', 'collect 需要 category 或 nodeIdPath',
              '例：{action:"collect", category:"glove clips", marketplace:"US"}');
          }
          const productLimit = asInt(args?.productLimit, 50, 10, 100);
          try {
            const run = await withLiveSession({
              outputRoot,
              record: args?.record === true,
              fps: typeof args?.recordFps === 'number' ? args.recordFps : 2,
              source: '采集采集表 · ' + (category || nodeIdPath || ''),
            }, () => selectCategoryWeb({
              marketplace,
              category: category || undefined,
              nodeIdPath: nodeIdPath || undefined,
              limit: productLimit,
              unitCost: null,
              costs: [],
              outputRoot,
              dataDir,
            }));
            const market = run.market || null;
            const products = (market && market.products) || [];
            const rows = productsToSelectionRows({
              market,
              products,
              marketplace,
              categoryPath: (market && market.label) || category || '',
              source: '卖家精灵查竞品页（' + (market && market.nodeIdPath ? market.nodeIdPath : '') + '）',
            });
            const collected = {
              ok: true,
              action,
              runId: run.runId,
              dir: run.dir,
              count: rows.length,
              label: (market && market.label) || category || '',
              nodeIdPath: (market && market.nodeIdPath) || '',
              rows,
              warnings: run.warnings || [],
            };
            if (args?.thenScreen === false || rows.length === 0) {
              return collected;
            }
            const screened = await screenCandidates({
              rows,
              title: asString(args?.title) || (market && market.label) || '选品体检',
              marketplace,
              ...costOptions(args, config),
              outputRoot,
              dataDir,
              source: collected.source,
              profile: asString(args?.profile) || 'beginner',
              channel: asString(args?.channel) || 'amazon-fba',
              targetMonthlyUnits: typeof args?.targetMonthlyUnits === 'number' && Number.isFinite(args.targetMonthlyUnits) ? args.targetMonthlyUnits : null,
              plan: null,
            });
            return { ...collected, screen: { runId: screened.runId, dir: screened.dir, summary: screened.summary, top: screened.top } };
          } catch (error) {
            const code = typeof error?.code === 'string' ? error.code : 'COLLECT_FAILED';
            const message = String(error?.message ?? error);
            const hint = code === 'NOT_LOGGED_IN'
              ? '请在 Chrome 里登录 www.sellersprite.com 后重试。'
              : code === 'NODE_NOT_FOUND'
                ? '换英文类目词重试，或直接传 nodeIdPath。'
                : undefined;
            return err(code, message, hint);
          }
        }

        if (action !== 'screen') {
          return err('INVALID_ARGS', '未知 action：' + action, '可选值：plan / screen');
        }

        let rows = Array.isArray(args?.rows) ? args.rows.filter((row) => row && typeof row === 'object') : [];
        if (rows.length === 0 && asString(args?.csv)) rows = parseCsv(asString(args.csv));
        if (rows.length === 0) {
          return err('INVALID_ARGS', 'screen 需要 rows 数组或 csv 文本', '可先用 action=plan 取采集清单，再按 assets/selection-table-template.csv 填表');
        }

        const plan = (category || nodeIdPath || keyword) ? buildSelectionPlan(planInput) : null;
        try {
          const result = await screenCandidates({
            rows,
            title: asString(args?.title) || category || '选品体检',
            marketplace,
            ...costOptions(args, config),
            outputRoot,
            dataDir,
            source: asString(args?.source) || 'research_product_select',
            plan,
            profile: asString(args?.profile) || 'beginner',
            channel: asString(args?.channel) || 'amazon-fba',
            reportStyle: asString(args?.reportStyle) || 'data',
            targetMonthlyUnits: typeof args?.targetMonthlyUnits === 'number' && Number.isFinite(args.targetMonthlyUnits) ? args.targetMonthlyUnits : null,
          });
          return { ...result, action };
        } catch (error) {
          return err(typeof error?.code === 'string' ? error.code : 'SELECTION_FAILED', String(error?.message ?? error));
        }
      },
    },
    {
      name: 'research_market_macro',
      description: [
        '沙特四平台宏观研究与差异化选品（不依赖卖家精灵）：Temu / AliExpress / Amazon.sa / Trendyol.sa 的平台体量与近两年 GMV 可得性、地区消费占比、人群画像与消费习惯，输出类目差异化矩阵与 做/小批量测/先补数/不做 决策单。',
        'action=plan：返回四平台口径（谁公开沙特 GMV、谁用什么需求代理）、公开来源清单、四层采集动作、各平台可攻击面、以及可直接填空的输入模板。免费、不联网。',
        'action=analyze：接收已采集的 gmv / regions / consumer / categories，做口径校验 → 可比性判定 → 差异化矩阵 → 决策单，落盘 report.md / macro.json / provenance.json 与三张 CSV。免费、不联网。',
        '⚠️ 关键事实：四家平台均不公开「沙特口径 GMV」（母公司只在区域/集团层面披露）。工具不会把区域数字改写成沙特 GMV，也不会把评价数/已售数换算成销量或 GMV；取不到一律写「未取到」。',
        '⚠️ 只有四个平台同指标、同期间、同口径、同币种齐全时才计算平台份额；不齐全只并列展示。',
        '采集用 research_page 读前台页面，或人工填表；规格未对齐的样本不参与价差倍数计算。结论不含采购与物流成本，确认可做后接 research_unit_cost 做全成本测算。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['plan', 'analyze'], description: 'plan=口径与采集路线图（免费）；analyze=用已采集数据出报告（免费）' },
          market: { type: 'string', enum: ['SA'], description: '市场，目前只有 SA（沙特阿拉伯）' },
          category: { type: 'string', description: '类目/品类关键词，用于拼各平台搜索链接与报告标题' },
          platform: { type: 'string', enum: ['amazon-sa', 'temu', 'aliexpress', 'trendyol-sa'], description: 'plan 用：只看某个平台；不传看四个' },
          gmv: {
            type: 'array',
            description: 'analyze 用：规模观测数组。字段 platform/metric/value/period/scope/basis/source/sourceUrl/observedAt/note。scope 必须写明 saudi-total 还是 mena/platform-global',
            items: { type: 'object', additionalProperties: true },
          },
          regions: {
            type: 'array',
            description: 'analyze 用：地区占比观测。{platform, region, share(0~1 或百分数), basis, source, observedAt}',
            items: { type: 'object', additionalProperties: true },
          },
          consumer: {
            type: 'object',
            description: 'analyze 用：按平台 id 给人群画像。{age:[{band,share}], gender:[...], income:[...], device:[...], payment:[...], habit, delivery, season, language, source, observedAt, sample}',
            additionalProperties: true,
          },
          categories: {
            type: 'array',
            description: 'analyze 用：类目样本。{name, useCase, platforms: {<platformId>: {priceSAR, ratingCount|soldLowerBound, rating, spec, sponsored, url}}}；spec 相同的样本才参与价差计算',
            items: { type: 'object', additionalProperties: true },
          },
          title: { type: 'string', description: '报告标题' },
          source: { type: 'string', description: '数据来源标注，如「浏览器前台采集 + 财报区域口径」' },
          outDir: { type: 'string', description: '报告输出根目录；不传用插件配置' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderJson },
      isConcurrencySafe: () => false,
      async execute(args) {
        const config = await readConfig(dataDir);
        const outputRoot = resolveOutputRoot(config, asString(args?.outDir));
        const action = asString(args?.action) || 'plan';
        const market = (asString(args?.market) || 'SA').toUpperCase();
        if (market !== 'SA') return err('INVALID_ARGS', '目前只支持 SA（沙特阿拉伯）', 'market 传 SA');
        if (action === 'plan') {
          return {
            ok: true,
            action,
            outputRoot,
            ...buildMacroPlan({ market, category: asString(args?.category), platform: asString(args?.platform) }),
          };
        }
        if (action !== 'analyze') {
          return err('INVALID_ARGS', '未知 action：' + action, '可选值：plan / analyze');
        }
        try {
          const result = await runMacroAnalysis({
            market,
            gmv: Array.isArray(args?.gmv) ? args.gmv : [],
            regions: Array.isArray(args?.regions) ? args.regions : [],
            consumer: args?.consumer && typeof args.consumer === 'object' ? args.consumer : {},
            categories: Array.isArray(args?.categories) ? args.categories : [],
            title: asString(args?.title),
            source: asString(args?.source),
            outputRoot,
            dataDir,
            registryDir: dataDir,
          });
          return jsonSafe({ ok: true, action, outputRoot, ...result });
        } catch (error) {
          return err(typeof error?.code === 'string' ? error.code : 'MACRO_FAILED', String(error?.message ?? error));
        }
      },
    },
    {
      name: 'research_page',
      description: [
        '直接操作你已经登录的 Chrome 页面：文本快照 → 按编号点击/输入 → 导航/截图，用来把「只渲染首屏」的页面数据翻出来。',
        '调用时机：卖家精灵扩展面板、卖家精灵网页版、Amazon 搜索页、1688 详情页、Trendyol 等需要点击「加载更多」、翻页、选筛选、滚动虚拟列表才能看到全部数据时。',
        '推荐顺序：先 snapshot 拿页面结构与控件编号（ref 形如 e12，跨快照稳定），再用 click/type 的 ref 操作；没有 ref 时才退回 selector / text / xpath。',
        'action：tabs 列标签页 ｜ state 页面概况 ｜ backend 浏览器驱动状态 ｜ snapshot 文本快照（含编号控件、正文、表单值脱敏；delta=true 只看变化）｜ click ｜ type ｜ press ｜ scroll ｜ drag ｜ read ｜ wait ｜ scrollAll ｜ navigate 导航到 URL ｜ back/forward/reload ｜ screenshot 截图（需 CDP）｜ follow 跟随标签页。',
        'target：tabId（精确）｜url（按 URL 片段匹配已打开标签页）。写操作必须传精确 tabId，或让 url 只匹配一个标签页；多匹配会拒绝，避免误操作。元素定位：ref ｜ selector ｜ text ｜ xpath，四选一。',
        '截图需要 Chrome 以 --remote-debugging-port 启动（browser.driver=cdp），且只能写数据目录 screenshots/ 下的新 PNG；macOS 未开启调试端口时截图报错、其它动作走 AppleScript，Windows/Linux 必须开 CDP。插件不会自行启动浏览器。',
        '纪律：不绕过验证码、登录、限流、拒绝访问或付费墙；命中风险页时写操作直接停止。跨域 frame 的 fN:eN ref 只读，不自动点击。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['tabs', 'state', 'backend', 'snapshot', 'click', 'type', 'press', 'scroll', 'drag', 'read', 'wait', 'scrollAll', 'navigate', 'back', 'forward', 'reload', 'screenshot', 'follow'], description: '要执行的动作' },
          tabId: { type: 'string', description: '标签页 id（tabs 动作返回）；不传则按 url 匹配或取第一个标签页' },
          url: { type: 'string', description: '按 URL 片段匹配已打开的标签页，如 sellersprite.com / amazon.com/s?k=' },
          selector: { type: 'string', description: 'CSS 选择器' },
          text: { type: 'string', description: '按可见文字找元素（等于或包含）' },
          xpath: { type: 'string', description: 'XPath（前两者不适用时用）' },
          index: { type: 'integer', minimum: 0, maximum: 500, description: '同名元素的第几个，默认 0' },
          value: { type: 'string', description: 'type 动作要写入的文本' },
          enter: { type: 'boolean', description: 'type 动作写完是否回车提交' },
          key: { type: 'string', description: 'press 动作的按键名，如 Enter / Escape / ArrowDown' },
          top: { type: 'number', description: 'scroll 动作：滚到指定 scrollTop' },
          deltaY: { type: 'number', description: 'scroll / drag 动作：相对滚动的像素' },
          toBottom: { type: 'boolean', description: 'drag 动作：是否拖到底（默认 true）' },
          ref: { type: 'string', description: '快照里的控件编号（如 e12 或 f2:e12），click/type/press 优先用它定位' },
          contains: { type: 'boolean', description: 'text 定位是否采用包含匹配，默认 true；false 为完全匹配' },
          clear: { type: 'boolean', description: 'type 动作输入前是否清空，默认 true；false 为追加' },
          requireNative: { type: 'boolean', description: '要求 CDP 真实输入；CDP 不可用或失败时直接报错，不降级成页面 JS' },
          waitUntil: { type: 'string', enum: ['none', 'dom-settled'], description: '交互后等待策略；dom-settled 等页面连续 600ms 无 DOM 变化' },
          waitForSelector: { type: 'string', description: '交互后等待这个 CSS 选择器出现' },
          waitForUrl: { type: 'string', description: '交互后等待 URL 包含此文本' },
          delta: { type: 'boolean', description: 'snapshot 动作：只返回控件及正文分块变化' },
          maxChars: { type: 'integer', minimum: 500, maximum: 200000, description: 'snapshot 正文字符上限，默认 6000' },
          maxItems: { type: 'integer', minimum: 1, maximum: 1000, description: 'snapshot 控件上限，默认 120' },
          fullPage: { type: 'boolean', description: 'screenshot 动作：截整页而不是可视区域' },
          savePath: { type: 'string', description: 'screenshot 动作：数据目录 screenshots/ 下的相对 PNG 路径；拒绝越界和覆盖' },
          targetUrl: { type: 'string', description: 'navigate 动作：要跳转的 http(s) 地址' },
          raw: { type: 'boolean', description: 'snapshot 动作：额外返回结构化 view（默认只返回渲染文本，避免重复占上下文）' },
          rows: { type: 'boolean', description: 'read 动作：读表格行而不是整页文本' },
          limit: { type: 'integer', minimum: 1, maximum: 5000, description: 'read 动作返回的最大条数，默认 500' },
          timeout: { type: 'integer', minimum: 1, maximum: 300, description: 'wait 动作的等待秒数，默认 30' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderJson },
      isConcurrencySafe: () => false,
      async execute(rawArgs) {
        const action = asString(rawArgs?.action);
        if (!action) return err('INVALID_ARGS', 'action 必填', '可选：tabs / state / backend / snapshot / click / type / press / scroll / drag / read / wait / scrollAll / navigate / back / forward / reload / screenshot / follow');
        let page;
        let chrome;
        try {
          page = await import('./web/page-actions.js');
          chrome = await import('./web/chrome.js');
        } catch (error) {
          return err('PAGE_UNAVAILABLE', '页面操作模块不可用：' + String(error?.message ?? error), '需要 Google Chrome：macOS 可用 AppleScript 或 CDP；Windows/Linux 需以 --remote-debugging-port 启动 Chrome。');
        }
        const launchHint = typeof chrome.chromeLaunchHint === 'function' ? chrome.chromeLaunchHint() : '';
        if (action === 'backend') {
          try {
            const { browserBackendInfo } = await import('./web/chrome.js');
            return { ok: true, backend: await browserBackendInfo({ force: true }) };
          } catch (error) {
            return err('BROWSER_BACKEND_FAILED', String(error?.message ?? error), launchHint || undefined);
          }
        }
        let tabs = [];
        try {
          tabs = await chrome.listTabs();
        } catch (error) {
          const hint = error?.launchHint || launchHint;
          return err(
            typeof error?.code === 'string' && /^(CDP_REQUIRED|BROWSER_UNSUPPORTED_ON_PLATFORM|CDP_UNREACHABLE|APPLESCRIPT_UNSUPPORTED)$/.test(error.code) ? error.code : 'CHROME_UNREACHABLE',
            String(error?.message ?? error),
            hint ? (process.platform === 'darwin' ? '确认 Chrome 正在运行，且系统已允许终端/DSH 控制 Google Chrome。' : '当前平台需先启动带调试端口的 Chrome：' + hint) : '确认 Chrome 正在运行。',
          );
        }
        if (action === 'tabs') {
          return { ok: true, count: tabs.length, tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title || '' })) };
        }
        const explicitTabId = asString(rawArgs?.tabId);
        const urlPart = asString(rawArgs?.url);
        const urlMatches = !explicitTabId && urlPart ? tabs.filter((t) => String(t.url || '').includes(urlPart)) : [];
        if (!explicitTabId && urlMatches.length > 1) {
          return err('AMBIGUOUS_TAB', 'URL 片段匹配到多个标签页，请传 tabs 返回的精确 tabId', urlMatches.map((t) => String(t.id) + ' ' + String(t.url || '')).join('\n'));
        }
        const writeActions = new Set(['click', 'type', 'press', 'scroll', 'drag', 'scrollAll', 'navigate', 'back', 'forward', 'reload', 'screenshot', 'follow']);
        if (writeActions.has(action) && !explicitTabId && urlMatches.length !== 1) {
          return err('TAB_REQUIRED', action + ' 是页面写操作，必须传精确 tabId，或传只能匹配一个标签页的 url 片段', '先调用 action=tabs 或 snapshot 确认目标页，避免操作错误标签页。');
        }
        const tabId = explicitTabId || (urlMatches[0]?.id ?? tabs[0]?.id ?? '');
        if (!tabId) return err('NO_TAB', '没有可操作的标签页', '先在 Chrome 里打开目标页面（或在参数里给 url 片段）。');
        const current = tabs.find((t) => String(t.id) === String(tabId));
        if (!current) return err('NO_TAB', '找不到指定标签页：' + tabId, '标签页可能已关闭或浏览器后端已变化，请重新调用 action=tabs。');
        if (current && !/^https?:/i.test(String(current.url || ''))) {
          return err('BAD_TAB', '目标标签页不是 http(s) 页面：' + String(current.url || ''), '先导航到目标页面再操作。');
        }
        const target = {
          ref: asString(rawArgs?.ref) || null,
          selector: asString(rawArgs?.selector) || null,
          text: asString(rawArgs?.text) || null,
          xpath: asString(rawArgs?.xpath) || null,
          index: Number.isFinite(Number(rawArgs?.index)) ? Number(rawArgs.index) : 0,
          contains: rawArgs?.contains !== false,
        };
        let caps;
        try {
          caps = await import('./web/page-capabilities.js');
        } catch (error) {
          return err('PAGE_UNAVAILABLE', '页面能力模块不可用：' + String(error?.message ?? error));
        }
        try {
          const interactionOptions = {
            requireNative: rawArgs?.requireNative === true,
            waitUntil: rawArgs?.waitUntil === 'dom-settled' ? 'dom-settled' : 'none',
            waitForSelector: asString(rawArgs?.waitForSelector) || null,
            waitForUrl: asString(rawArgs?.waitForUrl) || null,
            timeout: Number.isFinite(Number(rawArgs?.timeout)) ? Number(rawArgs.timeout) : 30,
          };
          if (action === 'state') return { ok: true, tabId, state: await page.pageState(tabId) };
          if (action === 'snapshot') {
            const result = await caps.snapshot(tabId, {
              delta: rawArgs?.delta === true,
              maxChars: Number.isFinite(Number(rawArgs?.maxChars)) ? Number(rawArgs.maxChars) : undefined,
              maxItems: Number.isFinite(Number(rawArgs?.maxItems)) ? Number(rawArgs.maxItems) : undefined,
            });
            const payload = {
              ok: true,
              tabId,
              text: result.text,
              evidence: result.evidence,
              pageFlags: result.view.pageFlags || {},
              stats: {
                items: result.view.items.length,
                changed: result.view.changed.length,
                removed: result.view.removed.length,
                textAdded: result.view.textDelta?.added?.length || 0,
                textRemoved: result.view.textDelta?.removed?.length || 0,
                inaccessibleFrames: result.view.inaccessibleFrames?.length || 0,
                truncated: result.view.truncated,
              },
            };
            if (rawArgs?.raw === true) payload.view = result.view;
            return payload;
          }
          if (action === 'navigate') {
            const url = asString(rawArgs?.targetUrl) || asString(rawArgs?.url);
            if (!url) return err('INVALID_ARGS', 'navigate 需要 targetUrl（http/https）');
            return { ok: true, tabId, ...(await caps.navigate(tabId, url, interactionOptions)) };
          }
          if (action === 'back' || action === 'forward' || action === 'reload') return { ok: true, tabId, ...(await caps.history(tabId, action, interactionOptions)) };
          if (action === 'screenshot') return { ok: true, tabId, ...(await caps.screenshot(tabId, { fullPage: rawArgs?.fullPage === true, savePath: asString(rawArgs?.savePath) || null })) };
          if (action === 'follow') return { ok: true, ...(await caps.follow(tabId)) };
          if (action === 'click') return { ok: true, tabId, ...(await caps.click(tabId, target, interactionOptions)) };
          if (action === 'type') return { ok: true, tabId, ...(await caps.type(tabId, target, String(rawArgs?.value ?? ''), { ...interactionOptions, enter: rawArgs?.enter === true, clear: rawArgs?.clear !== false })) };
          if (action === 'press') return { ok: true, tabId, ...(await caps.press(tabId, asString(rawArgs?.key) || 'Enter', target.ref || target.selector || target.text || target.xpath ? target : null, interactionOptions)) };
          if (action === 'scroll') {
            const deltaY = Number.isFinite(Number(rawArgs?.deltaY)) ? Number(rawArgs.deltaY) : null;
            if (!target.selector && deltaY !== null && !Number.isFinite(Number(rawArgs?.top))) {
              // caps.scrollPage 内部已做页面风险守卫。
              return { ok: true, tabId, ...(await caps.scrollPage(tabId, deltaY, interactionOptions)) };
            }
            await caps.assertPageSafe(tabId);
            return { ok: true, tabId, ...(await page.scroll(tabId, {
              selector: target.selector,
              top: Number.isFinite(Number(rawArgs?.top)) ? Number(rawArgs.top) : null,
              deltaY,
            })) };
          }
          if (action === 'drag') {
            await caps.assertPageSafe(tabId);
            return { ok: true, tabId, ...(await page.dragScroll(tabId, {
              selector: target.selector,
              toBottom: rawArgs?.toBottom !== false,
              deltaY: Number.isFinite(Number(rawArgs?.deltaY)) ? Number(rawArgs.deltaY) : 600,
            })) };
          }
          if (action === 'read') {
            const result = await page.read(tabId, {
              selector: target.selector,
              rows: rawArgs?.rows === true,
              limit: Number.isFinite(Number(rawArgs?.limit)) ? Number(rawArgs.limit) : 500,
            });
            const joined = Array.isArray(result?.data) ? JSON.stringify(result.data) : '';
            const warning = /验证码|人机验证|滑动验证|captcha|verify you are human|access denied|forbidden|too many requests|rate limit|开通会员|付费后查看|subscribe to continue/i.test(joined)
              ? '页面出现验证码、限流、拒绝访问或付费墙：请人工处理后重试，插件不绕过。'
              : null;
            return warning ? { ok: true, tabId, warning, ...result } : { ok: true, tabId, ...result };
          }
          if (action === 'wait') {
            const found = await page.waitForSelector(tabId, target.selector || '*', { timeout: Number(rawArgs?.timeout) || 30 });
            return { ok: true, tabId, found };
          }
          if (action === 'scrollAll') {
            await caps.assertPageSafe(tabId);
            const result = await page.scrollUntilStable(tabId, {
              selector: target.selector,
              step: Number.isFinite(Number(rawArgs?.deltaY)) ? Number(rawArgs.deltaY) : 600,
            });
            return { ok: true, tabId, ...result };
          }
          return err('INVALID_ARGS', '未知 action: ' + action, '可选：tabs / state / backend / snapshot / click / type / press / scroll / drag / read / wait / scrollAll / navigate / back / forward / reload / screenshot / follow');
        } catch (error) {
          const code = typeof error?.code === 'string' ? error.code : 'PAGE_ACTION_FAILED';
          return err(code, String(error?.message ?? error));
        }
      },
    },
    {
      name: 'mcp_call',
      description: [
        '直接调用已配置数据源的 MCP 工具（逃生口）：用于插件尚未封装的能力（关键词、评论、流量、ABA、单品详情等）。',
        '调用时机：research_category_select 覆盖不到、或用户明确要某个 MCP 工具的数据时；优先使用已有高层工具。',
        '会真实消耗数据服务额度；参数结构参考对应厂商工具文档（卖家精灵多数工具需要 {"request":{...}} 包裹）。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: ['sellersprite', 'sorftime'], description: '数据源' },
          tool: { type: 'string', description: '工具名，如 "market_brand_concentration"、"asin_detail"' },
          args: { type: 'object', additionalProperties: true, description: '工具参数对象，原样转发给 MCP' },
          saveToFile: { type: 'boolean', description: '响应过大时是否落盘为 JSON（默认 true）' },
        },
        required: ['provider', 'tool'],
        additionalProperties: false,
      },
      output: { schema: OUTPUT_SCHEMA, render: renderJson },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const provider = asString(args?.provider);
        const tool = asString(args?.tool);
        if (!provider || !tool) return err('INVALID_ARGS', 'provider 与 tool 必填');
        try {
          const data = await providers.call(provider, tool, args?.args && typeof args.args === 'object' ? args.args : {}, { signal: exec?.signal });
          const text = typeof data === 'string' ? data : JSON.stringify(data);
          if (text.length > 60000 && args?.saveToFile !== false) {
            const { mkdir, writeFile } = await import('node:fs/promises');
            const { join } = await import('node:path');
            const dir = join(dataDir, 'cache');
            await mkdir(dir, { recursive: true });
            const file = join(dir, provider + '_' + tool + '_' + Date.now() + '.json');
            await writeFile(file, text, 'utf8');
            return { ok: true, provider, tool, savedTo: file, bytes: text.length, preview: text.slice(0, 2000) };
          }
          return { ok: true, provider, tool, data };
        } catch (error) {
          const code = typeof error?.code === 'string' ? error.code : 'MCP_CALL_FAILED';
          return err(code, String(error?.message ?? error), code === 'NO_CREDENTIAL' ? '先在设置页配置该数据源的密钥' : undefined);
        }
      },
    },
  ];
}
