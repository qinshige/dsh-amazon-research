/**
 * dsh-amazon-research · test/analysis.test.mjs
 * 分析引擎回归测试（node:test / 纯 ESM / 不联网）。
 *
 * 覆盖：品牌级 HHI 口径（Cell_Phones 样本按品牌月销额复算 HHI≈3942.17、CR3≈94.12%）、
 * 92 分制归一化与评级边界、缺失字段最低档、报告关键章节、CSV/HTML 安全与结构。
 *
 * 样本适配器：test/fixtures/cell_phones_us.json 是上游 Cell_Phones_US_20260305/data.json 的副本，
 * 其中产品字段为中文（ASIN/标题/月销量/月销额/品牌/价格/星级/评论数/卖家来源/卖家），
 * 测试里用 fixtureProducts() 转成 Market.products 英文字段，再用 brandRowsFromProducts() 聚合成品牌行。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  brandHHI,
  crn,
  normalizeScore,
  summarizeDistribution,
  priceBandStats,
  lowReviewShareFromRatingsBuckets,
} from '../host/metrics.js';
import { scoreMarket } from '../host/scoring.js';
import {
  renderCategoryReport,
  renderScoresJson,
  toCsv,
  renderDashboardHtml,
} from '../host/report.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, 'fixtures', 'cell_phones_us.json');
const RAW = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const STATS = RAW['类目统计报告'];

const closeTo = (actual, expected, tolerance, message) => {
  assert.ok(
    typeof actual === 'number' && Math.abs(actual - expected) <= tolerance,
    (message || 'numeric mismatch') + '：actual=' + actual + ' expected≈' + expected,
  );
};

const sumBy = (rows, pick) => rows.reduce((acc, row) => acc + (Number(pick(row)) || 0), 0);

const parseNumberAfterColon = (text) => {
  const match = String(text ?? '').match(/[:：]\s*([\d.]+)/);
  return match ? Number(match[1]) : null;
};

const parsePercentValue = (text) => {
  const match = String(text ?? '').match(/([\d.]+)\s*%/);
  return match ? Number(match[1]) : null;
};

/** 把样本中文产品行适配成 Market.products（英文键）。 */
function fixtureProducts() {
  return RAW['Top100产品'].map((product) => ({
    asin: product.ASIN,
    title: product['标题'],
    price: Number(product['价格']),
    rating: Number(product['星级']),
    reviews: Number(product['评论数']),
    brand: product['品牌'],
    seller: product['卖家'],
    sellerSource: product['卖家来源'],
    monthlySales: Number(product['月销量']),
    monthlyRevenue: Number(product['月销额']),
    launchDays: Number(product['上线天数']),
  }));
}

/** 测试内适配器：把产品列表按品牌聚合成 brandRows（含销量/销额占比 0~1）。 */
function brandRowsFromProducts(products) {
  const map = new Map();
  for (const product of products) {
    const brand = String(product.brand || '未知品牌').trim();
    const row = map.get(brand) || { brand, products: 0, totalUnits: 0, totalRevenue: 0 };
    row.products += 1;
    row.totalUnits += Number(product.monthlySales) || 0;
    row.totalRevenue += Number(product.monthlyRevenue) || 0;
    map.set(brand, row);
  }
  const rows = [...map.values()];
  const totalUnits = rows.reduce((acc, row) => acc + row.totalUnits, 0);
  const totalRevenue = rows.reduce((acc, row) => acc + row.totalRevenue, 0);
  for (const row of rows) {
    row.totalUnitsRatio = totalUnits > 0 ? row.totalUnits / totalUnits : null;
    row.totalRevenueRatio = totalRevenue > 0 ? row.totalRevenue / totalRevenue : null;
  }
  rows.sort((a, b) => b.totalRevenue - a.totalRevenue);
  return rows;
}

