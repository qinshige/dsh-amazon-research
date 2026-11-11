/**
 * 卖家精灵「网页登录态」provider。
 *
 * 为什么存在：卖家精灵 MCP（mcp.sellersprite.com）需要账号开通 MCP 服务权限；
 * 未开通时 MCP 返回 TOOL_NOT_ALLOWED（密钥存在但无 MCP 权限）。而网页版（www.sellersprite.com）
 * 在用户浏览器里已登录，页面本身就渲染出与 MCP 同源的数据。本 provider 驱动用户自己的 Chrome
 * 读取这些页面，走用户自己的登录态与额度，不绕过任何鉴权。
 *
 * 取数口径与 MCP 工具对齐：
 *   - 选市场页 → 细分市场列表（样本量、月总销量、品牌/卖家/商品集中度、新品占比、退货率、FBA/AMZ 结构）
 *   - 类目报告页 → 类目大盘（样本数、均价、均销、均销额、均评分数/星级、集中度、新品指标）
 *   - 查竞品页 → Top 商品明细（ASIN/父ASIN/品牌/价格/销量/销售额/评分数/评分/FBA费/毛利率/上架时间）
 *
 * 所有返回都带 fetchedAt 与 source（页面 URL），便于报告溯源。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { listTabs, openTab, runJs, runJson, waitFor, closeTab } from './chrome.js';

const BASE = 'https://www.sellersprite.com';
const MARKET_LIST_URL = BASE + '/v2/market-research?marketplace=';
const NODE_URL = BASE + '/v2/market-research/1/{nodeIdPath}?topN=10&newReleaseNum=6&currentMonth=';

const snippetCache = new Map();

/** 读取并缓存注入脚本片段 */
async function snippet(name) {
  if (snippetCache.has(name)) return snippetCache.get(name);
  const path = fileURLToPath(new URL('./snippets/' + name, import.meta.url));
  const code = await readFile(path, 'utf8');
  snippetCache.set(name, code);
  return code;
}

/** 在标签页里执行片段并解析 JSON；片段也可能返回纯文本标记（如 OK / NO_INPUT） */
async function runSnippet(tabId, name) {
  const code = await snippet(name);
  const raw = await runJson(tabId, code, { strict: false });
  return raw;
}

/** 找到已登录的卖家精灵标签页；没有就新开一个 */
async function ensureTab(log = () => {}) {
  const tabs = await listTabs();
  const hit = tabs.find((tab) => tab.url.includes('sellersprite.com') && !tab.url.includes('/sign'));
  if (hit) {
    log('复用已登录的卖家精灵标签页 ' + hit.id);
    return { tabId: hit.id, owned: false };
  }
  log('未找到卖家精灵标签页，新开一个（需用户已登录）');
  const tabId = await openTab(MARKET_LIST_URL + 'US');
  await waitFor(tabId, 'document.body.innerText.length > 500', { timeout: 40 });
  return { tabId, owned: true };
}

