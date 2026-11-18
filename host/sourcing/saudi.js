/** Saudi-only sourcing preparation. No demand inference, gate approval, FX, FBA or profit calculation. */
import { searchOffers, fetchOfferDetail, parseQty } from './1688.js';

const clone = (value) => structuredClone(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const offerUrl = (value) => { try { const u = new URL(value); return u.protocol === 'https:' && u.hostname === 'detail.1688.com' && !u.username && !u.password && !u.port && /^\/offer\/\d+\.html$/.test(u.pathname); } catch { return false; } };
const saudiUrl = (value) => { try { const u = new URL(value); return u.protocol === 'https:' && ['trendyol.sa', 'www.trendyol.sa'].includes(u.hostname) && !u.username && !u.password && !u.port; } catch { return false; } };
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const dated = (value) => text(value) && /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) && Number.isFinite(Date.parse(value));
const evidence = (value) => value && text(value.source) && dated(value.observedAt) && text(value.evidence);
const identityKeys = ['brandAndAuthenticity', 'barcodeAndProductCode', 'attributes', 'packagingLabelsOriginFunction', 'supplierPhotosAndSource', 'resaleAndCatalogPermission', 'ipSearch'];

function assertResponse(result) {
  const status = result?.code || result?.status;
  if (result?.ok === false || ['CAPTCHA', 'NOT_LOGGED_IN', 'RATE_LIMITED', 'BLOCKED', 'FORBIDDEN', '429', '403'].includes(String(status))) {
    const error = new Error(result?.message || result?.reason || String(status || 'SOURCING_FAILED'));
    error.code = status || 'SOURCING_FAILED';
    throw error;
  }
}

/** Exactly one search, sequential bounded details; errors propagate without retry or partial success. */
export async function collectSaudiOffers({ keyword, limit = 5, detailLimit = 3, log = () => {} } = {}, deps = {}) {
  if (!text(keyword)) throw new TypeError('keyword is required');
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new RangeError('limit must be 1–20');
  if (!Number.isInteger(detailLimit) || detailLimit < 0 || detailLimit > 10) throw new RangeError('detailLimit must be 0–10');
  const search = await (deps.searchOffers || searchOffers)({ keyword, limit, log, stopOnWall: true });
  assertResponse(search);
  if (!Array.isArray(search?.rows)) throw new TypeError('searchOffers must return rows');
  const offers = [];
  let details = 0;
  for (const card of search.rows.slice(0, limit)) {
    if (!record(card) || !offerUrl(card.url)) throw new TypeError('search card must have an HTTPS detail.1688.com offer URL');
    let detail = null;
    if (details < detailLimit && text(card.url)) {
      details += 1;
      detail = await (deps.fetchOfferDetail || fetchOfferDetail)({ url: card.url, log, stopOnWall: true });
      assertResponse(detail);
      if (!record(detail)) throw new TypeError('fetchOfferDetail must return an object');
    }
    offers.push({ ...clone(card), keyword, source: search.source ?? null, fetchedAt: search.fetchedAt ?? null,
      searchEvidence: { source: search.source ?? null, fetchedAt: search.fetchedAt ?? null, card: clone(card) },
      detail: clone(detail), detailVisited: detail !== null, verified: false,
      verificationStatus: 'unreviewed', warnings: ['详情访问不证明同款或报价已核验；不得使用搜索卡片价或最低件重。'] });
  }
  return { ok: true, offers, keyword, fetchedAt: new Date().toISOString(),
    requestBudget: { searchPages: 1, detailPages: Math.min(limit, detailLimit), maxRequests: 1 + Math.min(limit, detailLimit), actualSearchPages: 1, actualDetailPages: details } };
}

/**
 * Pure preparation only. selection evidence records use {source, observedAt, evidence}.
 * Ready means sourcing inputs ready, NOT workflow gates passed or permission to purchase.
 */
