/**
 * Amazon.sa 前台找品读取（沙特专用）。
 *
 * 规则：
 *   - 只读公开前台，不做登录、不绕过验证码/限流/拒绝访问；
 *   - 只允许 www.amazon.sa 同源，币种必须是 SAR，否则停止；
 *   - 只产出观测行，不产生候选、不算利润、不写报告。
 */
import { readFile } from 'node:fs/promises';
import { openTab, closeTab, runJson, waitFor } from './chrome.js';
import { AMAZON_SA_ORIGIN, amazonSaUrl, parseSarPrice, parseRating, parseCount, parseRank } from '../market/sa-discovery.js';

const PAGE_DELAY_MS = 1200;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const snippetCache = new Map();
const fail = (code, message) => Object.assign(new Error(message), { code });

async function snippet(name) {
  if (!snippetCache.has(name)) snippetCache.set(name, await readFile(new URL('./snippets/' + name, import.meta.url), 'utf8'));
  return snippetCache.get(name).trim();
}

/** 搜索页与榜单页分页参数不同：/s? 用 page，bestsellers 用 pg。 */
export function buildDiscoveryUrls({ mode = 'search', keyword = '', categoryUrl = '', pages = 1 } = {}) {
  const count = Math.max(1, Math.min(3, Number(pages) || 1));
  const urls = [];
  if (mode === 'bestsellers') {
    if (!amazonSaUrl(categoryUrl)) throw fail('INVALID_ARGS', '榜单位置需要提供 www.amazon.sa 同源链接');
    for (let page = 1; page <= count; page += 1) {
      const url = new URL(categoryUrl);
      if (page > 1) url.searchParams.set('pg', String(page));
      urls.push(url.href);
    }
    return urls;
  }
  const kw = String(keyword || '').trim();
  if (!kw) throw fail('INVALID_ARGS', '搜索模式需要 keyword');
  for (let page = 1; page <= count; page += 1) {
    const url = new URL('/s', AMAZON_SA_ORIGIN);
    url.searchParams.set('k', kw);
    if (page > 1) url.searchParams.set('page', String(page));
    urls.push(url.href);
  }
  return urls;
}

/** 页面守卫：任何风控或国家/币种不符都立即抛错，不重试。 */
export function assertGuard(guard) {
  if (!guard || typeof guard !== 'object') throw fail('SESSION_NOT_READY', 'Amazon.sa 页面状态未取到');
  if (guard.captcha) throw fail('CAPTCHA', 'Amazon.sa 出现人机验证，已停止，请人工完成验证；插件不会绕过。');
  if (guard.rateLimited) throw fail('RATE_LIMITED', 'Amazon.sa 访问受限（限流），已停止；请人工检查，不自动重试。');
  if (guard.accessDenied) throw fail('ACCESS_DENIED', 'Amazon.sa 拒绝访问，已停止；不换标签、不重试。');
  if (guard.signIn) throw fail('NOT_LOGGED_IN', 'Amazon.sa 要求登录，已停止；请在 Chrome 手动登录后重试。');
  if (guard.origin !== AMAZON_SA_ORIGIN) throw fail('ORIGIN_MISMATCH', '当前页面不是 www.amazon.sa，已停止：' + String(guard.url || ''));
  if (guard.currencyUSD && !guard.currencySAR) throw fail('CURRENCY_MISMATCH', 'Amazon.sa 页面未显示 SAR 价格，已停止，不按域名猜测币种。');
  if (guard.empty && !guard.noResults) throw fail('EMPTY_PAGE', 'Amazon.sa 页面为空或未完成加载，已停止。');
  return guard;
}

/** 把卡片行规范成统一结构，价格/评分/数量解析失败一律 null（未取到），不估算。 */
export function normalizeCard(raw, { pageUrl, position } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const url = amazonSaUrl(raw.url) ? raw.url : null;
  if (!url) return null;
  const priceSAR = parseSarPrice(raw.priceText);
  return {
    kind: raw.kind === 'rank' ? 'rank' : 'search',
    asin: typeof raw.asin === 'string' && /^[A-Z0-9]{10}$/.test(raw.asin) ? raw.asin : null,
    title: String(raw.title || '').trim() || null,
    url,
    pageUrl,
    position: Number.isInteger(raw.position) ? raw.position : position ?? null,
    priceText: raw.priceText || null,
    priceSAR,
    rating: parseRating(raw.ratingText),
    ratingText: raw.ratingText || null,
    reviewCount: parseCount(raw.reviewText),
    reviewText: raw.reviewText || null,
    rank: parseRank(raw.rankText),
    rankText: raw.rankText || null,
    sponsored: raw.sponsored === true,
  };
}

/**
 * 采集：按 URL 顺序打开标签页，逐页守卫生效后抽取，遇阻立即抛出（不保留半成品结论）。
 * @returns {{ok:true, rows:object[], sourceUrls:string[], pagesFetched:number, diagnostics:object[], fetchedAt:string}}
 */
export async function collectAmazonSa({ mode = 'search', keyword = '', categoryUrl = '', pages = 1, limit = 30, log = () => {}, open = openTab, close = closeTab } = {}) {
  const max = Math.max(1, Math.min(60, Number(limit) || 30));
  const urls = buildDiscoveryUrls({ mode, keyword, categoryUrl, pages });
  const rows = [];
  const sourceUrls = [];
  const diagnostics = [];
  const seen = new Set();
  let pagesFetched = 0;
  for (const url of urls) {
    const tabId = await open(url);
    let guard = null;
    try {
      // 刚开的标签页先停在 about:blank，readyState 立刻为 complete。
      // 必须等到真正导航到目标域名再取守卫，否则会误判成 ORIGIN_MISMATCH。
      await waitFor(tabId, 'location.origin === ' + JSON.stringify(AMAZON_SA_ORIGIN) + ' && document.readyState === "complete"', { timeout: 45 });
      await pause(PAGE_DELAY_MS);
      guard = assertGuard(await runJson(tabId, await snippet('amazon-sa-guard.js')));
      pagesFetched += 1;
      sourceUrls.push(guard.url);
      if (guard.noResults) break;
      const data = await runJson(tabId, await snippet('amazon-sa-cards.js'));
      const items = Array.isArray(data?.items) ? data.items : [];
      if (!items.length) {
        diagnostics.push({ pageUrl: guard.url, reason: 'deterministic_card_selectors_empty', resultCount: guard.resultCount, rankCount: guard.rankCount });
      }
      let added = 0;
      for (const raw of items) {
        const card = normalizeCard(raw, { pageUrl: guard.url, position: raw?.position });
        if (!card) continue;
        const key = (card.asin || card.url) + '|' + card.kind;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(card);
        added += 1;
        if (rows.length >= max) break;
      }
      log('Amazon.sa 第 ' + pagesFetched + ' 页：' + added + ' 条');
      if (rows.length >= max) break;
    } finally {
      try {
        await close(tabId);
      } catch {
        /* 关闭失败不影响已采集结果，也不重试 */
      }
    }
  }
  return { ok: true, mode, keyword: mode === 'search' ? String(keyword).trim() : null, categoryUrl: mode === 'bestsellers' ? categoryUrl : null, rows, sourceUrls, pagesFetched, diagnostics, fetchedAt: new Date().toISOString() };
}
