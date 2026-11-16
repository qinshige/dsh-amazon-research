/**
 * dsh-amazon-research · host/selection/collect.js
 *
 * 自动采集器：关键词 → Amazon 前台搜索页 → 采集表行。
 *
 * 为什么需要它（实测发现）：
 *   卖家精灵**浏览器扩展**会把关键词级市场分析直接渲染在 Amazon 搜索页上，
 *   每行带：品牌、品类、BSR、变体数、价格、评分数、评分、上架时间、卖家数、配送、配送时长，
 *   顶部还有 ASIN 数量、平均 BSR / 价格 / 评分 / 评分数。
 *   这些正是采集表最缺的字段；插件原先要人手工填 CSV，等于把最好用的数据源浪费了。
 *
 * 合并策略：面板行没有 ASIN，但标题是完整 Amazon 标题 → 用标题（归一化）匹配
 * Amazon 搜索卡片的 ASIN；标题对不上时退回「价格 + 评论数」匹配；再不行标为未匹配。
 *
 * 纪律：只读页面已渲染的内容，不调用扩展的付费接口、不逆向登录态；
 * 扩展没装 / 面板没渲染时返回明确错误，不静默返回空表。
 */
import { openTab, runJson, waitFor, closeTab, focusTab } from '../web/chrome.js';

const AMAZON_DOMAINS = {
  US: 'amazon.com', UK: 'amazon.co.uk', DE: 'amazon.de', FR: 'amazon.fr',
  IT: 'amazon.it', ES: 'amazon.es', CA: 'amazon.ca', JP: 'amazon.co.jp',
  MX: 'amazon.com.mx', AU: 'amazon.com.au', IN: 'amazon.in', AE: 'amazon.ae',
  BR: 'amazon.com.br', SA: 'amazon.sa',
};

function normalizeTitle(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
    .trim();
}

