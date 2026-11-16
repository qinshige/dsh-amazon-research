/** Trendyol P1: public search snapshot -> explicit review proxies -> offline artifacts. */
import { mkdir } from 'node:fs/promises';
import { scoreMarket } from './scoring.js';
import { renderCategoryReport, renderScoresJson, renderDashboardHtml, toCsv } from './report.js';
import { createRun, writeArtifacts } from './runs.js';
import { trendyolWebProvider } from './providers/trendyol-web.js';
import { getTrendyolSite, requireTrendyolCaptureSite } from './platforms/trendyol-sites.js';
import { summarizeTrendyolProducts, TRENDYOL_MODEL_NOTE } from './trendyol-analysis.js';

const numeric = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const slug = (v) => String(v || 'trendyol').trim().replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 40);
const invalid = (message) => Object.assign(new Error(message), { code: 'INVALID_ARGS' });
export function validateTrendyolOptions({ keyword, marketplace = 'TR', pages = 2, detailTopN = 5, limit = 100 }) {
  if (typeof keyword !== 'string' || !keyword.trim()) throw invalid('Trendyol 需要搜索关键词 category（土耳其语效果最好），不能使用 Amazon nodeIdPath');
  requireTrendyolCaptureSite(marketplace);
  for (const [key, value, min, max] of [['pages', pages, 1, 5], ['detailTopN', detailTopN, 0, 5], ['limit', limit, 10, 100]]) {
    if (!Number.isInteger(value) || value < min || value > max) throw invalid(key + ' 必须为 ' + min + '–' + max + ' 的整数');
  }
}

/** Contiguous half-open buckets; missing observations excluded from denominator. */
export function bucketProducts(products, key, edges) {
  const observed = products.filter((p) => numeric(p[key]) !== null);
  return edges.map(([min, max]) => {
    const rows = observed.filter((p) => p[key] >= min && p[key] < max);
    const reviews = rows.map((p) => numeric(p.reviews)).filter((n) => n !== null);
    return { label: max === Infinity ? min + '+' : '[' + min + ', ' + max + ')', min, max: max === Infinity ? null : max,
      products: rows.length, productShare: observed.length ? rows.length / observed.length : null,
      reviewMass: reviews.length ? reviews.reduce((a, b) => a + b, 0) : null };
  });
}

