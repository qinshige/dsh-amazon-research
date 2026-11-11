import { fetchMarketList, fetchNodeReport, fetchTopProducts } from '../web/sellersprite-web.js';

/**
 * 卖家精灵「网页登录态」provider。
 * 能力：market / product / nodeReport。鉴权依赖用户在 Chrome 中已登录 sellersprite.com。
 */
export const sellerspriteWebProvider = {
  id: 'sellersprite-web',
  label: '卖家精灵（网页登录态）',
  capabilities: ['market', 'product', 'nodeReport'],
  async health(log = () => {}) {
    try {
      const probe = await fetchMarketList({ keyword: '', limit: 1, log });
      return { ok: true, note: '网页登录态可用' };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
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