/** 由样本构造完整的归一化 Market（价格/评分/评论数分布从产品明细聚合）。 */
function fixtureMarket() {
  const products = fixtureProducts();
  const priceBands = [['0-50', 0, 50], ['50-100', 50, 100], ['100-200', 100, 200], ['200-300', 200, 300], ['300-500', 300, 500], ['500-800', 500, 800], ['800+', 800, Infinity]];
  const price = priceBands.map(([label, min, max]) => {
    const rows = products.filter((product) => product.price >= min && product.price < max);
    return {
      label,
      products: rows.length,
      units: sumBy(rows, (row) => row.monthlySales),
      revenue: sumBy(rows, (row) => row.monthlyRevenue),
    };
  });
  const ratingBands = [['3.5-4.0', 3.5, 4.0], ['4.0-4.5', 4.0, 4.5], ['4.5-5.0', 4.5, 5.01]];
  const rating = ratingBands.map(([label, min, max]) => {
    const rows = products.filter((product) => product.rating >= min && product.rating < max);
    return { label, products: rows.length, units: sumBy(rows, (row) => row.monthlySales), revenue: sumBy(rows, (row) => row.monthlyRevenue) };
  });
  const reviewBands = [['0-100', 0, 101], ['101-300', 101, 301], ['301-1000', 301, 1001], ['1001+', 1001, Infinity]];
  const ratingsCount = reviewBands.map(([label, min, max]) => {
    const rows = products.filter((product) => product.reviews >= min && product.reviews < max);
    return { label, products: rows.length, units: sumBy(rows, (row) => row.monthlySales), revenue: sumBy(rows, (row) => row.monthlyRevenue) };
  });
  const countryMap = new Map();
  for (const product of products) {
    const country = product.sellerSource || '其他';
    const row = countryMap.get(country) || { country, products: 0, units: 0, revenue: 0 };
    row.products += 1;
    row.units += product.monthlySales;
    row.revenue += product.monthlyRevenue;
    countryMap.set(country, row);
  }
  const sellerCountry = [...countryMap.values()].sort((a, b) => b.units - a.units);

  return {
    provider: 'sellersprite',
    marketplace: 'US',
    month: '2026-03',
    nodeIdPath: STATS.nodeid,
    label: STATS['类目名称'],
    totals: {
      products: 100,
      units: parseNumberAfterColon(STATS['top100产品月销量']) ?? 232127,
      revenue: parseNumberAfterColon(STATS['top100产品月销额']) ?? 81687183.19,
    },
    avgs: {
      price: parseNumberAfterColon(STATS.average_price) ?? 363.7295,
      units: 2321.27,
      revenue: 816871.83,
      bsr: 12845,
      rating: 4.06,
      ratings: 4649.61,
    },
    concentration: {
      top3ProductCrn: parsePercentValue(STATS.top3_product_sales_volume_share) / 100,
      top3BrandCrn: parsePercentValue(STATS.top3_brands_sales_volume_share) / 100,
      top3SellerCrn: parsePercentValue(STATS.top3_seller_sales_volume_share) / 100,
      top5BrandCrn: 0.92,
      top10BrandCrn: 0.98,
    },
    structure: {
      fbaProportion: 95.2,
      fbmProportion: 4.8,
      amazonSelfProportion: parsePercentValue(STATS.amazonOwned_sales_volume_share),
      returnRatio: 5.1,
    },
    newRatio: { l1: 0.01, l3: 0.02, l6: 0.05, l12: 0.1 },
    distributions: {
      price,
      brand: brandRowsFromProducts(products),
      sellerCountry,
      rating,
      ratingsCount,
      listingDate: [],
      sellerType: [{ label: 'FBA', asinNum: 88, asinRatio: 0.88, units: 210000, unitsRatio: 0.9, productNum: 88 }],
      product: [],
      demandTrend: [],
    },
    products,
    fetchedAt: '2026-11-10T15:00:00.000Z',
    warnings: ['样本为 Top100 口径'],
  };
}

// ---------------------------------------------------------------------------
// 1. 品牌级 HHI / CRn
// ---------------------------------------------------------------------------

test('brandHHI 按品牌月销额复算 Cell_Phones：HHI≈3942.17（品牌级口径）', () => {
  const brandRows = brandRowsFromProducts(fixtureProducts());
  assert.equal(brandRows.length, 13, '样本应有 13 个品牌');
  const result = brandHHI(brandRows);
  closeTo(result.hhi, 3942.17, 0.5, '品牌级 HHI（销额份额）');
  assert.equal(result.basis, 'brand_revenue');
  assert.equal(result.coveredShare, 1);
  assert.equal(result.estimated, false);
});

