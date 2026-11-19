import { join } from 'node:path';
import { readConfig, resolveOutputRoot } from '../paths.js';
import { createRun, writeArtifacts } from '../runs.js';
import {
  DISCOVERY_MODEL, DEMAND_POLICY, buildDiscoveryPlan, mergeObservations,
  toObservations, waitingPoolMarkdown,
} from './sa-discovery.js';
import { collectAmazonSa } from '../web/amazon-sa.js';

const fail = (code, message) => ({ ok: false, error: { code, message } });
const output = { schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' } }, required: ['ok'] }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
const ALLOWED = { plan: ['keyword', 'categoryUrl'], collect: ['mode', 'keyword', 'categoryUrl', 'pages', 'limit'], prepare: ['observations'] };

/** 把采集行转成标准观测，并按 id 合并去重。 */
function rowsToObservations(rows, { fetchedAt, keyword }) {
  const collected = [];
  for (const row of rows) {
    collected.push(...toObservations(row, {
      sourceUrl: row.pageUrl,
      capturedAt: fetchedAt,
      keyword,
      position: row.position,
      listId: row.kind === 'rank' ? 'bestsellers grid item' : 'search-result card',
    }));
  }
  return collected;
}

/**
 * 找品运行的 Markdown 报告正文（面板读 report.md）。
 * 只展示已采集到的观测，不做结论、不给推荐。
 */
function discoveryReportMarkdown({ title, generatedAt, keyword, rows = [], observations = [], rejected = [], diagnostics = [] }) {
  const missing = '待确认';
  const cell = (value) => (value === null || value === undefined || value === '' ? missing : value);
  const md = (value) => String(cell(value)).replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ').replace(/</g, '&lt;');
  const table = (headers, list) => ['| ' + headers.map(md).join(' | ') + ' |', '| ' + headers.map(() => '---').join(' | ') + ' |', ...list.map((row) => '| ' + row.map(md).join(' | ') + ' |')].join('\n');
  const prices = rows.map((row) => row.priceSAR).filter((value) => typeof value === 'number');
  const sections = [
    '# ' + md(title),
    '',
    '生成时间：' + generatedAt + '；销售平台：Trendyol.sa（唯一）；找品来源：Amazon.sa。',
    '',
    '## 结论纪律',
    '',
    '- 本次只做**找品与需求交叉验证**：不产生候选、不算利润、不给推荐、不做合规结论。',
    '- Amazon.sa 观测最多支撑需求门槛，**不能替代 Trendyol.sa 的需求验证**（需求至少 1 项须来自 Trendyol.sa）。',
    '- 待匹配池商品**不进候选池**：必须先在 Trendyol.sa 找到同款并核验。',
    '- 未采集到的字段写「待确认」，不估算、不换算销量。',
    '',
    '## 本次采集概况',
    '',
    table(['项目', '数值'], [
      ['关键词', keyword || missing],
      ['卡片数', rows.length],
      ['观测条数', observations.length],
      ['被拒观测', rejected.length],
      ['价格带 SAR', prices.length ? Math.min(...prices) + ' ~ ' + Math.max(...prices) : missing],
      ['来源域名', 'www.amazon.sa'],
    ]),
    '',
    '## 采集到的商品（按搜索位次）',
    '',
  ];
  if (rows.length) {
    sections.push(table(['位次', 'ASIN', '标题', '售价SAR', '评分', '评论数', '广告位', '链接'], rows.map((row) => [
      row.position, row.asin, String(row.title || '').slice(0, 60), row.priceSAR, row.rating, row.reviewCount, row.sponsored ? '是' : '否', row.url,
    ])));
  } else {
    sections.push('本轮没有采集到卡片。');
  }
  sections.push('', '## 需求观测（Amazon.sa 来源）', '');
  if (observations.length) {
    sections.push(table(['观测ID', '信号', '值', '单位', '观测日期', '来源链接'], observations.map((item) => [
      item.id, item.signalType, item.value, item.unit, item.observedAt, item.sourceUrl,
    ])));
  } else {
    sections.push('本轮没有可用观测。');
  }
  if (rejected.length) {
    sections.push('', '## 被拒观测（不合规，不计入）', '', table(['来源', 'ID', '原因'], rejected.map((item) => [item.origin, item.id, (item.errors || []).join('；')])));
  }
  if (diagnostics.length) {
    sections.push('', '## 采集诊断', '', table(['页面', '原因', '结果数', '榜单数'], diagnostics.map((item) => [item.pageUrl, item.reason, item.resultCount, item.rankCount])));
  }
  sections.push('', '## 下一步', '', '1. 把观测填进候选的 `demand.observations`，用 `observationIds` 引用。', '2. 到 Trendyol.sa 搜同款，取得 Trendyol 商品链接作为候选 `pool.url`。', '3. 需求四项至少 2 项通过，其中至少 1 项必须来自 Trendyol.sa。', '4. 用 `research_saudi_source` 做 1688 同款核价，再跑 `research_product_select(action=screen)`。', '');
  return sections.join('\n');
}

async function persist({ dataDir, outDir, title, payload, markdown, report }) {
  const config = await readConfig(dataDir);
  const root = resolveOutputRoot(config, outDir);
  const run = await createRun({ rootDir: root, registryDir: dataDir, kind: 'saudi-discovery', site: 'SA', title, label: title });
  const artifacts = await writeArtifacts(run, {
    'report.md': report,
    '找品待匹配池.md': markdown,
    '找品来源.json': {
      model: DISCOVERY_MODEL,
      salesPlatform: 'trendyol-sa',
      demandSources: ['trendyol-sa', 'amazon-sa'],
      generatedAt: new Date().toISOString(),
      demandPolicy: { ...DEMAND_POLICY },
      ...payload,
    },
  });
  const manifest = {
    runId: run.runId,
    kind: 'saudi-discovery',
    title,
    site: 'SA',
    marketplace: 'SA',
    platform: 'trendyol',
    provider: 'trendyol-web',
    salesPlatform: 'trendyol-sa',
    demandSources: ['trendyol-sa', 'amazon-sa'],
    model: DISCOVERY_MODEL,
    createdAt: new Date().toISOString(),
    artifacts,
  };
  artifacts.push(...await writeArtifacts(run, { 'manifest.json': manifest }));
  return { runId: run.runId, dir: run.dir, reportPath: join(run.dir, 'report.md'), waitingPoolPath: join(run.dir, '找品待匹配池.md'), sourcePath: join(run.dir, '找品来源.json'), artifacts };
}

/**
 * Saudi-only 找品工具：Amazon.sa 前台读取 → 需求观测 + 待匹配池。
 * 不产生候选、不做利润、不替代 Trendyol.sa 需求验证。
 */
export function createSaudiDiscoveryTool({ dataDir, collect = collectAmazonSa } = {}) {
  return {
    name: 'research_saudi_discovery',
    description: [
      '沙特找品来源（Amazon.sa 前台）读取工具，只服务 Trendyol.sa 卖家的「找品 + 需求交叉验证」。',
      'action=plan：免费返回 amazon.sa 榜单/搜索入口、采集字段、观测模板、待匹配池模板与需求证据政策。',
      'action=collect：按 keyword（搜索页）或 categoryUrl（榜单页）打开 Amazon.sa 读取卡片；调用前须说明最多 pages（1–3）个页面请求。遇验证码/登录/限流/拒绝访问立即停止，不重试、不换标签。',
      'action=prepare：校验并合并人工补录的观测，输出可直接粘进候选 demand.observations 的数组与待匹配池。',
      '纪律：只产观测，不产生候选、不算利润、不做合规结论。Amazon.sa 找到但 Trendyol.sa 无对应的品只进待匹配池；需求 4 项至少 2 项通过且至少 1 项必须来自 Trendyol.sa。',
      '浏览器驱动默认 auto：Chrome 开了 --remote-debugging-port 走 CDP，macOS 否则回落 AppleScript；Windows/Linux 必须开 CDP。插件不会自行启动浏览器。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['plan', 'collect', 'prepare'], description: 'plan=免费路线图；collect=读 Amazon.sa 前台；prepare=校验合并观测' },
        platform: { type: 'string', enum: ['amazon-sa'], description: '仅 Amazon.sa；这是找品来源，不是销售平台' },
        marketplace: { type: 'string', enum: ['SA'], description: '仅沙特阿拉伯' },
        mode: { type: 'string', enum: ['search', 'bestsellers'], description: 'collect：search 用 keyword 拼搜索页；bestsellers 用 categoryUrl 读榜单页' },
        keyword: { type: 'string', description: 'collect(search) 必填：Amazon.sa 搜索词，英文或阿语' },
        categoryUrl: { type: 'string', description: 'collect(bestsellers) 必填：www.amazon.sa 榜单或类目页链接' },
        pages: { type: 'integer', minimum: 1, maximum: 3, description: 'collect：最多翻几页，默认 1；每页占一次页面请求' },
        limit: { type: 'integer', minimum: 1, maximum: 60, description: 'collect：最多保留多少条卡片，默认 30' },
        observations: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'prepare：Amazon.sa/Trendyol.sa 观测数组，按 sa-discovery 模板填写' },
        title: { type: 'string', description: '产物标题，默认「沙特找品」' },
        outDir: { type: 'string', description: '产物根目录；不传用插件配置的 outputRoot' },
      },
    },
    output,
    isConcurrencySafe: () => false,
    async execute(args = {}) {
      if (args.platform !== undefined && args.platform !== 'amazon-sa') return fail('MARKET_ROUTE_INVALID', '本工具只用于 Amazon.sa 找品；销售平台仍是 Trendyol.sa。');
      if (args.marketplace !== undefined && args.marketplace !== 'SA') return fail('MARKET_ROUTE_INVALID', '本工具只用于沙特阿拉伯（SA）。');
      const allowed = ALLOWED[args.action];
      if (!allowed) return fail('DISCOVERY_INPUT_INVALID', 'action 只能是 plan / collect / prepare');
      const extra = Object.keys(args).filter((key) => !['action', 'platform', 'marketplace', 'title', 'outDir', ...allowed].includes(key));
      if (extra.length) return fail('DISCOVERY_INPUT_INVALID', '当前动作不接受这些参数：' + extra.join(', '));
      const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : '沙特找品';
      try {
        if (args.action === 'plan') return { ok: true, ...buildDiscoveryPlan({ keyword: args.keyword, categoryUrl: args.categoryUrl }) };
        if (args.action === 'collect') {
          const mode = args.mode === 'bestsellers' ? 'bestsellers' : 'search';
          const collected = await collect({
            mode,
            keyword: args.keyword,
            categoryUrl: args.categoryUrl,
            pages: Number.isInteger(args.pages) ? args.pages : 1,
            limit: Number.isInteger(args.limit) ? args.limit : 30,
          });
          const keyword = mode === 'search' ? String(args.keyword || '').trim() : '';
          const observations = rowsToObservations(collected.rows, { fetchedAt: collected.fetchedAt, keyword });
          const merged = mergeObservations({ collected: observations });
          const markdown = waitingPoolMarkdown({ observations: merged.observations, keyword, generatedAt: collected.fetchedAt });
          const report = discoveryReportMarkdown({
            title,
            generatedAt: collected.fetchedAt,
            keyword,
            rows: collected.rows,
            observations: merged.observations,
            rejected: merged.rejected,
            diagnostics: collected.diagnostics,
          });
          const saved = await persist({
            dataDir,
            outDir: args.outDir,
            title,
            markdown,
            report,
            payload: { keyword, sourceUrls: collected.sourceUrls, rows: collected.rows, observations: merged.observations, rejected: merged.rejected, pagesFetched: collected.pagesFetched },
          });
          return {
            ok: true,
            model: DISCOVERY_MODEL,
            salesPlatform: 'trendyol-sa',
            demandSources: ['trendyol-sa', 'amazon-sa'],
            pagesFetched: collected.pagesFetched,
            sourceUrls: collected.sourceUrls,
            rows: collected.rows,
            observations: merged.observations,
            rejected: merged.rejected,
            diagnostics: collected.diagnostics,
            ...saved,
            warnings: [
              'Amazon.sa 观测只支撑需求门槛，不能替代 Trendyol.sa 的需求验证；需求至少 1 项须来自 Trendyol.sa。',
              '待匹配池商品不进候选池；需要先在 Trendyol.sa 找到对应商品并核验。',
              collected.diagnostics.length ? '有页面未取到结构化卡片，已记录 diagnostics，不得用记忆补数。' : '',
            ].filter(Boolean),
            nextAction: '把 observations 中 Amazon.sa 观测与 Trendyol.sa 观测一起填进 research_product_select(action=plan) 的候选 demand.observations，再去 Trendyol.sa 取同款链接作为 pool.url。',
          };
        }
        const list = Array.isArray(args.observations) ? args.observations : [];
        if (!list.length) return fail('DISCOVERY_INPUT_INVALID', 'prepare 需要非空 observations 数组');
        const merged = mergeObservations({ manual: list });
        const markdown = waitingPoolMarkdown({ observations: merged.observations });
        const report = discoveryReportMarkdown({
          title,
          generatedAt: new Date().toISOString(),
          keyword: '',
          rows: [],
          observations: merged.observations,
          rejected: merged.rejected,
        });
        const saved = await persist({ dataDir, outDir: args.outDir, title, markdown, report, payload: { observations: merged.observations, rejected: merged.rejected } });
        return {
          ok: merged.ok,
          model: DISCOVERY_MODEL,
          salesPlatform: 'trendyol-sa',
          demandSources: ['trendyol-sa', 'amazon-sa'],
          observations: merged.observations,
          rejected: merged.rejected,
          ...saved,
          nextAction: '把 observations 填进候选 demand.observations；每个需求信号用 observationIds 引用观测，引擎会自行判定是否通过。',
        };
      } catch (error) {
        return fail(String(error?.code || 'DISCOVERY_FAILED'), String(error?.message ?? error));
      }
    },
  };
}
