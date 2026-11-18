import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSaudiOffers, prepareSaudiCandidate, buildSaudiSourcingPlan, SAUDI_SELECTION_SCHEMA } from '../host/sourcing/saudi.js';
import { buildTrendyolPlan } from '../host/market/trendyol-workflow.js';

// Synthetic offline fixtures only: these are not real supplier quotations or identity evidence.
const date = '2026-11-18T00:00:00.000Z';
const url = 'https://detail.1688.com/offer/123456.html';
const ev = () => ({ source: url, observedAt: date, evidence: 'SYNTHETIC offline fixture, not real verification' });
export function saudiSourcingFixture() {
  const candidate = buildTrendyolPlan().inputTemplate;
  candidate.route.type = 'LD';
  const offer = { url, priceCNY: 0.01, fetchedAt: date, detail: { url, source: '1688:详情页', fetchedAt: date,
    moq: 10, moqText: '10件起批', priceTiers: [
      { qty: 10, qtyText: '10-99件', priceCNY: 12, priceMaxCNY: null },
      { qty: 100, qtyText: '≥100件', priceCNY: 10, priceMaxCNY: null },
    ], skuList: [{ sku: '蓝色单件', priceCNY: 12 }], weightG: 10, weightText: '10~300',
    skuVariants: [{ property: '颜色', values: ['蓝色单件', '红色单件'] }] } };
  const selection = { sku: '蓝色单件', spec: '蓝色/单件/完整包装', quantity: 20, unitPriceCNY: 12, billableWeightKg: 0.3,
    matchType: 'similar', route: { type: 'LD', ...ev() }, specEvidence: ev(),
    priceEvidence: { kind: 'detail-tier', tierIndex: 0, ...ev() },
    weightEvidence: { sku: '蓝色单件', spec: '蓝色/单件/完整包装', billableWeightKg: 0.3, ...ev() },
    additionalCosts: { domesticFreightCNY: { amount: 2, basis: 'per-unit', ...ev() }, packagingCNY: { amount: 1, basis: 'per-unit', ...ev() } },
  };
  return { candidate, offer, selection };
}

const paused = (input, field) => {
  const before = structuredClone(input);
  const result = prepareSaudiCandidate(input);
  assert.equal(result.status, 'paused');
  assert.ok(result.missing.includes(field), JSON.stringify(result.missing));
  assert.deepEqual(result.candidate.economics, input.candidate.economics);
  assert.deepEqual(input, before);
  return result;
};

test('collect one search, capped sequential details, exact raw structures preserved without verification', async () => {
  const calls = [];
  const detail = saudiSourcingFixture().offer.detail;
  const result = await collectSaudiOffers({ keyword: '收纳', limit: 3, detailLimit: 2 }, {
    searchOffers: async (opts) => { calls.push(['search', opts]); return { rows: [1, 2, 3, 4].map((id) => ({ url: url + '?id=' + id, offerId: String(id) })), source: '1688:搜索页', fetchedAt: date }; },
    fetchOfferDetail: async (opts) => { calls.push(['detail', opts]); return detail; },
  });
  assert.equal(result.offers.length, 3);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(([, opts]) => opts.stopOnWall === true));
  assert.equal(result.requestBudget.actualDetailPages, 2);
  assert.equal(result.requestBudget.maxRequests, 3);
  assert.deepEqual(result.offers[0].detail, detail);
  assert.equal(result.offers[0].verified, false);
  assert.equal(result.offers[2].detail, null);
  assert.equal(result.offers[0].fetchedAt, date);
  assert.notEqual(result.offers[0].detail, detail);
});

for (const code of ['CAPTCHA', 'NOT_LOGGED_IN', 'RATE_LIMITED', 'FORBIDDEN']) {
  test('collect propagates ' + code + ' and never requests next detail', async () => {
    let n = 0;
    const error = Object.assign(new Error(code), { code });
    await assert.rejects(collectSaudiOffers({ keyword: 'test' }, {
      searchOffers: async () => ({ rows: [{ url }, { url }] }),
      fetchOfferDetail: async () => { n++; throw error; },
    }), (err) => err === error);
    assert.equal(n, 1);
  });
}

