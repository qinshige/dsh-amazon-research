import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePriceTRY,
  parseReviewCount,
  parseRating,
  parseBestSellerRank,
  parseFavoriteRank,
  parseCategoryRank,
  parseProductId,
  parseBadges,
  formatBreadcrumb,
} from '../host/web/trendyol-parse.js';
import { listPlatforms, getPlatform, providerSupportsPlatform, providersForPlatform, resolveSite } from '../host/platforms/index.js';
import { scoreMarket } from '../host/scoring.js';
import { renderCategoryReport } from '../host/report.js';
import { Providers } from '../host/providers.js';

// ─────────────────────────────────────────────── 解析层

test('parsePriceTRY：土耳其数字格式（点千分位、逗号小数）', () => {
  assert.equal(parsePriceTRY('2.299 TL'), 2299);
  assert.equal(parsePriceTRY('2.655,20 TL'), 2655.2);
  assert.equal(parsePriceTRY('14.957,37 TL'), 14957.37);
  assert.equal(parsePriceTRY('699 TL'), 699);
  assert.equal(parsePriceTRY('1.234.567'), 1234567);
  assert.equal(parsePriceTRY('99,90'), 99.9);
  assert.equal(parsePriceTRY('12.5'), 12.5);
  assert.equal(parsePriceTRY(''), null);
  // 关键回归：'2.299 TL' 绝不能被解析成 2.299
  assert.notEqual(parsePriceTRY('2.299 TL'), 2.299);
});

test('parseReviewCount / parseRating：卡片上的 (2183) 与 4.1', () => {
  assert.equal(parseReviewCount('(2183)'), 2183);
  assert.equal(parseReviewCount('2183'), 2183);
  assert.equal(parseReviewCount(''), null);
  assert.equal(parseRating('4.1'), 4.1);
  assert.equal(parseRating('5.0'), 5);
  assert.equal(parseRating('9.9'), null, '超出 0~5 的应判非法');
});

test('排名解析：畅销 / 收藏 / 类目', () => {
  assert.equal(parseBestSellerRank('En Çok Satan 5. Ürün'), 5);
  assert.equal(parseBestSellerRank('普通商品'), null);
  assert.equal(parseFavoriteRank('En Çok Favorilenen 12. Ürün'), 12);
  assert.equal(parseCategoryRank('En Çok Satılan Tencere #3'), 3);
});

test('parseProductId / parseBadges / formatBreadcrumb', () => {
  assert.equal(parseProductId('/tac/x-p-926032710?boutiqueId=61'), '926032710');
  assert.equal(parseProductId('/no-id-here'), null);
  const badges = parseBadges('Süper Kampanya Kargo Bedava Bugün Kargoda');
  assert.deepEqual(badges, ['超级促销', '今日发货', '免运费']);
  assert.equal(formatBreadcrumb(['Trendyol', 'Ev ve Mobilya', 'Tencere']), 'Ev ve Mobilya › Tencere');
});

// ─────────────────────────────────────────────── 平台注册表

test('公开平台注册表保留Amazon非SA站点，沙特仅Trendyol.sa', () => {
  assert.deepEqual(listPlatforms().map((p) => p.id), ['amazon', 'trendyol']);
  assert.equal(getPlatform('amazon').defaultSite, 'US');
  const amazonSites = ['US','UK','DE','FR','IT','ES','CA','JP','MX','AU','IN','AE','BR'];
  assert.deepEqual(getPlatform('amazon').sites.map(s => s.value), amazonSites);
  for (const site of amazonSites) assert.equal(resolveSite('amazon', site), site);
  assert.equal(resolveSite('amazon', 'SA'), null);
  assert.equal(resolveSite('amazon'), 'US');
  assert.deepEqual(providersForPlatform('amazon'), ['sellersprite','sellersprite-web','sorftime']);
  assert.equal(providerSupportsPlatform('sellersprite', 'amazon'), true);
  assert.equal(providerSupportsPlatform('trendyol-web', 'amazon'), false);
  assert.equal(providerSupportsPlatform('sellersprite', 'trendyol'), false);
  assert.equal(providerSupportsPlatform('trendyol-web', 'trendyol'), true);
  assert.deepEqual(providersForPlatform('trendyol'), ['trendyol-web']);
  assert.equal(getPlatform('trendyol').currencySymbol, 'SAR');
  assert.equal(resolveSite('trendyol', 'sa'), 'SA');
  assert.equal(resolveSite('trendyol'), 'SA');
  for (const site of ['TR', 'US', 'DE']) assert.equal(resolveSite('trendyol', site), null);
});

