// Synthetic quotation for isolated workflow/financial regression tests; not market data.
import { prepareSaudiCandidate } from '../../host/sourcing/saudi.js';
export function withTestQuote(input) {
  const candidate = structuredClone(input);
  const ev = { source: 'https://example.test/synthetic-supplier-quote', observedAt: '2026-11-18T00:00:00Z', evidence: 'OFFLINE TEST FIXTURE ONLY' };
  const fields = { sku: 'fixture-sku', spec: 'fixture-spec', quantity: 20, unitPriceCNY: candidate.economics.purchaseCNY };
  const selection = { ...fields, billableWeightKg: candidate.economics.billableWeightKg, matchType: candidate.route.type === 'BB' ? 'same' : 'similar', route: { ...ev, type: candidate.route.type }, specEvidence: { ...ev }, priceEvidence: { ...ev, ...fields, kind: 'supplier-quote', moq: 1 }, weightEvidence: { ...ev, sku: fields.sku, spec: fields.spec, billableWeightKg: candidate.economics.billableWeightKg }, additionalCosts: { domesticFreightCNY: { ...ev, amount: 0, basis: 'per-unit' }, packagingCNY: { ...ev, amount: 0, basis: 'per-unit' } } };
  return prepareSaudiCandidate({ candidate, offer: { url: 'https://detail.1688.com/offer/1000001.html' }, selection }).candidate;
}