test('collect stops returned failure and search failure, including non-wall errors', async () => {
  let details = 0;
  await assert.rejects(collectSaudiOffers({ keyword: 'test' }, {
    searchOffers: async () => ({ ok: false, code: 'RATE_LIMITED' }),
    fetchOfferDetail: async () => { details++; },
  }), { code: 'RATE_LIMITED' });
  assert.equal(details, 0);
  await assert.rejects(collectSaudiOffers({ keyword: 'test' }, {
    searchOffers: async () => { throw new Error('network'); },
  }), /network/);
});

test('detailLimit zero means card-only and invalid budgets do no I/O', async () => {
  const result = await collectSaudiOffers({ keyword: 'test', detailLimit: 0 }, {
    searchOffers: async () => ({ rows: [{ url }] }), fetchOfferDetail: async () => assert.fail(),
  });
  assert.equal(result.offers[0].detail, null);
  assert.equal(result.requestBudget.actualDetailPages, 0);
  for (const detailLimit of [-1, 1.5, 11]) await assert.rejects(collectSaudiOffers({ keyword: 'test', detailLimit }), RangeError);
});

test('ready writes only selected purchase/weight inputs and explicit human route; no checks or profit', () => {
  const input = saudiSourcingFixture();
  const before = structuredClone(input);
  const result = prepareSaudiCandidate(input);
  assert.equal(result.status, 'ready', JSON.stringify(result.missing));
  assert.equal(result.candidate.economics.purchaseCNY, 12);
  assert.equal(result.candidate.economics.billableWeightKg, 0.3);
  assert.equal(result.candidate.economics.contributionSAR, undefined);
  for (const key of ['identity', 'compliance', 'logistics', 'returns', 'samples', 'demand', 'scores']) assert.deepEqual(result.candidate[key], before.candidate[key]);
  assert.deepEqual(input, before);
  assert.equal(result.candidate.sourcing.additionalCosts.domesticFreightCNY.amount, 2);
  assert.equal(result.candidate.route.newListing.status, 'unknown');
});

test('visited detail never auto-verifies and missing selection pauses without writing economics', () => {
  const input = saudiSourcingFixture(); input.selection = {};
  paused(input, 'selection.sku');
});

test('search card price cannot substitute for a quote', () => {
  const input = saudiSourcingFixture(); delete input.offer.detail; input.selection.unitPriceCNY = input.offer.priceCNY;
  paused(input, 'selection.priceEvidence.validSelectedQuote');
});

for (const [name, mutate] of [
  ['MOQ', (x) => { x.selection.quantity = 5; }],
  ['interval upper bound recovered from real qtyText', (x) => { x.selection.quantity = 100; }],
  ['range price even if endpoints equal', (x) => { x.offer.detail.priceTiers[0].priceMaxCNY = 12; }],
  ['wrong SKU', (x) => { x.selection.sku = 'not present'; }],
  ['mismatched SKU price', (x) => { x.offer.detail.skuList[0].priceCNY = 13; }],
  ['missing MOQ', (x) => { x.offer.detail.moq = null; }],
  ['unknown tier', (x) => { x.selection.priceEvidence.tierIndex = 9; }],
  ['null qty bound', (x) => { x.offer.detail.priceTiers[0].qty = null; }],
]) test('detail selected quote rejects ' + name, () => {
  const input = saudiSourcingFixture(); mutate(input);
  paused(input, 'selection.priceEvidence.validSelectedQuote');
});

test('source and date must match actual detail', () => {
  const input = saudiSourcingFixture(); input.selection.priceEvidence.observedAt = '2025-01-01';
  paused(input, 'selection.priceEvidence.detailProvenance');
});

test('explicit supplier quote can supersede page range, but requires exact SKU/spec/quantity/price/MOQ', () => {
  const input = saudiSourcingFixture();
  input.offer.detail.priceTiers[0].priceMaxCNY = 30;
  const { sku, spec, quantity, unitPriceCNY } = input.selection;
  input.selection.priceEvidence = { kind: 'supplier-quote', ...ev(), source: 'fixture-supplier-quote', sku, spec, quantity, unitPriceCNY, moq: 10 };
  assert.equal(prepareSaudiCandidate(input).status, 'ready');
  input.selection.priceEvidence.quantity = 100;
  paused(input, 'selection.priceEvidence.validSelectedQuote');
});

