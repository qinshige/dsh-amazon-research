import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inflateRawSync } from 'node:zlib';
import { createSaudiSourceTool } from '../host/market/sa-source-tool.js';
import { buildTrendyolPlan, evaluateTrendyolCandidates } from '../host/market/trendyol-workflow.js';
import { runTrendyolWorkflow } from '../host/market/trendyol-report.js';
import { withTestQuote } from './fixtures/saudi-quote.mjs';
function candidate() {
  const c = buildTrendyolPlan().inputTemplate;
  const yes = () => ({ status: 'passed', evidence: 'OFFLINE SYNTHETIC EVIDENCE' });
  c.pool = { keyword: 'fixture', url: 'https://www.trendyol.sa/en/test', priceSAR: 100, rating: 4, ratingCount: 100, reviewCount: 10, ranking: 'none', brand: 'Generic', observedAt: '2026-11-18' };
  c.demand.signals = [yes(), yes(), yes(), yes()]; c.route.evidence = 'test';
  for (const group of ['identity', 'compliance', 'logistics']) for (const key of Object.keys(c[group])) if (key !== 'billableWeightKg') c[group][key] = yes();
  c.logistics.billableWeightKg = .1;
  c.economics = { priceSAR: 100, purchaseCNY: 2, billableWeightKg: .1, evidence: 'test price evidence' };
  return withTestQuote(c);
}
const evaluate = c => evaluateTrendyolCandidates({ candidates: [c] }).candidates[0];
test('Saudi source plan is free and does not inherit Amazon default', async () => {
  const tool = createSaudiSourceTool({ searchOffers: () => { throw Error('must not query'); } });
  const r = await tool.execute({ action: 'plan' });
  assert.equal(r.ok, true); assert.ok(r.selectionTemplate); assert.ok(r.selectionSchema);
  assert.equal((await tool.execute({ action: 'plan', platform: 'amazon' })).ok, false);
  assert.equal((await tool.execute({ action: 'plan', marketplace: 'US' })).ok, false);
  assert.equal((await tool.execute({ action: 'plan', keyword: 'unexpected' })).ok, false);
});
test('collect propagates wall without retry or later details', async () => {
  let calls = 0;
  const tool = createSaudiSourceTool({ searchOffers: async args => { assert.equal(args.stopOnWall, true); return { rows: [{ url: 'https://detail.1688.com/offer/123.html' }, { url: 'https://detail.1688.com/offer/124.html' }] }; }, fetchOfferDetail: async args => { calls++; assert.equal(args.stopOnWall, true); throw Object.assign(new Error('manual verification needed'), { code: 'CAPTCHA' }); } });
  const r = await tool.execute({ action: 'collect', keyword: 'fixture' });
  assert.equal(r.ok, false); assert.equal(r.error.code, 'CAPTCHA'); assert.equal(calls, 1);
});
test('prepare returns candidate and real Saudi gate evaluation, not FBA', async () => {
  const c = candidate(); const before = structuredClone(c);
  const r = await createSaudiSourceTool().execute({ action: 'prepare', candidate: c, offer: c.sourcing.offer, selection: c.sourcing.selection });
  assert.equal(r.status, 'ready'); assert.equal(r.evaluation.candidates[0].stoppedAt, 'returns');
  assert.equal(r.evaluation.candidates[0].economics.contributionSAR, 100/1.15-100*.22-((2+.1*68)/1.8+15));
  assert.deepEqual(c, before);
});
test('absent, falsely ready, stale price and missing cost cannot reach profit', () => {
  const variants = [c => { delete c.sourcing; }, c => { c.sourcing = { status: 'ready' }; }, c => { c.economics.purchaseCNY = 1; }, c => { c.sourcing.selection.additionalCosts.domesticFreightCNY.amount = null; }, c => { c.sourcing.status = 'paused'; }];
  for (const change of variants) { const c = candidate(); change(c); const r = evaluate(c); assert.equal(r.stoppedAt, 'sourcing'); assert.equal(r.economics, null); assert.equal(r.score, null); }
});
test('ready sourcing does not approve unknown compliance and stop signals override sourcing', () => {
  const c = candidate(); c.compliance.saberSaso.status = 'unknown';
  assert.equal(evaluate(c).stoppedAt, 'compliance'); assert.equal(evaluate(c).economics, null);
  c.expansion.termination.batchDefects = { triggered: true, evidence: 'test' }; delete c.sourcing;
  assert.equal(evaluate(c).status, 'stop-replenishment');
});
test('report includes original supplier evidence, extra cost disclosure and a sixth trace sheet', async () => {
  const c = candidate(); c.sourcing.selection.additionalCosts.domesticFreightCNY.amount = 1.25;
  c.sourcing.additionalCosts.domesticFreightCNY.amount = 1.25;
  const outputRoot = await mkdtemp(join(tmpdir(), 'sa-source-report-'));
  const r = await runTrendyolWorkflow({ candidates: [c], outputRoot });
  const report = await readFile(r.reportPath, 'utf8');
  assert.match(report, /detail\.1688\.com/); assert.match(report, /fixture-sku/); assert.match(report, /1.25/); assert.match(report, /不是.*净利润/);
  const buffer = await readFile(r.workbookPath); const files = {}; let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) { const size = buffer.readUInt32LE(offset + 18), n = buffer.readUInt16LE(offset + 26), extra = buffer.readUInt16LE(offset + 28); const name = buffer.subarray(offset + 30, offset + 30 + n).toString(); const start = offset + 30 + n + extra; files[name] = inflateRawSync(buffer.subarray(start, start + size)).toString(); offset = start + size; }
  assert.match(files['xl/workbook.xml'], /1688寻源追溯/); assert.match(files['xl/worksheets/sheet6.xml'], /fixture-sku/); assert.doesNotMatch(files['xl/worksheets/sheet6.xml'], /<f>/);
  const provenance = JSON.parse(await readFile(join(r.dir, 'provenance.json'), 'utf8'));
  assert.deepEqual(provenance.input.candidates[0].sourcing, c.sourcing);
});