export function prepareSaudiCandidate(input = {}) {
  const missing = [];
  const { candidate, offer: rawOffer, selection } = record(input) ? input : {};
  if (!record(input)) missing.push('input');
  if (!record(candidate)) missing.push('candidate');
  if (!record(rawOffer)) missing.push('offer');
  if (!record(selection)) missing.push('selection');
  const c = clone(record(candidate) ? candidate : {});
  const s = clone(record(selection) ? selection : {});
  const offer = record(rawOffer) ? rawOffer : {};
  const d = record(offer.detail) ? offer.detail : null;
  const warnings = ['仅准备寻源输入，不计算利润、不批准任何关卡；额外费用独立披露，非固定公式净利润。'];
  const need = (condition, key) => { if (!condition) missing.push(key); };
  need(c?.platform === 'trendyol-sa', 'candidate.platform');
  need(offerUrl(offer.url), 'offer.url');
  if (c.pool?.url != null && c.pool.url !== '') need(saudiUrl(c.pool.url), 'candidate.pool.url');
  need(text(s.sku), 'selection.sku');
  need(text(s.spec), 'selection.spec');
  need(evidence(s.specEvidence), 'selection.specEvidence');
  need(Number.isInteger(s.quantity) && s.quantity > 0, 'selection.quantity');
  need(positive(s.unitPriceCNY), 'selection.unitPriceCNY');
  need(positive(s.billableWeightKg), 'selection.billableWeightKg');
  need(['same', 'similar'].includes(s.matchType), 'selection.matchType');
  need(['BB', 'LD'].includes(s.route?.type) && evidence(s.route), 'selection.route');
  need(['BB', 'LD'].includes(c.route?.type) && c.route.type === s.route?.type, 'candidate.route.type');
  if (s.matchType === 'similar') need(s.route?.type === 'LD', 'selection.route.similarRequiresLD');
  if (s.route?.type === 'BB') {
    need(s.matchType === 'same', 'selection.matchType.BBRequiresSame');
    for (const key of identityKeys) need(c.identity?.[key]?.status === 'passed' && text(c.identity[key].evidence), 'candidate.identity.' + key);
    if (missing.some((key) => key.startsWith('candidate.identity.') || key === 'selection.matchType.BBRequiresSame')) warnings.push('BB同款未获证明，暂停；不得以详情访问或相似外观替代身份核验。');
  }
  if (s.route?.type === 'LD') warnings.push('LD须独立页面，不继承BB评分、评论或Buybox；现有关卡保持原样。');

  const p = s.priceEvidence;
  need(evidence(p), 'selection.priceEvidence');
  let priceVerified = false;
  if (p?.kind === 'detail-tier') {
    need(d && text(d.source) && dated(d.fetchedAt) && offerUrl(d.url) && new URL(d.url).pathname === (offerUrl(offer.url) ? new URL(offer.url).pathname : null), 'offer.detail.sourceAndDate');
    need(p.source === d?.url && p.observedAt === d?.fetchedAt, 'selection.priceEvidence.detailProvenance');
    const tier = Number.isInteger(p.tierIndex) ? d?.priceTiers?.[p.tierIndex] : null;
    const parsedQty = parseQty(tier?.qtyText);
    const max = tier?.qtyMax ?? parsedQty?.qtyMax;
    // Next lower bound constrains open-ended earlier tiers, never silently accept a cheaper later tier.
    const next = Array.isArray(d?.priceTiers) ? d.priceTiers.filter((t) => record(t) && positive(t.qty) && t.qty > tier?.qty).map((t) => t.qty).sort((a, b) => a - b)[0] : undefined;
    const sku = Array.isArray(d?.skuList) ? d.skuList.find((item) => record(item) && item.sku === s.sku) : null;
    const variantKnown = !!sku || (Array.isArray(d?.skuVariants) && d.skuVariants.some((prop) => Array.isArray(prop?.values) && prop.values.includes(s.sku)));
    need(variantKnown, 'selection.sku.detailMatch');
    // When per-SKU prices exist they must agree; a page-level range is never a selected quote.
    const skuAgrees = !sku || (sku.priceCNY === s.unitPriceCNY && sku.priceMaxCNY == null);
    priceVerified = !!tier && positive(tier.qty) && positive(d.moq) && s.quantity >= d.moq && s.quantity >= tier.qty
      && (max == null || s.quantity <= max) && (next == null || s.quantity < next)
      && tier.priceMaxCNY == null && tier.priceCNY === s.unitPriceCNY && skuAgrees && variantKnown;
  } else if (p?.kind === 'supplier-quote') {
    // Explicit supplier quotation may supersede page tiers; all selected fields must be bound to it.
    priceVerified = evidence(p) && p.sku === s.sku && p.spec === s.spec && p.quantity === s.quantity
      && p.unitPriceCNY === s.unitPriceCNY && positive(p.moq) && s.quantity >= p.moq;
  }
  need(priceVerified, 'selection.priceEvidence.validSelectedQuote');
  const w = s.weightEvidence;
  need(evidence(w) && w.sku === s.sku && w.spec === s.spec && w.billableWeightKg === s.billableWeightKg, 'selection.weightEvidence');

  const additionalCosts = clone(record(s.additionalCosts) ? s.additionalCosts : {});
  for (const key of ['domesticFreightCNY', 'packagingCNY']) {
    const fee = additionalCosts[key];
    const valid = typeof fee?.amount === 'number' && Number.isFinite(fee.amount) && fee.amount >= 0 && fee.basis === 'per-unit' && evidence(fee);
    need(valid, 'selection.additionalCosts.' + key);
    if (!valid) {
      additionalCosts[key] = { ...fee, amount: null, status: 'unknown' };
      warnings.push(key + '未取到有效报价，不可按0；须注明整单/单件及是否已包含于采购报价，避免重复计费。');
    }
  }
  const status = missing.length ? 'paused' : 'ready';
  const nextActions = missing.map((field) => '补齐/复核 ' + field);
  c.sourcing = { ...(c.sourcing || {}), status, missing: [...missing], warnings: [...warnings], nextActions, offer: clone(offer), selection: s,
    additionalCosts, costDisclosure: '额外费用独立披露，不修改沙特工作流固定贡献利润公式；不是完整净利润。',
    verified: status === 'ready', verificationScope: 'selected-quote-and-billable-weight-inputs-only' };
  if (status === 'ready') {
    c.economics = { ...(c.economics || {}), purchaseCNY: s.unitPriceCNY, billableWeightKg: s.billableWeightKg,
      evidence: JSON.stringify({ priorEvidence: c.economics?.evidence ?? null, price: p, weight: w, spec: s.specEvidence, quantity: s.quantity, offerUrl: offer.url }) };
    c.route = { ...(c.route || {}), type: s.route.type, evidence: JSON.stringify(s.route), supplierUrl: offer.url };
  }
  return { ok: true, status, candidate: c, missing, warnings, nextActions };
}

