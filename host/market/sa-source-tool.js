import { collectSaudiOffers, prepareSaudiCandidate, buildSaudiSourcingPlan } from '../sourcing/saudi.js';
import { evaluateTrendyolCandidates } from './trendyol-workflow.js';

/** Saudi sourcing does not read a saved Amazon default and never invokes the FBA tool. */
export function createSaudiSourceTool(deps = {}) {
  return {
    name: 'research_saudi_source',
    description: 'Trendyol.sa沙特候选的1688寻源与成本回填。plan返回完整模板；collect搜索并读取详情（调用前说明最多1个搜索页+detailLimit个详情页，会占网页查询次数，加载另有请求）；prepare核对所选SKU/数量报价/同款及计费重证据并返回候选与按前置关卡执行的沙特评估。未知暂停；不下单、不套Amazon FBA、不自动通过身份合规。验证码/登录/限流立即停止。',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['plan', 'collect', 'prepare'] },
      platform: { type: 'string', enum: ['trendyol'], description: '仅Trendyol.sa；省略也不会沿用Amazon默认。' },
      marketplace: { type: 'string', enum: ['SA'] },
      keyword: { type: 'string', description: 'collect必填，1688中文同款搜索关键词。' },
      limit: { type: 'integer', minimum: 1, maximum: 20, description: 'collect最多保留货源数，默认5。' },
      detailLimit: { type: 'integer', minimum: 0, maximum: 10, description: 'collect详情页上限，默认3，最多不超过limit。' },
      candidate: { type: 'object', additionalProperties: true, description: 'prepare：research_product_select沙特plan模板的候选，保留需求/身份/合规等真实证据。' },
      offer: { type: 'object', additionalProperties: true, description: 'prepare：collect返回的一条offer，保留detail及原始来源日期；供应商报价须附原始证据。' },
      selection: { type: 'object', additionalProperties: true, description: 'prepare：先plan获取selectionTemplate与selectionSchema，填写SKU/规格/采购数量、报价、计费重、BB/LD证据及每销售单位额外费用。' },
    } },
    output: { schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' } }, required: ['ok'] }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    isConcurrencySafe: () => false,
    async execute(args = {}) {
      const fail = (code, message) => ({ ok: false, error: { code, message } });
      if ((args.platform !== undefined && args.platform !== 'trendyol') || (args.marketplace !== undefined && args.marketplace !== 'SA')) return fail('MARKET_ROUTE_INVALID', '本工具只用于Trendyol.sa；美国仍用research_unit_cost。');
      const allowed = { plan: [], collect: ['keyword', 'limit', 'detailLimit'], prepare: ['candidate', 'offer', 'selection'] };
      if (!allowed[args.action] || Object.keys(args).some(k => !['action', 'platform', 'marketplace', ...allowed[args.action]].includes(k))) return fail('SOURCING_INPUT_INVALID', '请先plan，再按collect或prepare各自参数调用，不混用参数。');
      try {
        if (args.action === 'plan') return { ok: true, ...buildSaudiSourcingPlan() };
        if (args.action === 'collect') return await collectSaudiOffers(args, deps);
        if (!args.candidate || !args.offer || !args.selection || [args.candidate, args.offer, args.selection].some(x => typeof x !== 'object' || Array.isArray(x))) return fail('SOURCING_INPUT_INVALID', 'prepare需要candidate、offer、selection对象。');
        const result = prepareSaudiCandidate(args);
        const evaluation = evaluateTrendyolCandidates({ candidates: [result.candidate] });
        return { ...result, evaluation, nextAction: '补齐missing及评估stoppedAt证据后，再将返回candidate交research_product_select(platform=trendyol,marketplace=SA,action=screen,candidates=[candidate])生成报告。ready不是进货许可。' };
      } catch (error) { return fail(String(error.code || 'SOURCING_FAILED'), String(error.message || error)); }
    },
  };
}
