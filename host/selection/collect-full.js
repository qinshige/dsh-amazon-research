/**
 * dsh-amazon-research · host/selection/collect-full.js
 *
 * 类目全量采集器：把「一个类目/关键词下的所有品」抓成候选池（目标 Top 50–100+）。
 *
 * 为什么需要（用户诉求 + 实测）：
 *   - 卖家精灵「查竞品」页按父体销量排序，且该类目下 Top240 全是手套、
 *     手套夹（真正的目标品）根本排不进去 → 只看 Top10 会得出完全错误的结论；
 *   - 用户要的是「第 50–100 名还有没有利润」，前提是**必须真的采到 100 个品**。
 *
 * 数据来源与分工：
 *   1) Amazon 前台搜索分页 → 候选池的 ASIN（相关性强，覆盖整个关键词生态）；
 *   2) 卖家精灵浏览器扩展面板 → 每个 ASIN 的 BSR / 变体数 / 价格 / 评分数 / 评分 / 上架时间；
 *   3) Amazon 详情页 → 包装尺寸重量（算体积重与头程）、件数（包装对齐）；
 *   4) 1688 详情页 → 采购价（必须过 verify.js 校验才用）。
 *
 * 每一项都带 source 标注；取不到就留空，不猜。
 */
import { openTab, runJson, runJs, waitFor, closeTab, focusTab, listTabs } from '../web/chrome.js';
import { READ_CARDS } from './collect.js';

const AMAZON_DOMAINS = {
  US: 'amazon.com', UK: 'amazon.co.uk', DE: 'amazon.de', FR: 'amazon.fr',
  IT: 'amazon.it', ES: 'amazon.es', CA: 'amazon.ca', JP: 'amazon.co.jp',
  MX: 'amazon.com.mx', AU: 'amazon.com.au', IN: 'amazon.in', AE: 'amazon.ae',
  BR: 'amazon.com.br', SA: 'amazon.sa',
};

function num(value) {
  const cleaned = String(value ?? '').replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * 抓一个关键词的搜索结果（多页）。
 * @param {{keyword:string, marketplace?:string, pages?:number, perPage?:number}} input
 */
export async function collectSearchPages({ keyword, marketplace = 'US', pages = 3, perPage = 48 } = {}) {
  const domain = AMAZON_DOMAINS[String(marketplace || 'US').toUpperCase()] || AMAZON_DOMAINS.US;
  const items = [];
  const seen = new Set();
  // 复用同一个标签页翻页：每页开新标签会堆出大量标签页（实测 Chrome 被堆到 189 个）。
  let tabId = null;
  try {
  for (let page = 1; page <= pages; page += 1) {
    const url = 'https://www.' + domain + '/s?k=' + encodeURIComponent(keyword) + (page > 1 ? '&page=' + page : '');
    try {
      if (tabId === null) {
        tabId = await openTab(url);
      } else {
        await runJs(tabId, 'location.href = ' + JSON.stringify(url) + '; "OK"', { timeout: 30_000 }).catch(() => {});
      }
      await focusTab(tabId).catch(() => {});
      const ready = await waitFor(tabId, 'document.querySelectorAll("[data-component-type=\'s-search-result\']").length > 3', { timeout: 45 });
      if (!ready) break;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const data = await runJson(tabId, READ_CARDS, { timeout: 40000, strict: false });
      const list = (data && data.items) || [];
      let added = 0;
      for (const card of list) {
        if (!card.asin || seen.has(card.asin)) continue;
        seen.add(card.asin);
        items.push({
          asin: card.asin,
          title: card.title,
          price: num(card.price),
          rating: num(String(card.rating || '').split(' ')[0]),
          reviews: num(card.reviews),
          sponsored: Boolean(card.sponsored),
          keyword,
          page,
          url: 'https://www.' + domain + '/dp/' + card.asin,
        });
        added += 1;
      }
      if (added === 0) break;
    } catch {
      /* 该页失败就停，不影响已抓到的 */
      break;
    }
  }
  return { keyword, items, count: items.length };
  } finally {
    if (tabId) await closeTab(tabId).catch(() => {});
  }
}

/**
 * 多关键词合并成一个候选池（去重，保留每个 ASIN 命中的关键词）。
 */
export function mergePools(pools) {
  const map = new Map();
  for (const pool of pools || []) {
    for (const item of pool.items || []) {
      const hit = map.get(item.asin);
      if (hit) {
        if (!hit.keywords.includes(item.keyword)) hit.keywords.push(item.keyword);
        continue;
      }
      map.set(item.asin, { ...item, keywords: [item.keyword] });
    }
  }
  return [...map.values()];
}
