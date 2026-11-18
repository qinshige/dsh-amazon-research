(() => {
  const clean = (value) => String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
  const asinOf = (href) => (String(href || '').match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/) || [])[1] || null;
  const absolute = (href) => {
    try {
      const url = new URL(href, location.origin);
      return url.origin === location.origin ? url.href : null;
    } catch {
      return null;
    }
  };
  const items = [];
  const searchCards = [...document.querySelectorAll('[data-component-type="s-search-result"]')];
  if (searchCards.length) {
    searchCards.slice(0, 60).forEach((card, index) => {
      const link = card.querySelector('a[href*="/dp/"]');
      const href = link ? link.getAttribute('href') : '';
      const priceEl = card.querySelector('.a-price .a-offscreen') || card.querySelector('.a-price');
      const ratingEl = card.querySelector('[aria-label*="out of 5 stars"]') || card.querySelector('[aria-label*="من أصل 5"]');
      const reviewEl = card.querySelector('a[href*="#customerReviews"] span') || card.querySelector('[data-cy="reviews-block"] .a-size-base');
      items.push({
        kind: 'search',
        position: index + 1,
        asin: card.getAttribute('data-asin') || asinOf(href),
        title: clean((card.querySelector('h2') || {}).innerText || (card.querySelector('h2 span') || {}).textContent),
        url: absolute(href),
        priceText: priceEl ? clean(priceEl.textContent) : null,
        ratingText: ratingEl ? clean(ratingEl.getAttribute('aria-label') || ratingEl.textContent) : null,
        reviewText: reviewEl ? clean(reviewEl.textContent) : null,
        rankText: null,
        sponsored: /Sponsored|مُموَّل|مموّل/i.test(clean(card.innerText).slice(0, 400)),
      });
    });
  }
  if (!items.length) {
    const rankCards = [...document.querySelectorAll('#gridItemRoot, .zg-grid-general-faceout')];
    rankCards.slice(0, 60).forEach((card, index) => {
      const link = card.querySelector('a[href*="/dp/"]') || card.querySelector('a[href*="/gp/product/"]');
      const href = link ? link.getAttribute('href') : '';
      const priceEl = card.querySelector('._cDEzb_p13n-sc-price_3mJ9Z, .p13n-sc-price, .a-price .a-offscreen') || card.querySelector('.a-color-price');
      const ratingEl = card.querySelector('[aria-label*="out of 5 stars"]') || card.querySelector('.a-icon-alt');
      const reviewEl = card.querySelector('.a-size-small .a-color-secondary, .a-size-small');
      const rankEl = card.querySelector('.zg-bdg-text');
      items.push({
        kind: 'rank',
        position: index + 1,
        asin: asinOf(href),
        title: clean((card.querySelector('.p13n-sc-truncate, ._cDEzb_p13n-sc-css-line-clamp-3_g3dy1, .p13n-sc-truncated, a .a-size-base') || {}).textContent),
        url: absolute(href),
        priceText: priceEl ? clean(priceEl.textContent) : null,
        ratingText: ratingEl ? clean(ratingEl.getAttribute('aria-label') || ratingEl.textContent) : null,
        reviewText: reviewEl ? clean(reviewEl.textContent) : null,
        rankText: rankEl ? clean(rankEl.textContent) : null,
        sponsored: false,
      });
    });
  }
  return JSON.stringify({ url: location.href, count: items.length, items });
})()