export function buildTrendyolMarket({ keyword, marketplace = 'TR', currency, reviewMetric, rows = [], details = [], pagesFetched = 0, fetchedAt, sourceUrls, warnings = [] }) {
  const site = requireTrendyolCaptureSite(marketplace);
  if (!site || (currency && currency !== site.currency)) throw invalid('快照国家或币种不匹配');
  const sa = site.value === 'SA';
  const metric = sa ? 'rating_count' : 'review_count';
  if (reviewMetric && reviewMetric !== metric) throw invalid('快照评价计数口径不匹配');
  for (const r of [...rows, ...details]) {
    if ((r.currency && r.currency !== site.currency) || (r.marketplace && r.marketplace !== site.value) || (r.reviewMetric && r.reviewMetric !== metric) || (site.value !== 'TR' && r.priceTRY != null)) throw invalid('样本混入了其他国家或币种');
  }
  const seen = new Set();
  const products = rows.filter((r) => r?.productId && !seen.has(String(r.productId)) && seen.add(String(r.productId))).map((r) => ({
    productId: String(r.productId), title: r.name ?? r.title ?? null, brand: r.brand || null,
    price: numeric(site.value === 'TR' ? (r.priceTRY ?? r.price) : r.price), rating: numeric(r.rating),
    reviews: numeric(sa ? (r.ratingCount ?? r.reviews) : (r.reviewCount ?? r.reviews)),
    ...(sa ? { ratingCount:numeric(r.ratingCount ?? r.reviews), commentCount:numeric(r.commentCount) } : {}),
    currency:site.currency, marketplace:site.value, reviewMetric:metric, priceBasis:r.priceBasis || null,
    monthlySales: null, monthlyRevenue: null, url: r.url || null,
    bestSellerRank: numeric(r.bestSellerRank), badges: r.badges || [], attributes: r.attributes || [],
  }));
  const s = summarizeTrendyolProducts(products);
  return {
    platform: 'trendyol', provider: 'trendyol-web', marketplace: site.value, siteLabel:site.label, currency:site.currency, reviewMetric:metric,
    label: keyword, keyword, nodeIdPath: '', nodeLabelPath: '', scope: 'keyword_search_sample',
    totals: { products: products.length, units: null, revenue: null, reviewMass: s.reviewMass },
    avgs: { price: s.priceMean, rating: s.ratingMean, ratings: s.reviewMean, units: null, revenue: null },
    medians: { price: s.priceMedian, reviews: s.reviewMedian },
    concentration: { basis: 'review_mass_known_brands', top3BrandReviewShare: s.top3BrandReviewShare,
      brandReviewHHI: s.brandHHI, knownBrandReviewCoverage: s.brandCoverage, top3SellerCrn: null },
    structure: { selfOperatedShare: null },
    distributions: {
      price: bucketProducts(products, 'price', site.value === 'SA' ? [[0,25],[25,50],[50,100],[100,200],[200,500],[500,Infinity]] : [[0,250],[250,500],[500,1000],[1000,2000],[2000,5000],[5000,Infinity]]),
      ratingsCount: bucketProducts(products, 'reviews', [[0,11],[11,51],[51,100],[100,301],[301,1001],[1001,Infinity]]),
      rating: bucketProducts(products, 'rating', [[0,1],[1,2],[2,3],[3,4],[4,5.01]]),
      brand: s.brands,
    },
    products, detailSamples: details,
    sample: { products: products.length, pages: pagesFetched, details: details.length, reviewsObserved: s.reviewsObserved, pricesObserved: s.pricesObserved },
    fetchedAt: fetchedAt || null,
    sourceUrls: Array.isArray(sourceUrls) ? [...sourceUrls] : [],
    warnings: [...warnings, ...(sa ? ['沙特口径：评价数（含仅评分，非文字评论数）；不与土耳其评论样本横比。', '价格为搜索卡片展示促销价，可能附带结算优惠条件，不代表所有买家最终到手价。'] : []), TRENDYOL_MODEL_NOTE, '关键词搜索样本：' + products.length + ' 个去重商品，非全类目；详情类目仅属于各自商品。',
      '月销量、月销额、卖家集中度、平台自营占比和利润未取到，不以评论或其它指标填充。'],
  };
}

/** Offline rendering entry: preserve acquisition timestamps and allocate a new run, never overwrite a snapshot. */
export async function persistTrendyolMarket({ market, outputRoot, dataDir = null, params = {}, usage = {}, regeneratedFrom = null }) {
  const site = getTrendyolSite(market?.marketplace);
  if (market?.platform !== 'trendyol' || !site || market.currency !== site.currency) throw invalid('快照国家或币种不匹配');
  await mkdir(outputRoot, { recursive: true });
  const score = scoreMarket(market);
  const scores = { ...renderScoresJson(score), model: score.model, experimental: true };
  const generatedAt = new Date().toISOString();
  const run = await createRun({ rootDir: outputRoot, kind: 'category', title: market.label, site: site.value, label: 'Trendyol_' + slug(market.keyword), registryDir: dataDir });
  const manifest = {
    runId: run.runId, kind: 'category', platform: 'trendyol', title: market.label, site: site.value, siteLabel:site.label, marketplace: site.value, currency: site.currency, reviewMetric:market.reviewMetric || 'review_count', provider: 'trendyol-web',
    params, usage, fetchedAt: market.fetchedAt, createdAt: generatedAt, regeneratedFrom,
    score: { total: score.total, max: score.max, normalized: score.normalized, grade: score.grade, model: score.model },
    warnings: market.warnings, sources: market.sourceUrls, sample: market.sample,
  };
  const known = (v) => v === null || v === undefined ? '未取到' : v;
  // Spreadsheet-safe scraped fields: do not turn merchant titles into formulas.
  const safeCsv = (v) => typeof v === 'string' && /^(\s*[=+\-@]|[\t\r\n])/.test(v) ? "'" + v : known(v);
  const products = market.products.map((p, i) => ({ searchIndex: i + 1, productId: safeCsv(p.productId), title: safeCsv(p.title), brand: safeCsv(p.brand), price:known(p.price), currency:site.currency, marketplace:site.value, reviewMetric:market.reviewMetric || 'review_count', ...(site.value === 'TR' ? {priceTRY:known(p.price)} : {}),
    rating: known(p.rating), reviews: known(p.reviews), bestSellerRank: known(p.bestSellerRank), monthlySales: '未取到', monthlyRevenue: '未取到', url: safeCsv(p.url) }));
  const brands = market.distributions.brand.map((b) => ({ brand: safeCsv(b.brand), products: b.products, reviewMass: known(b.reviewMass), reviewShare: known(b.reviewShare) }));
  const artifacts = await writeArtifacts(run, {
    'manifest.json': manifest, 'market.json': market, 'scores.json': scores,
    'report.md': renderCategoryReport({ market, score, generatedAt }),
    'dashboard.html': renderDashboardHtml({ market, score, generatedAt }),
    'tables/top_products.csv': toCsv(products, ['searchIndex','productId','title','brand','price','currency','marketplace','reviewMetric',...(site.value === 'TR' ? ['priceTRY'] : []),'rating','reviews','bestSellerRank','monthlySales','monthlyRevenue','url']),
    'tables/brand_concentration.csv': toCsv(brands, ['brand','products','reviewMass','reviewShare']),
  });
  return { ok: true, stage: 'completed', runId: run.runId, dir: run.dir, platform: 'trendyol', provider: 'trendyol-web', site: site.value, currency:site.currency, reviewMetric:market.reviewMetric || 'review_count',
    label: market.label, keyword: market.keyword, score: scores,
    market: { ...market.sample, currency:site.currency, reviewMetric:market.reviewMetric || 'review_count', priceMedian:market.medians.price, ...(site.value === 'TR' ? {priceMedianTRY:market.medians.price} : {}), reviewMedian: market.medians.reviews, reviewMass: market.totals.reviewMass,
      top3BrandReviewShare: market.concentration.top3BrandReviewShare },
    warnings: market.warnings, usage, artifacts, fetchedAt: market.fetchedAt, reportPath: run.dir + '/report.md' };
}