test('Providers.list 带 platforms 声明，listForPlatform 只返回该平台可用的', () => {
  const providers = new Providers({ secrets: { get: async () => null } });
  const all = providers.list();
  const trendyolProviders = providers.listForPlatform('trendyol');
  assert.deepEqual(trendyolProviders.map((p) => p.id), ['trendyol-web']);
  assert.ok(all.some((p) => p.id === 'sellersprite' && p.platforms.includes('amazon')));
});

// ─────────────────────────────────────────────── 评分：Trendyol 口径

function trendyolMarket(overrides = {}) {
  return {
    platform: 'trendyol',
    provider: 'trendyol-web',
    marketplace: 'TR',
    label: 'Tencere',
    totals: { products: 60, units: null, revenue: null, reviewMass: 54898 },
    avgs: { price: 1999, rating: 4.3, ratings: 101, bsr: null, units: null, revenue: null },
    concentration: { top3BrandCrn: 0.86, top3ProductCrn: 0.5, top3SellerCrn: null },
    structure: { fbaProportion: null, fbmProportion: null, amazonSelfProportion: null, returnRatio: null },
    newRatio: { l1: null },
    distributions: { price: [], brand: [], ratingsCount: [], rating: [] },
    products: [
      { productId: '1', brand: 'A', price: 1999, rating: 4.5, reviews: 10 },
      { productId: '2', brand: 'A', price: 2499, rating: 4.4, reviews: 50 },
      { productId: '3', brand: 'B', price: 999, rating: 4.2, reviews: 5000 },
    ],
    ...overrides,
  };
}

test('Trendyol 市场规模用评论总量代理，不是销额', () => {
  const score = scoreMarket(trendyolMarket());
  const marketSize = score.dimensions.find((d) => d.key === 'market_size');
  assert.equal(marketSize.max, 20);
  assert.equal(marketSize.inputs.basis, 'review_mass');
  assert.equal(marketSize.inputs.reviewMass, 54898);
  assert.match(marketSize.detail, /评论/);
  assert.ok(score.notes.some((n) => n.includes('市场活跃度代理')));
});

test('Trendyol 利润维度按缺数处理（不能拿美元价格带套 TRY）', () => {
  const score = scoreMarket(trendyolMarket());
  const profit = score.dimensions.find((d) => d.key === 'profit_margin');
  assert.equal(profit.score, 0, '没有成本口径时不得给满分');
  assert.equal(profit.inputs.basis, 'not_available');
  assert.equal(profit.inputs.missing, true);
  assert.match(profit.detail, /美元价格带|缺数/);
});

test('Amazon 利润维度不受影响（价格带兜底仍然生效）', () => {
  const amazonMarket = {
    provider: 'sellersprite',
    marketplace: 'US',
    label: 'Cell Phones',
    totals: { products: 50, units: 1000, revenue: 50000 },
    avgs: { price: 25, rating: 4.5, ratings: 300, bsr: 1000 },
    concentration: {},
    structure: {},
    distributions: {},
    products: [],
  };
  const score = scoreMarket(amazonMarket);
  const profit = score.dimensions.find((d) => d.key === 'profit_margin');
  assert.ok(profit.score > 0, 'Amazon 仍走价格带兜底');
  assert.notEqual(profit.inputs.basis, 'not_available');
});

test('Trendyol 增长潜力按商品数占比（没有销量权重）', () => {
  const score = scoreMarket(trendyolMarket());
  const growth = score.dimensions.find((d) => d.key === 'growth_potential');
  assert.ok(growth.inputs.lowReviewShare !== null);
  assert.match(growth.detail, /商品数占比/);
});

// ─────────────────────────────────────────────── 报告：平台与货币

test('Trendyol 报告标题带平台名、金额用 TL', () => {
  const market = trendyolMarket();
  const score = scoreMarket(market);
  const md = renderCategoryReport({ market, score, site: 'TR', generatedAt: '2026-11-13T00:00:00.000Z' });
  assert.match(md, /^# Tencere（Trendyol · TR）品类选品分析报告/);
  assert.match(md, /平台：Trendyol/);
  assert.match(md, /TL/);
  assert.doesNotMatch(md, /\$1,999/);
});

test('Amazon 报告标题保持原格式（不含平台前缀）', () => {
  const market = {
    provider: 'sellersprite',
    marketplace: 'US',
    label: 'Cell Phones',
    totals: { products: 50, units: 1000, revenue: 50000 },
    avgs: { price: 25, rating: 4.5, ratings: 300 },
    concentration: {},
    structure: {},
    distributions: {},
    products: [],
  };
  const score = scoreMarket(market);
  const md = renderCategoryReport({ market, score, site: 'US', generatedAt: '2026-11-13T00:00:00.000Z' });
  assert.match(md, /^# Cell Phones（US）品类选品分析报告/);
});
