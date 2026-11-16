/**
 * Trendyol 页面文本解析（纯函数，可离线单测）。
 *
 * 这里的每个函数都对应一个实测踩过的坑，别凭直觉改：
 *   - 土耳其数字格式：'2.299 TL' = 2299（点是千分位）；'2.655,20 TL' = 2655.20（逗号是小数）
 *   - 评论数是带括号的 '(2183)'
 *   - 畅销/收藏排名写成 'En Çok Satan 5. Ürün' / 'En Çok Favorilenen 5. Ürün'
 */

/** 安全转数字；失败返回 null（不用 0 兜底，避免把"取不到"伪装成"是 0"）。 */
export function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/\s/g, '');
  if (cleaned === '') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 解析土耳其格式价格 → 数字（TRY）。
 *
 * 规则（按实测样本归纳）：
 *   '2.299 TL'      → 2299      （单个点 + 后 3 位 = 千分位）
 *   '2.655,20 TL'   → 2655.20   （点和逗号都有 = 点千分位、逗号小数）
 *   '14.957,37 TL'  → 14957.37
 *   '699 TL'        → 699
 *   '1.234.567'     → 1234567   （多个点 = 全是千分位）
 *   '99,90'         → 99.90     （只有逗号 = 小数）
 *   '12.5'          → 12.5      （单个点 + 非 3 位 = 小数）
 */
export function parsePriceTRY(text) {
  const src = String(text ?? '').trim();
  const amounts = [...src.matchAll(/(\d[\d.,]*)\s*TL\b/gi)];
  // Multiple prices (old/current/basket) are ambiguous: never guess which applies.
  if (amounts.length > 1) return null;
  const rawText = amounts.length === 1 ? amounts[0][1] : src;
  if (!/^\d[\d.,]*$/.test(rawText)) return null;
  let raw = rawText;
  if (raw.includes(',')) {
    if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+),\d{1,2}$/.test(raw)) return null;
    raw = raw.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(?:\.\d{3})+$/.test(raw)) raw = raw.replace(/\./g, '');
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Saudi English storefront: decimal point, comma thousands; dedicated fields only. */
export function parsePriceSAR(text) {
  const raw = String(text ?? '').trim().replace(/\s*(?:SAR|ر\.س\.?)\s*/gi, '').trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw)) return null;
  const value = Number(raw.replace(/,/g, ''));
  return Number.isFinite(value) && value >= 0 ? value : null;
}
export function parseSaudiRatingCount(text) {
  const raw = String(text ?? '').trim().replace(/^\(([^()]+)\)$/, '$1').trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(raw)) return null;
  const value = Number(raw.replace(/,/g, ''));
  return Number.isSafeInteger(value) ? value : null;
}

/** '(2.183)' or a bare whole number; abbreviations are not inferred. */
export function parseReviewCount(text) {
  const raw = String(text ?? '').trim().replace(/^\(([^()]+)\)$/, '$1').trim();
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)$/.test(raw)) return null;
  return num(raw.replace(/\./g, ''));
}

/** Rating fields only; model numbers must not become ratings. */
export function parseRating(text) {
  const raw = String(text ?? '').trim();
  if (!/^[0-5](?:[.,]\d+)?$/.test(raw)) return null;
  const value = num(raw.replace(',', '.'));
  return value !== null && value <= 5 ? value : null;
}

/** 解析「En Çok Satan 5. Ürün」→ 5；没有返回 null。 */
export function parseBestSellerRank(text) {
  const match = String(text ?? '').match(/En\s+Çok\s+Satan\s+(\d+)\.?\s*Ürün/i);
  return match ? num(match[1]) : null;
}

/** 解析「En Çok Favorilenen 5. Ürün」→ 5；没有返回 null。 */
export function parseFavoriteRank(text) {
  const match = String(text ?? '').match(/En\s+Çok\s+Favorilenen\s+(\d+)\.?\s*Ürün/i);
  return match ? num(match[1]) : null;
}

/** 解析「En Çok Satılan Tencere #3」→ 3（商品详情页的类目畅销排名）。 */
export function parseCategoryRank(text) {
  const match = String(text ?? '').match(/En\s+Çok\s+Satılan\s+[^#\n]{0,60}#\s*(\d+)/i);
  return match ? num(match[1]) : null;
}

/** 从商品 URL 抽 productId：'/tac/xxx-p-926032710?boutiqueId=61' → '926032710'。 */
export function parseProductId(href) {
  const match = String(href ?? '').match(/-p-(\d+)/);
  return match ? match[1] : null;
}

/** 从 URL 抽品牌 slug：'/tac/xxx-p-1' → 'tac'（仅作兜底，优先用页面的 product-brand）。 */
export function parseBrandSlug(href) {
  const match = String(href ?? '').match(/^\/?([^/?#]+)\//);
  return match ? match[1] : null;
}

/** 常见促销/物流标签（用于报告里说明价格是否含活动）。 */
const BADGE_PATTERNS = Object.freeze([
  ['超级促销', /Süper\s+Kampanya/i],
  ['超级优惠', /Süper\s+Fırsat/i],
  ['今日发货', /Bugün\s+Kargoda/i],
  ['免运费', /Kargo\s+Bedava/i],
  ['购物车折扣', /Sepette\s+%\s*\d+\s*İndirim/i],
  ['优惠券', /Kupon/i],
  ['30天最低价', /Son\s+30\s+Günün\s+En\s+Düşük\s+Fiyatı/i],
]);

/** 从卡片文本里提取命中的标签（中文名，便于报告阅读）。 */
export function parseBadges(text) {
  const src = String(text ?? '');
  return BADGE_PATTERNS.filter(([, pattern]) => pattern.test(src)).map(([label]) => label);
}

/**
 * 把一张商品卡片的原始文本解析成结构化结果（兜底路径）。
 * 正常路径优先用结构化选择器（见 snippets/trendyol-search-cards.js），
 * 这个函数用于选择器失效时从文本兜底，以及离线单测。
 */
export function parseCardText(cardText) {
  const text = String(cardText ?? '').replace(/\s+/g, ' ').trim();
  return {
    bestSellerRank: parseBestSellerRank(text),
    favoriteRank: parseFavoriteRank(text),
    rating: parseRating((text.match(/(?:^|\s)([0-5][.,]\d+)\s*\(\d[\d.]*\)/) || [])[1]),
    reviewCount: parseReviewCount((text.match(/\(\d[\d.]*\)/) || [])[0]),
    priceTRY: /\bTL\b/.test(text) ? parsePriceTRY(text) : null,
    badges: parseBadges(text),
  };
}

/** 类目路径数组 → 可读路径（'Ev ve Mobilya › Sofra&Mutfak › Tencere'）。 */
export function formatBreadcrumb(crumbs, sep = ' › ') {
  const list = (Array.isArray(crumbs) ? crumbs : [])
    .map((c) => String(c ?? '').trim())
    .filter((c) => c !== '' && c !== 'Trendyol');
  return list.length ? list.join(sep) : '';
}