test('brandHHI 不是产品级口径：产品级 HHI 远小于品牌级 HHI', () => {
  const products = fixtureProducts();
  const brandRows = brandRowsFromProducts(products);
  const brandHhi = brandHHI(brandRows).hhi;
  const totalUnits = sumBy(products, (product) => product.monthlySales);
  const productLevelHhi = products.reduce((acc, product) => acc + ((product.monthlySales / totalUnits) * 100) ** 2, 0);
  // 上游 workflow.py 的产品级口径在 Cell_Phones 样本上只有 173.09，品牌级口径约 3942.17。
  closeTo(productLevelHhi, 173.09, 0.5, '产品级 HHI（上游 bug 口径，仅用于对照）');
  assert.ok(brandHhi > 3000, '品牌级 HHI 应体现头部品牌集中');
  assert.ok(Math.abs(brandHhi - productLevelHhi) > 1000, '两种口径必须显著不同');
});

test('brandHHI 支持品牌销量口径，并返回 0~10000 刻度', () => {
  const brandRows = brandRowsFromProducts(fixtureProducts());
  const result = brandHHI(brandRows, { basis: 'units' });
  closeTo(result.hhi, 3362.16, 0.5, '品牌级 HHI（销量份额）');
  assert.equal(result.basis, 'brand_units');
  assert.ok(result.hhi > 0 && result.hhi <= 10000);
  assert.ok(result.coveredShare >= 0 && result.coveredShare <= 1);
});

test('brandHHI 覆盖不足时标记 estimated，并给出 coveredShare', () => {
  const brandRows = brandRowsFromProducts(fixtureProducts());
  const top3 = brandRows.slice(0, 3);
  const result = brandHHI(top3);
  closeTo(result.coveredShare, 0.9412, 0.002, 'Top3 品牌销额覆盖份额');
  assert.equal(result.estimated, true);
  closeTo(result.hhi, 3930.9, 15, '按类目总分母还原后的 HHI 仍是下限估计');
});

test('brandHHI 空数据安全：hhi=0、coveredShare=0、estimated=true', () => {
  assert.deepEqual(brandHHI([]), { hhi: 0, basis: 'brand_revenue', coveredShare: 0, estimated: true });
  assert.deepEqual(brandHHI(null, { basis: 'units' }), { hhi: 0, basis: 'brand_units', coveredShare: 0, estimated: true });
});

test('crn 按品牌销额/销量返回 0~1 的 CR3', () => {
  const brandRows = brandRowsFromProducts(fixtureProducts());
  closeTo(crn(brandRows, 'totalRevenue', 3), 0.9412, 0.002, 'CR3（销额）');
  closeTo(crn(brandRows, 'totalUnits', 3), 0.8411, 0.002, 'CR3（销量，与上游 top3_brands 84.11% 一致）');
  assert.equal(crn([], 'totalRevenue', 3), 0);
  assert.equal(crn([{ totalRevenue: 0 }], 'totalRevenue', 3), 0);
  const value = crn(brandRows, 'totalRevenue', 3);
  assert.ok(value >= 0 && value <= 1);
});

// ---------------------------------------------------------------------------
// 2. 92 分制归一化与评级边界
// ---------------------------------------------------------------------------

test('normalizeScore：92 分制归一化与评级边界', () => {
  assert.deepEqual(normalizeScore(92), {
    normalized: 100,
    grade: '优秀',
    thresholds: [
      { grade: '优秀', min: 80 },
      { grade: '良好', min: 60 },
      { grade: '一般', min: 40 },
      { grade: '较差', min: 0 },
    ],
  });
  assert.equal(normalizeScore(73.6).normalized, 80);
  assert.equal(normalizeScore(73.6).grade, '优秀');
  assert.equal(normalizeScore(73.5).normalized, 79.9);
  assert.equal(normalizeScore(73.5).grade, '良好');
  assert.equal(normalizeScore(55.2).normalized, 60);
  assert.equal(normalizeScore(55.2).grade, '良好');
  assert.equal(normalizeScore(36.8).normalized, 40);
  assert.equal(normalizeScore(36.8).grade, '一般');
  assert.equal(normalizeScore(36.7).normalized, 39.9);
  assert.equal(normalizeScore(36.7).grade, '较差');
  assert.equal(normalizeScore(0).grade, '较差');
});

