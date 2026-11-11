import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectCategoryWeb } from '../host/category-web.js';

/**
 * web provider 的离线测试：用假的 sellersprite-web provider 替换真实取数，
 * 验证「归一化 → 评分 → 落盘」链路与口径标注是否正确。
 */
async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-web-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 通过依赖注入替换真实 provider（selectCategoryWeb 内部直接 import，这里改用模块级 stub） */
test('web 取数链路：归一化 + 评分 + 落盘（离线桩）', async () => {
  await withTempDir(async (dir) => {
    const providers = await import('../host/providers/sellersprite-web.js');
    const original = { ...providers.sellerspriteWebProvider };
    providers.sellerspriteWebProvider.marketList = async () => ({
      rows: [
        {
          rank: 1,
          name: 'Furniture Pads (脚垫)',
          nodeUrl: '/v2/market-research/1/228013:511228:2380872011?topN=10',
          nodeIdPath: '228013:511228:2380872011',
          sample: { products: 100, brands: 53, sellers: 52 },
          totalUnits: 362426,
          averageUnits: 3624,
          headAverageRevenue: 36894,
          averageRatings: 5805,
          averageRating: 4.5,
          averagePrice: 10.14,
          concentration: { brandCr3: 0.703, productCr3: 0.389, sellerCr3: 0.707 },
          structure: { fbaProportion: 91, amazonSelfProportion: 6, fbmProportion: 0 },
          newItems: { count: 3, ratio: 3 },
          goodsTotal: 4995,
          returnRate: 5.13,
        },
        {
          rank: 2,
          name: 'Picture Hangers (图片挂架)',
          nodeUrl: '/v2/market-research/1/228013:511228:511352?topN=10',
          nodeIdPath: '228013:511228:511352',
          sample: { products: 100, brands: 69, sellers: 64 },
          totalUnits: 312651,
          averageUnits: 3126,
          headAverageRevenue: 34480,
          averageRatings: 3259,
          averageRating: 4.5,
          averagePrice: 11.09,
          concentration: { brandCr3: 0.636, productCr3: 0.444, sellerCr3: 0.694 },
          structure: { fbaProportion: 86, amazonSelfProportion: 14, fbmProportion: 0 },
          newItems: { count: 8, ratio: 8 },
          goodsTotal: 3847,
          returnRate: 2.89,
        },
      ],
      count: 2,
      fetchedAt: '2026-11-11T00:00:00.000Z',
      source: 'stub:选市场',
    });
    providers.sellerspriteWebProvider.nodeReport = async () => ({
      title: 'Hardware',
      marketPath: 'Tools & Home Improvement › Hardware',
      sampleProducts: 57,
      sampleBrandsSellers: '53/51',
      avgBsr: 334538,
      avgUnits: 126,
      avgRevenue: 2687,
      avgPrice: 31.08,
      avgRatings: 406,
      avgRating: 4.5,
      avgSellers: 3.2,
      grossMargin: 53.03,
      newItems: 1,
      newRatio: 1.75,
      productCr3: 0.705,
      brandCr3: 0.707,
      sellerCr3: 0.813,
      topProductsCount: '57',
      goodsTotal: '63,042',
      fetchedAt: '2026-11-11T00:00:00.000Z',
      source: 'stub:类目报告',
    });
    providers.sellerspriteWebProvider.topProducts = async () => ({
      rows: [
        { rank: 1, asin: 'B0D9ZHRH11', title: 'Door Security Bar', brand: 'BRINKS', price: 37.27, units: 1185, revenue: 44165, rating: 4.6, reviews: 9247, listedDate: '2024-07-24', fulfillment: 'AMZ', buyBox: 'Amazon', fbaFee: 10.07, margin: 56, variants: 5, sellers: 2 },
        { rank: 2, asin: 'B0HHG7PGLH', title: 'Folding Door Bar', brand: 'BRINKS', price: 49.99, units: 1185, revenue: 59238, rating: 4.6, reviews: 9247, listedDate: '2026-09-02', fulfillment: 'AMZ', buyBox: 'Amazon', fbaFee: 6.89, margin: 71, variants: 5, sellers: 2 },
      ],
      count: 2,
      fetchedAt: '2026-11-11T00:00:00.000Z',
      source: 'stub:查竞品',
    });

    try {
      const result = await selectCategoryWeb({
        marketplace: 'US',
        category: 'Hardware',
        limit: 50,
        unitCost: 3,
        outputRoot: dir,
      });
      assert.equal(result.ok, true);
      assert.equal(result.nodeIdPath, '228013:511228', '应按最长公共前缀推断出所选节点');
      assert.equal(result.score.max, 92);
      assert.ok(result.score.total > 0 && result.score.total <= 92);
      assert.equal(result.market.scaleBasis, 'submarket_sum');
      assert.ok(result.artifacts.some((a) => a.name === 'report.md'));
      assert.ok(result.artifacts.some((a) => a.name === 'tables/sub_markets.csv'));
      assert.ok(result.artifacts.some((a) => a.name === 'tables/top_products.csv'));

      const manifest = JSON.parse(await readFile(join(result.dir, 'manifest.json'), 'utf8'));
      assert.equal(manifest.provider, 'sellersprite-web');
      assert.ok(manifest.sources.marketList);

      const report = await readFile(join(result.dir, 'report.md'), 'utf8');
      assert.match(report, /sellersprite-web/);
      assert.match(report, /样本口径|抽样口径/);
    } finally {
      Object.assign(providers.sellerspriteWebProvider, original);
    }
  });
});