const evidenceProperties = { source: { type: 'string', minLength: 1 }, observedAt: { type: 'string', format: 'date-time' }, evidence: { type: 'string', minLength: 1 } };
const evidenceRequired = ['source', 'observedAt', 'evidence'];
const evidenceSchema = (properties = {}, required = []) => ({ type: 'object', properties: { ...evidenceProperties, ...properties }, required: [...evidenceRequired, ...required], additionalProperties: false });
const selectedProperties = { sku: { type: 'string', minLength: 1 }, spec: { type: 'string', minLength: 1 }, quantity: { type: 'integer', minimum: 1 }, unitPriceCNY: { type: 'number', exclusiveMinimum: 0 }, moq: { type: 'number', exclusiveMinimum: 0 } };
const costSchema = evidenceSchema({ amount: { type: 'number', minimum: 0 }, basis: { const: 'per-unit' } }, ['amount', 'basis']);

/** Public input contract; semantic SKU/tier/evidence checks also run in prepareSaudiCandidate. */
export const SAUDI_SELECTION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['sku', 'spec', 'quantity', 'unitPriceCNY', 'billableWeightKg', 'matchType', 'route', 'specEvidence', 'priceEvidence', 'weightEvidence', 'additionalCosts'],
  properties: {
    sku: selectedProperties.sku, spec: selectedProperties.spec, quantity: selectedProperties.quantity, unitPriceCNY: selectedProperties.unitPriceCNY,
    billableWeightKg: { type: 'number', exclusiveMinimum: 0 }, matchType: { enum: ['same', 'similar'] },
    route: evidenceSchema({ type: { enum: ['BB', 'LD'] } }, ['type']),
    specEvidence: evidenceSchema(),
    priceEvidence: { oneOf: [
      evidenceSchema({ kind: { const: 'detail-tier' }, tierIndex: { type: 'integer', minimum: 0 } }, ['kind', 'tierIndex']),
      evidenceSchema({ kind: { const: 'supplier-quote' }, ...selectedProperties }, ['kind', ...Object.keys(selectedProperties)]),
    ] },
    weightEvidence: evidenceSchema({ sku: selectedProperties.sku, spec: selectedProperties.spec, billableWeightKg: { type: 'number', exclusiveMinimum: 0 } }, ['sku', 'spec', 'billableWeightKg']),
    additionalCosts: { type: 'object', properties: { domesticFreightCNY: costSchema, packagingCNY: costSchema }, required: ['domesticFreightCNY', 'packagingCNY'], additionalProperties: false },
  },
};

