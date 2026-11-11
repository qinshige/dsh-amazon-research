import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectCategory } from '../host/category.js';

/** 模拟 Sellersprite MCP 返回：形状按上游 reference/market_research.md 实测字段构造 */
function makeProviders() {
  const calls = [];
  return {
    calls,
    async call(provider, tool, args) {
      calls.push({ provider, tool, args });
      if (tool === 'product_node') {
        return { code: 200, data: { items: [{ nodeIdPath: '11091801:11974521:8882489011', nodeLabelPath: 'Cell Phones & Accessories:Cell Phones', products: 8885 }] } };
      }
      if (tool === 'market_research') {
        return {
          code: 200,
          data: {
            items: [
              {
                nodeIdPath: '11091801:11974521:8882489011',
                nodeLabelPath: 'Cell Phones & Accessories:Cell Phones',
                totalProducts: 8885,
                totalUnits: 120000,
                totalRevenue: 9000000,
                avgPrice: 75,
                avgUnits: 1200,
                avgRevenue: 90000,
                avgRating: 4.2,
                avgRatings: 850,
                avgBsr: 5000,
                top3ProductCrn: 0.35,
                top3BrandCrn: 0.62,
                top3SellerCrn: 0.28,
                fbaProportion: 95,
                fbmProportion: 5,
                amazonSelfProportion: 8,
                returnRatio: 6,
                l1NewRatio: 0.03,
                l3NewRatio: 0.06,
                l6NewRatio: 0.1,
                l12NewRatio: 0.18,
              },
            ],
          },
        };
      }
      if (tool === 'market_brand_concentration') {
        return {
          code: 200,
          data: [
            { brand: 'Apple', products: 120, newProducts: 4, avgPrice: 900, ratings: 8000, rating: 4.5, totalUnits: 42000, totalRevenue: 38000000, totalUnitsRatio: 0.35 },
            { brand: 'Samsung', products: 90, newProducts: 6, avgPrice: 500, ratings: 5000, rating: 4.3, totalUnits: 32000, totalRevenue: 16000000, totalUnitsRatio: 0.2667 },
            { brand: 'Motorola', products: 60, newProducts: 3, avgPrice: 200, ratings: 3000, rating: 4.1, totalUnits: 18000, totalRevenue: 3600000, totalUnitsRatio: 0.15 },
          ],
        };
      }
      if (tool === 'market_price_distribution') {
        return { code: 200, data: [{ label: '0-150', products: 300, units: 40000, revenue: 3000000, unitsRatio: 0.3333 }] };
      }
      if (tool === 'market_rating_distribution') {
        return { code: 200, data: [{ label: '4.0-4.5', products: 400, units: 60000, unitsRatio: 0.5 }] };
      }
      if (tool === 'market_ratings_count_distribution') {
        return { code: 200, data: [{ label: '0-50', products: 500, units: 50000, unitsRatio: 0.42 }] };
      }
      if (tool === 'market_listing_date_distribution') {
        return { code: 200, data: [{ label: '6个月内', products: 100, units: 12000, unitsRatio: 0.1 }] };
      }
      if (tool === 'market_seller_country_distribution') {
        return { code: 200, data: [{ country: 'CN', products: 600, units: 80000, unitsRatio: 0.67 }] };
      }
      if (tool === 'product_research') {
        return {
          code: 200,
          data: {
            items: [
              { asin: 'B0001', title: 'Phone A', price: 299, rating: 4.4, ratings: 1200, brand: 'Apple', units: 9000, revenue: 2691000 },
              { asin: 'B0002', title: 'Phone B', price: 199, rating: 4.1, ratings: 800, brand: 'Samsung', units: 6000, revenue: 1194000 },
            ],
          },
        };
      }
      throw new Error('未预期的工具: ' + tool);
    },
  };
}

test('selectCategory 完成取数、评分与报告落盘', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsr-cat-'));
  try {
    const providers = makeProviders();
    const result = await selectCategory({
      providers,
      dataDir: root,
      outputRoot: root,
      provider: 'sellersprite',
      marketplace: 'US',
      category: 'Cell Phones',
      limit: 20,
      unitCost: 30,
    });
    assert.equal(result.ok, true);
    assert.equal(result.stage, 'completed');
    assert.ok(result.runId);
    assert.equal(result.score.max, 92);
    assert.ok(result.score.total > 0 && result.score.total <= 92);
    assert.ok(result.artifacts.some((a) => a.name === 'report.md'));
    assert.ok(result.artifacts.some((a) => a.name === 'scores.json'));

    const report = await readFile(join(result.dir, 'report.md'), 'utf8');
    assert.match(report, /结论|评级|评分/);
    const scores = JSON.parse(await readFile(join(result.dir, 'scores.json'), 'utf8'));
    assert.equal(scores.max, 92);
    assert.ok(Array.isArray(scores.dimensions) && scores.dimensions.length === 5);

    const tools = providers.calls.map((c) => c.tool);
    assert.ok(tools.includes('product_node'));
    assert.ok(tools.includes('market_research'));
    assert.ok(tools.includes('market_brand_concentration'));
    assert.ok(result.usage.calls >= 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('selectCategory 缺参数时报 INVALID_ARGS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsr-cat-'));
  try {
    await assert.rejects(
      () => selectCategory({ providers: makeProviders(), dataDir: root, outputRoot: root }),
      (error) => error.code === 'INVALID_ARGS',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
