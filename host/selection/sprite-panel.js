/**
 * dsh-amazon-research · host/selection/sprite-panel.js
 *
 * 操作卖家精灵**浏览器扩展**（产品查询视图），把关键词级市场分析抓成结构化数据。
 *
 * 为什么必须自己操作页面（实测发现）：
 *   - 扩展在 Amazon 搜索页上直接渲染 26 列关键词级数据：BSR / 销量(父) / 销售额 /
 *     子体销量 / 变体数 / 价格 / 评分数 / 评分 / FBA费 / 毛利率 / 上架时间 / 卖家数 / 配送 / 配送时长；
 *   - 这些是 MCP 与网页文本都拿不到的（卖家精灵 MCP 密钥 401 时唯一的退路）；
 *   - 表格是 **vxe-table 虚拟滚动**，只渲染视口行 → 必须**滚动全表**才能读全；
 *   - 部分列（销量/销售额/FBA费/毛利率）是懒加载占位 `i`，**滚动到才填充真实值**
 *     （实测：首屏看不到销量，滚到 BrenixCraft 那几行才有 销量455 / 销售额$10,915 / FBA$4.36）；
 *   - 顶部统计是**全量**的：ASIN 数量 / 总销量 / 总销售额 / 平均BSR / 平均价格 / 平均评分 /
 *     平均评分数 / 平均上架天数 —— 即使表格读不全，大盘数据也在。
 *
 * 操作序列：打开 Amazon 搜索页 → 等扩展面板渲染 → 点「加载更多」→ 滚动全表收集 → 合并父体/子体行。
 */
import { openTab, runJson, runJs, waitFor, closeTab, focusTab } from '../web/chrome.js';

const PANEL = '#main-sellersprite-extension';

/** 页面内：滚动到指定位置（同步）。 */
export const SCROLL_TO = [
  '(function(){',
  '  var p=document.querySelector("' + PANEL + '");',
  '  if(!p) return 0;',
  '  var b=[].slice.call(p.querySelectorAll("table")).find(function(t){return t.className.includes("vxe-table--body")});',
  '  if(!b) return 0;',
  '  var sc=b.closest(".vxe-table--body-wrapper") || b.parentElement;',
  '  sc.scrollTop=__Y__;',
  '  sc.dispatchEvent(new Event("scroll",{bubbles:true}));',
  '  return sc.scrollHeight;',
  '})()'
].join('\n');

/** 页面内：读当前渲染出来的行（同步）。 */
export const GRAB_ROWS = [
  '(function(){',
  '  var p=document.querySelector("' + PANEL + '");',
  '  if(!p) return "[]";',
  '  var b=[].slice.call(p.querySelectorAll("table")).find(function(t){return t.className.includes("vxe-table--body")});',
  '  if(!b) return "[]";',
  '  var rows=b.querySelectorAll("tr");',
  '  var out=[];',
  '  for(var i=0;i<rows.length;i++){',
  '    var tds=[].slice.call(rows[i].cells);',
  '    var title=(tds[4]&&tds[4].innerText||"").trim();',
  '    if(!title) continue;',
  '    out.push(tds.map(function(td){return (td.innerText||"").trim().replace(/\s+/g," ");}));',
  '  }',
  '  return JSON.stringify(out);',
  '})()'
].join('\n');

/** 页面内：读顶部统计（全量口径）。 */
export const READ_STATS = [
  '(function(){',
  '  var p=document.querySelector("' + PANEL + '");',
  '  if(!p) return "{}";',
  '  var t=p.innerText||"";',
  '  var grab=function(re){var m=t.match(re);return m?m[1].trim():null};',
  '  return JSON.stringify({',
  '    asinCount:grab(/ASIN数量\\s*([\\d,]+)/),',
  '    totalUnits:grab(/总销量\\s*([^\\n]*)/),',
  '    avgUnits:grab(/平均销量:\\s*([^\\n]*)/),',
  '    totalRevenue:grab(/总销售额\\s*([^\\n]*)/),',
  '    avgRevenue:grab(/平均销售额:\\s*([^\\n]*)/),',
  '    avgBsr:grab(/平均BSR\\s*([^\\n]*)/),',
  '    avgPrice:grab(/平均价格\\s*([^\\n]*)/),',
  '    avgRating:grab(/平均评分\\s*([^\\n]*)/),',
  '    avgReviews:grab(/平均评分数\\s*([^\\n]*)/),',
  '    avgListingDays:grab(/平均上架天数\\s*([^\\n]*)/)',
  '  });',
  '})()'
].join('\n');

