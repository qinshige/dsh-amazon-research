(() => {
  const table = [...document.querySelectorAll('table')].find(t => t.rows.length > 20);
  if (!table) return 'NO_TABLE';
  const n = (s) => {
    const m = String(s || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  const out = [];
  for (let i = 0; i < table.rows.length; i++) {
    const tr = table.rows[i];
    const tds = [...tr.cells].map(c => c.innerText.replace(/\s+/g, ' ').trim());
    if (tds.length !== 22) continue;
    const info = tds[3] || '';
    const a = tr.querySelector('a[href*="/dp/"]');
    let detail = '';
    const nxt = table.rows[i + 1];
    if (nxt && nxt.cells.length === 1) detail = nxt.cells[0].innerText.replace(/\s+/g, ' ').trim();
    const cat = detail.match(/#([\d,]+)\s+in\s+([^\s]+)/);
    out.push({
      rank: n(tds[1]),
      asin: a ? (a.getAttribute('href').match(/\/dp\/([A-Z0-9]{10})/) || [])[1] || null : null,
      parentAsin: (info.match(/父ASIN\s*:\s*([A-Z0-9]{10})/) || [])[1] || null,
      title: info.replace(/\s*ASIN:.*$/s, '').trim(),
      brand: (info.match(/品牌:([^\s]+)/) || [])[1] || '',
      badges: tds[2],
      bsrBig: n(tds[4]),
      bsrCategory: cat ? { rank: n(cat[1]), category: cat[2] } : null,
      units: n(tds[6]),
      revenue: n(tds[7]),
      childUnits: tds[8],
      variants: n(tds[9]),
      price: n(tds[10]),
      qa: n((tds[10] || '').split(/\s+/)[1]),
      reviews: n(tds[11]),
      monthNewReviews: n((tds[11] || '').split(/\s+/)[1]),
      rating: n(tds[12]),
      reviewRate: n((tds[12] || '').split(/\s+/)[1]),
      fbaFee: n(tds[13]),
      margin: n((tds[13] || '').split(/\s+/)[1]),
      listedDate: (tds[14].match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || null,
      listedRaw: tds[14],
      sellers: n(tds[15]),
      fulfillment: (tds[16] || '').split(/\s+/)[0] || null,
      buyBox: (tds[17] || '').split(/\s+/)[0] || null,
      lqs: n(tds[18]),
      weight: tds[19],
      packWeight: tds[20],
    });
  }
  return JSON.stringify(out);
})()