test('normalizeScore：自定义满分与钳制', () => {
  assert.equal(normalizeScore(50, 100).normalized, 50);
  assert.equal(normalizeScore(50, 100).grade, '一般');
  assert.equal(normalizeScore(100).normalized, 100, '超出 92 分被钳制到 100');
  assert.equal(normalizeScore(-10).normalized, 0);
  assert.equal(normalizeScore(63).normalized, 68.5);
  assert.equal(normalizeScore(63).grade, '良好');
});

// ---------------------------------------------------------------------------
// 3. scoreMarket 五维评分
// ---------------------------------------------------------------------------

test('scoreMarket：Cell_Phones 样本五维 20/14/8/9/12 = 63/92，归一化 68.5 良好', () => {
  const market = fixtureMarket();
  const score = scoreMarket(market);
  assert.equal(score.max, 92);
  assert.equal(score.total, 63);
  assert.equal(score.normalized, 68.5);
  assert.equal(score.grade, '良好', '92 分制下 63 分归一化 68.5 → 良好（不是旧口径的“一般”）');
  assert.deepEqual(score.dimensions.map((dimension) => dimension.key), ['market_size', 'growth_potential', 'competition', 'entry_barrier', 'profit_margin']);
  assert.deepEqual(score.dimensions.map((dimension) => dimension.label), ['市场规模', '增长潜力', '竞争烈度', '进入壁垒', '利润空间']);
  assert.deepEqual(score.dimensions.map((dimension) => dimension.score), [20, 14, 8, 9, 12]);
  assert.deepEqual(score.dimensions.map((dimension) => dimension.max), [20, 22, 18, 20, 12]);
  assert.equal(score.dimensions.reduce((acc, dimension) => acc + dimension.max, 0), 92);
  for (const dimension of score.dimensions) {
    assert.equal(dimension.normalized, Math.round((dimension.score / dimension.max) * 1000) / 10);
    assert.equal(typeof dimension.detail, 'string');
    assert.ok(dimension.detail.length > 0);
    assert.equal(typeof dimension.inputs, 'object');
  }
  const competition = score.dimensions.find((dimension) => dimension.key === 'competition');
  closeTo(competition.inputs.top3BrandCrn, 0.8411, 0.001, 'Top3 品牌占比 0~1');
  assert.ok(competition.detail.includes('84.11%'));
  const barrier = score.dimensions.find((dimension) => dimension.key === 'entry_barrier');
  closeTo(barrier.inputs.amazonSelfShare, 0.2238, 0.001, 'structure.amazonSelfProportion 百分数 ÷100');
  assert.equal(barrier.inputs.amazonPoints, 6);
  assert.equal(barrier.inputs.newProductPoints, 3);
});

test('scoreMarket：无输入时五维全部走最低档并写 notes（10/14/8/6/4）', () => {
  const score = scoreMarket({});
  assert.equal(score.total, 42);
  assert.equal(score.max, 92);
  assert.equal(score.normalized, 45.7);
  assert.equal(score.grade, '一般');
  assert.deepEqual(score.dimensions.map((dimension) => dimension.score), [10, 14, 8, 6, 4]);
  assert.ok(score.notes.length >= 5, '每个缺失维度至少一条 notes');
  for (const note of score.notes) assert.equal(typeof note, 'string');
  assert.ok(score.notes.every((note) => !note.includes('NaN')));
  assert.equal(scoreMarket(null).total, 42);
});

test('scoreMarket：缺 ≥2 维仍输出评级（不拒绝评分）', () => {
  const score = scoreMarket({ totals: { revenue: 2_000_000 }, avgs: { price: 120 } });
  assert.equal(score.dimensions.length, 5);
  // 市场规模 14 + 增长潜力 14(缺失最低档) + 竞争烈度 8(缺失最低档) + 进入壁垒 6(两个子项均缺失) + 利润空间 7 = 49
  assert.equal(score.total, 49);
  assert.equal(score.normalized, 53.3);
  assert.equal(score.grade, '一般', '缺 ≥2 维仍给出评级（不为 null、不拒绝评分）');
  assert.ok(score.notes.some((note) => note.includes('增长潜力')));
  assert.ok(score.notes.some((note) => note.includes('竞争烈度')));
});