/** 点击「加载更多」。 */
export const CLICK_LOAD_MORE = [
  '(function(){',
  '  var p=document.querySelector("' + PANEL + '");',
  '  if(!p) return "NOPANEL";',
  '  var els=[].slice.call(p.querySelectorAll("span,button,a")).filter(function(e){',
  '    return e.children.length===0 && (e.innerText||"").trim()==="加载更多";',
  '  });',
  '  if(!els.length) return "NONE";',
  '  els[0].click();',
  '  return "CLICKED";',
  '})()'
].join('\n');

function num(text) {
  const cleaned = String(text ?? '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return cleaned ? Number(cleaned[0]) : null;
}

function money(text) {
  const cleaned = String(text ?? '').replace(/[$,]/g, '').match(/-?\d+(\.\d+)?/);
  return cleaned ? Number(cleaned[0]) : null;
}

/** 列索引（表头顺序）。 */
const COL = Object.freeze({ rank: 2, title: 4, brand: 6, category: 7, bsr: 8, units: 9, revenue: 10, childUnits: 11, variants: 12, price: 13, qa: 14, reviews: 15, monthNew: 16, rating: 17, reviewRate: 18, fba: 19, margin: 20, listed: 21, sellers: 22, fulfillment: 23, delivery: 24 });

/** 把一行（数组）转成结构化对象。父体行没有品牌/BSR 等 → 返回 null。 */
export function parseRow(cells) {
  const at = (i) => (Array.isArray(cells) && cells[i] !== undefined ? String(cells[i]).trim() : '');
  const title = at(COL.title);
  if (!title) return null;
  const isParentRow = !at(COL.brand) && !at(COL.bsr);
  return {
    rank: num(at(COL.rank)),
    title,
    brand: at(COL.brand),
    category: at(COL.category),
    bsr: num(at(COL.bsr)),
    units: num(at(COL.units)),
    revenue: money(at(COL.revenue)),
    childUnits: at(COL.childUnits),
    variants: num(at(COL.variants)),
    price: money(at(COL.price)),
    reviews: num(at(COL.reviews)),
    monthNewReviews: num(at(COL.monthNew)),
    rating: num(at(COL.rating)),
    reviewRate: num(at(COL.reviewRate)),
    fbaFee: money(at(COL.fba)),
    margin: num(at(COL.margin)),
    listedDate: at(COL.listed),
    sellers: num(at(COL.sellers)),
    fulfillment: at(COL.fulfillment),
    delivery: at(COL.delivery),
    isParentRow,
  };
}

/**
 * 采集一个关键词的卖家精灵扩展数据。
 *
 * @param {{keyword:string, marketplace?:string, scrollStep?:number, maxScroll?:number,
 *          loadMore?:boolean, onProgress?:Function, reuseTabId?:string|null}} input
 * @returns {Promise<{ok:boolean, keyword:string, stats:object, rows:Array<object>, rawRows:number, matched:number}>}
 */
export async function collectSpritePanel({ keyword, marketplace = 'US', scrollStep = 250, maxScroll = 20000, loadMore = true, onProgress = null, reuseTabId = null } = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) {
    const error = new Error('缺少关键词');
    error.code = 'INVALID_ARGS';
    throw error;
  }
  const domain = marketplace.toUpperCase() === 'US' ? 'amazon.com' : 'amazon.com';
  const url = 'https://www.' + domain + '/s?k=' + encodeURIComponent(kw);
  let tabId = reuseTabId;
  let owns = false;
  try {
    if (!tabId) {
      tabId = await openTab(url);
      owns = true;
    } else {
      await runJs(tabId, 'location.href = ' + JSON.stringify(url) + '; "OK"', { timeout: 30000 }).catch(() => {});
    }
    await focusTab(tabId).catch(() => {});
    const ready = await waitFor(
      tabId,
      'document.querySelector("' + PANEL + ' table.vxe-table--body") !== null',
      { timeout: 45 },
    ).catch(() => false);
    if (!ready) {
      const error = new Error('卖家精灵扩展面板未渲染（扩展未安装/未登录，或 Amazon 页被验证拦截）');
      error.code = 'PANEL_NOT_READY';
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // 点「加载更多」把关键词的完整 ASIN 集灌进来
    if (loadMore) {
      await runJson(tabId, CLICK_LOAD_MORE, { timeout: 20000, strict: false }).catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, 3500));
    }

    const statsRaw = await runJson(tabId, READ_STATS, { timeout: 20000, strict: false });
    let stats = {};
    try { stats = typeof statsRaw === 'string' ? JSON.parse(statsRaw) : (statsRaw || {}); } catch { stats = {}; }

    // 滚动全表收集（虚拟滚动 + 懒加载列，必须逐屏滚动）
    const seen = new Map();
    let max = 0;
    let steps = 0;
    for (let y = 0; y <= maxScroll && steps < 200; y += scrollStep) {
      const height = await runJs(tabId, SCROLL_TO.replace('__Y__', String(y)), { timeout: 15000 }).catch(() => null);
      if (typeof height === 'string' && Number.isFinite(Number(height))) max = Number(height);
      await new Promise((resolve) => setTimeout(resolve, 130));
      const rows = await runJson(tabId, GRAB_ROWS, { timeout: 15000, strict: false }).catch(() => null);
      if (Array.isArray(rows)) {
        for (const cells of rows) {
          const parsed = parseRow(cells);
          if (!parsed) continue;
          const key = parsed.title + '|' + (parsed.price === null ? '' : parsed.price) + '|' + parsed.brand;
          if (seen.has(key)) continue;
          seen.set(key, parsed);
        }
      }
      steps += 1;
      if (onProgress) onProgress({ step: steps, y, max, rows: seen.size });
      if (max && y >= max) break;
    }

    const list = [...seen.values()];
    // 合并父体/子体行：父体行没有品牌与 BSR，数据在同标题的子体行上
    const merged = new Map();
    for (const item of list) {
      const key = item.title;
      const prev = merged.get(key);
      if (!prev) { merged.set(key, { ...item }); continue; }
      const next = { ...prev };
      for (const field of Object.keys(item)) {
        const value = item[field];
        const old = next[field];
        const empty = value === null || value === '' || value === 'i' || value === 'i i';
        const oldEmpty = old === null || old === '' || old === 'i' || old === 'i i';
        if (empty && !oldEmpty) continue;
        if (!empty && !oldEmpty && field === 'price') continue;   // 价格保留第一条（父体行）
        if (!empty || oldEmpty) next[field] = value;
      }
      merged.set(key, next);
    }

    return {
      ok: true,
      keyword: kw,
      marketplace: String(marketplace || 'US').toUpperCase(),
      sourceUrl: url,
      stats,
      rows: [...merged.values()],
      rawRows: list.length,
      matched: merged.size,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    if (owns && tabId) await closeTab(tabId).catch(() => {});
  }
}

