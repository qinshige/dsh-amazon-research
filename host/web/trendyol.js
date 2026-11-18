/** Public-page Chrome driver. TR and Saudi English storefronts only; never bypass guards. */
import { readFile } from 'node:fs/promises';
import { listTabs, openTab, runJs, runJson, waitFor, closeTab } from './chrome.js';
import { requireTrendyolCaptureSite } from '../platforms/trendyol-sites.js';
import { attachBrowserEvidence } from '../evidence.js';
import { parseBadges, parseCardText, parseCategoryRank, parseFavoriteRank, parseBestSellerRank,
  parsePriceTRY, parsePriceSAR, parseSaudiRatingCount, parseProductId, parseRating, parseReviewCount, formatBreadcrumb } from './trendyol-parse.js';
const PAGE_DELAY_MS = 3000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const snippetCache = new Map();
async function snippet(name, site) {
  if (!snippetCache.has(name)) snippetCache.set(name, await readFile(new URL('./snippets/' + name, import.meta.url), 'utf8'));
  return '((expectedCountry, expectedOrigin, expectedCurrency) => ' + snippetCache.get(name).trim().replace(/;$/, '') + ')(' +
    [site.value, site.origin, site.currency].map(JSON.stringify).join(',') + ')';
}
async function runSnippet(tabId, name, site) { return runJson(tabId, await snippet(name, site)); }
async function pageDiagnostic(tabId, reason) {
  try {
    const { snapshot } = await import('./page-capabilities.js');
    const result = await snapshot(tabId, { maxChars: 1200, maxItems: 40 });
    return { reason, evidence: result.evidence, pageFlags: result.view?.pageFlags || {}, inaccessibleFrames: result.view?.inaccessibleFrames || [], text: String(result.text || '').slice(0, 2000) };
  } catch (error) {
    return { reason, error: String(error?.message ?? error).slice(0, 500) };
  }
}
const fail = (code, message) => Object.assign(new Error(message), { code });
export function validatePageGuard(guard, site) {
  if (!guard || typeof guard !== 'object') throw fail('SESSION_NOT_READY', 'Trendyol 页面状态未取到');
  if (guard.captcha) throw fail('CAPTCHA', 'Trendyol 出现人机验证，已停止，请人工完成验证；插件不会绕过。');
  if (guard.rateLimited || guard.accessDenied) throw fail(guard.rateLimited ? 'RATE_LIMIT' : 'ACCESS_DENIED', 'Trendyol 访问受限，已停止；请人工检查，不自动重试。');
  if (guard.countrySelect) throw fail('COUNTRY_SELECT', '请在 Chrome 的 Trendyol 官网手动选择' + site.label + '（' + site.value + '）。');
  if (guard.wrongOrigin || guard.wrongCountry || guard.wrongCurrency) throw fail('COUNTRY_MISMATCH', 'Trendyol 当前页面与目标' + site.label + '（' + site.value + ' / ' + site.currency + '）不符，已停止，请人工切换。');
  if (guard.countryUnknown || guard.currencyUnknown) throw fail('COUNTRY_UNKNOWN', '无法从官网元数据验证目标国家或沙特币种，已停止，不能按域名猜测。');
  return guard;
}
async function assertPageUsable(tabId, site, { expectCards = false } = {}) {
  const guard = validatePageGuard(await runSnippet(tabId, 'trendyol-page-guard.js', site), site);
  if (guard.empty && !guard.noResults) {
    const count = expectCards ? Number(await runJs(tabId, 'document.querySelectorAll("a.product-card").length')) : 0;
    if (!count) throw fail('EMPTY_PAGE', 'Trendyol 页面为空或尚未完成加载，已停止。');
  }
  return guard;
}
async function waitForPage(tabId, site, readyJs, timeout = 50) {
  const guard = await snippet('trendyol-page-guard.js', site);
  return waitFor(tabId, '(() => { const g = JSON.parse(' + guard + '); return g.captcha || g.rateLimited || g.accessDenied || g.wrongOrigin || g.wrongCountry || g.wrongCurrency || g.countrySelect || g.noResults || (' + readyJs + '); })()', { timeout });
}
/** Inspect the actual target site, not translated country labels. Do not auto-switch countries. */
export async function ensureSession({ marketplace = 'TR', log = () => {} } = {}) {
  const site = requireTrendyolCaptureSite(marketplace);
  const hit = (await listTabs()).find(tab => { try { return new URL(tab.url).origin === site.origin && !tab.url.includes('select-country'); } catch { return false; } });
  const tabId = hit?.id || await openTab(site.origin + site.entryPath);
  try {
    await waitForPage(tabId, site, 'document.body && document.body.innerText.length > 120', 45);
    const guard = await assertPageUsable(tabId, site);
    log('已核验 Trendyol 国家：' + site.label + ' / ' + site.currency);
    return { ok:true, url:guard.url, marketplace:site.value, currency:site.currency };
  } finally { if (!hit) await closeTab(tabId); }
}
export function toProductCard(raw, marketplace = 'TR') {
  const site = requireTrendyolCaptureSite(marketplace);
  const sa = site.value === 'SA';
  const fullText = String(raw?.fullText ?? '');
  const fallback = sa ? {} : parseCardText(fullText);
  const price = sa ? parsePriceSAR(raw?.priceText) : (parsePriceTRY(raw?.priceText) ?? fallback.priceTRY);
  const count = sa ? parseSaudiRatingCount(raw?.countText) : parseReviewCount(raw?.countText);
  let url = null;
  try { const u = new URL(raw?.href, site.origin); if (u.origin === site.origin && !u.username && !u.password && parseProductId(u.pathname)) url = u.href; } catch {}
  return { productId:raw?.productId ?? parseProductId(raw?.href), url, marketplace:site.value, currency:site.currency,
    brand:raw?.brand || null, name:raw?.name || null, price,
    ...(sa ? { ratingCount:count, reviewMetric:'rating_count' } : { priceTRY:price, reviewCount:count, reviewMetric:'review_count' }),
    rating:parseRating(raw?.ratingText),
    bestSellerRank:sa ? null : (parseBestSellerRank(fullText) ?? fallback.bestSellerRank),
    favoriteRank:sa ? null : (parseFavoriteRank(fullText) ?? fallback.favoriteRank),
    priceBasis:sa ? 'search_card_displayed_sale_price_may_be_conditional' : 'search_card_displayed_price',
    badges:parseBadges([raw?.badgeText, fullText].filter(Boolean).join(' ')),
    attributes:Array.isArray(raw?.attributes) ? raw.attributes.filter(Boolean) : [] };
}
export async function searchProducts({ keyword, marketplace = 'TR', pages = 2, limit = 100, log = () => {} } = {}) {
  const site = requireTrendyolCaptureSite(marketplace);
  const kw = String(keyword ?? '').trim();
  if (!kw) throw fail('INVALID_ARGS', '缺少搜索关键词');
  if (!Number.isInteger(pages) || pages < 1 || pages > 5 || !Number.isInteger(limit) || limit < 10 || limit > 100) throw fail('INVALID_ARGS', 'pages 必须为1-5、limit 为10-100的整数');
  await ensureSession({ marketplace:site.value, log });
  const rows = [], seen = new Set(), sourceUrls = [], diagnostics = [];
  let pagesFetched = 0;
  for (let page = 1; page <= pages; page++) {
    const url = new URL(site.searchPath, site.origin);
    url.searchParams.set('q', kw);
    if (page > 1) url.searchParams.set('pi', String(page));
    const tabId = await openTab(url.href);
    try {
      await waitForPage(tabId, site, 'document.querySelectorAll("a.product-card").length > 0');
      await pause(PAGE_DELAY_MS);
      const guard = await assertPageUsable(tabId, site, { expectCards:true });
      pagesFetched++;
      sourceUrls.push(guard.url);
      if (guard.noResults) break;
      const data = await runSnippet(tabId, 'trendyol-search-cards.js', site);
      const items = Array.isArray(data?.items) ? data.items : [];
      if (!items.length && !guard.noResults) diagnostics.push(await pageDiagnostic(tabId, 'deterministic_search_selectors_empty'));
      let added = 0;
      for (const raw of items) {
        const card = toProductCard(raw, site.value);
        if (!card.productId || !card.url || seen.has(card.productId)) continue;
        const capturedAt = new Date().toISOString();
        const evidenced = attachBrowserEvidence(card, {
          sourceUrl: guard.url,
          source: 'trendyol:搜索页',
          capturedAt,
          expectedOrigin: site.origin,
          expectedMarketplace: site.value,
          expectedCurrency: site.currency,
          locators: {
            price: 'product-card price selectors', rating: 'product-card rating selectors',
            ratingCount: 'product-card rating-count selectors', reviewCount: 'product-card review-count selectors',
            productId: 'product-card href/data-id', url: 'product-card href',
          },
        });
        seen.add(card.productId); rows.push(evidenced); added++;
      }
      log('搜索第 ' + page + ' 页：' + items.length + ' 张卡片，新增 ' + added + ' 个商品');
      if (!added || rows.length >= limit) break;
    } finally { await closeTab(tabId); }
    if (page < pages) await pause(PAGE_DELAY_MS);
  }
  return { rows:rows.slice(0,limit), sourceUrls, diagnostics, count:Math.min(rows.length,limit), keyword:kw, pagesFetched,
    marketplace:site.value, currency:site.currency, fetchedAt:new Date().toISOString(), source:'trendyol:搜索页' };
}
export async function fetchProductDetail({ url, marketplace = 'TR', log = () => {} } = {}) {
  const site = requireTrendyolCaptureSite(marketplace);
  if (!url) throw fail('INVALID_ARGS', '缺少商品 url');
  let target;
  try { target = new URL(url, site.origin); } catch { throw fail('INVALID_ARGS', '非法 Trendyol 商品链接'); }
  if (target.origin !== site.origin || target.username || target.password || !parseProductId(target.pathname)) throw fail('INVALID_ARGS', '商品链接与目标 Trendyol 国家不符');
  const tabId = await openTab(target.href);
  try {
    await waitForPage(tabId, site, 'document.body && document.body.innerText.length > 500');
    await pause(PAGE_DELAY_MS);
    const guard = await assertPageUsable(tabId, site);
    const data = await runSnippet(tabId, 'trendyol-product-detail.js', site);
    const sa = site.value === 'SA', s = data?.structured;
    if (sa && s?.currency && s.currency !== site.currency) throw fail('COUNTRY_MISMATCH', '商品结构化价格币种不匹配');
    const price = sa ? (s?.currency === site.currency ? parsePriceSAR(s.price) : null) : parsePriceTRY(data?.priceText);
    const integer = value => { const n = value == null || value === '' ? NaN : Number(value); return Number.isSafeInteger(n) && n >= 0 ? n : null; };
    const crumbs = Array.isArray(data?.crumbs) ? data.crumbs : [];
    log('商品页：' + (data?.h1 || data?.title || ''));
    const capturedAt = new Date().toISOString();
    const record = { url:guard.url, productId:parseProductId(guard.url), title:data?.h1 || data?.title || null,
      marketplace:site.value, currency:site.currency, price,
      ...(sa ? { ratingCount:integer(s?.ratingCount), commentCount:integer(s?.commentCount), rating:parseRating(s?.rating), metricSource:s?.source || null } : { priceTRY:price }),
      breadcrumb:crumbs, categoryPath:formatBreadcrumb(crumbs), categoryRank:sa ? null : parseCategoryRank(data?.bodyHead),
      priceText:data?.priceText || null, attributes:data?.attrs || {},
      origin:(String(data?.bodyHead || '').match(/Menşei\s*\n?\s*([A-Z]{2})\b/) || [])[1] || null,
      fetchedAt:capturedAt, source:'trendyol:商品页' };
    if (!record.title || record.price === null) record.diagnostic = await pageDiagnostic(tabId, 'deterministic_detail_fields_missing');
    return attachBrowserEvidence(record, {
      sourceUrl: guard.url, source: record.source, capturedAt,
      expectedOrigin: site.origin, expectedMarketplace: site.value, expectedCurrency: site.currency,
      locators: {
        title: 'h1/title/structured-data', price: 'structured-data or product-price selectors',
        rating: 'structured-data aggregateRating', ratingCount: 'structured-data ratingCount',
        commentCount: 'structured-data reviewCount', breadcrumb: 'breadcrumb selectors', attributes: 'product attribute selectors',
      },
    });
  } finally { await closeTab(tabId); }
}
