import { searchProducts, fetchProductDetail } from '../web/trendyol.js';
import { listTabs } from '../web/chrome.js';
import { TRENDYOL_SITES } from '../platforms/trendyol-sites.js';

/**
 * Trendyol「网页登录态」provider。
 *
 * 与 sellersprite-web 的差别：
 *   - 不需要登录（公开页面），但必须核验真实目标国家（TR / SA）与币种；
 *   - 只能取 marketplace / product 两类能力，没有关键词、流量、ABA 这些 Amazon 专有数据。
 */

/** 健康检查缓存（避免面板每次刷新都驱动浏览器）。 */
const HEALTH_TTL_MS = 60_000;
let healthCache = { at: 0, value: null };

/**
 * 轻量健康检查：只列标签页判断「Chrome 可用 + 有 Trendyol 页」，不打开任何页面。
 * 与 sellersprite-web 同款策略：慢探针会拖垮面板 overview。
 */
async function probeSession() {
  const tabs = await listTabs();
  const hit = tabs.find(tab => { try { return TRENDYOL_SITES.some(site => site.captureSupported && new URL(tab.url).origin === site.origin) && !tab.url.includes('select-country'); } catch { return false; } });
  if (!hit) {
    return {
      ok: false,
      error: '未检测到 Trendyol 标签页：土耳其请打开 www.trendyol.com；沙特阿拉伯请打开 www.trendyol.sa/en。抓取前还会核验国家/币种。',
    };
  }
  return { ok: true, note: '检测到 Trendyol 标签页（轻量检查，不代表国家/页面验证通过；抓取前会校验）' };
}

export const trendyolWebProvider = {
  id: 'trendyol-web',
  label: 'Trendyol（网页抓取）',
  platforms: ['trendyol'],
  capabilities: ['market', 'product'],

  /**
   * 健康检查（带 TTL 缓存）。
   * @param {{force?:boolean}} [opts]
   */
  async health(opts = {}) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const now = Date.now();
    if (options.force !== true && healthCache.value !== null && now - healthCache.at < HEALTH_TTL_MS) {
      return healthCache.value;
    }
    let value;
    try {
      value = await probeSession();
    } catch (error) {
      value = { ok: false, error: String(error?.message ?? error) };
    }
    healthCache = { at: now, value };
    return value;
  },

  /** 强制刷新健康检查缓存 */
  invalidateHealth() {
    healthCache = { at: 0, value: null };
  },

  async searchProducts(args) {
    return searchProducts(args);
  },

  async productDetail(args) {
    return fetchProductDetail(args);
  },
};
