import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Exercise retained legacy handlers below the SA-only public adapter. These handlers
// are no longer registered publicly; their historical calculation contract is still tested.
// Mock module boundaries, not tool bodies; keep landedCost and resolveCostProfile real.
test('cost tool schemas and forwarding (offline module mocks)', async (t) => {
  const key = '__costToolsMocks';
  let config = { marketplace: 'US' };
  const calls = { screen: [], fx: [], freight: [] };
  let freightResult = { mode: 'sea', label: '海运', perKgCNY: 20, source: 'live', fetchedAt: '2026-11-17T00:00:00Z', transitDays: '30' };
  const fxResult = { costFx: 8, settleFx: 7, costFxSource: 'live', settleFxSource: 'live', fetchedAt: '2026-11-17T00:00:00Z' };
  const unused = () => { throw new Error('unexpected dependency call'); };
  const mocks = {
    'market/sa-tools.js': { saOnlyTools: (legacy) => legacy },
    'market/macro.js': { buildMacroPlan: unused, runMacroAnalysis: unused },
    'paths.js': { readConfig: async () => config, resolveOutputRoot: () => '/mock-output' },
    'runs.js': { listRuns: unused, readRun: unused },
    'category.js': { selectCategory: unused },
    'category-web.js': { selectCategoryWeb: async () => ({ runId: 'collected', market: { products: [{ asin: 'MOCK' }] } }) },
    'category-trendyol.js': { selectCategoryTrendyol: unused },
    'platforms/index.js': { getPlatform: () => ({ sites: [{ value: 'US' }] }), providerSupportsPlatform: unused, providersForPlatform: unused, resolveSite: unused },
    'selection/channels.js': { buildSelectionPlan: () => ({}) },
    'selection/pipeline.js': {
      parseCsv: unused,
      screenCandidates: async (options) => { calls.screen.push(options); return { ok: true, runId: 'screened', dir: '/mock-output', summary: {}, top: [] }; },
    },
    'selection/from-products.js': { productsToSelectionRows: () => [{ asin: 'MOCK' }] },
    'live.js': { beginSession: async () => {}, endSession: async () => ({}), attachToRun: unused, push: unused },
    'fx.js': { getFx: async (options) => { calls.fx.push(options); return fxResult; } },
    'sourcing/freight.js': { getFreight: async (options) => { calls.freight.push(options); return freightResult; } },
    'sourcing/1688.js': {
      searchOffers: async () => ({ rows: [{ offerId: 'mock', url: 'https://example.invalid/offer', priceCNY: 16 }], source: 'mock' }),
      fetchOfferDetail: async () => ({ priceTiers: [{ minQty: 1, priceCNY: 16 }], weightG: 100, fetchedAt: '2026-11-17T00:00:00Z' }),
    },
  };
  globalThis[key] = mocks;
  const urls = new Map(Object.keys(mocks).map((path) => [new URL('../host/' + path, import.meta.url).href, path]));
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      const path = urls.get(url);
      if (!path) return nextLoad(url, context);
      const source = Object.keys(mocks[path]).map((name) =>
        'export const ' + name + ' = (...args) => globalThis[' + JSON.stringify(key) + '][' + JSON.stringify(path) + '][' + JSON.stringify(name) + '](...args);'
      ).join('\n');
      return { format: 'module', source, shortCircuit: true };
    },
  });
  t.after(() => { hooks.deregister(); delete globalThis[key]; });
  const { createTools } = await import('../host/tools.js?cost-tools-test');
  const tools = createTools({ dataDir: '/mock-data' });
  const product = tools.find((tool) => tool.name === 'research_product_select');
  const unit = tools.find((tool) => tool.name === 'research_unit_cost');
  const subMarkets = [{ keyword: 'mock', avgPriceUSD: 20 }];

  await t.test('both public schemas accept identical cost options with explicit user defaults', () => {
    for (const name of ['fx', 'costFx', 'settleFx', 'liveFx', 'costProfile', 'freightMode', 'freightPerKgCNY', 'freightApiUrl']) {
      assert.ok(product.parameters.properties[name], name);
      assert.deepEqual(unit.parameters.properties[name], product.parameters.properties[name]);
    }
    const profile = product.parameters.properties.costProfile;
    assert.equal(profile.additionalProperties, false);
    for (const [name, value] of Object.entries({ adRate: 0.10, returnRate: 0.05, referralRate: 0.06, otherUSD: 0 })) {
      assert.equal(profile.properties[name].default, value);
    }
    assert.deepEqual(product.parameters.properties.freightMode.enum, ['sea', 'air', 'express']);
    assert.equal(product.parameters.properties.freightPerKgCNY.exclusiveMinimum, 0);
  });

  const explicit = { costProfile: { adRate: 0, returnRate: 0.02, referralRate: 0.15, otherUSD: 0, freightMode: 'sea' }, freightMode: 'air', freightPerKgCNY: 48, freightApiUrl: 'https://example.invalid/rates', fx: 7.1, costFx: 7.2, settleFx: 7, liveFx: false };
  for (const action of ['screen', 'collect']) {
    await t.test(action + ' forwards every explicit option without dropping zero fees', async () => {
      const result = await product.execute({ action, category: 'mock', rows: [{ asin: 'MOCK' }], ...explicit });
      assert.equal(result.ok, true);
      const passed = calls.screen.at(-1);
      for (const [name, value] of Object.entries(explicit)) assert.deepEqual(passed[name], value, name);
    });
  }
  await t.test('legacy fx alias becomes costFx; omitted costs remain unknown and use config endpoint', async () => {
    config = { freight: { apiUrl: 'https://example.invalid/config' } };
    await product.execute({ action: 'screen', rows: [{}], fx: 7.4 });
    const passed = calls.screen.at(-1);
    assert.equal(passed.costFx, 7.4);
    assert.equal(passed.settleFx, null);
    assert.equal(passed.freightPerKgCNY, null);
    assert.equal(passed.freightApiUrl, config.freight.apiUrl);
    assert.equal(passed.liveFx, true);
    assert.deepEqual(passed.costProfile, {});
    config = {};
  });
  await t.test('collect thenScreen=false does not fetch cost data or screen', async () => {
    const count = calls.screen.length;
    await product.execute({ action: 'collect', category: 'mock', thenScreen: false, ...explicit });
    assert.equal(calls.screen.length, count);
    assert.equal(calls.fx.length, 0);
    assert.equal(calls.freight.length, 0);
  });
  await t.test('unit cost gets live rates once and applies default user profile', async () => {
    const result = await unit.execute({ subMarkets });
    assert.equal(result.ok, true);
    assert.deepEqual(calls.fx.at(-1), { live: true, costFx: null, settleFx: null });
    assert.deepEqual(calls.freight.at(-1), { mode: 'sea', perKgCNY: null, apiUrl: undefined, live: false });
    assert.equal(calls.fx.length, 1);
    assert.equal(calls.freight.length, 1);
    assert.deepEqual(result.fx, fxResult);
    assert.deepEqual(result.freight, freightResult);
    assert.equal(result.profit.length, 1);
    const profit = result.profit[0];
    assert.equal(profit.purchaseUSD, 2);
    assert.equal(profit.firstMileUSD, 0.25);
    assert.equal(profit.referralUSD, 1.2);
    assert.equal(profit.adUSD, 2);
    assert.equal(profit.returnUSD, 1);
    assert.equal(profit.otherUSD, 0);
  });
  await t.test('unit cost respects explicit profile and mode, FX alias precedence and endpoint', async () => {
    const result = await unit.execute({ subMarkets, ...explicit });
    assert.deepEqual(calls.fx.at(-1), { live: false, costFx: 7.2, settleFx: 7 });
    assert.deepEqual(calls.freight.at(-1), { mode: 'air', perKgCNY: 48, apiUrl: explicit.freightApiUrl, live: true });
    assert.equal(result.costProfile.freightMode, 'air');
    assert.equal(result.profit[0].referralUSD, 3);
    assert.equal(result.profit[0].adUSD, 0);
    assert.equal(result.profit[0].returnUSD, 0.4);
  });
  await t.test('unit cost supports profile-only freight mode and configured endpoint', async () => {
    config = { freight: { apiUrl: 'https://example.invalid/config' } };
    await unit.execute({ subMarkets, fx: 7.4, costProfile: { freightMode: 'express' } });
    assert.equal(calls.fx.at(-1).costFx, 7.4);
    assert.equal(calls.freight.at(-1).mode, 'express');
    assert.equal(calls.freight.at(-1).apiUrl, config.freight.apiUrl);
    config = {};
  });
  await t.test('missing freight stays null: real landedCost refuses profit instead of zero/estimate', async () => {
    freightResult = { mode: 'sea', perKgCNY: null, source: 'missing', fetchedAt: null };
    const result = await unit.execute({ subMarkets });
    assert.equal(result.ok, true);
    assert.equal(result.offers.length, 1);
    assert.deepEqual(result.profit, []);
    assert.equal(result.freight.perKgCNY, null);
    assert.ok(result.warnings.some((warning) => warning.includes('头程运价未取到')));
  });
});