test('minimum/raw weight is not promoted and weight requires selected SKU evidence', () => {
  const input = saudiSourcingFixture(); delete input.selection.weightEvidence;
  paused(input, 'selection.weightEvidence');
});

test('similar must LD; BB requires all existing identity checks, never fabricates them', () => {
  const input = saudiSourcingFixture(); input.selection.route.type = 'BB';
  paused(input, 'selection.route.similarRequiresLD');
  input.selection.matchType = 'same';
  input.candidate.route.type = 'BB';
  paused(input, 'candidate.identity.attributes');
  for (const check of Object.values(input.candidate.identity)) { check.status = 'passed'; check.evidence = 'SYNTHETIC human identity fixture'; }
  const result = prepareSaudiCandidate(input);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.candidate.identity, input.candidate.identity);
});

test('unknown extra cost is null, not zero; batch fee not treated as per-unit', () => {
  const input = saudiSourcingFixture(); delete input.selection.additionalCosts.domesticFreightCNY;
  const result = paused(input, 'selection.additionalCosts.domesticFreightCNY');
  assert.equal(result.candidate.sourcing.additionalCosts.domesticFreightCNY.amount, null);
  input.selection.additionalCosts.domesticFreightCNY = { amount: 0, basis: 'per-batch', ...ev() };
  paused(input, 'selection.additionalCosts.domesticFreightCNY');
  input.selection.additionalCosts.domesticFreightCNY.basis = 'per-unit';
  assert.equal(prepareSaudiCandidate(input).status, 'ready');
});

test('only HTTPS numeric 1688 offer URLs and Saudi demand URLs are accepted', async () => {
  for (const bad of ['http://detail.1688.com/offer/123.html', 'https://evil.test/offer/123.html', 'https://detail.1688.com.evil.test/offer/123.html', 'https://detail.1688.com/offer/no.html', 'https://user@detail.1688.com/offer/123.html']) {
    const input = saudiSourcingFixture(); input.offer.url = bad;
    paused(input, 'offer.url');
    await assert.rejects(collectSaudiOffers({ keyword: 'x' }, {
      searchOffers: async () => ({ rows: [{ url: bad }] }), fetchOfferDetail: async () => assert.fail('must not open invalid URL'),
    }), TypeError);
  }
  const input = saudiSourcingFixture(); input.candidate.pool.url = 'https://www.trendyol.com/en/item';
  paused(input, 'candidate.pool.url');
  input.candidate.pool.url = 'https://www.trendyol.sa/en/item';
  input.offer.url += '?tracking=1';
  assert.equal(prepareSaudiCandidate(input).status, 'ready');
});

test('route mismatch requires explicit human decision, and prior sale-price evidence survives', () => {
  const input = saudiSourcingFixture(); input.candidate.route.type = 'BB';
  paused(input, 'candidate.route.type');
  input.candidate.route.type = 'LD';
  input.candidate.economics.evidence = 'SYNTHETIC sale price original source';
  input.candidate.economics.priceSAR = 45;
  const result = prepareSaudiCandidate(input);
  assert.equal(result.status, 'ready');
  assert.equal(result.candidate.economics.priceSAR, 45);
  assert.equal(JSON.parse(result.candidate.economics.evidence).priorEvidence, input.candidate.economics.evidence);
});

test('null and malformed containers pause without mutation or a crash', () => {
  for (const input of [null, [], { candidate: null, offer: null, selection: null }, { candidate: [], offer: [], selection: [] }]) {
    assert.equal(prepareSaudiCandidate(input).status, 'paused');
  }
  const input = saudiSourcingFixture();
  input.offer.detail.priceTiers = [null]; input.offer.detail.skuList = {}; input.offer.detail.skuVariants = {};
  input.selection.additionalCosts = [];
  assert.equal(prepareSaudiCandidate(input).status, 'paused');
});

test('plan returns blank evidence and independent schema copies', () => {
  const plan = buildSaudiSourcingPlan();
  assert.equal(plan.selectionTemplate.route.type, null);
  assert.equal(plan.selectionTemplate.additionalCosts.packagingCNY.amount, null);
  assert.deepEqual(plan.selectionSchema, SAUDI_SELECTION_SCHEMA);
  plan.selectionSchema.required.length = 0;
  assert.notEqual(SAUDI_SELECTION_SCHEMA.required.length, 0);
});
