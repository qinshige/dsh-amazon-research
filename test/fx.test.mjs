import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_COST_FX, DEFAULT_SETTLE_FX, clearFxCache, fetchLiveFx, fxNote, getFx, resolveFx } from '../host/fx.js';
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

test('实时汇率进程内缓存：全局 fetch 使用 mock，零 TTL 强制刷新', async (t) => {
  clearFxCache();
  t.after(clearFxCache);
  let called = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    called += 1;
    return { ok: true, json: async () => ({ rates: { CNY: 6.71 }, date: '2026-11-16' }) };
  });
  const a = await getFx();
  const b = await getFx();
  assert.equal(called, 1);
  assert.deepEqual(b, a);
  await getFx({ cacheTtlMs: 0 });
  assert.equal(called, 2);
});

test('live:false 与部分手动指定：只为缺失项取数', async () => {
  let called = 0;
  const fetchImpl = async () => {
    called += 1;
    return { ok: true, json: async () => ({ rates: { CNY: 7.123456 }, date: '2026-11-16' }) };
  };
  const disabled = await getFx({ live: false, costFx: 7, fetchImpl });
  assert.equal(called, 0);
  assert.equal(disabled.costFxSource, 'manual');
  assert.equal(disabled.settleFxSource, 'default');
  assert.equal(disabled.endpoint, null);
  const partial = await getFx({ costFx: 7, fetchImpl });
  assert.equal(called, 1);
  assert.equal(partial.costFx, 7);
  assert.equal(partial.costFxSource, 'manual');
  assert.equal(partial.settleFx, 7.123456);
  assert.equal(partial.settleFxSource, 'live');
  assert.equal(partial.dataDate, '2026-11-16');
  assert.ok(Number.isFinite(Date.parse(partial.fetchedAt)));
});

test('无效汇率不能冒充手动或实时来源', () => {
  for (const value of [-1, 0, Infinity, NaN, 'bad', true, []]) {
    const fx = resolveFx({ costFx: value, settleFx: value, costFxSource: 'live' });
    assert.equal(fx.costFx, DEFAULT_COST_FX);
    assert.equal(fx.costFxSource, 'default');
    assert.equal(fx.settleFxSource, 'default');
  }
});

test('备用接口成功记录真实端点及接口日期', async () => {
  const urls = [];
  const fx = await getFx({ retries: 0, fetchImpl: async (url) => {
    urls.push(url);
    if (urls.length === 1) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ base: 'USD', date: '2026-11-13', rates: { CNY: 7.2 } }) };
  } });
  assert.equal(urls.length, 2);
  assert.equal(fx.endpoint, urls[1]);
  assert.equal(fx.dataDate, '2026-11-13');
});

test('主接口时间戳与缺失日期不混同抓取日期', async () => {
  const fx = await fetchLiveFx({ fetchImpl: async () => ({ ok: true, json: async () => ({
    base_code: 'USD', time_last_update_unix: Date.parse('2026-11-16T00:00:00Z') / 1000, rates: { CNY: 7.2 },
  }) }) });
  assert.equal(fx.dataDate, '2026-11-16');
  const missing = await fetchLiveFx({ fetchImpl: async () => ({ ok: true, json: async () => ({ rates: { CNY: 7.2 } }) }) });
  assert.equal(missing.dataDate, null);
  assert.ok(missing.fetchedAt);
});

test('响应体挂起也超时并中止，每个尝试计时器均被清理', async (t) => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const pending = new Set();
  t.mock.method(globalThis, 'setTimeout', (...args) => {
    const timer = realSetTimeout(...args);
    pending.add(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer) => {
    pending.delete(timer);
    return realClearTimeout(timer);
  });
  const signals = [];
  const result = await fetchLiveFx({ timeoutMs: 5, retries: 0, fetchImpl: async (_, { signal }) => {
    signals.push(signal);
    return { ok: true, json: () => new Promise(() => {}) };
  } });
  assert.equal(result, null);
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(pending.size, 0);
  for (const fetchImpl of [
    async () => { throw new Error('offline'); },
    async () => ({ ok: false, status: 500 }),
    async () => ({ ok: true, json: async () => { throw new Error('invalid JSON'); } }),
    async () => ({ ok: true, json: async () => ({ rates: { CNY: 7.1 } }) }),
  ]) {
    await fetchLiveFx({ fetchImpl, retries: 0 });
    assert.equal(pending.size, 0);
  }
});


test('请求本身挂起仍有界；错误基准币与接口失败不标 live', async () => {
  const hanging = await fetchLiveFx({ timeoutMs: 5, retries: 0, fetchImpl: () => new Promise(() => {}) });
  assert.equal(hanging, null);
  for (const data of [
    { base: 'EUR', rates: { CNY: 7 } },
    { result: 'error', rates: { CNY: 7 } },
    { rates: { CNY: true } },
    { rates: { CNY: 0 } },
  ]) {
    const fx = await getFx({ retries: 0, fetchImpl: async () => ({ ok: true, json: async () => data }) });
    assert.equal(fx.costFxSource, 'default');
    assert.equal(fx.endpoint, null);
    assert.equal(fx.dataDate, null);
    assert.equal(fx.fetchedAt, null);
  }
});

test('保留重试：首个接口第二次成功不切换来源', async () => {
  const urls = [];
  const fx = await fetchLiveFx({ fetchImpl: async (url) => {
    urls.push(url);
    if (urls.length === 1) throw new Error('temporary');
    return { ok: true, json: async () => ({ rates: { CNY: 7 } }) };
  } });
  assert.equal(urls.length, 2);
  assert.equal(urls[0], urls[1]);
  assert.equal(fx.source, urls[0]);
});
