/** Trendyol P1: explicit review/count proxies, never synthetic sales. Pure and offline. */
import { getTrendyolSite } from './platforms/trendyol-sites.js';
const metricText = (text, market) => market.reviewMetric === 'rating_count' ? text.replaceAll('评论', '评价') : text;
const number = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
const valid = (v) => number(v) !== null && v >= 0;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => xs.length ? sum(xs) / xs.length : null;
const median = (xs) => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
};
export const TRENDYOL_MODEL = 'trendyol-review-proxy-v1';
export const TRENDYOL_MODEL_NOTE = 'P1 实验性初筛模型：评论量、商品数为代理指标；阈值未经 Trendyol 销量校准，不可与 Amazon 分数横向比较，也不构成进入建议。';

export function summarizeTrendyolProducts(products = []) {
  const rows = products.filter((p) => p && typeof p === 'object');
  const reviews = rows.map((p) => p.reviews).filter(valid);
  const prices = rows.map((p) => p.price).filter((v) => valid(v) && v > 0);
  const ratings = rows.map((p) => p.rating).filter((v) => valid(v) && v <= 5);
  const reviewMass = reviews.length ? sum(reviews) : null;
  const lowCount = reviews.filter((v) => v < 100).length;
  const brandMap = new Map();
  for (const p of rows) {
    const brand = String(p.brand || '').trim();
    // Do not combine unknown brands into a fictitious giant brand.
    if (!brand) continue;
    const b = brandMap.get(brand) || { brand, products: 0, reviewMass: 0, reviewsObserved: 0 };
    b.products++;
    if (valid(p.reviews)) { b.reviewMass += p.reviews; b.reviewsObserved++; }
    brandMap.set(brand, b);
  }
  const knownBrandMass = sum([...brandMap.values()].map((b) => b.reviewMass));
  const brands = [...brandMap.values()].map((b) => ({ ...b,
    reviewMass: b.reviewsObserved ? b.reviewMass : null,
    reviewShare: knownBrandMass > 0 && b.reviewsObserved ? b.reviewMass / knownBrandMass : null,
  })).sort((a, b) => (b.reviewMass || 0) - (a.reviewMass || 0));
  const top3BrandReviewShare = knownBrandMass > 0 ? sum(brands.slice(0, 3).map((b) => b.reviewMass || 0)) / knownBrandMass : null;
  const brandHHI = knownBrandMass > 0 ? sum(brands.map((b) => (b.reviewShare || 0) ** 2)) * 10000 : null;
  return {
    products: rows.length, reviewMass, reviewsObserved: reviews.length,
    lowReviewCount: lowCount, lowReviewShare: reviews.length ? lowCount / reviews.length : null,
    priceMean: mean(prices), priceMedian: median(prices), pricesObserved: prices.length,
    ratingMean: mean(ratings), reviewMean: mean(reviews), reviewMedian: median(reviews),
    brands, brandHHI, top3BrandReviewShare, knownBrandMass,
    brandCoverage: reviewMass > 0 ? knownBrandMass / reviewMass : null,
  };
}

const fmt = (n, digits = 0) => number(n) === null ? '未取到' : n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (n) => number(n) === null ? '未取到' : fmt(n * 100, 2) + '%';
const formatMoney = (n, currency) => number(n) === null ? '未取到' : (currency === 'TRY' ? 'TL' : currency + ' ') + fmt(n, 2);
const gradeOf = (n) => n >= 80 ? '优秀' : n >= 60 ? '良好' : n >= 40 ? '一般' : '较差';
const dimension = (key, label, score, max, detail, inputs) => ({ key, label, score, max, normalized: Math.round(score / max * 1000) / 10, detail, inputs });