/** 页面内：往 ASIN 输入框灌一批 ASIN 并回车触发查询。 */
export const TYPE_ASINS = [
  '(function(){',
  '  var p=document.querySelector("' + PANEL + '");',
  '  var inp=[].slice.call(p.querySelectorAll("input")).filter(function(i){return (i.placeholder||"").indexOf("ASIN")>=0;})[0];',
  '  if(!inp) return JSON.stringify({ok:false, reason:"NO_ASIN_INPUT"});',
  '  var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;',
  '  setter.call(inp, __ASINS__);',
  '  inp.dispatchEvent(new Event("input",{bubbles:true}));',
  '  inp.dispatchEvent(new Event("change",{bubbles:true}));',
  '  inp.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",keyCode:13,bubbles:true}));',
  '  inp.dispatchEvent(new KeyboardEvent("keyup",{key:"Enter",keyCode:13,bubbles:true}));',
  '  return JSON.stringify({ok:true, value:inp.value.slice(0,120)});',
  '})()'
].join('\n');

/** 页面内：读面板状态（行数 / ASIN 数 / 总销量 / 是否有机器人检测）。 */
export const READ_STATE = [
  '(function(){',
  '  var p=document.querySelector("' + PANEL + '");',
  '  if(!p) return JSON.stringify({ok:false, reason:"NO_PANEL"});',
  '  var b=[].slice.call(p.querySelectorAll("table")).find(function(x){return x.className.includes("vxe-table--body")});',
  '  var t=p.innerText||"";',
  '  var g=function(re){var m=t.match(re);return m?m[1].trim():null};',
  '  return JSON.stringify({',
  '    ok:true,',
  '    rows:b?b.rows.length:0,',
  '    asinCount:g(/ASIN数量\\s*([\\d,]+)/),',
  '    totalUnits:g(/总销量\\s*([^\\n]*)/),',
  '    totalRevenue:g(/总销售额\\s*([^\\n]*)/),',
  '    wall:/机器人检测|请拖动|图形验证码/.test(t)',
  '  });',
  '})()'
].join('\n');

