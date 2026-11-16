/** Offline only: no provider calls. Keep the acquisition time and create a separate run. */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildTrendyolMarket, persistTrendyolMarket } from '../host/category-trendyol.js';
const [input, output, registry] = process.argv.slice(2);
if (!input || !output) throw Error('Usage: node scripts/regenerate-trendyol.mjs <market.json> <outputRoot> [registryDir]');
const source = resolve(input);
const saved = JSON.parse(await readFile(source, 'utf8'));
if (saved.platform !== 'trendyol' || !saved.marketplace || !Array.isArray(saved.products) || !saved.products.length) throw Error('Requires a nonempty Trendyol country snapshot');
let original = {};
try { original = JSON.parse(await readFile(join(dirname(source), 'manifest.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const market = buildTrendyolMarket({
  keyword: saved.keyword || original.params?.keyword || saved.label,
  marketplace:saved.marketplace, currency:saved.currency, reviewMetric:saved.reviewMetric,
  rows: saved.products, details: saved.detailSamples || [],
  pagesFetched: saved.sample?.pages ?? original.sample?.pages ?? 0,
  fetchedAt: saved.fetchedAt || original.fetchedAt || null,
  sourceUrls: saved.sourceUrls || [],
  warnings: [
    '本报告从已保存的真实样本离线重建，未追加在线取数。原始采集时间保留；生成时间单独记录。',
    '历史快照中的商品字段保留原值，未重新访问页面验证；详情价格不参与搜索样本价格统计。',
    ...(!saved.sourceUrls?.length ? ['原始搜索页 URL 日志未保存，不补造；来源链接使用快照内实际记录的商品 URL。'] : []),
    ...(saved.label !== saved.keyword ? ['原始报告标签可能取自单个商品类目；本报告改用保存的搜索关键词，不把单个品牌当作整个市场。'] : []),
  ],
});
market.provenance = { mode:'offline_regeneration', source, originalRunId:original.runId || null, revalidatedOnline:false };
const result = await persistTrendyolMarket({
  market, outputRoot:resolve(output), dataDir:registry ? resolve(registry) : null,
  params:{ ...original.params, offline:true },
  usage:{ calls:0, byTool:{}, errors:[], mode:'offline_regeneration', originalUsage:original.usage || null },
  regeneratedFrom:source,
});
console.log(JSON.stringify({runId:result.runId,dir:result.dir,score:result.score,market:result.market,fetchedAt:result.fetchedAt},null,2));
