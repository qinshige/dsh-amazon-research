(() => {
  const txt = (el) => (el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : null);

  // 面包屑：Trendyol › Ev ve Mobilya › Sofra&Mutfak › Pişirme › Tencere › <品牌类目>
  const crumbEls = [...document.querySelectorAll('a.breadcrumb-item, .breadcrumb a, nav[aria-label="breadcrumb"] a')];
  const crumbs = [];
  for (const el of crumbEls) {
    const t = txt(el);
    if (t && t.length <= 40 && !crumbs.includes(t)) crumbs.push(t);
  }

  // 价格：详情页主价格区
  const priceText = txt(document.querySelector('.product-price-container .price, .price-container .price, [class*="price"][class*="current"]'))
    || null;

  // 属性表：Öne Çıkan Özellikler / Ürün Özellikleri
  const attrs = {};
  const rows = [...document.querySelectorAll('.product-attributes-item, .attribute-item, tr')];
  for (const row of rows) {
    const t = txt(row);
    if (!t || t.length > 120) continue;
    const parts = t.split(/\s{2,}|:/);
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const value = parts.slice(1).join(' ').trim();
      if (key && value && key.length <= 30 && !attrs[key]) attrs[key] = value;
    }
  }

  let structured = null;
  const products = [];
  const collect = (value) => {
    if (Array.isArray(value)) return value.forEach(collect);
    if (!value || typeof value !== 'object') return;
    if (value['@type'] === 'Product' || (Array.isArray(value['@type']) && value['@type'].includes('Product'))) products.push(value);
    if (value['@graph']) collect(value['@graph']);
  };
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { collect(JSON.parse(s.textContent)); } catch {}
  }
  if (products.length === 1) {
    const p = products[0];
    const offer = Array.isArray(p.offers) ? (p.offers.length === 1 ? p.offers[0] : null) : p.offers;
    structured = { price:offer?.price ?? null, currency:offer?.priceCurrency ?? null,
      ratingCount:p.aggregateRating?.ratingCount ?? null, commentCount:p.aggregateRating?.reviewCount ?? null,
      rating:p.aggregateRating?.ratingValue ?? null, source:'Product JSON-LD' };
  }
  const bodyText = document.body.innerText || '';
  return JSON.stringify({
    url: location.href,
    title: document.title,
    h1: txt(document.querySelector('h1')),
    crumbs,
    priceText,
    structured,
    attrs,
    bodyHead: bodyText.replace(/\n{2,}/g, '\n').slice(0, 2500),
  });
})()