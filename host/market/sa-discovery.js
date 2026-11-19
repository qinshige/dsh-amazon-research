/**
 * 沙特找品来源（Amazon.sa）与需求观测契约。
 *
 * 定位：Trendyol.sa 是**唯一**销售平台；Amazon.sa 只回答「这个品在沙特有没有人买」，
 * 不产生候选、不通过任何关卡、不参与利润/退货/评分计算。
 *
 * 本文件只放纯逻辑：模板、校验、解析、待匹配池渲染。没有浏览器、没有 IO、不联网。
 */

export const DISCOVERY_MODEL = 'saudi-demand-discovery-v1';
export const AMAZON_SA_ORIGIN = 'https://www.amazon.sa';
export const TRENDYOL_SA_ORIGIN = 'https://www.trendyol.sa';

/** 需求证据门槛：4 项规则至少 2 项通过，且至少 1 项来自 Trendyol.sa。 */
export const DEMAND_POLICY = Object.freeze({
  minimumPassed: 2,
  minimumTrendyolPassed: 1,
  aggregation: 'forbidden',
  rule: '两平台观测只并列，绝不相加、不平均、不换算销量',
});

/** 可用信号类型：只描述「看到了什么」，不换算成销量或 GMV。 */
export const SIGNAL_TYPES = Object.freeze([
  'rating-count',
  'review-count',
  'rating',
  'rank',
  'badge',
  'search-result-count',
  'recent-growth',
  'seller-count',
  'unmet-need',
]);

/** 观测商品与 Trendyol 候选的关系。Amazon 观测最多只能到「同用途同规格」。 */
export const RELATIONS = Object.freeze(['same-product', 'same-purpose-same-spec', 'similar', 'unknown']);

/** 可比性：not-comparable 的观测不允许计入需求门槛。 */
export const COMPARABILITY = Object.freeze(['source-only', 'existence-check', 'not-comparable']);

const SOURCE_PLATFORMS = Object.freeze(['trendyol-sa', 'amazon-sa']);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** 严格同源校验：https、无凭证、无端口、域名精确匹配。 */
export function strictOriginUrl(value, origin) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === origin && !url.username && !url.password && !url.port;
  } catch {
    return false;
  }
}

export function amazonSaUrl(value) {
  return strictOriginUrl(value, AMAZON_SA_ORIGIN);
}

export function trendyolSaUrl(value) {
  return strictOriginUrl(value, TRENDYOL_SA_ORIGIN);
}

