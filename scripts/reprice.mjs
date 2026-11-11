/**
 * 用 1688 采价结果重算某个类目的利润维度（示例脚本）。
 *
 * 用法：
 *   DSR_CACHE_MARKET=<上一轮 market.json> \
 *   DSR_PROFIT_INPUT=<成本计划 json> \
 *   DSR_OUTPUT_ROOT=<输出目录> \
 *   node scripts/reprice.mjs
 *
 * 说明：这是开发期示例，用于「不重复打卖家精灵、只重算利润维度」。
 * 正常使用请直接调 research_category_select（它的 costs 参数就是同一套逻辑）。
 */
import { readFile } from 'node:fs/promises';
import { selectCategoryWeb } from '../host/category-web.js';

const CACHE = process.env.DSR_CACHE_MARKET;
const PROFILE = process.env.DSR_PROFIT_INPUT;
const OUTPUT_ROOT = process.env.DSR_OUTPUT_ROOT;

if (!CACHE || !PROFILE || !OUTPUT_ROOT) {
  console.error('缺少环境变量：DSR_CACHE_MARKET / DSR_PROFIT_INPUT / DSR_OUTPUT_ROOT');
  process.exit(1);
}

const cached = JSON.parse(await readFile(CACHE, 'utf8'));
console.log('缓存父体样本：' + (cached.products || []).length + ' 个');

const plan = JSON.parse(await readFile(PROFILE, 'utf8'));
const costs = plan.map((p) => ({
  name: p.name,
  keyword: p.keyword,
  priceCNY: p.perUnitCNY,
  weightG: p.unitWeightTotalG,
  moq: p.moq,
  offerUrl: p.offerUrl,
  offerId: p.offerId,
  verified: p.verified,
  material: p.material,
  title: p.offerTitle,
  packSize: p.packBasis,
  alignNote: p.alignNote,
  avgPriceUSD: p.amazonPriceMedian,
  amazonPackMedian: p.amazonPackMedian,
  amazonPackQuantiles: p.amazonPackQuantiles,
  amazonQuery: p.amazonQuery,
  targetPack: p.targetPack,
  packsBought: p.packsBought,
  packUnitQty: p.packUnitQty,
  packUnitPriceCNY: p.packUnitPriceCNY,
  weightBasis: p.weightBasis,
}));

const result = await selectCategoryWeb({
  marketplace: process.env.DSR_MARKETPLACE || 'US',
  category: process.env.DSR_CATEGORY || 'Hardware',
  limit: Number(process.env.DSR_LIMIT || 50),
  costs,
  cachedProducts: cached.products,
  cachedDistributions: cached.distributions,
  outputRoot: OUTPUT_ROOT,
});
console.log('RUN ' + result.runId);
console.log('score ' + result.score.total + '/' + result.score.max + ' → ' + result.score.normalized + ' ' + result.score.grade);
console.log('dims ' + result.score.dimensions.map((d) => d.label + ' ' + d.score + '/' + d.max).join(' | '));
console.log('DIR ' + result.dir);
