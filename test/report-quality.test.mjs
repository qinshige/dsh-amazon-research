import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreMarket } from '../host/scoring.js';
import { renderCategoryReport, renderScoresJson } from '../host/report.js';

function completeMarket() {
  return {
    provider: 'sellersprite',
    marketplace: 'US',
    label: 'Cell Phones',
    totals: { products: 8885, units: 120000, revenue: 9000000 },
    avgs: { price: 75, units: 1200, revenue: 90000, rating: 4.2, ratings: 850 },
    concentration: { top3BrandCrn: 0.62, top3ProductCrn: 0.35 },
    structure: { fbaProportion: 95, fbmProportion: 5, amazonSelfProportion: 8, returnRatio: 6 },
    newRatio: { l6: 0.1 },
    distributions: {
      ratingsCount: [
        { label: '0-100', products: 500, units: 50000, unitsRatio: 0.42 },
        { label: '301-1000', products: 200, units: 30000, unitsRatio: 0.25 },
      ],
      brand: [
        { brand: 'Apple', products: 120, units: 42000, revenue: 38000000, unitsRatio: 0.35 },
        { brand: 'Samsung', products: 90, units: 32000, revenue: 16000000, unitsRatio: 0.2667 },
        { brand: 'Motorola', products: 60, units: 18000, revenue: 3600000, unitsRatio: 0.15 },
      ],
      price: [{ label: '0-150', products: 300, units: 40000, revenue: 3000000, unitsRatio: 0.3333 }],
    },
    products: [],
    fetchedAt: '2026-11-10T00:00:00.000Z',
    warnings: [],
  };
}

function thinMarket() {
  // 只有市场规模 / 增长 / 进入壁垒可判，竞争烈度与利润空间缺数 → 数据质量 C
  return {
    provider: 'sellersprite',
    marketplace: 'US',
    label: 'Thin Market',
    totals: { revenue: 20000000 },
    avgs: {},
    concentration: {},
    structure: { amazonSelfProportion: 15 },
    distributions: {
      ratingsCount: [
        { label: '0-100', products: 500, units: 80 },
        { label: '101-300', products: 200, units: 20 },
      ],
    },
    products: [],
    fetchedAt: '2026-11-10T00:00:00.000Z',
    warnings: [],
  };
}

test('数据完整时给出正常评级与建议', () => {
  const market = completeMarket();
  const score = scoreMarket(market);
  assert.equal(score.max, 92);
  const report = renderCategoryReport({ market, score, site: 'US', generatedAt: '2026-11-10T00:00:00.000Z' });
  assert.match(report, /强烈推荐进入|可以考虑进入|谨慎进入/);
  const scores = renderScoresJson(score);
  assert.equal(scores.dataQuality, 'A');
  assert.equal(scores.missingDimensions, 0);
});

test('缺 ≥2 维时报告不给「进入」背书（数据质量 C）', () => {
  const market = thinMarket();
  const score = scoreMarket(market);
  assert.equal(score.total, 74);
  assert.equal(score.grade, '优秀');
  const report = renderCategoryReport({ market, score, site: 'US', generatedAt: '2026-11-10T00:00:00.000Z' });
  assert.equal(report.includes('强烈推荐进入'), false, '兜底评级不应输出「强烈推荐进入」');
  assert.match(report, /数据质量 C/);
  assert.match(report, /补数后再评/);
  const scores = renderScoresJson(score);
  assert.equal(scores.dataQuality, 'C');
  assert.equal(scores.missingDimensions, 2);
});