/** 把 "SAR 39.99" / "39,99 SAR" / "‏8.12 ريال" / "ر.س.‏ 39.99" 解析为数字；不带货币标记时返回 null。 */
export function parseSarPrice(input) {
  const arabic = (value) => String(value).replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
  const raw = arabic(String(input ?? '')).replace(/\u00a0/g, ' ').replace(/[\u200e\u200f]/g, '').trim();
  if (!raw) return null;
  // 沙特前台常见三种写法：SAR / ر.س. / ريال
  const marker = /(?:SAR|ريال|ر\.?\s?س\.?|﷼)/i.test(raw);
  if (!marker) return null;
  const digits = raw.replace(/[^\d.,]/g, ' ').trim().replace(/^[.,\s]+/, '').split(/\s+/)[0] || '';
  if (!/\d/.test(digits)) return null;
  // 沙特价通常形如 1,299.00 或 1.299,00；按最后一个分隔符判断小数位。
  let normalized = digits;
  const lastComma = digits.lastIndexOf(',');
  const lastDot = digits.lastIndexOf('.');
  if (lastComma > lastDot) normalized = digits.replace(/\./g, '').replace(',', '.');
  else normalized = digits.replace(/,/g, '');
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** "4.3 out of 5 stars" / "4,3 من 5 نجوم" / "4.3 de 5 estrellas" → 4.3 */
export function parseRating(input) {
  const raw = String(input ?? '');
  // 优先匹配「X ... 5 ...」这类明确星级（阿语可能是「4.7 من أصل 5 نجوم」），避免抓到「5 个评论」
  const explicit = raw.match(/(\d(?:[.,]\d)?)\s*(?:out of|من|de|de un|of)\s*(?:أصل\s*)?5/i);
  if (explicit) {
    const value = Number.parseFloat(explicit[1].replace(',', '.'));
    return Number.isFinite(value) && value >= 0 && value <= 5 ? value : null;
  }
  const stars = raw.match(/(\d(?:[.,]\d)?)\s*(?:نجوم|stars?|estrella|sterne)/i);
  if (stars) {
    const value = Number.parseFloat(stars[1].replace(',', '.'));
    return Number.isFinite(value) && value >= 0 && value <= 5 ? value : null;
  }
  const fallback = raw.match(/(\d(?:[.,]\d)?)/);
  if (!fallback) return null;
  const value = Number.parseFloat(fallback[1].replace(',', '.'));
  return Number.isFinite(value) && value >= 0 && value <= 5 ? value : null;
}

/** "1,234" / "١٢٣٤" → 1234；含 "K" 时按千展开。 */
export function parseCount(input) {
  const raw = String(input ?? '');
  const match = raw.match(/([\d٠-٩][\d٠-٩.,]*)\s*(K|k|ألف)?/);
  if (!match) return null;
  const digits = match[1].replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  // 带 K/ألف 时保留小数点（2.1K=2100），否则按千分位分隔符处理（1,234=1234）。
  let value = Number.parseFloat(match[2] ? digits.replace(/,/g, '') : digits.replace(/[,.]/g, ''));
  if (!Number.isFinite(value)) return null;
  if (match[2]) value *= 1000;
  return Number.isInteger(value) && value >= 0 ? value : Math.round(value);
}

/** "#12 in Home & Kitchen" / "١٢ في المنزل" → 12 */
export function parseRank(input) {
  const raw = String(input ?? '');
  const match = raw.match(/#?\s*([\d٠-٩]{1,7})/);
  if (!match) return null;
  const digits = match[1].replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const value = Number.parseInt(digits, 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * 校验单条观测。返回错误数组（空数组表示通过）。
 * 只校验结构与来源，不判断观测内容是否真实——真实性由采集方式与证据路径负责。
 */
export function validateObservation(observation, { index = 0, seenIds = null } = {}) {
  const errors = [];
  const at = `observations[${index}]`;
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return [at + ' 必须是对象'];
  if (!text(observation.id)) errors.push(at + '.id 缺失');
  else if (seenIds && seenIds.has(observation.id)) errors.push(at + '.id 重复：' + observation.id);
  if (!SOURCE_PLATFORMS.includes(observation.sourcePlatform)) errors.push(at + '.sourcePlatform 必须是 trendyol-sa 或 amazon-sa');
  const originCheck = observation.sourcePlatform === 'trendyol-sa' ? trendyolSaUrl : amazonSaUrl;
  if (!text(observation.sourceUrl) || !originCheck(observation.sourceUrl)) errors.push(at + '.sourceUrl 必须是对应平台 https 原始链接');
  if (!text(observation.observedAt) || !/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/.test(observation.observedAt) || !Number.isFinite(Date.parse(observation.observedAt))) errors.push(at + '.observedAt 必须是有效日期');
  if (!SIGNAL_TYPES.includes(observation.signalType)) errors.push(at + '.signalType 不在允许列表');
  if (!(finite(observation.value) || text(observation.value))) errors.push(at + '.value 必须是非空文本或有限数字');
  if (!COMPARABILITY.includes(observation.comparability)) errors.push(at + '.comparability 不在允许列表');
  if (observation.signalType === 'unmet-need' && !text(observation?.scope?.note)) errors.push(at + '.scope.note 说明未满足需求时必填');
  if (observation.candidateRelation !== undefined && !RELATIONS.includes(observation.candidateRelation)) errors.push(at + '.candidateRelation 不在允许列表');
  if (!text(observation?.capture?.method)) errors.push(at + '.capture.method 必填：记录采集方式，不接受无来源观测');
  return errors;
}

/** 批量校验；同时检测 id 重复。 */
export function validateObservations(observations) {
  if (!Array.isArray(observations)) return { ok: false, errors: ['observations 必须是数组'] };
  const seenIds = new Set();
  const errors = [];
  observations.forEach((item, index) => {
    errors.push(...validateObservation(item, { index, seenIds }));
    if (text(item?.id)) seenIds.add(item.id);
  });
  return { ok: errors.length === 0, errors };
}

/**
 * 把采集到的一行 Amazon.sa 卡片转成标准观测。
 * 一行可能同时提供评分数、评分、榜单位次 → 拆成多条观测，每条只表达一个信号。
 */
export function toObservations(row, {
  sourceUrl,
  capturedAt = new Date().toISOString(),
  keyword = '',
  position = null,
  relation = 'unknown',
  listId = null,
} = {}) {
  if (!row || typeof row !== 'object') return [];
  if (!amazonSaUrl(sourceUrl)) return [];
  const observedAt = String(capturedAt).slice(0, 10);
  const scope = { keyword: keyword || null, category: null, listingId: row.asin || null, listingUrl: row.url || null, position, timeWindow: observedAt, note: '' };
  const base = {
    observedAt,
    scope,
    comparability: 'existence-check',
    candidateRelation: relation,
    capture: { method: 'browser-dom-structured', locator: listId || null, evidenceRef: null },
  };
  const out = [];
  const push = (suffix, signalType, value, locator) => {
    if (value === null || value === undefined || value === '') return;
    out.push({
      ...base,
      id: 'amz-' + String(row.asin || 'unknown') + '-' + suffix,
      sourcePlatform: 'amazon-sa',
      sourceUrl,
      signalType,
      value,
      unit: signalType === 'rank' ? 'position' : signalType === 'rating' ? 'stars' : 'count',
      capture: { ...base.capture, locator: locator || base.capture.locator },
    });
  };
  push('rating', 'rating', parseRating(row.ratingText), 'search-result [aria-label*="out of 5 stars"]');
  push('ratings', 'rating-count', parseCount(row.reviewText), 'search-result #customerReviews span');
  push('rank', 'rank', parseRank(row.rankText), 'bestsellers .zg-bdg-text');
  return out;
}

/** 采集入口：只允许 Amazon.sa 的搜索页与榜单页。 */
export function discoveryEntryPoints({ keyword = 'cup holder', categoryUrl = null } = {}) {
  const entries = [
    { id: 'best-sellers', label: 'Best Sellers', url: 'https://www.amazon.sa/gp/bestsellers/', note: '一级类目需下钻到三、四级，记录子类目链接' },
    { id: 'new-releases', label: 'New Releases', url: 'https://www.amazon.sa/gp/new-releases/', note: '上架时间与评论数同时记录，避免把新品当稳定需求' },
    { id: 'movers', label: 'Movers & Shakers', url: 'https://www.amazon.sa/gp/movers-and-shakers/', note: '短期飙升可能是促销或站外引爆，需回查增长是否持续' },
    { id: 'search', label: '关键词搜索', url: 'https://www.amazon.sa/s?k=' + encodeURIComponent(keyword), note: '只记录自然位；Sponsored 单独标注，不计入需求门槛' },
    { id: 'category', label: '指定类目页', url: categoryUrl || null, note: '用户提供时优先，必须是 www.amazon.sa 同源链接' },
  ];
  return entries.filter((entry) => entry.url !== null && amazonSaUrl(entry.url));
}

const missing = '待确认';
const md = (value) => String(value === null || value === undefined || value === '' ? missing : value).replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ').replace(/</g, '&lt;');
const table = (headers, rows) => ['| ' + headers.map(md).join(' | ') + ' |', '| ' + headers.map(() => '---').join(' | ') + ' |', ...rows.map((row) => '| ' + row.map(md).join(' | ') + ' |')].join('\n');

/** 免费计划：告诉调用方从哪找、记什么、哪些不能做。 */
export function buildDiscoveryPlan({ category = '', keyword = '', categoryUrl = null } = {}) {
  return {
    model: DISCOVERY_MODEL,
    salesPlatform: 'trendyol-sa',
    demandSources: ['trendyol-sa', 'amazon-sa'],
    currency: 'SAR',
    category,
    role: 'Amazon.sa 只做找品与需求交叉验证；候选、利润、合规、评分仍全部在 Trendyol.sa 工作流内完成。',
    rules: [
      '只有 Trendyol.sa 商品链接才能成为候选（pool.url 必须 trendyol.sa）',
      'Amazon.sa 观测最多支撑需求门槛，不能替代 Trendyol.sa 的需求验证',
      '需求 4 项至少 2 项通过，其中至少 1 项必须来自 Trendyol.sa',
      '两平台数值只并列：不相加、不平均、不换算销量或 GMV',
      'Amazon.sa 找到但 Trendyol.sa 无对应的品，只进待匹配池，不进候选池',
      '1688 依旧只做供应链证据，不得当作需求信号',
    ],
    entries: discoveryEntryPoints({ keyword, categoryUrl }),
    collectFields: [
      { field: 'asin', note: 'Amazon.sa 自身标识，仅用于追溯，不进入 Trendyol 候选' },
      { field: 'url', note: '必须 www.amazon.sa 同源' },
      { field: 'title', note: '原文，不做翻译改写' },
      { field: 'priceSAR', note: '页面显示价；带货币标记才解析，否则未取到' },
      { field: 'rating', note: '0–5 星' },
      { field: 'reviewCount', note: '页面评论/评分数字，不换算销量' },
      { field: 'rankText', note: '榜单位次原文，仅榜单页有' },
      { field: 'sponsored', note: '广告位单独标注，不计入需求门槛' },
      { field: 'observedAt', note: '观测日期，必填' },
    ],
    observationTemplate: {
      id: 'amz-B0XXXXXXXX-rating',
      sourcePlatform: 'amazon-sa',
      sourceUrl: 'https://www.amazon.sa/dp/B0XXXXXXXX',
      observedAt: '2026-11-18',
      signalType: 'rating-count',
      value: 1200,
      unit: 'count',
      scope: { keyword: 'cup holder', category: null, listingId: 'B0XXXXXXXX', position: 3, timeWindow: '2026-11-18', note: '' },
      candidateRelation: 'same-purpose-same-spec',
      comparability: 'existence-check',
      capture: { method: 'browser-dom-structured', locator: 'search-result #customerReviews span', evidenceRef: null },
    },
    waitingPoolColumns: ['ASIN', '标题', '售价SAR', '评分', '评分数', '榜单位次', '广告位', '链接', '观测日期'],
    demandPolicy: { ...DEMAND_POLICY },
    outputs: ['找品待匹配池.md', '找品来源.json'],
    nextStep: 'collect 产出 Amazon.sa 观测后，到 Trendyol.sa 搜同款拿到 Trendyol 链接，再按 research_product_select(action=plan) 模板回填候选的 demand.observations 与 pool。',
  };
}

/**
 * 合并采集观测与人工补录观测：按 id 去重，保留先出现的；返回 rejected 明细而不是静默丢弃。
 */
export function mergeObservations({ collected = [], manual = [] } = {}) {
  const merged = [];
  const seen = new Set();
  const rejected = [];
  for (const [origin, list] of [['collected', collected], ['manual', manual]]) {
    if (!Array.isArray(list)) {
      rejected.push({ origin, reason: '必须是数组' });
      continue;
    }
    for (const item of list) {
      const errors = validateObservation(item);
      if (errors.length) {
        rejected.push({ origin, id: item?.id ?? null, errors });
        continue;
      }
      if (seen.has(item.id)) {
        rejected.push({ origin, id: item.id, errors: ['id 重复，已保留首次出现的观测'] });
        continue;
      }
      seen.add(item.id);
      merged.push(item);
    }
  }
  return { ok: rejected.length === 0, observations: merged, rejected };
}

/** 待匹配池：Amazon.sa 找到但 Trendyol.sa 尚无对应的品，明确标注不进候选池。 */
export function waitingPoolMarkdown({ observations = [], keyword = '', generatedAt = new Date().toISOString() } = {}) {
  const valid = Array.isArray(observations) ? observations.filter((item) => item?.sourcePlatform === 'amazon-sa') : [];
  const byListing = new Map();
  for (const item of valid) {
    const key = item.scope?.listingId || item.scope?.listingUrl || item.sourceUrl;
    if (!byListing.has(key)) byListing.set(key, { url: item.scope?.listingUrl || item.sourceUrl, observedAt: item.observedAt, signals: {} });
    const bucket = byListing.get(key);
    bucket.signals[item.signalType] = item.value;
    if (!bucket.observedAt || item.observedAt > bucket.observedAt) bucket.observedAt = item.observedAt;
  }
  const rows = [...byListing.entries()].map(([listingId, entry]) => [
    listingId,
    entry.signals['rating-count'] ?? null,
    entry.signals.rating ?? null,
    entry.signals.rank ?? null,
    entry.signals['search-result-count'] ?? null,
    entry.url,
    entry.observedAt,
  ]);
  const header = [
    '# 找品待匹配池（Amazon.sa）',
    '',
    `生成时间：${generatedAt}；关键词：${keyword || missing}；来源平台：Amazon.sa（找品来源，不是销售平台）。`,
    '',
    '## 纪律',
    '',
    '- 本表商品**不进候选池**，也不参与利润、合规、评分。',
    '- 只有在 Trendyol.sa 找到对应商品并核验后，才能转入严格工作流成为候选。',
    '- 数字来自 Amazon.sa 前台观测，仅说明该品在沙特有人在买，不证明在 Trendyol.sa 能卖。',
    '- 未观测到的字段写「待确认」，不估算、不换算销量。',
    '',
    '## 待匹配商品',
    '',
  ];
  if (!rows.length) return header.concat(['本轮无 Amazon.sa 观测。', '']).join('\n');
  return header.concat([table(['商品标识', '评分数', '评分', '榜单位次', '搜索位', 'Amazon.sa 链接', '观测日期'], rows), '', `合计 ${rows.length} 条，全部等待 Trendyol.sa 同款匹配。`, '']).join('\n');
}
