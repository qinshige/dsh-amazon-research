(() => {
  // 只取商品网格卡片 a.product-card；
  // 必须排除 a.seller-store-product-card（店铺推广轮播，实测同页有 40 个，会把推荐位当商品）
  const cards = [...document.querySelectorAll('a.product-card')]
    .filter((el) => !/(^|\s)seller-store-product-card(\s|$)/.test((el.className || '').toString()));

  const txt = (el) => (el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : null);

  const out = [];
  const seen = new Set();
  for (const card of cards) {
    const href = card.getAttribute('href') || '';
    const pidMatch = href.match(/-p-(\d+)/);
    const productId = pidMatch ? pidMatch[1] : null;
    if (!productId || seen.has(productId)) continue;
    seen.add(productId);

    const brand = txt(card.querySelector('.product-brand'));
    const name = txt(card.querySelector('.product-name'));
    const ratingText = txt(card.querySelector('.average-rating'));
    const countText = txt(card.querySelector('.total-count'));
    // Dedicated sale price excludes the crossed-out amount and conditional Plus prices.
    const sa = typeof expectedCountry === 'string' && expectedCountry === 'SA';
    const priceText = sa ? txt(card.querySelector('.sale-price, [data-testid="sale-price"]')) : txt(card.querySelector('.price-section'));
    const badgeText = txt(card.querySelector('.badges-container'));
    const attrItems = [...card.querySelectorAll('.product-attributes-item')].map((el) => txt(el)).filter(Boolean);
    const fullText = txt(card) || '';

    out.push({
      productId,
      href,
      brand,
      name,
      ratingText,
      countText,
      priceText,
      badgeText,
      attributes: attrItems,
      fullText,
    });
  }

  return JSON.stringify({
    count: out.length,
    page: (location.search.match(/[?&]pi=(\d+)/) || [])[1] || '1',
    hasNext: !!document.querySelector('a[href*="pi="]'),
    items: out,
  });
})()