export function scoreTrendyolMarket(market = {}) {
  const s = summarizeTrendyolProducts(market.products);
  // Explicit aggregate accepted for existing snapshots; zero is observed, null is not zero.
  const mass = valid(market.totals?.reviewMass) ? market.totals.reviewMass : s.reviewMass;
  const size = mass === null ? 8 : mass > 500000 ? 20 : mass > 150000 ? 17 : mass > 50000 ? 14 : mass > 10000 ? 11 : 8;
  const low = s.lowReviewShare;
  const growth = low === null ? 14 : low > 0.4 ? 22 : low > 0.2 ? 18 : 14;
  const brand = s.top3BrandReviewShare;
  const competition = brand === null ? 8 : brand < 0.3 ? 18 : brand < 0.5 ? 14 : 8;
  const opportunity = low === null ? 3 : low > 0.4 ? 10 : low > 0.2 ? 6 : 3;
  const dimensions = [
    dimension('market_size', '市场规模', size, 20,
      mass === null ? '样本评论量未取到，缺数兜底 8/20 分' : '样本累计评论 ' + fmt(mass) + ' 条（市场活跃度代理，非销额）；实验档位 → ' + size + '/20 分',
      { basis: 'review_mass', reviewMass: mass, missing: mass === null, experimental: true }),
    dimension('growth_potential', '增长潜力', growth, 22,
      '低评论（评论数 < 100）商品数占比 ' + pct(low) + '（' + s.lowReviewCount + '/' + s.reviewsObserved + ' 个有评论字段样本；非销量、非实际上新率）' + (low === null ? '；缺数兜底' : ''),
      { basis: 'product_count', lowReviewShare: low, lowReviewThreshold: 100, missing: low === null }),
    dimension('competition', '竞争烈度', competition, 18,
      'Top3 品牌评论量占比 ' + pct(brand) + '（已知品牌内，非销量；品牌评论覆盖率 ' + pct(s.brandCoverage) + '）' + (brand === null ? '；缺数兜底 8/18 分' : ''),
      { basis: 'review_mass', top3BrandReviewShare: brand, coverage: s.brandCoverage, missing: brand === null }),
    dimension('entry_barrier', '进入壁垒', 3 + opportunity, 20,
      '平台自营占比未取到，自营子项缺数兜底 3/10 分；低评论商品数占比 ' + pct(low) + ' → ' + opportunity + '/10 分（不能据此认定为新品机会）',
      { basis: 'partial_product_count', selfOperatedShare: null, lowReviewShare: low, missing: true }),
    dimension('profit_margin', '利润空间', 0, 12,
      'P1 未接入采购、佣金、物流、税费等成本，利润未取到；缺数记 0/12 分，不表示真实利润为零。不套用美元价格档位。',
      { basis: 'not_available', missing: true, reason: 'no_cost_basis_for_platform' }),
  ];
  for (const d of dimensions) { d.detail = metricText(d.detail, market); d.inputs.reviewMetric = market.reviewMetric || 'review_count'; }
  const total = sum(dimensions.map((d) => d.score));
  const normalized = Math.round(total / 92 * 1000) / 10;
  const missingDimensions = dimensions.filter((d) => d.inputs.missing).length;
  const dataQuality = missingDimensions >= 3 ? 'D' : missingDimensions === 2 ? 'C' : missingDimensions === 1 ? 'B' : 'A';
  return { dimensions, total, max: 92, normalized, grade: gradeOf(normalized), model: TRENDYOL_MODEL, experimental: true, dataQuality, missingDimensions,
    notes: [TRENDYOL_MODEL_NOTE,
      '市场规模：样本累计评论是市场活跃度代理，历史累积、搜索排序、广告及样本数都会影响它，不是销量或销额。',
      '评论总量分档（严格大于阈值）：500,000→20；150,000→17；50,000→14；10,000→11；其余→8（满分20）。',
      '增长商品数占比分档：>40%→22，>20%→18，其余→14；品牌评论 CR3：<30%→18，<50%→14，其余→8。',
      '缺失字段保持未取到；平台自营子项按最低3分、利润按0分占位；总分分母仍为92，不按可得维度重新放大。'].map(n => metricText(n, market)),
    reviewMetric:market.reviewMetric || 'review_count',
  };
}