test('scoreMarket：低评论占比由 ratingsCount 分布推导（阈值 300）', () => {
  const market = {
    totals: { revenue: 2_000_000 },
    concentration: { top3BrandCrn: 0.25 },
    structure: { amazonSelfProportion: 15 },
    avgs: { price: 100 },
    distributions: {
      ratingsCount: [
        { label: '0-100', units: 60 },
        { label: '101-300', units: 20 },
        { label: '301-1000', units: 20 },
      ],
    },
  };
  const score = scoreMarket(market);
  const growth = score.dimensions.find((dimension) => dimension.key === 'growth_potential');
  closeTo(growth.inputs.lowReviewShare, 0.8, 0.0001, '80% 销量来自评论数 <300 的桶');
  assert.equal(growth.score, 22);
  assert.ok(String(growth.inputs.lowReviewSource).includes('ratingsCount'));
  const barrier = score.dimensions.find((dimension) => dimension.key === 'entry_barrier');
  assert.equal(barrier.score, 20); // Amazon 15% → 10 分；低评论 80% → 10 分
  assert.equal(score.total, 81);
  assert.equal(score.normalized, 88);
  assert.equal(score.grade, '优秀');
});

test('scoreMarket：opts.unitCost 走毛利率分档，无成本时注明「未接入采购成本，仅供初筛」', () => {
  const market = fixtureMarket();

  const noCost = scoreMarket(market);
  const profitNoCost = noCost.dimensions.find((dimension) => dimension.key === 'profit_margin');
  assert.equal(profitNoCost.inputs.basis, 'avg_price');
  assert.equal(profitNoCost.score, 12);
  assert.ok(profitNoCost.detail.includes('未接入采购成本，仅供初筛'));
  assert.ok(noCost.notes.some((note) => note.includes('未接入采购成本，仅供初筛')));

  const withCost = scoreMarket(market, { unitCost: 200 });
  const profitWithCost = withCost.dimensions.find((dimension) => dimension.key === 'profit_margin');
  assert.equal(profitWithCost.inputs.basis, 'unit_cost');
  closeTo(profitWithCost.inputs.grossMargin, 0.4501, 0.001, '毛利率 0~1');
  assert.equal(profitWithCost.score, 10);
  assert.ok(profitWithCost.detail.includes('毛利率'));
  assert.ok(!withCost.notes.some((note) => note.includes('未接入采购成本，仅供初筛')), '接入成本后不再标注该提示');

  const lowMargin = scoreMarket(market, { unitCost: 300, extraCostPerUnit: 20 });
  assert.equal(lowMargin.dimensions.find((dimension) => dimension.key === 'profit_margin').score, 4);
  assert.equal(withCost.total, 61);
});

test('数据质量守卫：推导估算的增长潜力不算缺数（estimated≠missing，B 级不抑制建议）', () => {
  // 低评论占比来自跨阈值分桶推导（estimated=true），但数据本身并未缺失 → missing=false；
  // 真正缺数的只有竞争烈度（concentration 为空）→ missingDimensions=1 → dataQuality=B。
  const market = {
    totals: { revenue: 20_000_000 },
    structure: { amazonSelfProportion: 15 },
    avgs: { price: 100 },
    distributions: { ratingsCount: [{ label: '0-100', units: 30 }, { label: '101-500', units: 70 }] },
    products: [],
  };
  const score = scoreMarket(market);
  const growth = score.dimensions.find((dimension) => dimension.key === 'growth_potential');
  assert.equal(growth.inputs.missing, false);
  assert.equal(growth.inputs.estimated, true);
  assert.equal(score.dimensions.find((dimension) => dimension.key === 'competition').inputs.missing, true);

  const scores = renderScoresJson(score);
  assert.equal(scores.missingDimensions, 1);
  assert.equal(scores.dataQuality, 'B');
  const report = renderCategoryReport({ market, score, site: 'US', generatedAt: 't' });
  assert.ok(!report.includes('不构成进入建议'), 'B 级不抑制进入建议');
});

