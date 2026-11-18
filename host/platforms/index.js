/**
 * 平台注册表：把「平台差异」收进一处，评分引擎 / 报告 / 面板只认抽象字段。
 *
 * 设计原则：
 *   - 这里只放**描述性元数据**（各叫法、币种、站点、可用数据源），不放业务逻辑；
 *   - 平台特有计算（比如 Trendyol 没有销额用什么代理）放在 scoring.js 的平台分支里；
 *   - 新增平台 = 这里加一条 + providers 里声明 + 一个取数适配器。
 */

import { TRENDYOL_SITES } from './trendyol-sites.js';

/** @typedef {{value:string, label:string}} PlatformSite */

export const PLATFORMS = Object.freeze({
  amazon: Object.freeze({
    id: 'amazon',
    label: 'Amazon',
    /** 报告与商品 ID 的叫法 */
    productIdLabel: 'ASIN',
    categoryPathLabel: 'nodeIdPath',
    rankLabel: 'BSR',
    fulfillmentLabel: 'FBA',
    selfOperatedLabel: 'Amazon 自营',
    /** 币种 */
    currency: 'USD',
    currencySymbol: '$',
    defaultSite: 'US',
    sites: Object.freeze([
      { value: 'US', label: '美国' },
      { value: 'UK', label: '英国' },
      { value: 'DE', label: '德国' },
      { value: 'FR', label: '法国' },
      { value: 'IT', label: '意大利' },
      { value: 'ES', label: '西班牙' },
      { value: 'CA', label: '加拿大' },
      { value: 'JP', label: '日本' },
      ...['MX','AU','IN','AE','BR'].map((value) => ({ value, label: value })),
    ]),
    /** 该平台可用的数据源（provider id） */
    providers: Object.freeze(['sellersprite', 'sellersprite-web', 'sorftime']),
    /**
     * 市场规模维度的取数口径：
     *   revenue     — 有月销额（Amazon 卖家精灵能给）
     *   review_mass — 没有销额，用样本累计评论数当市场活跃度代理（Trendyol）
     */
    marketSizeBasis: 'revenue',
    /** 进入壁垒维度里「平台自营占比」这一项的来源 */
    selfOperatedAvailable: true,
  }),

  trendyol: Object.freeze({
    id: 'trendyol',
    label: 'Trendyol.sa',
    productIdLabel: 'productId',
    categoryPathLabel: 'categoryId',
    rankLabel: '类目畅销排名',
    fulfillmentLabel: 'Trendyol Express',
    selfOperatedLabel: 'Trendyol 自营',
    currency: 'SAR',
    currencySymbol: 'SAR',
    defaultSite: 'SA',
    sites: Object.freeze(TRENDYOL_SITES.filter(site => site.value === 'SA')),
    providers: Object.freeze(['trendyol-web']),
    /** Trendyol 页面不公布销量/销额 → 只能用评论总量做代理 */
    marketSizeBasis: 'review_mass',
    selfOperatedAvailable: false,
  }),
});

/** 全部平台列表（按注册顺序） */
export function listPlatforms() {
  return Object.values(PLATFORMS).map((p) => ({
    id: p.id,
    label: p.label,
    currency: p.currency,
    defaultSite: p.defaultSite,
    sites: p.sites.map((s) => ({ ...s })),
    providers: [...p.providers],
  }));
}

/** 取平台定义；未知返回 null */
export function getPlatform(id) {
  const key = String(id || '').trim().toLowerCase();
  return Object.hasOwn(PLATFORMS, key) ? PLATFORMS[key] : null;
}

/** 取平台定义，找不到就抛可读错误（用于工具入口的参数校验） */
export function requirePlatform(id) {
  const platform = getPlatform(id);
  if (platform) return platform;
  const err = new Error('未知平台: ' + String(id) + '。可选值：' + Object.keys(PLATFORMS).join(' / '));
  err.code = 'UNKNOWN_PLATFORM';
  throw err;
}

/** 某个 provider 是否支持该平台 */
export function providerSupportsPlatform(providerId, platformId) {
  const platform = getPlatform(platformId);
  if (!platform) return false;
  return platform.providers.includes(String(providerId || '').trim());
}

/** 该平台可用的 provider 列表 */
export function providersForPlatform(platformId) {
  const platform = getPlatform(platformId);
  return platform ? [...platform.providers] : [];
}

/** 根据 provider 反查它属于哪些平台（一个 provider 可能支持多个平台） */
export function platformsOfProvider(providerId) {
  const id = String(providerId || '').trim();
  return Object.values(PLATFORMS).filter((p) => p.providers.includes(id)).map((p) => p.id);
}

/** 平台的站点校验：非法站点返回 null */
export function resolveSite(platformId, site) {
  const platform = getPlatform(platformId);
  if (!platform) return null;
  const wanted = String(site || platform.defaultSite).trim().toUpperCase();
  const hit = platform.sites.find((s) => s.value === wanted);
  return hit ? hit.value : null;
}
