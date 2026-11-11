import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateNetMargin,
  estimateFbaFee,
  judgeProfit,
  landedCost,
  maxPurchaseCNYForNetMargin,
  NET_MARGIN_REDLINE,
  pickTierPrice,
  SMALL_VOLUME_NET_MARGIN_REDLINE,
} from '../host/sourcing/cost-model.js';
import { profitScoreFromNetMargin, scoreMarket } from '../host/scoring.js';
import { renderCategoryReport } from '../host/report.js';
import { selectCategoryWeb } from '../host/category-web.js';

const closeTo = (actual, expected, tolerance, label) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, (label || '数值') + ' 期望 ' + expected + '，实际 ' + actual);
};

/* ------------------------------------------------------------------ */
/* 成本模型                                                             */
/* ------------------------------------------------------------------ */

test('landedCost：按净利率口径拆解全成本（采购 + 头程 + FBA + 佣金 + 广告 + 退货 + 其它）', () => {
  const result = landedCost({ priceCNY: 2.8, weightG: 67, priceUSD: 23.99 });
  assert.ok(result, '应返回测算结果');
  closeTo(result.purchaseUSD, 2.8 / 7.1, 0.001, '采购$');
  closeTo(result.firstMileUSD, (67 / 1000) * 35 / 7.1, 0.001, '头程$');
  closeTo(result.fbaFeeUSD, 3.22, 0.001, 'FBA$（≤4oz 档）');
  closeTo(result.referralUSD, 23.99 * 0.15, 0.001, '佣金$');
  closeTo(result.adUSD, 23.99 * 0.1, 0.001, '广告$');
  closeTo(result.returnUSD, 23.99 * 0.05, 0.001, '退货$');
  closeTo(result.otherUSD, 0.35, 0.001, '其它$');
  closeTo(result.totalCostUSD,
    result.purchaseUSD + result.firstMileUSD + result.referralUSD + result.fbaFeeUSD + result.adUSD + result.returnUSD + result.otherUSD,
    0.01, '全成本$');
  closeTo(result.netMargin, result.netProfitUSD / 23.99, 0.001, '净利率 = 净利 ÷ 售价');
  closeTo(result.grossMargin, (23.99 - result.purchaseUSD - result.firstMileUSD - result.fbaFeeUSD) / 23.99, 0.001, '毛利率只扣货与物流');
  assert.ok(result.grossMargin > result.netMargin, '毛利率口径必然高于净利率口径');
});

test('landedCost：notes 逐项标注「实测值 / 估算值」', () => {
  const result = landedCost({ priceCNY: 2.8, weightG: 67, priceUSD: 23.99 });
  const joined = result.notes.join('\n');
  assert.match(joined, /采购价 ¥2\.80（实测值/);
  assert.match(joined, /汇率 7\.1 CNY\/USD（估算值/);
  assert.match(joined, /头程 ¥35\/kg（估算值/);
  assert.match(joined, /FBA 配送费 \$3\.22（估算值/);
  assert.match(joined, /广告 10\.00%（估算值/);
  assert.match(joined, /退货损耗 5\.00%（估算值/);
  assert.match(joined, /仓储\/其它 \$0\.35（估算值/);
});

test('landedCost：给定 FBA 费时按实测值标注且 fbaEstimated=false', () => {
  const result = landedCost({ priceCNY: 2.8, weightG: 67, priceUSD: 23.99, fbaFeeUSD: 4.15 });
  assert.equal(result.fbaEstimated, false);
  closeTo(result.fbaFeeUSD, 4.15, 0.001, 'FBA$');
  assert.match(result.notes.join('\n'), /FBA 配送费 \$4\.15（实测值/);
});

test('landedCost：缺售价或采购价返回 null（不编造数据）', () => {
  assert.equal(landedCost({ priceCNY: 2.8, weightG: 67 }), null);
  assert.equal(landedCost({ priceCNY: 2.8, weightG: 67, priceUSD: 0 }), null);
  assert.equal(landedCost({ priceCNY: null, priceUSD: 20 }), null);
});

