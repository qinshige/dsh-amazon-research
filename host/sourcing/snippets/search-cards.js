/**
 * 1688 搜索页 · 卡片抽取片段。
 *
 * 在 s.1688.com/offer_search.htm 页面上执行，返回搜索结果卡片（入口价级别）的原始文本。
 * 只取页面真实文本：不做任何推断或价格换算，解析交给 Node 侧纯函数（parseCardText）。
 *
 * 返回：JSON 字符串 { url, count, items: [{ offerId, url, titleAttr, cardText }] }
 */
(() => {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const anchors = [...document.querySelectorAll('a[href*="detail.1688.com/offer/"]')];
  const seen = new Set();
  const items = [];
  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    const m = href.match(/detail\.1688\.com\/offer\/(\d+)\.html/);
    if (!m) continue;
    const offerId = m[1];
    if (seen.has(offerId)) continue;
    seen.add(offerId);
    let cardText = (a.innerText || '').trim();
    if (cardText.length < 12) {
      const card = a.closest('[class*="gridCell"],[class*="offer-item"],[class*="offerItem"],[class*="card"]') || a.parentElement;
      cardText = ((card && card.innerText) || '').trim();
    }
    const img = a.querySelector('img');
    items.push({
      offerId: offerId,
      url: 'https://detail.1688.com/offer/' + offerId + '.html',
      titleAttr: norm(a.getAttribute('title') || (img && img.alt) || ''),
      cardText: cardText.slice(0, 1500),
    });
    if (items.length >= 60) break;
  }
  return JSON.stringify({ url: location.href, count: items.length, items: items });
})()