/**
 * 用卖家精灵扩展的「产品查询」批量补齐 ASIN 的市场数据。
 *
 * 前提：扩展在 **Amazon 商品详情页** 上功能完整（搜索页不渲染表格）。
 * 做法：在详情页的 ASIN 输入框灌一批 ASIN → 回车 → 读表 → 滚动补全。
 *
 * @param {{asins:string[], marketplace?:string, batchSize?:number, anchorAsin?:string,
 *          onProgress?:Function, tabId?:string|null}} input
 * @returns {Promise<{ok:boolean, rows:Array<object>, stats:object, batches:number, wall:boolean}>}
 */
export async function collectSpriteForAsins({ asins = [], marketplace = 'US', batchSize = 25, anchorAsin = 'B08MBNV7YW', onProgress = null, tabId = null } = {}) {
  const list = asins.filter(Boolean);
  if (!list.length) {
    const error = new Error('没有 ASIN');
    error.code = 'INVALID_ARGS';
    throw error;
  }
  const domain = marketplace.toUpperCase() === 'US' ? 'amazon.com' : 'amazon.com';
  let useTab = tabId;
  let owns = false;
  try {
    if (!useTab) {
      useTab = await openTab('https://www.' + domain + '/dp/' + (anchorAsin || list[0]));
      owns = true;
    }
    await focusTab(useTab).catch(() => {});
    const ready = await waitFor(
      useTab,
      'document.querySelector("' + PANEL + ' input[placeholder*=\'ASIN\']") !== null',
      { timeout: 45 },
    ).catch(() => false);
    if (!ready) {
      const error = new Error('卖家精灵扩展未就绪（扩展未安装/未登录，或页面被验证拦截）');
      error.code = 'PANEL_NOT_READY';
      throw error;
    }

    const merged = new Map();
    const stats = {};
    let batches = 0;
    let wall = false;
    for (let offset = 0; offset < list.length; offset += batchSize) {
      const batch = list.slice(offset, offset + batchSize);
      const typed = await runJson(useTab, TYPE_ASINS.replace('__ASINS__', JSON.stringify(batch.join(','))), { timeout: 25000, strict: false });
      if (!typed || typed.ok === false) break;
      await new Promise((resolve) => setTimeout(resolve, 3500));
      const state = await runJson(useTab, READ_STATE, { timeout: 20000, strict: false });
      if (state && state.wall) { wall = true; break; }
      if (state && state.asinCount) stats.asinCount = state.asinCount;
      if (state && state.totalUnits) stats.totalUnits = state.totalUnits;
      if (state && state.totalRevenue) stats.totalRevenue = state.totalRevenue;
      // 滚动全表
      let max = 0;
      for (let y = 0; y <= max && y < 6000; y += 250) {
        const height = await runJs(useTab, SCROLL_TO.replace('__Y__', String(y)), { timeout: 15000 }).catch(() => null);
        if (typeof height === 'string' && Number.isFinite(Number(height))) max = Number(height);
        await new Promise((resolve) => setTimeout(resolve, 130));
        const rows = await runJson(useTab, GRAB_ROWS, { timeout: 15000, strict: false }).catch(() => null);
        if (Array.isArray(rows)) {
          for (const cells of rows) {
            const parsed = parseRow(cells);
            if (!parsed || parsed.isParentRow) continue;
            const key = parsed.title + '|' + (parsed.price === null ? '' : parsed.price);
            if (!merged.has(key)) merged.set(key, parsed);
          }
        }
        if (max && y >= max) break;
      }
      batches += 1;
      if (onProgress) onProgress({ batch: batches, total: Math.ceil(list.length / batchSize), rows: merged.size, offset });
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }

    return { ok: !wall, rows: [...merged.values()], stats, batches, wall, fetchedAt: new Date().toISOString() };
  } finally {
    if (owns && useTab) await closeTab(useTab).catch(() => {});
  }
}
