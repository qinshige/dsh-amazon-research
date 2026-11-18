/**
 * 浏览器采集证据契约：为每个直接采集字段保留来源页、时间、定位器与提取方式。
 * 不把「存在证据索引」误写成「已经截图」；截图只有提供 screenshotPath 时才标记。
 */

const META_FIELDS = new Set(['fieldEvidence', 'pageContract', 'fetchedAt', 'source']);

export function buildFieldEvidence(record, {
  sourceUrl = null,
  source = 'browser-page',
  capturedAt = new Date().toISOString(),
  method = 'dom-structured-extraction',
  locators = {},
  confidence = 'direct',
  screenshotPath = null,
} = {}) {
  const output = {};
  for (const [field, value] of Object.entries(record || {})) {
    if (META_FIELDS.has(field) || value === null || value === undefined || value === '') continue;
    output[field] = {
      sourceUrl: sourceUrl || (field === 'url' ? String(value) : null),
      source,
      capturedAt,
      method,
      locator: locators[field] || null,
      confidence,
      screenshotPath: screenshotPath || null,
      screenshotCaptured: Boolean(screenshotPath),
    };
  }
  return output;
}

export function attachBrowserEvidence(record, options = {}) {
  const capturedAt = options.capturedAt || record?.fetchedAt || new Date().toISOString();
  const sourceUrl = options.sourceUrl || record?.url || null;
  return {
    ...record,
    fetchedAt: record?.fetchedAt || capturedAt,
    source: record?.source || options.source || 'browser-page',
    pageContract: {
      sourceUrl,
      capturedAt,
      expectedOrigin: options.expectedOrigin || null,
      expectedMarketplace: options.expectedMarketplace || null,
      expectedCurrency: options.expectedCurrency || null,
      guardStatus: options.guardStatus || 'validated',
      extractionMethod: options.method || 'dom-structured-extraction',
      screenshotCaptured: Boolean(options.screenshotPath),
    },
    fieldEvidence: buildFieldEvidence(record, { ...options, sourceUrl, capturedAt }),
  };
}
