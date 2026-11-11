import { fetchMarketList, fetchNodeReport, fetchTopProducts } from '../web/sellersprite-web.js';
import { listTabs } from '../web/chrome.js';

/**
 * 卖家精灵「网页登录态」provider。
 * 能力：market / product / nodeReport。鉴权依赖用户在 Chrome 中已登录 sellersprite.com。
 */

/** 健康检查结果缓存（避免每次面板刷新都跑浏览器自动化）。 */
const HEALTH_TTL_MS = 60_000;
let healthCache = { at: 0, value: null };

/**
 * 轻量健康检查：**只列浏览器标签页**判断是否已登录卖家精灵，不打开任何数据页。
 *
 * 为什么不能直接抓数据页：抓「选市场」页要开新标签、跑筛选、等渲染，单次 8~10 秒。
 * 面板每次刷新 overview 都调一次 health()，会让面板请求直接超时（前端超时 8 秒）。
 */
async function probeWebSession() {
  const tabs = await listTabs();
  const hit = tabs.find((tab) => tab.url.includes('sellersprite.com') && !tab.url.includes('/sign'));
  if (!hit) {
    return {
      ok: false,
      error: '未找到已登录的卖家精灵标签页：请在 Chrome 里登录 sellersprite.com 后打开一个页面',
    };
  }
  return { ok: true, note: '网页登录态可用（检测到已登录标签页）', tabUrl: hit.url };
}

export const sellerspriteWebProvider = {
  id: 'sellersprite-web',
  label: '卖家精灵（网页登录态）',
  capabilities: ['market', 'product', 'nodeReport'],
  /**
   * 健康检查（带 TTL 缓存）。
   * @param {{force?:boolean, log?:Function}} [opts]
   */
  async health(opts = {}) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const now = Date.now();
    if (options.force !== true && healthCache.value !== null && now - healthCache.at < HEALTH_TTL_MS) {
      return healthCache.value;
    }
    let value;
    try {
      value = await probeWebSession();
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
  async marketList(args) {
    return fetchMarketList(args);
  },
  async nodeReport(args) {
    return fetchNodeReport(args);
  },
  async topProducts(args) {
    return fetchTopProducts(args);
  },
};
