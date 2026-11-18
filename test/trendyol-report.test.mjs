import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { runTrendyolWorkflow } from '../host/market/trendyol-report.js';
import { buildTrendyolPlan } from '../host/market/trendyol-workflow.js';
import { withTestQuote } from './fixtures/saudi-quote.mjs';
function unzipLocal(buffer) {
  const files = {}; let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const size = buffer.readUInt32LE(offset + 18), nameSize = buffer.readUInt16LE(offset + 26), extraSize = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameSize).toString();
    const start = offset + 30 + nameSize + extraSize;
    files[name] = inflateRawSync(buffer.subarray(start, start + size)).toString(); offset = start + size;
  }
  return files;
}
async function root() { return mkdtemp(join(tmpdir(), 'trendyol-report-test-')); }
const yes = () => ({ status: 'passed', evidence: '测试人工核验证据' });
function preReturns() {
  const c = buildTrendyolPlan().inputTemplate; c.id = 'test'; c.name = '测试夹具';
  c.pool = { keyword: 'fixture', url: 'https://www.trendyol.sa/en/fixture', priceSAR: 100, rating: 4, ratingCount: 100, reviewCount: 10, ranking: '无榜单', brand: 'Generic', observedAt: '2026-11-17' };
  c.demand.signals = [yes(), yes(), yes(), yes()]; c.route.evidence = '实物匹配';
  for (const group of ['identity', 'compliance', 'logistics']) for (const key of Object.keys(c[group])) if (key !== 'billableWeightKg') c[group][key] = yes();
  c.logistics.billableWeightKg = .1;
  c.economics = { priceSAR: 100, purchaseCNY: 2, billableWeightKg: .1, evidence: '实际报价' };
  return withTestQuote(c);
}
test('persists standard outputs, binary xlsx, complete stage order, and provenance hash', async () => {
  const outputRoot = await root(); const c = buildTrendyolPlan().inputTemplate; c.id = 'paused';
  c.evidence = [{ path: '/actual/user-supplied/photo.png', description: '用户提供；不验证' }];
  const r = await runTrendyolWorkflow({ candidates: [c], outputRoot, registryDir: join(outputRoot, 'registry'), title: '测试报告' });
  assert.equal(r.summary.paused, 1); assert.equal(r.summary.expandEligible, 0);
  const report = await readFile(r.reportPath, 'utf8'); assert.match(report, /本轮无/); assert.match(report, /未到此关卡，不计算利润/); assert.match(report, /扩货\/终止/);
  const provenance = JSON.parse(await readFile(join(r.dir, 'provenance.json'), 'utf8'));
  assert.equal(createHash('sha256').update(JSON.stringify(provenance.input)).digest('hex'), r.inputHash);
  const evidence = JSON.parse(await readFile(join(r.dir, 'evidence/index.json'), 'utf8')); assert.equal(evidence[0].path, c.evidence[0].path); assert.equal(evidence[0].verified, false);
  const manifest = JSON.parse(await readFile(join(r.dir, 'manifest.json'), 'utf8')); assert.equal(manifest.platform, 'trendyol'); assert.equal(manifest.site, 'SA'); assert.ok(manifest.artifacts.some(a=>a.name==='利润测算.xlsx'));
  const zip = unzipLocal(await readFile(r.workbookPath)); assert.match(zip['xl/workbook.xml'], /三档情景/); assert.match(zip['xl/worksheets/sheet1.xml'], /待确认/); assert.doesNotMatch(zip['xl/worksheets/sheet1.xml'], /<v>/);
  const registry = JSON.parse(await readFile(join(outputRoot, 'registry/run-index.json'), 'utf8')); assert.equal(registry[0].runId, r.runId);
});
test('economic results and algebra sensitivity only appear once reached; missing scenarios stay unknown', async () => {
  const r = await runTrendyolWorkflow({ candidates: [preReturns()], outputRoot: await root() });
  const zip = unzipLocal(await readFile(r.workbookPath));
  assert.match(zip['xl/worksheets/sheet1.xml'], /<v>100<\/v>/);
  assert.match(zip['xl/worksheets/sheet2.xml'], /pessimistic/); assert.doesNotMatch(zip['xl/worksheets/sheet2.xml'], /<v>/);
  const upper = (100/1.15 - 100*.22 - 15)*1.8 - .1*68;
  assert.ok(zip['xl/worksheets/sheet4.xml'].includes('<v>'+upper+'</v>'));
  const evaluation = JSON.parse(await readFile(join(r.dir, 'evaluation.json'), 'utf8')); assert.equal(evaluation.candidates[0].stoppedAt, 'returns'); assert.equal(evaluation.candidates[0].score, null);
});
test('real supplied scenarios are preserved and user text is not Excel formulas', async () => {
  const c = preReturns(); c.id = '=HYPERLINK("bad")'; c.economics.scenarios = { pessimistic: { priceSAR: 90, purchaseCNY: 3, billableWeightKg: .12, evidence: '明确情景依据' } };
  const r = await runTrendyolWorkflow({ candidates: [c], outputRoot: await root() }); const zip = unzipLocal(await readFile(r.workbookPath));
  assert.match(zip['xl/worksheets/sheet2.xml'], /<v>90<\/v>/); assert.match(zip['xl/worksheets/sheet2.xml'], /明确情景依据/); assert.doesNotMatch(zip['xl/worksheets/sheet1.xml'], /<f>/);
});
test('empty report records no fabricated evidence and repeated names do not overwrite', async () => {
  const outputRoot = await root(); const a = await runTrendyolWorkflow({ outputRoot }); const b = await runTrendyolWorkflow({ outputRoot });
  assert.notEqual(a.dir, b.dir); assert.deepEqual(JSON.parse(await readFile(join(a.dir, 'evidence/index.json'), 'utf8')), []);
  assert.match(await readFile(join(a.dir, '淘汰候选.md'), 'utf8'), /本轮无/);
});
test('rejects absent destination and non-JSON provenance inputs', async () => {
  await assert.rejects(runTrendyolWorkflow({}), /outputRoot/);
  await assert.rejects(runTrendyolWorkflow({ outputRoot: await root(), candidates: [{ value: NaN }] }), /finite JSON/);
});
