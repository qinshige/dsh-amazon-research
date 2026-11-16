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
 *
 * ⚠️ 页面片段里**禁止写正则**：片段是 JS 字符串字面量，`'\\s'` 会被求值成 `'s'`，
 *   正则直接坏掉（实测 /\\s+/ 变成 /s+/ 报 "Nothing to repeat"，采集器静默失效）。
 *   下面所有文本处理都用 split/join，不用正则。
 */
import { listTabs, openTab, runJson, waitFor, closeTab, focusTab } from '../web/chrome.js';

const AMAZON_DOMAINS = {
  US: 'amazon.com', UK: 'amazon.co.uk', DE: 'amazon.de', FR: 'amazon.fr',
  IT: 'amazon.it', ES: 'amazon.es', CA: 'amazon.ca', JP: 'amazon.co.jp',
  MX: 'amazon.com.mx', AU: 'amazon.com.au', IN: 'amazon.in', AE: 'amazon.ae',
  BR: 'amazon.com.br', SA: 'amazon.sa',
};

function normalizeTitle(text) {
  return String(text || '')
    .toLowerCase()
    .split(' ').filter(Boolean).join(' ');
}

/** 取第一个数字（不用正则）：返回 null 表示没有数字。 */
function firstNumber(text) {
  const cleaned = String(text ?? '').replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseRating(text) {
  const n = firstNumber(text);
  return n !== null && n >= 0 && n <= 5 ? n : null;
}

function parseReviews(text) {
  const n = firstNumber(text);
  return n;
}

function parseDate(text) {
  const t = String(text || '').trim();
  const ymd = t.split('/');
  if (ymd.length === 3 && ymd.every((part) => part.length <= 4 && part !== '')) {
    return ymd[0] + '-' + String(ymd[1]).padStart(2, '0') + '-' + String(ymd[2]).padStart(2, '0');
  }
  const months = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  const parts = t.replace(',', ' ').split(' ').filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    const month = months[String(parts[i]).toLowerCase()];
    if (month !== undefined && parts[i + 1] && parts[i + 2]) {
      return parts[i + 2] + '-' + String(month).padStart(2, '0') + '-' + String(parts[i + 1]).padStart(2, '0');
    }
  }
  return '';
}
/** 页面内：读 Amazon 搜索卡片（ASIN + 标题 + 价格 + 评分 + 评论数）。无正则、无转义。 */
export const READ_CARDS = [
  '(function(){',
  '  var NL=String.fromCharCode(10);',
  '  function clean(s){ return String(s==null?\'\':s).split(NL).map(function(l){return l.trim();}).filter(Boolean).join(\' \'); }',
  '  var cards=[...document.querySelectorAll(\'[data-component-type="s-search-result"]\')];',
  '  var out=[];',
  '  for (var i=0;i<cards.length;i++){',
  '    var c=cards[i];',
  '    var link=c.querySelector(\'a.a-link-normal[href*="/dp/"]\');',
  '    var href=link?(link.getAttribute(\'href\')||\'\'):\'\';',
  '    var parts=href.split(\'/dp/\');',
  '    var asin=null;',
  '    if(parts.length>1){ var seg=parts[1].split(\'?\')[0].split(\'/\')[0]; if(seg.length===10) asin=seg; }',
  '    var h2=c.querySelector(\'h2\');',
  '    var pe=c.querySelector(\'.a-price .a-offscreen\');',
  '    var re=c.querySelector(\'a[href*="#customerReviews"] span\');',
  '    var ra=c.querySelector(\'[aria-label*="out of 5 stars"]\');',
  '    out.push({',
  '      asin:asin,',
  '      title:h2?clean(h2.innerText):\'\',',
  '      price:pe?pe.innerText:null,',
  '      rating:ra?ra.getAttribute(\'aria-label\'):null,',
  '      reviews:re?re.innerText:null,',
  '      sponsored:clean(c.innerText).slice(0,400).indexOf(\'Sponsored\')>=0',
  '    });',
  '  }',
  '  return JSON.stringify({count:cards.length, items:out});',
  '})()',
].join('\n');