test('landedCost：退货率可传真实子市场退货率（标注实测值）', () => {
  const result = landedCost({ priceCNY: 5, weightG: 100, priceUSD: 27.04, returnRate: 0.1611, sources: { return: '实测值' } });
  closeTo(result.returnUSD, 27.04 * 0.1611, 0.001, '退货$');
  assert.match(result.notes.join('\n'), /退货损耗 16\.11%（实测值/);
});

test('estimateFbaFee：按件重落在美国站小号标准件档位（估算值）', () => {
  assert.equal(estimateFbaFee(50).feeUSD, 3.22);
  assert.equal(estimateFbaFee(113).feeUSD, 3.22);
  assert.equal(estimateFbaFee(150).feeUSD, 3.4);
  assert.equal(estimateFbaFee(250).feeUSD, 3.55);
  assert.equal(estimateFbaFee(400).feeUSD, 3.77);
  assert.equal(estimateFbaFee(600).feeUSD, 5.3);
  assert.equal(estimateFbaFee(null).estimated, true);
  assert.equal(estimateFbaFee(null).feeUSD, 3.22);
});

test('pickTierPrice：取起批量对应价（最小 qty 档），不用搜索页卡片价', () => {
  const picked = pickTierPrice([{ qty: 5000, priceCNY: 0.7 }, { qty: 2, priceCNY: 0.75 }]);
  assert.equal(picked.priceCNY, 0.75);
  assert.equal(picked.qty, 2);
  assert.equal(pickTierPrice([]), null);
});

/* ------------------------------------------------------------------ */
/* 红线判定                                                             */
/* ------------------------------------------------------------------ */

test('judgeProfit：净利率 > 25% 通过；> 30% 同时过体量红线', () => {
  const ok = judgeProfit({ netMargin: 0.28, logisticsRatio: 0.12, purchaseRatio: 0.08, priceUSD: 25, purchaseCNY: 14, fbaFeeUSD: 3.4 });
  assert.equal(ok.checks[0].status, '通过');
  assert.equal(ok.verdict, '通过');
  const strong = judgeProfit({ netMargin: 0.33, logisticsRatio: 0.12, purchaseRatio: 0.08, priceUSD: 25, purchaseCNY: 14, fbaFeeUSD: 3.4 });
  assert.match(strong.checks[0].note, /体量红线/);
});

test('judgeProfit：体量小（≤200 单）时 25%–30% 判「未达小体量红线」', () => {
  const judge = judgeProfit({ netMargin: 0.27, logisticsRatio: 0.12, purchaseRatio: 0.05, priceUSD: 25, smallVolume: true });
  assert.equal(judge.checks[0].status, '未达小体量红线');
  assert.equal(judge.verdict, '未达小体量红线');
});

test('judgeProfit：物流占售价 > 20% 提示放弃', () => {
  const judge = judgeProfit({ netMargin: 0.4, logisticsRatio: 0.28, purchaseRatio: 0.05, priceUSD: 10.14 });
  assert.equal(judge.checks[1].status, '提示放弃');
  assert.equal(judge.verdict, '提示放弃');
});

test('judgeProfit：物流占售价落在 10%–15% 理想带为通过', () => {
  const judge = judgeProfit({ netMargin: 0.4, logisticsRatio: 0.13, purchaseRatio: 0.05, priceUSD: 25 });
  assert.equal(judge.checks[1].status, '通过');
});

test('judgeProfit：采购占售价 > 25% 判未达标', () => {
  const judge = judgeProfit({ netMargin: 0.3, logisticsRatio: 0.12, purchaseRatio: 0.3, priceUSD: 25 });
  assert.equal(judge.checks[2].status, '未达标');
});