function parseNumber(text) {
  const match = String(text ?? '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function parseRating(text) {
  const match = String(text ?? '').match(/([\d.]+)\s*out of 5/);
  if (match) return Number(match[1]);
  const n = parseNumber(text);
  return n !== null && n >= 0 && n <= 5 ? n : null;
}

function parseReviews(text) {
  const match = String(text ?? '').replace(/,/g, '').match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

function parseDate(text) {
  const t = String(text || '').trim();
  const m = t.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (m) return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
  const en = t.match(/([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if (en) {
    const months = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
    const month = months[en[1].toLowerCase()];
    if (month) return en[3] + '-' + String(month).padStart(2, '0') + '-' + String(en[2]).padStart(2, '0');
  }
  return '';
}

export const READ_CARDS = [
  '(function(){',
  '  var cards=[...document.querySelectorAll("[data-component-type=\'s-search-result\']")];',
  '  var out=[];',
  '  for (var c of cards){',
  '    var link=c.querySelector("a.a-link-normal[href*=\'/dp/\']");',
  '    var href=link?(link.getAttribute("href")||""):"";',
  '    var m=href.match(/\/dp\/([A-Z0-9]{10})/);',
  '    var h2=c.querySelector("h2");',
  '    var pe=c.querySelector(".a-price .a-offscreen");',
  '    var re=c.querySelector("a[href*=\'#customerReviews\'] span");',
  '    var ra=c.querySelector("[aria-label*=\'out of 5 stars\']");',
  '    out.push({',
  '      asin:m?m[1]:null,',
  '      title:h2?h2.innerText.replace(/\s+/g," ").trim():"",',
  '      price:pe?pe.innerText:null,',
  '      rating:ra?ra.getAttribute("aria-label"):null,',
  '      reviews:re?re.innerText:null,',
  '      sponsored:/Sponsored/i.test(c.innerText.slice(0,400))',
  '    });',
  '  }',
  '  return JSON.stringify({count:cards.length, items:out});',
  '})()'
].join('\n');

export const READ_PANEL = [
  '(function(){',
  '  var panel=document.querySelector("#main-sellersprite-extension");',
  '  if(!panel) return JSON.stringify({hasPanel:false});',
  '  var txt=panel.innerText||"";',
  '  var body=[...document.querySelectorAll("table")].find(function(t){return t.className.includes("vxe-table--body")});',
  '  var rows=[];',
  '  if(body){',
  '    body.querySelectorAll("tr").forEach(function(tr){',
  '      var tds=[...tr.querySelectorAll("td")];',
  '      if(tds.length<20) return;',
  '      var g=function(i){var td=tds[i];return td?(td.innerText||"").trim().replace(/\s+/g," "):""};',
  '      rows.push({',
  '        rank:g(2), title:g(4), brand:g(6), category:g(7), bsr:g(8),',
  '        variants:g(12), price:g(13), reviews:g(15), rating:g(17),',
  '        listed:g(21), sellers:g(22), fulfillment:g(23), delivery:g(24)',
  '      });',
  '    });',
  '  }',
  '  var grab=function(re){var m=txt.match(re);return m?m[1].trim():null};',
  '  var stats={',
  '    asinCount:grab(/ASIN数量\s*([\d,]+)/),',
  '    avgBsr:grab(/平均BSR\s*([\d,]+)/),',
  '    avgPrice:grab(/平均价格\s*\$?([\d,.]+)/),',
  '    avgRating:grab(/平均评分\s*([\d.]+)/),',
  '    avgReviews:grab(/平均评分数\s*([\d,]+)/),',
  '    avgListingDays:grab(/平均上架天数\s*([^\n]+)/)',
  '  };',
  '  var hasLoadMore=/加载更多/.test(txt);',
  '  return JSON.stringify({hasPanel:true, rows:rows, stats:stats, hasLoadMore:hasLoadMore});',
  '})()'
].join('\n');

export const CLICK_MORE = [
  '(function(){',
  '  var panel=document.querySelector("#main-sellersprite-extension");',
  '  if(!panel) return "NOPANEL";',
  '  var els=[...panel.querySelectorAll("a,button,span,div")];',
  '  var hit=els.filter(function(e){return e.children.length===0 && (e.innerText||"").trim()==="加载更多"})[0];',
  '  if(!hit) return "NONE";',
  '  hit.click();',
  '  return "CLICKED";',
  '})()'
].join('\n');

/**
 * 采集一个关键词。
 * @param {{keyword:string, marketplace?:string, maxRows?:number, loadMoreRounds?:number, timeoutSec?:number}} input
 */
export async function collectKeywordRows({ keyword, marketplace = 'US', maxRows = 60, loadMoreRounds = 4, timeoutSec = 45 } = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) {
    const error = new Error('缺少关键词');
    error.code = 'INVALID_ARGS';
    throw error;
  }
  const domain = AMAZON_DOMAINS[String(marketplace || 'US').toUpperCase()] || AMAZON_DOMAINS.US;
  const url = 'https://www.' + domain + '/s?k=' + encodeURIComponent(kw);
  let tabId = null;
  try {
    tabId = await openTab(url);
    // 必须把标签页切到前台：后台标签页被 Chrome 节流，扩展不会渲染数据表。
    await focusTab(tabId).catch(() => {});
    const ready = await waitFor(tabId, 'document.querySelectorAll("[data-component-type=\'s-search-result\']").length > 2', { timeout: timeoutSec });
    if (!ready) {
      const error = new Error('Amazon 搜索页未加载出结果（可能被验证码拦截或需人工验证）');
      error.code = 'PAGE_NOT_READY';
      throw error;
    }
    // 扩展面板是**异步渲染**的：元素先出现，表格与统计要等它自己的接口回来。
    // 必须等到表体真的在（否则会读到空面板、误判成「没数据」）。
    const panelReady = await waitFor(
      tabId,
      'document.querySelector("#main-sellersprite-extension table.vxe-table--body") !== null',
      { timeout: Math.max(30, timeoutSec) },
    ).catch(() => false);
    if (!panelReady) {
      const error = new Error('卖家精灵扩展面板未渲染出数据表（扩展未登录 / 接口未返回 / 该词无关键词分析数据）');
      error.code = 'PANEL_NOT_READY';
      throw error;
    }

    let panel = await runJson(tabId, READ_PANEL, { timeout: 40000, strict: false });
    for (let round = 0; round < loadMoreRounds && panel && panel.hasLoadMore && panel.rows.length < maxRows; round += 1) {
      const before = panel.rows.length;
      const clicked = await runJson(tabId, CLICK_MORE, { timeout: 30000, strict: false });
      if (clicked !== 'CLICKED') break;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      panel = await runJson(tabId, READ_PANEL, { timeout: 40000, strict: false });
      if (panel.rows.length <= before) break;
    }

    const cards = await runJson(tabId, READ_CARDS, { timeout: 40000, strict: false });

    const byTitle = new Map();
    for (const card of cards.items || []) {
      const key = normalizeTitle(card.title);
      if (key && !byTitle.has(key)) byTitle.set(key, card);
    }
    const byPriceReviews = new Map();
    for (const card of cards.items || []) {
      const key = (card.price || '') + '|' + (card.reviews || '');
      if (!byPriceReviews.has(key)) byPriceReviews.set(key, card);
    }

    const rows = [];
    let unmatched = 0;
    for (const item of (panel.rows || []).slice(0, maxRows)) {
      const titleKey = normalizeTitle(item.title);
      let card = byTitle.get(titleKey);
      let matchedBy = '标题';
      if (!card) {
        card = byPriceReviews.get(item.price + '|' + item.reviews);
        matchedBy = card ? '价格+评论数' : '';
      }
      if (!card) unmatched += 1;
      rows.push({
        asin: card ? card.asin : null,
        title: item.title,
        brand: item.brand,
        bsr: parseNumber(item.bsr),
        price: parseNumber(item.price),
        reviews: parseReviews(item.reviews),
        rating: parseRating(item.rating),
        variants: parseNumber(item.variants),
        listingDate: parseDate(item.listed),
        sellers: parseNumber(item.sellers),
        fulfillment: item.fulfillment,
        deliveryTime: item.delivery,
        categoryLabel: item.category,
        sponsored: card ? Boolean(card.sponsored) : false,
        matchedBy,
        source: '卖家精灵扩展关键词分析 + Amazon 搜索卡片',
        url: card && card.asin ? 'https://www.' + domain + '/dp/' + card.asin : '',
      });
    }

    return {
      ok: true,
      keyword: kw,
      marketplace: String(marketplace || 'US').toUpperCase(),
      sourceUrl: url,
      hasExtensionPanel: Boolean(panel && panel.hasPanel),
      keywordStats: (panel && panel.stats) || {},
      cardCount: cards.count || 0,
      panelRowCount: (panel.rows || []).length,
      unmatched,
      rows,
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error && error.code) throw error;
    const wrapped = new Error('采集失败：' + String(error?.message ?? error));
    wrapped.code = 'COLLECT_FAILED';
    throw wrapped;
  } finally {
    if (tabId) await closeTab(tabId).catch(() => {});
  }
}

/** 把采集结果转成采集表行（screen 的输入格式）。 */
export function toSelectionRows(collected, { categoryPath = '' } = {}) {
  const list = collected?.rows || [];
  const reviews = list.map((row) => row.reviews).filter((value) => typeof value === 'number');
  const avgReviews = reviews.length ? Math.round(reviews.reduce((a, b) => a + b, 0) / reviews.length) : null;
  return list.map((row) => ({
    ASIN: row.asin || '',
    商品名称: row.title || '',
    链接: row.url || '',
    采集时间: collected.fetchedAt,
    来源: row.source,
    售价USD: row.price,
    评分: row.rating,
    评论数: row.reviews,
    BSR排名: row.bsr,
    变体数: row.variants,
    上架时间: row.listingDate,
    品牌: row.brand,
    类目路径: categoryPath,
    '品牌集中度%': null,
    '前10评价数': avgReviews,
    '新品占比%': null,
    备注: [
      '匹配方式：' + (row.matchedBy || '未匹配到 ASIN'),
      row.fulfillment ? '配送：' + row.fulfillment : '',
      row.deliveryTime ? '配送时长：' + row.deliveryTime : '',
      row.sellers ? '卖家数：' + row.sellers : '',
    ].filter(Boolean).join('；'),
  }));
}
