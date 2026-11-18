import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrendyolPlan, evaluateTrendyolCandidates, SCORE_WEIGHTS } from '../host/market/trendyol-workflow.js';
import { withTestQuote } from './fixtures/saudi-quote.mjs';
const yes = () => ({ status: 'passed', evidence: '实测证据 https://example.test/record' });
function fixture() {
  const c = buildTrendyolPlan().inputTemplate;
  c.id = 'one'; c.name = '测试夹具（不是市场事实）';
  c.pool = { keyword: 'fixture', url: 'https://www.trendyol.sa/en/test-p-1', priceSAR: 100, rating: 4, ratingCount: 100, reviewCount: 20, ranking: '未上榜，已核对', brand: 'Generic', observedAt: '2026-11-17' };
  c.demand.signals = [yes(), yes(), { status: 'failed', evidence: '无近期信号' }, { status: 'failed', evidence: '无文字痛点' }];
  c.route.evidence = '实物同款核对';
  for (const section of ['identity', 'compliance', 'logistics', 'quality']) for (const key of Object.keys(c[section])) if (key !== 'billableWeightKg') c[section][key] = yes();
  c.logistics.billableWeightKg = 0.1;
  c.economics = { priceSAR: 100, purchaseCNY: 2, billableWeightKg: 0.1, evidence: '采购报价与称重' };
  c.returns = { returnFreightSAR: 15, warehouseSAR: 1, packagingLossSAR: 1, nonRefundableFeesSAR: 1, recoverableValueSAR: 0, expectedRate: 0.1, evidence: '仓库报价，残值0已确认' };
  for (const [key, max] of Object.entries(SCORE_WEIGHTS)) c.scores[key] = { points: max, evidence: '人工评分说明' };
  c.samples.count = 2; c.samples.tests = yes(); for (const key of Object.keys(c.samples.supplier)) c.samples.supplier[key] = yes();
  c.test = { catalogApproved: yes(), batchUnits: 20, impressions: 1000, effectiveClicks: 50, orders: 20, actualReturns: yes(), evidence: '真实订单记录' };
  for (const key of Object.keys(c.expansion.checks)) c.expansion.checks[key] = yes();
  for (const key of Object.keys(c.expansion.termination)) c.expansion.termination[key] = { triggered: false, evidence: '已核查' };
  return withTestQuote(c);
}
// Financial tests deliberately change quoted inputs; bind matching synthetic supplier evidence.
// Tampered/stale sourcing is tested separately in saudi-source-tool.test.mjs.
const run = (c) => evaluateTrendyolCandidates({ candidates: [c.economics && c.route ? withTestQuote(c) : c] }).candidates[0];
test('plan is fresh, only Saudi, and weights total 100', () => {
  const p = buildTrendyolPlan(); assert.equal(p.platform, 'trendyol-sa'); assert.equal(Object.values(p.weights).reduce((a,b)=>a+b), 100);
  p.inputTemplate.compliance.saberSaso.status = 'passed'; assert.equal(buildTrendyolPlan().inputTemplate.compliance.saberSaso.status, 'unknown');
});
test('full BB flow passes in exact order without mutating input', () => {
  const c = fixture(), before = structuredClone(c), r = run(c);
  assert.equal(r.status, 'expand-eligible'); assert.equal(r.score.total, 100);
  assert.deepEqual(r.stages.map(s=>s.stage), buildTrendyolPlan().steps); assert.deepEqual(c, before);
  assert.equal(r.economics.contributionSAR, 100/1.15-100*.22-((2+.1*68)/1.8+10+5));
});
test('wrong platform or non Saudi URL never reaches calculation', () => {
  for (const change of [{ platform: 'amazon-sa' }, { pool: { ...fixture().pool, url: 'https://www.trendyol.com/p-1' } }]) {
    const r = run({ ...fixture(), ...change }); assert.equal(r.stoppedAt, 'pool'); assert.equal(r.economics, null);
  }
});
test('demand requires at least two evidenced signals; unknown is not false or pass', () => {
  const c = fixture(); c.demand.signals[1] = { status: 'passed', evidence: '' };
  assert.equal(run(c).status, 'paused'); c.demand.signals[1] = { status: 'failed', evidence: '不满足' };
  assert.equal(run(c).status, 'eliminated'); assert.equal(run(c).economics, null);
});
test('every pre-economic unknown pauses with no economics or score', () => {
  for (const section of ['identity', 'compliance', 'logistics']) {
    const c = fixture(); const key = Object.keys(c[section])[0]; c[section][key] = { status: 'unknown', evidence: '' };
    const r = run(c); assert.equal(r.stoppedAt, section); assert.equal(r.economics, null); assert.equal(r.score, null);
  }
});
test('failed compliance vetoes and quantity/brand matching cannot be skipped', () => {
  const c = fixture(); c.compliance.saberSaso = { status: 'failed', evidence: '不符合要求' }; assert.equal(run(c).status, 'eliminated');
  delete c.identity.attributes; assert.equal(run(c).stoppedAt, 'identity');
});
test('zero profit and under 10% are rejected; no future price substitution', () => {
  const c = fixture(); c.economics.purchaseCNY = 200; assert.equal(run(c).stoppedAt, 'economics'); assert.equal(run(c).status, 'eliminated');
  c.economics.purchaseCNY = 2; c.economics.priceSAR = 120; assert.equal(run(c).economics, null);
});
test('missing reverse/warehouse does not become zero; provisional floor is distinct', () => {
  const c = fixture(); c.returns = { standardParcel: yes() };
  const r = run(c); assert.equal(r.stoppedAt, 'returns'); assert.equal(r.returns.completeLossSAR, null); assert.equal(r.returns.returnFreightSAR, 15);
  assert.equal(r.returns.minimumKnownLossSAR, 2/1.8+.1*68/1.8+10+15+5); assert.equal(r.score, null);
  c.logistics.billableWeightKg = 3; c.economics.billableWeightKg = 3; c.pool.priceSAR = 1000; c.economics.priceSAR = 1000;
  assert.equal(run(c).returns.returnFreightSAR, null); assert.equal(run(c).returns.minimumKnownLossSAR, null);
});
test('complete loss uses actual components, expected loss is not deducted twice', () => {
  const r = run(fixture()); const full = 2/1.8+.1*68/1.8+10+15+1+1+1;
  assert.equal(r.returns.completeLossSAR, full); assert.equal(r.returns.expectedReturnCostSAR, full*.1); assert.equal(r.returns.afterSalesReserveAlreadyIncluded, true);
});
test('40 SAR threshold is strict greater than, high risk prevents scoring', () => {
  const c = fixture(); const base = 2/1.8+.1*68/1.8+10+15+1+1;
  c.returns.warehouseSAR = 40-base; assert.equal(run(c).status, 'expand-eligible');
  c.returns.warehouseSAR += .01; assert.equal(run(c).stoppedAt, 'returns'); assert.equal(run(c).score, null);
});
test('quality unknown stops prior to scoring', () => { const c = fixture(); c.quality.controllable = {}; assert.equal(run(c).stoppedAt, 'quality'); assert.equal(run(c).score, null); });
test('score only accepts finite in-range manual points with basis; 60 and 70 boundaries', () => {
  const c = fixture(); c.scores.demand.evidence = ''; assert.equal(run(c).score, null);
  c.scores.demand = { points: 31, evidence: '人工' }; assert.equal(run(c).score, null);
  c.scores.demand.points = 0; assert.equal(run(c).score.total, 70);
  c.scores.supply.points = 0; assert.equal(run(c).status, 'observe');
  c.scores.quality.points = 14; assert.equal(run(c).status, 'eliminated');
});
test('LD independent listing and opportunity review never share BB rank', () => {
  const c = fixture(); c.route = { type: 'LD', evidence: '改材质', newListing: yes(), improvementValue: yes(), launchCost: yes() };
  const r = evaluateTrendyolCandidates({ candidates: [withTestQuote(c)] }); assert.equal(r.candidates[0].status, 'expand-eligible'); assert.equal(r.candidates[0].score, null); assert.equal(r.bbRanking.length, 0); assert.equal(r.ldCandidates.length, 1);
  delete c.route.newListing; assert.equal(run(c).stoppedAt, 'route'); assert.equal(run(c).economics, null);
});
test('no invented pessimistic or optimistic scenarios', () => {
  const c = fixture(); assert.deepEqual(run(c).scenarios, { pessimistic: null, neutral: null, optimistic: null });
  c.economics.scenarios = { pessimistic: { priceSAR: 90, purchaseCNY: 3, billableWeightKg: .12, evidence: '明确报价场景' }, optimistic: { priceSAR: 110 } };
  assert.equal(run(c).scenarios.pessimistic.priceSAR, 90); assert.equal(run(c).scenarios.optimistic, null);
});
test('single sample, absent supplier facts, and absent approval prevent tests', () => {
  const c = fixture(); c.samples.count = 1; assert.equal(run(c).stoppedAt, 'samples');
  c.samples.count = 2; delete c.samples.supplier.weightVideo; assert.equal(run(c).stoppedAt, 'samples');
  const d = fixture(); d.test.catalogApproved = {}; assert.equal(run(d).stoppedAt, 'test');
});
test('test thresholds include 1000/50/20; below each is testing, not expansion', () => {
  for (const [key, value] of [['impressions',999],['effectiveClicks',49],['orders',19]]) { const c = fixture(); c.test[key]=value; assert.equal(run(c).status, 'testing'); }
  const c = fixture(); c.test.batchUnits = 31; assert.equal(run(c).status, 'paused');
});
test('termination stops restocking; unknown expansion does not authorize it', () => {
  const c = fixture(); c.expansion.termination.batchDefects = { triggered: true, evidence: '批量缺陷记录' }; assert.equal(run(c).status, 'stop-replenishment');
  const d = fixture(); delete d.expansion.checks.cashFlowTurnover; assert.equal(run(d).status, 'paused');
});
test('documented termination overrides incomplete testing and all unknown prerequisites', () => {
  for (const c of [fixture(), { id: 'missing-pool' }]) {
    c.test = { impressions: 1, effectiveClicks: 0, orders: 0 };
    c.expansion = { termination: { identityOrBrandComplaint: { triggered: true, evidence: '已收到身份投诉工单' } } };
    const r = run(c);
    assert.equal(r.status, 'stop-replenishment'); assert.match(r.reason, /identityOrBrandComplaint/);
    assert.equal(r.economics, null); assert.equal(r.scenarios, null); assert.equal(r.score, null); assert.equal(r.test, null);
    assert.deepEqual(r.stages.map(s=>s.stage), ['expansion']);
  }
  const unknown = { expansion: { termination: { batchDefects: { triggered: true, evidence: '' } } } };
  assert.equal(run(unknown).status, 'paused');
});
test('LD template describes optional unmet need and supplier link and warns without new veto', () => {
  const plan = buildTrendyolPlan();
  assert.equal(plan.inputTemplate.route.unmetNeed, ''); assert.equal(plan.inputTemplate.route.supplierUrl, '');
  assert.ok(plan.fieldDescriptions['route.unmetNeed']); assert.ok(plan.fieldDescriptions['route.supplierUrl']);
  const c = fixture(); c.route = { type: 'LD', evidence: '改良', newListing: yes(), improvementValue: yes(), launchCost: yes() };
  const r = run(c); assert.equal(r.status, 'expand-eligible'); assert.ok(r.warnings.some(w=>w.includes('route.unmetNeed'))); assert.ok(!r.warnings.some(w=>w.includes('route.supplierUrl')), 'ready sourcing supplies a verified-input supplier link');
  c.route.unmetNeed = '评论指出清洗困难'; c.route.supplierUrl = 'https://detail.1688.com/example';
  assert.ok(!run(c).warnings.some(w=>w.includes('route.unmetNeed') || w.includes('route.supplierUrl')));
});
test('input validation and deterministic output', () => {
  assert.throws(()=>evaluateTrendyolCandidates({ candidates: {} }), TypeError);
  assert.deepEqual(evaluateTrendyolCandidates({ candidates: [fixture()] }), evaluateTrendyolCandidates({ candidates: [fixture()] }));
});