test('judgeProfit：$15–20 售价段硬约束（采购 ≤ ¥30 且 FBA < $4.5）', () => {
  const hit = judgeProfit({ netMargin: 0.3, logisticsRatio: 0.12, purchaseRatio: 0.1, priceUSD: 18, purchaseCNY: 24, fbaFeeUSD: 4.1 });
  assert.equal(hit.checks[3].status, '通过');
  const miss = judgeProfit({ netMargin: 0.3, logisticsRatio: 0.12, purchaseRatio: 0.1, priceUSD: 18, purchaseCNY: 34, fbaFeeUSD: 5.2 });
  assert.equal(miss.checks[3].status, '未达标');
  const outside = judgeProfit({ netMargin: 0.3, logisticsRatio: 0.12, purchaseRatio: 0.1, priceUSD: 27.04, purchaseCNY: 34, fbaFeeUSD: 5.2 });
  assert.equal(outside.checks[3].status, '不适用');
});

/* ------------------------------------------------------------------ */
/* 净利率加权与利润维度                                                   */
/* ------------------------------------------------------------------ */

test('aggregateNetMargin：按子市场月总销量加权并给出覆盖度', () => {
  const agg = aggregateNetMargin([
    { name: 'A', netMargin: 0.3, units: 100, priceUSD: 10 },
    { name: 'B', netMargin: 0.1, units: 300, priceUSD: 20 },
  ], { totalUnits: 500 });
  closeTo(agg.netMargin, (0.3 * 100 + 0.1 * 300) / 400, 0.0001, '加权净利率');
  assert.equal(agg.basis, '按子市场月总销量加权');
  closeTo(agg.coverageRatio, 0.8, 0.0001, '覆盖度');
});

test('aggregateNetMargin：缺净利率的子市场不参与加权但计入缺失数', () => {
  const agg = aggregateNetMargin([
    { name: 'A', netMargin: 0.3, units: 100 },
    { name: 'B', netMargin: null, units: 100 },
  ], { totalUnits: 200 });
  assert.equal(agg.count, 1);
  assert.equal(agg.missingCount, 1);
  closeTo(agg.netMargin, 0.3, 0.0001, '加权净利率');
});

test('profitScoreFromNetMargin：净利率档位与知识库红线一致', () => {
  assert.equal(profitScoreFromNetMargin({ netMargin: 0.35 }).score, 12);
  assert.equal(profitScoreFromNetMargin({ netMargin: 0.26 }).score, 10);
  assert.equal(profitScoreFromNetMargin({ netMargin: 0.2 }).score, 7);
  assert.equal(profitScoreFromNetMargin({ netMargin: 0.05 }).score, 4);
  assert.equal(profitScoreFromNetMargin({ netMargin: -0.02 }).score, 0);
  assert.equal(profitScoreFromNetMargin({ netMargin: 0 }).score, 0);
});

test('profitScoreFromNetMargin：缺净利率 → 最低档且标 missing（不编造数据）', () => {
  const scored = profitScoreFromNetMargin({ netMargin: null });
  assert.equal(scored.score, 0);
  assert.equal(scored.missing, true);
  assert.equal(scored.basis, 'net_margin');
});

test('profitScoreFromNetMargin：detail/notes 写明是净利率口径、与上游毛利口径不可比', () => {
  const scored = profitScoreFromNetMargin({ netMargin: 0.27, priceUSD: 12 });
  assert.match(scored.detail, /净利率口径/);
  assert.ok(scored.notes.some((note) => note.includes('不可直接比较')));
});

