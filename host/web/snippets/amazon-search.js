(() => {
  const cards = [...document.querySelectorAll('[data-component-type="s-search-result"]')];
  const out = [];
  for (const c of cards.slice(0, 30)) {
    const t = c.querySelector('h2') ? c.querySelector('h2').innerText.replace(/\s+/g, ' ').trim() : '';
    const pEl = c.querySelector('.a-price .a-offscreen');
    const link = c.querySelector('a.a-link-normal[href*="/dp/"]');
    const href = link ? link.getAttribute('href') : '';
    const asin = (href.match(/\/dp\/([A-Z0-9]{10})/) || [])[1] || null;
    out.push({
      title: t,
      price: pEl ? pEl.innerText : null,
      asin,
      rating: c.querySelector('[aria-label*="out of 5 stars"]') ? c.querySelector('[aria-label*="out of 5 stars"]').getAttribute('aria-label') : null,
      reviews: c.querySelector('a[href*="#customerReviews"] span') ? c.querySelector('a[href*="#customerReviews"] span').innerText : null,
      sponsored: /Sponsored/i.test(c.innerText.slice(0, 400)),
    });
  }
  return JSON.stringify({ count: cards.length, items: out });
})()