// Escape scraped text for Markdown and HTML; never interpret page text as markup.
const md = (v) => String(v ?? '未取到').replace(/[\\\x60*_{}\[\]()<>#|!]/g, (c) => '&#' + c.charCodeAt(0) + ';').replace(/[\r\n]+/g, ' ');
const html = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const table = (headers, rows) => ['| ' + headers.map(md).join(' | ') + ' |', '| ' + headers.map(() => '---').join(' | ') + ' |', ...rows.map((row) => '| ' + row.map(md).join(' | ') + ' |')].join('\n');
const safeLink = (value, site) => {
  try { const u = new URL(value); return u.origin === site.origin && !u.username && !u.password ? u.href : ''; } catch { return ''; }
};

export function renderTrendyolReport({ market = {}, score = scoreTrendyolMarket(market), generatedAt = '', warnings = [] } = {}) {
  const site = getTrendyolSite(market.marketplace || 'TR');
  if (!site || (market.currency && market.currency !== site.currency)) throw new Error('Trendyol report country/currency mismatch');
  const s = summarizeTrendyolProducts(market.products);
  const noun = market.reviewMetric === 'rating_count' ? '评价' : '评论';
  const money = n => formatMoney(n, site.currency);
  const lines = [
    '# ' + md(market.label || market.keyword || 'Trendyol') + '（Trendyol · ' + site.value + '）品类选品分析报告', '',
    '> 数据来源：trendyol-web（Trendyol ' + site.label + '搜索页 / 商品页）｜ 平台：Trendyol ｜ 币种：' + site.currency + '（' + site.currencySymbol + '）',
    '> 原始抓取时间：' + md(market.fetchedAt || '未取到') + ' ｜ 报告生成：' + md(generatedAt || '未取到'), '',
    '## 一、结论与数据边界', '',
    '**实验性初筛评级：' + md(score.grade) + '** ｜ 原始总分 **' + score.total + ' / 92** ｜ 归一化 **' + score.normalized + ' / 100**。', '',
    '> 数据质量 ' + score.dataQuality + '（' + score.missingDimensions + ' 个维度存在缺数）：补数后再评，不能据占位评级决策进货。', '',
    '> ' + metricText(TRENDYOL_MODEL_NOTE, market), '',
    '- 计数口径：' + (market.reviewMetric === 'rating_count' ? '评价数（含仅评分，非文字评论数）。不与土耳其评论样本横比。' : '评论数代理，非销量。'),
    '- 搜索关键词：' + md(market.keyword || market.label) + '；样本 ' + s.products + ' 个去重商品，不是全类目 Top 销量榜。',
    '- 样本累计' + noun + '：' + fmt(s.reviewMass) + ' 次；' + noun + '字段覆盖：' + s.reviewsObserved + '/' + s.products + '。月销量、月销额：**未取到**（网页未提供）。',
    '- 价格中位数：' + money(s.priceMedian) + '；价格均值：' + money(s.priceMean) + '；价格字段覆盖：' + s.pricesObserved + '/' + s.products + '。',
    '- 星级均值：' + fmt(s.ratingMean, 2) + '；' + noun + '数中位数：' + fmt(s.reviewMedian, 1) + '；低' + noun + '商品数占比：' + pct(s.lowReviewShare) + '（阈值 <100）。',
    '- Top3 品牌' + noun + '量占比：' + pct(s.top3BrandReviewShare) + '；' + noun + '权重 HHI：' + fmt(s.brandHHI, 2) + '；已知品牌' + noun + '覆盖率：' + pct(s.brandCoverage) + '。均非销量指标。',
    '- 平台自营占比、卖家集中度、净利润：未取到。P1 不估算佣金、外汇、运输或成本。', '',
    '## 二、五维评分', '',
    '归一化 = 总分 ÷ 92 × 100；≥80 优秀 / ≥60 良好 / ≥40 一般 / <40 较差。缺数占位参与总分，仅供补数前初筛。', '',
    table(['维度', '得分 / 上限', '依据与口径'], score.dimensions.map(d => [d.label, d.score + ' / ' + d.max, d.detail])), '',
    ...score.notes.map(n => '- ' + n), '',
    '## 三、样本品牌与价格分布', '',
    '品牌表分母为已知品牌的可得' + noun + '总量；缺失品牌不合并成一个虚构品牌。', '',
    table(['品牌', '商品数', '累计' + noun, '品牌' + noun + '量占比'], s.brands.map(b => [b.brand, b.products, fmt(b.reviewMass), pct(b.reviewShare)])), '',
    table(['价格区间（' + site.currency + '）', '商品数', '有效价格样本占比'], (market.distributions?.price || []).map(p => [p.label, p.products, pct(p.productShare)])), '',
    '## 四、搜索结果商品明细', '',
    '序号是抓取顺序，不是畅销排名；畅销徽标/类目排名仅在网页明确提供时记录。', '',
    table(['序号', '商品ID', '商品名', '品牌', '价格（' + site.currency + '）', '星级', noun + '数', '畅销徽标排名'], (market.products || []).map((p, i) => [i + 1, p.productId, p.title, p.brand || '未取到', money(p.price), fmt(p.rating, 2), fmt(p.reviews), fmt(p.bestSellerRank)])), '',
    '### 商品详情页类目（样本，不代表整个关键词唯一类目）', '',
    table(['商品ID', '类目路径', '类目畅销排名'], (market.detailSamples || []).map(d => [d.productId, d.categoryPath || '未取到', fmt(d.categoryRank)])), '',
    '## 五、来源、质量与限制', '',
    ...[...new Set([...(market.warnings || []), ...warnings])].map(w => '- ' + md(w)),
    '- 累计' + noun + '不代表当月需求；广告和个性化排序可能影响样本，同一' + noun + '可能覆盖变体。低' + noun + '也不等于新品。',
    '- 缺失值不补零。利润维度占位分不是盈利测算；在补齐真实成本前不能据此决策进货。',
    '- 数据采集遇验证码、访问限制或国家页异常时停止，请人工确认，不绕过风控。', '',
    '### 可复核来源', '',
    ...(market.sourceUrls || []).map(u => { const safe = safeLink(u, site); return safe ? '- <' + safe + '>' : ''; }).filter(Boolean),
    ...(market.products || []).map(p => { const safe = safeLink(p.url, site); return safe ? '- ' + md(p.productId) + '：<' + safe + '>' : ''; }).filter(Boolean), '',
  ];
  return lines.join('\n');
}


export function renderTrendyolDashboard(params = {}) {
  // Render only our controlled Markdown subset. All scraped content stays escaped.
  const decode = (text) => String(text).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  const inline = (text) => html(decode(text)).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/&lt;(https:\/\/[^<>\s]+)&gt;/g, (_, url) => '<a href="' + url + '" rel="noopener noreferrer">' + url + '</a>');
  const lines = renderTrendyolReport(params).split('\n'), blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (line.startsWith('| ')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('| ')) rows.push(lines[i++]);
      i--;
      const cells = (row) => row.slice(1,-1).split('|').map((c) => c.trim());
      blocks.push('<div class="table"><table><thead><tr>' + cells(rows[0]).map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>' + rows.slice(2).map((row) => '<tr>' + cells(row).map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
    } else if (/^#{1,3} /.test(line)) {
      const level = line.indexOf(' ');
      blocks.push('<h' + level + '>' + inline(line.slice(level+1)) + '</h' + level + '>');
    } else if (line.startsWith('> ')) blocks.push('<blockquote>' + inline(line.slice(2)) + '</blockquote>');
    else blocks.push('<p>' + inline(line.replace(/^- /, '• ')) + '</p>');
  }
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trendyol 选品报告</title><style>body{margin:0;background:#f5f7fb;color:#172033;font:15px/1.7 system-ui}main{max-width:1200px;margin:24px auto;padding:28px;background:white;border-radius:12px}h1{color:#c55300}h2{margin-top:32px;border-bottom:1px solid #ddd}p,blockquote{overflow-wrap:anywhere}blockquote{margin:12px 0;padding:10px 16px;background:#fff4e6;border-left:4px solid #f27a1a}.table{overflow:auto;margin:16px 0}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:8px 12px;border:1px solid #e1e5eb;text-align:left;min-width:72px}th{background:#edf1f7}tr:nth-child(even){background:#fafbfc}a{color:#155aac}@media(max-width:700px){main{padding:16px;margin:0}h1{font-size:24px}}@media print{body{background:white}main{margin:0;padding:0}.table{overflow:visible}a{overflow-wrap:anywhere}}</style></head><body><main>' + blocks.join('\n') + '</main></body></html>';
}