test('数据质量守卫：进入壁垒部分缺数/零销额计入缺数维度；空市场 D 级抑制建议', () => {
  // 只缺 Amazon 自营子项（低评论与其余维度齐全）→ 进入壁垒算 1 个缺数维度。
  const barrierMarket = {
    totals: { revenue: 20_000_000 },
    concentration: { top3BrandCrn: 0.25 },
    avgs: { price: 100 },
    distributions: { ratingsCount: [{ label: '0-100', units: 30 }, { label: '101-300', units: 70 }] },
    products: [],
  };
  const barrierScore = scoreMarket(barrierMarket);
  assert.equal(barrierScore.dimensions.find((dimension) => dimension.key === 'entry_barrier').inputs.missing, true);
  const barrierJson = renderScoresJson(barrierScore);
  assert.equal(barrierJson.missingDimensions, 1);
  assert.equal(barrierJson.dataQuality, 'B');

  // 月销额为 0（疑似取数失败）→ 市场规模按缺数计入。
  const zeroRevenue = {
    totals: { revenue: 0 },
    concentration: { top3BrandCrn: 0.25 },
    structure: { amazonSelfProportion: 15 },
    avgs: { price: 100 },
    distributions: { ratingsCount: [{ label: '0-100', units: 80 }, { label: '301-1000', units: 20 }] },
    products: [],
  };
  const zeroScore = scoreMarket(zeroRevenue);
  assert.equal(zeroScore.dimensions.find((dimension) => dimension.key === 'market_size').inputs.missing, true);
  assert.equal(renderScoresJson(zeroScore).missingDimensions, 1);

  // 空市场：五维全缺 → D，报告结论抑制并写「补数后再评」。
  const emptyScore = scoreMarket({});
  const emptyJson = renderScoresJson(emptyScore);
  assert.equal(emptyJson.missingDimensions, 5);
  assert.equal(emptyJson.dataQuality, 'D');
  const emptyReport = renderCategoryReport({ market: {}, score: emptyScore, site: 'US', generatedAt: 't' });
  assert.ok(emptyReport.includes('不构成进入建议'));
  assert.ok(emptyReport.includes('补数后再评'));

  // 无评分时 dataQuality 为 null（兼容旧 run，读不到按 null 处理）。
  const nullJson = renderScoresJson(null);
  assert.equal(nullJson.dataQuality, null);
  assert.equal(nullJson.missingDimensions, 0);
});

// ---------------------------------------------------------------------------
// 4. 分布工具
// ---------------------------------------------------------------------------

test('summarizeDistribution：销量占比为 0~1、累计占比收口到 1', () => {
  const summary = summarizeDistribution([
    { label: '0-50', products: 1, units: 30, revenue: 300 },
    { label: '50-100', products: 2, units: 70, revenue: 7000 },
  ]);
  assert.equal(summary.rows.length, 2);
  assert.equal(summary.totalUnits, 100);
  assert.equal(summary.totalRevenue, 7300);
  assert.equal(summary.rows[0].unitsShare, 0.3);
  assert.equal(summary.rows[1].unitsShare, 0.7);
  assert.equal(summary.rows[1].cumulativeShare, 1);
  assert.equal(summary.rows[0].revenueShare, 0.0411);
  assert.equal(summary.estimated, false);
  const top = priceBandStats([
    { label: 'A', units: 10, revenue: 100 },
    { label: 'B', units: 80, revenue: 800 },
    { label: 'C', units: 10, revenue: 100 },
  ]);
  assert.equal(top.topBand.label, 'B');
  assert.equal(top.top3UnitsShare, 1);
});

test('lowReviewShareFromRatingsBuckets：跨阈值桶按均匀分布估算并标 estimated', () => {
  const result = lowReviewShareFromRatingsBuckets([
    { label: '0-100', units: 30 },
    { label: '101-500', units: 70 },
  ]);
  closeTo(result.share, 0.6491, 0.001, '30 + 70*(199/399)');
  assert.equal(result.threshold, 300);
  assert.equal(result.matchedShare, 1);
  assert.equal(result.estimated, true);
  assert.equal(lowReviewShareFromRatingsBuckets([]).share, null);
});

// ---------------------------------------------------------------------------
// 5. 报告渲染
// ---------------------------------------------------------------------------