test('scoreMarket：拿到真实净利率时替换利润空间维度（basis=net_margin）', () => {
  const market = {
    totals: { revenue: 9_000_000 },
    avgs: { price: 31.08 },
    concentration: { top3BrandCrn: 0.707 },
    structure: { amazonSelfProportion: 6 },
    distributions: { ratingsCount: [{ label: '0-100', units: 60 }, { label: '301-1000', units: 40 }] },
    products: [],
  };
  const fallback = scoreMarket(market);
  const fallbackProfit = fallback.dimensions.find((dimension) => dimension.key === 'profit_margin');
  assert.equal(fallbackProfit.inputs.basis, 'avg_price', '无成本时保留按均价档位兜底');

  const withCost = scoreMarket(market, { unitCost: 3 });
  assert.equal(withCost.dimensions.find((dimension) => dimension.key === 'profit_margin').inputs.basis, 'unit_cost');

  const withNet = scoreMarket(market, {
    profitBySubMarket: [
      { name: 'A', netMargin: 0.32, units: 362426, priceUSD: 10.14 },
      { name: 'B', netMargin: 0.12, units: 204966, priceUSD: 27.04 },
    ],
    totalUnits: 567392,
  });
  const profit = withNet.dimensions.find((dimension) => dimension.key === 'profit_margin');
  assert.equal(profit.inputs.basis, 'net_margin');
  assert.equal(profit.inputs.missing, false, '真实净利率不算缺数（不触发 inputs.missing 守卫）');
  closeTo(profit.inputs.netMargin, (0.32 * 362426 + 0.12 * 204966) / 567392, 0.0001, '按月销量加权的净利率');
  assert.match(profit.detail, /净利率口径/);
  assert.ok(withNet.notes.some((note) => note.includes('不可直接比较')));
});

/* ------------------------------------------------------------------ */
/* 报告第八章                                                           */
/* ------------------------------------------------------------------ */

function profitFixtureMarket() {
  return {
    provider: 'sellersprite-web',
    marketplace: 'US',
    label: 'Hardware',
    totals: { products: 63042, units: 1428914, revenue: 44400000 },
    avgs: { price: 31.08 },
    concentration: { top3BrandCrn: 0.707 },
    structure: { amazonSelfProportion: 6 },
    newRatio: { l1: 0.0175 },
    distributions: { ratingsCount: [{ label: '0-100', units: 60 }] },
    products: [],
    subMarkets: [
      { name: 'Furniture Pads (脚垫)', totalUnits: 362426, averagePrice: 10.14 },
      { name: 'Pulls (拉手)', totalUnits: 204966, averagePrice: 27.04 },
    ],
    sourcing: [
      {
        name: 'Furniture Pads (脚垫)', keyword: 'furniture pads', offerId: '930991226514',
        priceCNY: 2.8, moq: 5000, material: '塑料', weightG: 67,
        offerUrl: 'https://detail.1688.com/offer/930991226514.html', verified: true,
      },
    ],
    profitBySubMarket: [
      {
        name: 'Furniture Pads (脚垫)', keyword: 'furniture pads', units: 362426,
        priceUSD: 10.14, purchaseUSD: 0.3944, firstMileUSD: 0.3303, fbaFeeUSD: 3.22, fbaEstimated: true,
        referralUSD: 1.521, adUSD: 1.014, returnUSD: 0.5202, otherUSD: 0.35,
        totalCostUSD: 7.3499, netProfitUSD: 2.7901, netMargin: 0.2751, grossMargin: 0.6355,
        logisticsUSD: 3.5503, logisticsRatio: 0.3501, purchaseRatio: 0.0389,
        sellerSpriteMargin: 56, verdict: '提示放弃',
        checks: [
          { key: 'net_margin', name: '净利率判定', rule: '净利率 > 25%（体量小需 > 30%）', value: '27.51%', status: '通过', note: '过主红线 25%' },
          { key: 'logistics', name: '物流占售价比', rule: '目标 10%–15%，> 20% 提示放弃', value: '35.01%', status: '提示放弃', note: '超过 20%' },
        ],
      },
    ],
  };
}