export async function selectCategoryTrendyol({ keyword, pages = 2, detailTopN = 5, limit = 100, marketplace = 'TR', outputRoot, dataDir = null,
  log = () => {}, provider = trendyolWebProvider, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  validateTrendyolOptions({ keyword, pages, detailTopN, limit, marketplace });
  const start = Date.now();
  const search = await provider.searchProducts({ keyword: keyword.trim(), marketplace, pages, limit, log });
  const seen = new Set();
  const rows = (search.rows || []).filter((r) => r?.productId && !seen.has(String(r.productId)) && seen.add(String(r.productId))).slice(0, limit);
  if (!rows.length) throw Object.assign(new Error('搜索没有可用商品；关键词无结果或页面结构变化，不能生成空样本报告'), { code: 'EMPTY_RESULT' });
  const details = [], warnings = [], errors = [];
  let detailRequests = 0;
  for (const target of rows.filter((p) => p.url).slice(0, detailTopN)) {
    try {
      detailRequests++;
      const detail = await provider.productDetail({ url: target.url, marketplace, log });
      details.push({ ...detail, productId: detail.productId || target.productId });
    } catch (error) {
      // Safety errors stop the whole run; no misleading complete report after a challenge.
      if (/CAPTCHA|RATE_LIMIT|ACCESS_DENIED|COUNTRY|SESSION|EMPTY_PAGE/.test(error?.code || '')) throw error;
      errors.push({ productId: target.productId, code: error?.code || 'DETAIL_FAILED', message: String(error?.message || error) });
      warnings.push('商品 ' + target.productId + ' 详情未取到：' + String(error?.message || error));
    }
    if (detailRequests < Math.min(detailTopN, rows.length)) await delay(2500);
  }
  const market = buildTrendyolMarket({ keyword: keyword.trim(), marketplace, currency:search.currency, rows, details, pagesFetched: search.pagesFetched,
    fetchedAt: search.fetchedAt, sourceUrls: search.sourceUrls, warnings });
  const usage = { searchPages: search.pagesFetched, detailRequests, calls: search.pagesFetched + detailRequests, errors, totalMs: Date.now() - start,
    basis: 'search_and_detail_page_visits', note: '不含可选的首页/国家选择页；不是 MCP 额度' };
  return persistTrendyolMarket({ market, outputRoot, dataDir, params: { keyword: keyword.trim(), marketplace, pages, detailTopN, limit }, usage });
}