test('renderCategoryReport：包含结论/五维/大盘/集中度/价格带/风险/数据来源章节', () => {
  const market = fixtureMarket();
  const score = scoreMarket(market);
  const markdown = renderCategoryReport({
    market,
    score,
    site: 'US',
    generatedAt: '2026-11-10T15:30:00.000Z',
    warnings: ['外部提示：类目数据为月度快照'],
  });
  assert.ok(markdown.startsWith('# Cell Phones（US）品类选品分析报告'));
  for (const section of [
    '## 一、结论摘要',
    '## 二、五维评分',
    '## 三、市场大盘',
    '## 四、品牌与卖家集中度',
    '## 五、价格带与评论结构',
    '## 六、风险与一票否决提示',
    '## 七、数据来源与缺失清单',
  ]) {
    assert.ok(markdown.includes(section), '缺少章节：' + section);
  }
  assert.ok(markdown.includes('63 / 92'));
  assert.ok(markdown.includes('68.5'));
  assert.ok(markdown.includes('良好'));
  assert.ok(markdown.includes('未接入采购成本，仅供初筛'));
  assert.ok(markdown.includes('3,942.17'), '报告应体现品牌级 HHI');
  assert.ok(markdown.includes('外部提示：类目数据为月度快照'));
  assert.ok(markdown.includes('一票否决'));
  assert.ok(!markdown.includes('undefined'));
  assert.ok(!markdown.includes('NaN'));
});

test('renderCategoryReport：空 Market / 空 score 不崩溃且提示缺失', () => {
  const markdown = renderCategoryReport({ market: {}, score: null });
  assert.equal(typeof markdown, 'string');
  assert.ok(markdown.includes('## 一、结论摘要'));
  assert.ok(markdown.includes('未评分'));
  assert.ok(markdown.includes('## 七、数据来源与缺失清单'));
  assert.ok(markdown.includes('缺失字段清单'));
  assert.ok(!markdown.includes('undefined'));
  assert.ok(!markdown.includes('NaN'));
});

test('renderScoresJson：输出 JSON 安全的评分对象', () => {
  const score = scoreMarket(fixtureMarket());
  const json = renderScoresJson(score);
  assert.equal(json.total, 63);
  assert.equal(json.max, 92);
  assert.equal(json.normalized, 68.5);
  assert.equal(json.grade, '良好');
  assert.equal(json.dimensions.length, 5);
  for (const dimension of json.dimensions) {
    assert.deepEqual(Object.keys(dimension).sort(), ['detail', 'inputs', 'key', 'label', 'max', 'normalized', 'score'].sort());
  }
  assert.doesNotThrow(() => JSON.stringify(json));
  assert.equal(renderScoresJson(null).dimensions.length, 0);
});

test('toCsv：表头、列筛选与逗号/引号/换行转义', () => {
  const rows = [
    { brand: 'A,B', units: 10, note: 'he said "hi"', empty: null },
    { brand: 'C', units: 20, note: 'line\nbreak', empty: undefined },
  ];
  const csv = toCsv(rows, ['brand', 'units', 'note', 'empty']);
  const lines = csv.split('\n');
  assert.equal(lines[0], 'brand,units,note,empty');
  assert.ok(csv.includes('"A,B",10,"he said ""hi""",'));
  assert.ok(csv.includes('C,20,"line\nbreak",'));
  assert.ok(csv.endsWith('\n'));
  assert.equal(toCsv([], ['a']), 'a\n');
  assert.equal(toCsv(null, null), '');
  const labeled = toCsv([{ brand: 'X' }], [{ key: 'brand', label: '品牌' }]);
  assert.equal(labeled.split('\n')[0], '品牌');
});

test('renderDashboardHtml：纯内联 HTML（无 CDN/外链/script），含柱状条并转义文本', () => {
  const market = fixtureMarket();
  const score = scoreMarket(market);
  const html = renderDashboardHtml({ market, score, generatedAt: '2026-11-10T15:30:00.000Z' });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('<style>'));
  assert.ok(!/<script/i.test(html), '禁止 script');
  assert.ok(!html.includes('http://') && !html.includes('https://'), '禁止外链');
  assert.ok(!html.includes('cdn'), '禁止 CDN');
  assert.ok(!html.includes('<link'), '禁止外部样式');
  assert.ok(html.includes('style="width:'), '应包含内联宽度柱状条');
  assert.ok(html.includes('Cell Phones'));
  assert.ok(html.includes('3,942.17'));

  const injected = fixtureMarket();
  injected.label = '<script>alert(1)</script>';
  const escapedHtml = renderDashboardHtml({ market: injected, score, generatedAt: 't' });
  assert.ok(!escapedHtml.includes('<script>alert(1)</script>'), 'HTML 插值必须转义');
  assert.ok(escapedHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('renderDashboardHtml：空数据不崩溃', () => {
  const html = renderDashboardHtml({});
  assert.ok(html.includes('关键指标'));
  assert.ok(html.includes('五维评分'));
  assert.ok(!html.includes('undefined'));
});