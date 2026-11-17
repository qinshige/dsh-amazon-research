import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_COST_FX, DEFAULT_SETTLE_FX, clearFxCache, fxNote, getFx, resolveFx } from '../host/fx.js';
import { landedCost } from '../host/sourcing/cost-model.js';

test('默认汇率：成本 6.7、结算 6.6', () => {
  assert.equal(DEFAULT_COST_FX, 6.7);
  assert.equal(DEFAULT_SETTLE_FX, 6.6);
  const fx = resolveFx();
  assert.equal(fx.costFx, 6.7);
  assert.equal(fx.settleFx, 6.6);
  assert.equal(fx.costFxSource, 'default');
});

test('手动指定的汇率优先，且来源标为 manual', () => {
  const fx = resolveFx({ costFx: 6.75, settleFx: 6.65 });
  assert.equal(fx.costFx, 6.75);
  assert.equal(fx.settleFx, 6.65);
  assert.equal(fx.costFxSource, 'manual');
  assert.equal(fx.settleFxSource, 'manual');
});

test('实时汇率取不到时回落默认值，不抛错', async () => {
  const fx = await getFx({ live: true, fetchImpl: async () => { throw new Error('network down'); } });
  assert.equal(fx.costFx, 6.7);
  assert.equal(fx.settleFx, 6.6);
  assert.equal(fx.costFxSource, 'default');
});

test('实时汇率可用时成本与结算都用实时值', async () => {
  const fx = await getFx({
    live: true,
    fetchImpl: async () => ({ ok: true, json: async () => ({ rates: { CNY: 6.85 } }) }),
  });
  assert.equal(fx.costFx, 6.85);
  assert.equal(fx.settleFx, 6.85);
  assert.equal(fx.costFxSource, 'live');
  assert.ok(fx.fetchedAt);
});

test('成本汇率影响人民币成本折美元，结算汇率不影响净利率', () => {
  const base = landedCost({ priceCNY: 26.9, weightG: 90, priceUSD: 19.99 });
  const a = landedCost({ priceCNY: 26.9, weightG: 90, priceUSD: 19.99, costFx: 6.7, settleFx: 6.6 });
  const b = landedCost({ priceCNY: 26.9, weightG: 90, priceUSD: 19.99, costFx: 7.1, settleFx: 6.6 });
  assert.equal(a.purchaseUSD, Number((26.9 / 6.7).toFixed(4)));
  assert.equal(b.purchaseUSD, Number((26.9 / 7.1).toFixed(4)));
  // 成本汇率越高 → 人民币成本折美元越少 → 美元成本越低 → 净利率越高
  assert.ok(a.netMargin < b.netMargin);
  assert.ok(a.totalCostUSD > b.totalCostUSD);
  // 净利率只由美元口径决定，结算汇率改它不动
  const c = landedCost({ priceCNY: 26.9, weightG: 90, priceUSD: 19.99, costFx: 6.7, settleFx: 7.2 });
  assert.equal(c.netMargin, a.netMargin);
  // 但人民币利润额随结算汇率变化
  assert.notEqual(c.netProfitCNY, a.netProfitCNY);
});

test('人民币口径：净利 = 净利美元 × 结算汇率，总成本同理', () => {
  const r = landedCost({ priceCNY: 26.9, weightG: 90, priceUSD: 19.99, costFx: 6.7, settleFx: 6.6 });
  assert.equal(r.netProfitCNY, Number((r.netProfitUSD * 6.6).toFixed(2)));
  assert.equal(r.totalCostCNY, Number((r.totalCostUSD * 6.6).toFixed(2)));
  assert.equal(r.priceCNY_settle, Number((19.99 * 6.6).toFixed(2)));
  assert.equal(r.costFx, 6.7);
  assert.equal(r.settleFx, 6.6);
});

test('fxNote 一句话说明双汇率口径', () => {
  const note = fxNote(resolveFx());
  assert.match(note, /成本汇率 6\.7/);
  assert.match(note, /结算汇率 6\.6/);
});

test('默认走实时汇率（live 不传即为真）', async () => {
  const fx = await getFx({ fetchImpl: async () => ({ ok: true, json: async () => ({ rates: { CNY: 6.72 } }) }) });
  assert.equal(fx.costFx, 6.72);
  assert.equal(fx.settleFx, 6.72);
  assert.equal(fx.costFxSource, 'live');
});

test('手动指定两个汇率时不再走网络，来源标 manual', async () => {
  let called = 0;
  const fx = await getFx({
    costFx: 6.75,
    settleFx: 6.65,
    fetchImpl: async () => { called += 1; return { ok: true, json: async () => ({ rates: { CNY: 6.9 } }) }; },
  });
  assert.equal(called, 0, '手动指定就不该再请求接口');
  assert.equal(fx.costFx, 6.75);
  assert.equal(fx.settleFx, 6.65);
  assert.equal(fx.costFxSource, 'manual');
});

test('实时汇率进程内缓存：第二次调用不重复请求', async () => {
  clearFxCache();
  let called = 0;
  const impl = async () => { called += 1; return { ok: true, json: async () => ({ rates: { CNY: 6.7 } }) }; };
  const a = await getFx({ fetchImpl: null, live: true });
  assert.ok(a.costFx > 0);
  const before = called;
  const b = await getFx({ live: true });
  assert.equal(called, before, '缓存命中时不应再发请求');
  assert.equal(b.costFx, a.costFx);
  clearFxCache();
});
