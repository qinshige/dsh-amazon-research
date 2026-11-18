import { readConfig, resolveOutputRoot } from '../paths.js';
import { getPlatform, resolveSite, providerSupportsPlatform } from '../platforms/index.js';
import { buildTrendyolPlan } from './trendyol-workflow.js';
import { createSaudiSourceTool } from './sa-source-tool.js';

const failure = (message) => ({ ok: false, error: { code: 'MARKET_ROUTE_INVALID', message } });
const output = { schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' } }, required: ['ok'] }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
const marketFields = {
  platform: { type: 'string', enum: ['amazon', 'trendyol'], description: 'Amazon 保留非沙特原站点；沙特只使用 Trendyol.sa。显式平台/站点优先于默认配置。' },
  marketplace: { type: 'string', enum: [...getPlatform('amazon').sites.map(s => s.value), 'SA'], description: 'US等非沙特站点走Amazon原流程；SA仅Trendyol严格流程。' },
};
const saCategoryKeys = ['platform', 'provider', 'marketplace', 'category', 'pages', 'limit', 'detailTopN', 'outDir'];
const saSelectionKeys = ['platform', 'marketplace', 'action', 'category', 'candidates', 'title', 'source', 'outDir'];

/** Explicit platform/site outrank configuration. Never interpret Amazon SA as Amazon US. */
function route(args, config) {
  for (const key of ['platform', 'marketplace']) {
    if (Object.hasOwn(args, key) && (typeof args[key] !== 'string' || !args[key].trim())) return { error: key + ' 必须为非空字符串' };
  }
  const explicitSite = args.marketplace?.trim().toUpperCase();
  const platformId = args.platform?.trim().toLowerCase() || (explicitSite ? (explicitSite === 'SA' ? 'trendyol' : 'amazon') : config.platform || 'amazon');
  const platform = getPlatform(platformId);
  if (!platform) return { error: '仅支持 Amazon 原非沙特站点与 Trendyol.sa' };
  const site = explicitSite || (platformId === config.platform ? config.marketplace : platform.defaultSite);
  if (!resolveSite(platformId, site)) return { error: '平台与站点不匹配：沙特仅支持 Trendyol.sa；Amazon不支持SA，Trendyol不支持非SA站点' };
  return { platform: platformId, marketplace: site };
}

function parameters(tool, extra = {}) {
  const original = structuredClone(tool.parameters);
  return { ...original, properties: { ...original.properties, ...structuredClone(marketFields), ...extra } };
}

/** Catch explicit nested Saudi routing markers before forwarding opaque MCP arguments. */
function nestedSaudi(value, key = '') {
  if (Array.isArray(value)) return value.some(item => nestedSaudi(item, key));
  if (value && typeof value === 'object') return Object.entries(value).some(([k, item]) => nestedSaudi(item, k));
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (/(?:amazon|trendyol)\.sa(?:[/:?#]|$)/i.test(text) || text === 'A17E79C6D8DWNP') return true;
  return /(?:market|country|site|region|currency|platform|domain)/i.test(key) && /^(?:SA|SAR|KSA|SAU|Saudi(?: Arabia)?|沙特(?:阿拉伯)?|trendyol(?:-sa)?)$/i.test(text);
}

/** Amazon retains its original tools; Saudi research is exclusively Trendyol.sa. */
export function saOnlyTools(legacy, { dataDir }) {
  const byName = Object.fromEntries(legacy.map(tool => [tool.name, tool]));
  const oldCategory = byName.research_category_select;
  const category = { ...oldCategory,
    description: 'Amazon非沙特站点保留原品类研究与全部参数。Trendyol仅SA/SAR：关键词采集只建立需求池，调用前说明最多pages个搜索页与detailTopN个详情页；遇验证停止，旧92分不能替代严格工作流100分。',
    parameters: parameters(oldCategory, { category: { ...oldCategory.parameters.properties.category, description: 'Amazon类目关键词；Trendyol.sa使用英文或阿语搜索词' } }),
    async execute(args = {}, exec) {
      const config = await readConfig(dataDir);
      const selected = route(args, config);
      if (selected.error) return failure(selected.error);
      if (selected.platform === 'trendyol' && Object.keys(args).some(key => !saCategoryKeys.includes(key))) return failure('Trendyol.sa 不接受 Amazon 节点、成本或月份参数');
      const provider = args.provider ?? (providerSupportsPlatform(config.provider, selected.platform) ? config.provider : getPlatform(selected.platform).providers[0]);
      if (!providerSupportsPlatform(provider, selected.platform) || provider === 'sorftime') return failure('数据源与品类研究平台不匹配');
      return oldCategory.execute({ ...args, ...selected, provider }, exec);
    },
  };
  const oldSelection = byName.research_product_select;
  const selection = { ...oldSelection,
    description: oldSelection.description + '\n市场分流：Amazon非SA保留plan/collect/screen和原成本、画像、渠道参数。Trendyol仅SA，先plan取得完整嵌套模板，再screen candidates；需求→BB/LD→身份合规→物流→research_saudi_source的1688核价回填→利润退货质量→100分→样品测试扩货。缺寻源证据暂停（旧候选重跑也需补齐），LD单列不排名。',
    parameters: parameters(oldSelection, {
      candidates: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '仅Trendyol.sa screen：先plan按inputTemplate填写，不接受旧ASIN行替代' },
    }),
    output, isConcurrencySafe: () => false,
    async execute(args = {}, exec) {
      const config = await readConfig(dataDir);
      const selected = route(args, config);
      if (selected.error) return failure(selected.error);
      if (selected.platform === 'amazon') {
        if (Object.hasOwn(args, 'candidates')) return failure('Amazon使用原rows/csv输入，candidates仅用于Trendyol.sa');
        const { platform: _platform, ...forward } = { ...args, ...selected };
        return oldSelection.execute(forward, exec);
      }
      if (Object.keys(args).some(key => !saSelectionKeys.includes(key))) return failure('Trendyol.sa只接受严格模板candidates，不接受Amazon采集表、成本或渠道参数');
      if (args.action === 'plan') return { ok: true, ...buildTrendyolPlan({ category: args.category || '' }) };
      if (args.action !== 'screen' || !Array.isArray(args.candidates) || !args.candidates.length) return failure('Trendyol.sa先plan；screen必须提供非空candidates，collect仅支持Amazon');
      try {
        const { runTrendyolWorkflow } = await import('./trendyol-report.js');
        return { ok: true, ...await runTrendyolWorkflow({ candidates: args.candidates, outputRoot: resolveOutputRoot(config, args.outDir), registryDir: dataDir, title: args.title, source: args.source }) };
      } catch (error) { return { ok: false, error: { code: 'WORKFLOW_FAILED', message: String(error.message || error) } }; }
    },
  };
  const oldCost = byName.research_unit_cost;
  const cost = { ...oldCost, parameters: parameters(oldCost),
    description: oldCost.description + '\n仅用于Amazon非沙特站点；当前默认Trendyol时需显式指定Amazon平台或非SA站点，禁止套用到沙特。',
    async execute(args = {}, exec) {
      const selected = route(args, await readConfig(dataDir));
      if (selected.error || selected.platform !== 'amazon') return failure(selected.error || '沙特不得使用Amazon FBA成本模型，请走Trendyol.sa严格工作流');
      const { platform: _platform, marketplace: _marketplace, ...forward } = args;
      return oldCost.execute(forward, exec);
    },
  };
  const oldMcp = byName.mcp_call;
  const mcp = { ...oldMcp, parameters: parameters(oldMcp),
    description: oldMcp.description + '\n仅用于Amazon非SA站点；显式platform/marketplace优先配置，任何嵌套沙特标记均拒绝。Trendyol.sa不能通过MCP绕过专用工作流。',
    async execute(args = {}, exec) {
      const selected = route(args, await readConfig(dataDir));
      if (selected.error || selected.platform !== 'amazon') return failure(selected.error || 'Trendyol.sa不使用Amazon MCP');
      if (!['sellersprite', 'sorftime'].includes(args.provider) || nestedSaudi(args.args)) return failure('MCP仅支持Amazon非SA数据源与站点，禁止嵌套沙特请求');
      const { platform: _platform, marketplace: _marketplace, ...forward } = args;
      return oldMcp.execute(forward, exec);
    },
  };
  const page = {
    ...byName.research_page,
    description: [
      '读取已登录的Amazon研究/卖家精灵、Trendyol.sa以及1688/Alibaba供应链页面。沙特需求只以Trendyol.sa为准；不绕过验证码、登录或付费墙。',
      '推荐顺序：snapshot 取文本快照与编号控件（ref 如 e12，跨快照稳定）→ click/type 传 ref；长页面用 delta=true 只看变化。navigate/back/forward/reload 做导航，screenshot 需 CDP 驱动，backend 查看当前驱动。',
      'Windows/Linux 只有 CDP 驱动：先用 --remote-debugging-port 启动 Chrome（插件不会自行启动浏览器）；macOS 未开调试端口时回落 AppleScript。',
    ].join('\n'),
  };
  return [byName.research_provider_status, category, selection, cost, mcp, byName.research_runs, page, createSaudiSourceTool()];
}
