import test from 'node:test';
import assert from 'node:assert/strict';
import { attachBrowserEvidence, buildFieldEvidence } from '../host/evidence.js';

test('字段级证据记录来源、时间、定位器且不谎报截图', () => {
  const capturedAt = '2026-01-02T03:04:05.000Z';
  const record = { url: 'https://example.test/p/1', title: 'Product', price: 19.9, missing: null };
  const output = attachBrowserEvidence(record, {
    sourceUrl: record.url, source: 'fixture:detail', capturedAt,
    expectedOrigin: 'https://example.test', expectedMarketplace: 'SA', expectedCurrency: 'SAR',
    locators: { price: '.price' },
  });
  assert.equal(output.fieldEvidence.price.sourceUrl, record.url);
  assert.equal(output.fieldEvidence.price.locator, '.price');
  assert.equal(output.fieldEvidence.price.capturedAt, capturedAt);
  assert.equal(output.fieldEvidence.price.screenshotCaptured, false);
  assert.equal(output.fieldEvidence.missing, undefined);
  assert.deepEqual(output.pageContract, {
    sourceUrl: record.url,
    capturedAt,
    expectedOrigin: 'https://example.test',
    expectedMarketplace: 'SA',
    expectedCurrency: 'SAR',
    guardStatus: 'validated',
    extractionMethod: 'dom-structured-extraction',
    screenshotCaptured: false,
  });
});

test('截图只有传入真实路径时才标记已采集', () => {
  const evidence = buildFieldEvidence({ price: 10 }, { screenshotPath: '/tmp/proof.png' });
  assert.equal(evidence.price.screenshotCaptured, true);
  assert.equal(evidence.price.screenshotPath, '/tmp/proof.png');
});
