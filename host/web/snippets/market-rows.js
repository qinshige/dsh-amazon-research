(() => {
  const rows = [...document.querySelectorAll('table tbody tr')];
  const out = [];
  for (const r of rows) {
    const tds = [...r.querySelectorAll('td')].map(td => td.innerText.replace(/\s+/g, ' ').trim());
    if (!tds.length || !/^\d+$/.test(tds[0])) continue;
    const link = [...r.querySelectorAll('a')].map(a => a.getAttribute('href')).find(h => h && /market-research\/\d+\//.test(h));
    out.push({
      rank: +tds[0], name: tds[1], sample: tds[2], totalUnits: tds[3], avg: tds[4],
      headRevenue: tds[5], ratings: tds[6], bsr: tds[7], sellersPrice: tds[8],
      fulfillment: tds[9], concentration: tds[10], newItems: tds[11],
      goods: tds[12], returnRate: tds[13], node: link || null,
    });
  }
  return JSON.stringify(out);
})()