test('renderCategoryReport：第八章渲染逐子市场测算表 + 口径说明', () => {
  const market = profitFixtureMarket();
  const score = scoreMarket(market, { profitBySubMarket: market.profitBySubMarket });
  const report = renderCategoryReport({ market, score, site: 'US', generatedAt: '2026-11-11T00:00:00.000Z' });
  assert.match(report, /## 八、1688 采购价与净利测算/);
  assert.match(report, /净利率口径/);
  assert.match(report, /不可直接比较/);
  assert.match(report, /Furniture Pads/);
  assert.match(report, /提示放弃/);
  assert.match(report, /930991226514/);
  assert.match(report, /卖家精灵毛利率（参照）/);
  assert.match(report, /净利\$/);
});

test('renderCategoryReport：没有 1688 成本时第八章写「未接入 1688 采购成本，本章不产出」', () => {
  const market = { totals: { revenue: 1000 }, avgs: { price: 20 }, products: [] };
  const score = scoreMarket(market);
  const report = renderCategoryReport({ market, score, site: 'US', generatedAt: '2026-11-11T00:00:00.000Z' });
  assert.match(report, /未接入 1688 采购成本，本章不产出/);
});
/* ------------------------------------------------------------------ */
/* category-web：costs 参数 → sourcing[] / profitBySubMarket[] + CSV 落盘 */
/* ------------------------------------------------------------------ */

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-cost-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('category-web：接入 costs 后产出 sourcing / profitBySubMarket 与两张 CSV，利润维度换成净利率档', async () => {
  await withTempDir(async (dir) => {
    const providers = await import('../host/providers/sellersprite-web.js');
    const original = { ...providers.sellerspriteWebProvider };
    providers.sellerspriteWebProvider.marketList = async () => ({
      rows: [
        {
          rank: 1, name: 'Furniture Pads (脚垫)', nodeIdPath: '228013:511228:2380872011',
          totalUnits: 362426, averagePrice: 10.14,
          concentration: { brandCr3: 0.703, productCr3: 0.389, sellerCr3: 0.707 },
          structure: { fbaProportion: 91, amazonSelfProportion: 6, fbmProportion: 0 },
          newItems: { count: 3, ratio: 3 }, goodsTotal: 4995, returnRate: 5.13,
        },
        {
          rank: 2, name: 'Pulls (拉手)', nodeIdPath: '228013:511228:2380871011:511260',
          totalUnits: 204966, averagePrice: 27.04,
          concentration: { brandCr3: 0.792, productCr3: 0.262, sellerCr3: 0.792 },
          structure: { fbaProportion: 95, amazonSelfProportion: 3, fbmProportion: 0 },
          newItems: { count: 2, ratio: 2 }, goodsTotal: 2100, returnRate: 16.11,
        },
      ],
      count: 2, fetchedAt: '2026-11-11T00:00:00.000Z', source: 'stub:选市场',
    });
    providers.sellerspriteWebProvider.nodeReport = async () => ({
      title: 'Hardware', sampleProducts: 57, avgBsr: 334538, avgUnits: 126, avgRevenue: 2687,
      avgPrice: 31.08, avgRatings: 406, avgRating: 4.5, avgSellers: 3.2, grossMargin: 53.03,
      newItems: 1, newRatio: 1.75, productCr3: 0.705, brandCr3: 0.707, sellerCr3: 0.813,
      topProductsCount: '57', goodsTotal: '63,042', fetchedAt: '2026-11-11T00:00:00.000Z', source: 'stub:类目报告',
    });
    providers.sellerspriteWebProvider.topProducts = async () => ({
      rows: [
        { rank: 1, asin: 'B0D9ZHRH11', title: 'Door Security Bar', brand: 'BRINKS', price: 10.5, units: 1185, revenue: 12442, rating: 4.6, reviews: 9247, listedDate: '2024-07-24', fulfillment: 'FBA', buyBox: 'JIAWONG', fbaFee: 3.22, margin: 56, variants: 5, sellers: 2, weight: '0.07 kg', packWeight: '0.09 kg' },
        { rank: 2, asin: 'B0HHG7PGLH', title: 'Folding Door Bar', brand: 'BRINKS', price: 26.9, units: 1185, revenue: 31876, rating: 4.6, reviews: 9247, listedDate: '2026-09-02', fulfillment: 'FBA', buyBox: 'JIAWONG', fbaFee: 5.5, margin: 71, variants: 5, sellers: 2, weight: '0.3 kg', packWeight: '0.35 kg' },
      ],
      count: 2, fetchedAt: '2026-11-11T00:00:00.000Z', source: 'stub:查竞品',
    });

    try {
      const result = await selectCategoryWeb({
        marketplace: 'US',
        category: 'Hardware',
        limit: 50,
        outputRoot: dir,
        costs: [
          {
            name: 'Furniture Pads (脚垫)', keyword: 'furniture pads', priceCNY: 2.8, weightG: 67,
            moq: 5000, offerUrl: 'https://detail.1688.com/offer/930991226514.html', verified: true,
          },
          {
            name: 'Pulls (拉手)', keyword: 'cabinet pulls', priceCNY: 3.6, weightG: 120,
            moq: '2件起批', offerUrl: 'https://detail.1688.com/offer/123456.html', verified: '已进详情页验证',
          },
        ],
      });
      assert.equal(result.ok, true);
      assert.equal(result.profit.available, true);
      assert.equal(result.profit.rows.length, 2);

      const market = JSON.parse(await readFile(join(result.dir, 'market.json'), 'utf8'));
      assert.equal(market.sourcing.length, 2, 'market.json 应有 sourcing 明细');
      assert.equal(market.profitBySubMarket.length, 2, 'market.json 应有 profitBySubMarket 测算');
      assert.equal(market.profitBySubMarket[0].priceUSD, 10.14, '售价取子市场均价');
      closeTo(market.profitBySubMarket[0].returnRate, 0.0513, 0.0001, '脚垫退货率用真实 5.13%');
      closeTo(market.profitBySubMarket[1].returnRate, 0.1611, 0.0001, '拉手退货率用真实 16.11%');
      assert.equal(market.profitBySubMarket[0].fbaEstimated, false, '有 fbaFee 样本 → 实测值');
      assert.equal(market.profitBySubMarket[0].fbaFeeUSD, 3.22);
      assert.equal(market.sourcing[1].verified, true, '验证状态兼容文案写法');
      assert.equal(market.sourcing[1].moqText, '2件起批', '起批量兼容文案写法');
      assert.ok(market.profitNetMargin !== null, '应算出加权净利率');
      assert.match(market.profitBasis, /月总销量加权/);
      assert.ok(market.profitCoverage > 0 && market.profitCoverage <= 1);
      assert.ok(market.profitScopeNote.includes('不是全类目净利率'));

      const profitCsv = await readFile(join(result.dir, 'tables/profit_by_submarket.csv'), 'utf8');
      assert.match(profitCsv, /子市场,售价,采购\$,头程\$,FBA\$,佣金\$,广告\$,退货\$,其它\$,全成本\$,净利\$,净利率/);
      assert.match(profitCsv, /Furniture Pads/);
      const sourcingCsv = await readFile(join(result.dir, 'tables/sourcing_1688.csv'), 'utf8');
      assert.match(sourcingCsv, /子市场,关键词,offerId,采购价\(元\)\/可售单位,包装规格对齐,Amazon包装数,起批量,材质,件重\(g\),链接,验证状态,对齐说明/);
      assert.match(sourcingCsv, /930991226514/);

      const report = await readFile(join(result.dir, 'report.md'), 'utf8');
      assert.match(report, /## 八、1688 采购价与净利测算/);
      assert.match(report, /Furniture Pads/);
      assert.match(report, /Pulls/);
      assert.ok(!report.includes('未接入 1688 采购成本，本章不产出'));

      const profitDimension = result.score.dimensions.find((dimension) => dimension.key === 'profit_margin');
      assert.equal(profitDimension.inputs.basis, 'net_margin');
      assert.equal(profitDimension.inputs.missing, false);
    } finally {
      Object.assign(providers.sellerspriteWebProvider, original);
    }
  });
});

test('category-web：没有 costs 时不产出 sourcing / profitBySubMarket，报告第八章写未接入', async () => {
  await withTempDir(async (dir) => {
    const providers = await import('../host/providers/sellersprite-web.js');
    const original = { ...providers.sellerspriteWebProvider };
    providers.sellerspriteWebProvider.marketList = async () => ({
      rows: [{
        rank: 1, name: 'Furniture Pads (脚垫)', nodeIdPath: '228013:511228:2380872011',
        totalUnits: 362426, averagePrice: 10.14,
        concentration: { brandCr3: 0.703, productCr3: 0.389, sellerCr3: 0.707 },
        structure: { fbaProportion: 91, amazonSelfProportion: 6, fbmProportion: 0 },
        newItems: { count: 3, ratio: 3 }, goodsTotal: 4995, returnRate: 5.13,
      }],
      count: 1, fetchedAt: '2026-11-11T00:00:00.000Z', source: 'stub:选市场',
    });
    providers.sellerspriteWebProvider.nodeReport = async () => ({
      title: 'Hardware', sampleProducts: 57, avgUnits: 126, avgRevenue: 2687, avgPrice: 31.08,
      avgRatings: 406, avgRating: 4.5, avgSellers: 3.2, grossMargin: 53.03, newItems: 1, newRatio: 1.75,
      productCr3: 0.705, brandCr3: 0.707, sellerCr3: 0.813, topProductsCount: '57', goodsTotal: '63,042',
      fetchedAt: '2026-11-11T00:00:00.000Z', source: 'stub:类目报告',
    });
    providers.sellerspriteWebProvider.topProducts = async () => ({ rows: [], count: 0, fetchedAt: '2026-11-11T00:00:00.000Z', source: 'stub:查竞品' });
    try {
      const result = await selectCategoryWeb({ marketplace: 'US', category: 'Hardware', limit: 50, outputRoot: dir });
      assert.equal(result.profit.available, false);
      const market = JSON.parse(await readFile(join(result.dir, 'market.json'), 'utf8'));
      assert.deepEqual(market.sourcing, []);
      assert.deepEqual(market.profitBySubMarket, []);
      const report = await readFile(join(result.dir, 'report.md'), 'utf8');
      assert.match(report, /未接入 1688 采购成本，本章不产出/);
    } finally {
      Object.assign(providers.sellerspriteWebProvider, original);
    }
  });
});

/* ------------------------------------------------------------------ */
/* research_unit_cost 工具                                              */
/* ------------------------------------------------------------------ */

test('research_unit_cost：已注册，描述写明会打开 1688 页面并消耗网页端查询次数', async () => {
  const { createTools } = await import('../host/tools.js');
  const tools = createTools({ ctx: {}, dataDir: '/tmp', secrets: null, providers: null, version: 'test' });
  const tool = tools.find((item) => item.name === 'research_unit_cost');
  assert.ok(tool, '应注册 research_unit_cost 工具');
  assert.match(tool.description, /会打开 1688 页面并消耗网页端查询次数/);
  assert.match(tool.description, /净利率/);
  assert.ok(tool.parameters.properties.subMarkets, '应接受 subMarkets 参数');
  assert.ok(tool.parameters.properties.limit, '应接受 limit 参数');
  assert.ok(tool.parameters.properties.provider, '应接受 provider 参数');
});

test('research_unit_cost：缺 subMarkets 与 category 时返回 INVALID_ARGS（不发网络请求）', async () => {
  const { createTools } = await import('../host/tools.js');
  const tools = createTools({ ctx: {}, dataDir: '/tmp', secrets: null, providers: null, version: 'test' });
  const tool = tools.find((item) => item.name === 'research_unit_cost');
  const result = await tool.execute({});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_ARGS');
});


test('maxPurchaseCNYForNetMargin：按 25% 红线倒推采购价上限', () => {
  const result = maxPurchaseCNYForNetMargin({ priceUSD: 23.99, weightG: 67, fbaFeeUSD: 3.22, returnRate: 0.05 });
  const expectedCNY = (23.99 * (1 - 0.15 - 0.10 - 0.05 - 0.25) - result.firstMileUSD - 3.22 - 0.35) * 7.1;
  closeTo(result.maxPurchaseCNY, expectedCNY, 0.02, '采购价上限（¥）');
  assert.ok(result.maxPurchaseCNY > 45 && result.maxPurchaseCNY < 55, '售价 23.99 的小件采购上限约 ¥49');
  assert.equal(maxPurchaseCNYForNetMargin({ priceUSD: 5 }), null, '售价撑不起红线时返回 null');
});