export function buildSaudiSourcingPlan() {
  const blank = () => ({ source: '', observedAt: '', evidence: '' });
  return { platform: 'trendyol-sa', marketplace: 'SA', selectionSchema: clone(SAUDI_SELECTION_SCHEMA),
    steps: ['collect：一次搜索，至多detailLimit详情；遇验证、登录、限流立停', '人工核对SKU/spec与BB同款或LD类似路线', '按实际数量/MOQ/非区间阶梯报价或明确供应商报价选择', '核验所选SKU计费重及额外单件费用', 'prepare：仅写寻源输入，原工作流所有关卡仍须独立通过'],
    selectionTemplate: { sku: '', spec: '', quantity: null, unitPriceCNY: null, billableWeightKg: null, matchType: null,
      route: { type: null, ...blank() }, specEvidence: blank(), priceEvidence: { kind: 'detail-tier', tierIndex: null, ...blank() },
      weightEvidence: { sku: '', spec: '', billableWeightKg: null, ...blank() },
      additionalCosts: { domesticFreightCNY: { amount: null, basis: 'per-unit', ...blank() }, packagingCNY: { amount: null, basis: 'per-unit', ...blank() } } },
    fieldDescriptions: {
      'priceEvidence': 'detail-tier来源须等于detail.url，日期须等于detail.fetchedAt，tierIndex为0起；MOQ/数量区间/SKU单价全部一致，range拒绝。supplier-quote另需sku/spec/quantity/unitPriceCNY/moq及明确供应商原始报价来源日期证据。',
      'specEvidence': '所选SKU完整材质、颜色、尺寸、数量、配件、包装、功能的原始证据，不自动判同款。',
      'weightEvidence': '必须为所选SKU/spec确认的计费重（非最低净重）；来源应含包装、实重/体积重依据。',
      'additionalCosts': 'CNY每销售单位。整批费用先按真实数量人工分摊并在evidence保留总额/除数/是否已包含在采购价；未知null不得0。仅独立披露，不加入或改变固定贡献利润公式。',
      'route': '人工有证据选择BB/LD，须先明确candidate.route.type并与selection.route.type一致。similar只能LD；BB须candidate.identity七项已有passed与证据。工具不会批准checks或静默改变路线。',
      'status': 'ready仅表示寻源数据齐备，不代表需求/合规/物流/利润/样品等关卡通过。paused不得继续测算。',
    } };
}