/** 页面内：读卖家精灵扩展的关键词市场分析表 + 顶部统计。无正则、无转义。 */
export const READ_PANEL = [
  '(function(){',
  '  var NL=String.fromCharCode(10);',
  '  function clean(s){ return String(s==null?\'\':s).split(NL).map(function(l){return l.trim();}).filter(Boolean).join(\' \'); }',
  '  var panel=document.querySelector(\'#main-sellersprite-extension\');',
  '  if(!panel) return JSON.stringify({hasPanel:false});',
  '  var txt=panel.innerText||\'\';',
  '  var body=[...document.querySelectorAll(\'table\')].find(function(t){return t.className.includes(\'vxe-table--body\');});',
  '  var rows=[];',
  '  if(body){',
  '    var trs=body.querySelectorAll(\'tr\');',
  '    for(var i=0;i<trs.length;i++){',
  '      var tds=[...trs[i].querySelectorAll(\'td\')];',
  '      if(tds.length<20) continue;',
  '      var g=function(idx){var td=tds[idx];return td?clean(td.innerText):\'\'};',
  '      rows.push({',
  '        rank:g(2), title:g(4), brand:g(6), category:g(7), bsr:g(8),',
  '        variants:g(12), price:g(13), reviews:g(15), rating:g(17),',
  '        listed:g(21), sellers:g(22), fulfillment:g(23), delivery:g(24)',
  '      });',
  '    }',
  '  }',
  '  function grab(label){',
  '    var i=txt.indexOf(label);',
  '    if(i<0) return null;',
  '    var parts=clean(txt.slice(i+label.length)).split(\' \').filter(Boolean);',
  '    return parts.length?parts[0]:null;',
  '  }',
  '  var stats={',
  '    asinCount:grab(\'ASIN数量\'),',
  '    totalUnits:grab(\'总销量\'),',
  '    totalRevenue:grab(\'总销售额\'),',
  '    avgBsr:grab(\'平均BSR\'),',
  '    avgPrice:grab(\'平均价格\'),',
  '    avgRating:grab(\'平均评分\'),',
  '    avgReviews:grab(\'平均评分数\'),',
  '    avgListingDays:grab(\'平均上架天数\')',
  '  };',
  '  return JSON.stringify({hasPanel:true, rows:rows, stats:stats, hasLoadMore:txt.indexOf(\'加载更多\')>=0});',
  '})()',
].join('\n');

/** 点击扩展面板里的「加载更多」。 */
export const CLICK_MORE = [
  '(function(){',
  '  var panel=document.querySelector(\'#main-sellersprite-extension\');',
  '  if(!panel) return \'NOPANEL\';',
  '  var els=[...panel.querySelectorAll(\'a,button,span,div\')];',
  '  for(var i=0;i<els.length;i++){',
  '    var e=els[i];',
  '    if(e.children.length===0 && String(e.innerText||\'\').trim()===\'加载更多\'){ e.click(); return \'CLICKED\'; }',
  '  }',
  '  return \'NONE\';',
  '})()',
].join('\n');
/**
 * 采集一个关键词。
 * @param {{keyword:string, marketplace?:string, maxRows?:number, loadMoreRounds?:number, timeoutSec?:number}} input
 */
export async function collectKeywordRows({ keyword, marketplace = 'US', maxRows = 60, loadMoreRounds = 3, timeoutSec = 60 } = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) {
    const error = new Error('缺少关键词');
    error.code = 'INVALID_ARGS';
    throw error;
  }
  const domain = AMAZON_DOMAINS[String(marketplace || 'US').toUpperCase()] || AMAZON_DOMAINS.US;
  const url = 'https://www.' + domain + '/s?k=' + encodeURIComponent(kw);
  let tabId = null;
  let ownsTab = true;
  try {
    // 复用同关键词的已有标签页：卖家精灵扩展只在这个页面已经打开、且被激活过的窗口里
    // 才会把关键词分析面板渲染出来（新开的后台标签页实测不渲染）。
    const existing = (await listTabs()).find((tab) => {
      if (!tab.url || !tab.url.includes('/s?k=')) return false;
      const q = decodeURIComponent(tab.url.split('/s?k=')[1].split('&')[0]).split('+').join(' ').trim().toLowerCase();
      return q === kw.toLowerCase();
    });
    if (existing) {
      tabId = existing.id;
      ownsTab = false;
      await focusTab(tabId).catch(() => {});
    } else {
      tabId = await openTab(url);
    }
    // 必须把标签页切到前台：后台标签页被 Chrome 节流，扩展不会渲染数据表。
    await focusTab(tabId).catch(() => {});
    const ready = await waitFor(tabId, 'document.querySelectorAll("[data-component-type=\'s-search-result\']").length > 2', { timeout: timeoutSec });
    if (!ready) {
      const error = new Error('Amazon 搜索页未加载出结果（可能被验证码拦截或需人工验证）');
      error.code = 'PAGE_NOT_READY';
      throw error;
    }
    // 扩展面板是异步渲染的：等表体真的在
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
      await new Promise((resolve) => setTimeout(resolve, 2000));
      panel = await runJson(tabId, READ_PANEL, { timeout: 40000, strict: false });
      if (!panel || panel.rows.length <= before) break;
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
        bsr: firstNumber(item.bsr),
        price: firstNumber(item.price),
        reviews: parseReviews(item.reviews),
        rating: parseRating(item.rating),
        variants: firstNumber(item.variants),
        listingDate: parseDate(item.listed),
        sellers: firstNumber(item.sellers),
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
    if (tabId && ownsTab) await closeTab(tabId).catch(() => {});
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