const num = (text) => {
  const match = String(text ?? '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
};

const split = (text) => String(text ?? '').trim().split(/\s+/).filter(Boolean);

/**
 * 抓「选市场」细分市场列表（按类目关键词过滤后）。
 * @param {{keyword?:string, nodeIdPath?:string, limit?:number, log?:Function}} opts
 */
export async function fetchMarketList({ keyword, nodeIdPath, limit = 50, marketplace = 'US', log = () => {} } = {}) {
  const { tabId, owned } = await ensureTab(log);
  try {
    const probe = await runSnippet(tabId, 'login-probe.js');
    if (probe && probe.hasLogin) {
      const err = new Error('卖家精灵网页未登录：请在 Chrome 里登录 sellersprite.com 后重试');
      err.code = 'NOT_LOGGED_IN';
      throw err;
    }
    if (keyword) {
      // 复用标签页可能停在其它页面（类目报告/查竞品），先回到选市场页
      const current = await runJson(tabId, 'location.href', { strict: false }).catch(() => '');
      if (String(current).indexOf('/v2/market-research?marketplace=') === -1) {
        await runJs(tabId, 'location.href = ' + JSON.stringify(MARKET_LIST_URL + marketplace) + '; "OK"', { timeout: 30_000 }).catch(() => {});
        await waitFor(tabId, 'document.body.innerText.indexOf("筛选市场") >= 0', { timeout: 45 });
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      await runSnippet(tabId, 'set-context.js');
      await runJson(tabId, 'window.__dsrCtx = ' + JSON.stringify({ keyword, nodeIdPath: nodeIdPath || '' }) + '; "OK"', { strict: false });
      await runSnippet(tabId, 'type-keyword.js');
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await runSnippet(tabId, 'select-node.js');
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    await runSnippet(tabId, 'filter-market.js');
    await new Promise((resolve) => setTimeout(resolve, 7000));

    const list = await runSnippet(tabId, 'market-rows.js');
    const rows = (Array.isArray(list) ? list : []).slice(0, limit).map((row) => {
      const conc = row.concentration || '';
      const fulfill = row.fulfillment || '';
      const newParts = split(row.newItems);
      const sampleParts = split(row.sample);
      const sampleText = row.sample || '';
      return {
        rank: row.rank,
        name: row.name,
        nodeUrl: row.node,
        nodeIdPath: row.node ? (row.node.match(/\/market-research\/\d+\/([^?]+)/) || [])[1] || null : null,
        sample: {
          products: num((sampleText.match(/商品:\s*([\d,]+)/) || [])[1]),
          brands: num((sampleText.match(/品牌:\s*([\d,]+)/) || [])[1]),
          sellers: num((sampleText.match(/卖家:\s*([\d,]+)/) || [])[1]),
        },
        totalUnits: num(row.totalUnits),
        averageUnits: num(split(row.avg)[0]),
        headAverageRevenue: num(split(row.headRevenue)[0]),
        averageRatings: num(split(row.ratings)[0]),
        averageRating: num(split(row.ratings)[1]),
        averagePrice: num(split(row.sellersPrice).slice(-1)[0]),
        concentration: {
          brandCr3: num((conc.match(/品牌:\s*([\d.]+)%/) || [])[1]) === null ? null : num((conc.match(/品牌:\s*([\d.]+)%/) || [])[1]) / 100,
          productCr3: num((conc.match(/商品:\s*([\d.]+)%/) || [])[1]) === null ? null : num((conc.match(/商品:\s*([\d.]+)%/) || [])[1]) / 100,
          sellerCr3: num((conc.match(/卖家:\s*([\d.]+)%/) || [])[1]) === null ? null : num((conc.match(/卖家:\s*([\d.]+)%/) || [])[1]) / 100,
        },
        structure: {
          fbaProportion: num((fulfill.match(/FBA:\s*([\d.]+)%/) || [])[1]),
          amazonSelfProportion: num((fulfill.match(/AMZ:\s*([\d.]+)%/) || [])[1]),
          fbmProportion: num((fulfill.match(/FBM:\s*([\d.]+)%/) || [])[1]),
        },
        newItems: { count: num(newParts[0]), ratio: num(newParts[1]) },
        goodsTotal: num(row.goods),
        returnRate: num(row.returnRate),
        raw: row,
      };
    });
    return { rows, count: rows.length, fetchedAt: new Date().toISOString(), source: 'sellersprite-web:选市场' };
  } finally {
    if (owned) await closeTab(tabId);
  }
}

/**
 * 抓类目报告页的大盘指标。
 * @param {{nodeIdPath:string, log?:Function}} opts
 */
export async function fetchNodeReport({ nodeIdPath, log = () => {} } = {}) {
  if (!nodeIdPath) throw new Error('缺少 nodeIdPath');
  const url = NODE_URL.replace('{nodeIdPath}', nodeIdPath);
  const tabId = await openTab(url);
  try {
    await waitFor(tabId, 'document.body.innerText.indexOf("市场名称") >= 0', { timeout: 45 });
    const data = await runSnippet(tabId, 'node-report.js');
    return { ...data, fetchedAt: new Date().toISOString(), source: 'sellersprite-web:类目报告', url };
  } finally {
    await closeTab(tabId);
  }
}

/**
 * 抓「查竞品」Top 商品明细。
 * @param {{nodeIdPath:string, limit?:number, log?:Function}} opts
 */
export async function fetchTopProducts({ nodeIdPath, limit = 50, log = () => {} } = {}) {
  if (!nodeIdPath) throw new Error('缺少 nodeIdPath');
  // 查竞品每页 60 行；翻页参数 page=N 有效（实测 page=2 返回不同 ASIN）。
  // 注意不要手动改 size：前端会按自己的分页状态重写 URL，手工 size 会导致列表为空。
  const baseUrl =
    BASE +
    '/v3/competitor-lookup/?market=US&nodeIdPathEqual=true&monthName=bsr_sales_nearly&nodeIdPaths=' +
    encodeURIComponent(JSON.stringify([nodeIdPath]));
  const maxPages = Math.max(1, Math.min(10, Math.ceil((limit * 3) / 60)));
  const all = [];
  const seen = new Set();
  let url = baseUrl;
  for (let page = 1; page <= maxPages; page += 1) {
    const tabId = await openTab(page === 1 ? baseUrl : baseUrl + '&page=' + page);
    try {
      await waitFor(tabId, 'document.querySelectorAll("table").length > 1', { timeout: 45 });
      await new Promise((resolve) => setTimeout(resolve, page === 1 ? 3500 : 2500));
      const rows = await runSnippet(tabId, 'top-products.js');
      const list = Array.isArray(rows) ? rows : [];
      if (!list.length) break;
      let added = 0;
      for (const row of list) {
        const key = row.asin || row.parentAsin;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        all.push(row);
        added += 1;
      }
      log('查竞品第 ' + page + ' 页：' + list.length + ' 行，新增 ' + added + ' 个 ASIN');
      if (added === 0) break;
      url = page === 1 ? baseUrl : baseUrl + '&page=' + page;
    } finally {
      await closeTab(tabId);
    }
    if (all.length >= limit * 4) break;
  }
  const list = all.slice(0, Math.max(limit, Math.min(all.length, limit * 4)));
  return { rows: list, count: list.length, fetchedAt: new Date().toISOString(), source: 'sellersprite-web:查竞品', url };
}
