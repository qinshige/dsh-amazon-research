(() => {
  // 卖家精灵「查竞品」页：表 0 = 表头，表 1 = 数据体。
  //
  // 为什么改成表头驱动：页面改版后数据行从 22 列变成 17 列，旧的硬编码
  // `tds.length !== 22` 会把每一行都跳过 → 抓到 0 个父体（实测）。
  // 现在按表头列名定位，页面再改列序也不会整页失配。
  const tables = [...document.querySelectorAll('table')];
  const headTable = tables.find((t) => t.rows.length === 1);
  const bodyTable = tables.find((t) => t.rows.length > 1);
  if (!bodyTable) return 'NO_TABLE';

  const headers = headTable
    ? [...headTable.rows[0].cells].map((c) => c.innerText.replace(/\s+/g, ' ').trim())
    : [];

  // 表头有合并单元格（空列），按出现顺序映射到数据行的非空列。
  const idx = {};
  let col = 0;
  for (const h of headers) {
    if (h === '') { col += 1; continue; }
    idx[h.split(' ')[0]] = col;
    col += 1;
  }
  const colAt = (row, key, fallback) => {
    const i = idx[key];
    return i === undefined ? (fallback === undefined ? '' : fallback) : (row.cells[i] ? row.cells[i].innerText.replace(/\s+/g, ' ').trim() : '');
  };

  const n = (s) => {
    const m = String(s || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  const n2 = (s) => {
    const parts = String(s || '').split(/\s+/).filter(Boolean);
    return parts.length > 1 ? n(parts[1]) : null;
  };
  const money = (s) => {
    const m = String(s || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  };

  const out = [];
  for (let i = 0; i < bodyTable.rows.length; i += 1) {
    const tr = bodyTable.rows[i];
    if (!tr.cells || tr.cells.length < 10) continue;
    const info = colAt(tr, '产品信息');
    if (!info) continue;
    const link = tr.querySelector('a[href*="/dp/"]');
    const href = link ? link.getAttribute('href') || '' : '';
    const asin = (href.match(/\/dp\/([A-Z0-9]{10})/) || [])[1] || null;

    // 明细行（1 个单元格）跟着数据行：类目路径、小类排名、LQS、卖家数、重量、尺寸
    const detailRow = bodyTable.rows[i + 1];
    const detail = detailRow && detailRow.cells.length === 1
      ? detailRow.cells[0].innerText.replace(/\s+/g, ' ').trim()
      : '';
    if (detailRow && detailRow.cells.length === 1) i += 1;

    const catRank = (detail.match(/#([\d,]+)\s+in\s+([^\s]+)/) || [])[1] || null;
    const catName = (detail.match(/#([\d,]+)\s+in\s+([^\s]+)/) || [])[2] || null;
    const lqs = n((detail.match(/LQS:\s*([\d.]+)/) || [])[1]);
    const sellers = n((detail.match(/卖家:\s*([\d,]+)\s*家/) || [])[1]);
    const itemWeight = (detail.match(/商品重量:\s*([\d.]+)\s*(pounds|lbs|ounces|oz|grams|kg)/i) || [])[0] || '';
    const itemDims = (detail.match(/商品尺寸:\s*([\d.]+\s*x\s*[\d.]+\s*x\s*[\d.]+\s*(inches|inch|cm))/i) || [])[0] || '';
    const packWeight = (detail.match(/包装重量:\s*([\d.]+\s*(pounds|lbs|ounces|oz|grams|kg))/i) || [])[0] || '';
    const packDims = (detail.match(/包装尺寸:\s*([\d.]+\s*x\s*[\d.]+\s*x\s*[\d.]+\s*(inches|inch|cm))/i) || [])[0] || '';
    const sizeTier = (detail.match(/\(([^)]*大件[^)]*)\)/) || [])[1] || null;

    out.push({
      rank: n(colAt(tr, '#')),
      asin,
      parentAsin: (info.match(/父ASIN\s*:\s*([A-Z0-9]{10})/) || [])[1] || null,
      title: info.replace(/\s*ASIN:.*$/s, '').trim(),
      brand: (info.match(/品牌:([^\s]+)/) || [])[1] || '',
      bsrBig: n(colAt(tr, '大类BSR')),
      bsrBigText: colAt(tr, '大类BSR'),
      bsrCategoryRank: catRank ? n(catRank) : null,
      bsrCategory: catName || null,
      units: n(colAt(tr, '销量(父)')),
      unitsGrowth: (colAt(tr, '销量(父)').match(/([\d.]+%)/) || [])[1] || null,
      revenue: money(colAt(tr, '销售额')),
      childUnits: colAt(tr, '子体销量'),
      variants: n(colAt(tr, '变体数')),
      price: money(colAt(tr, '价格')),
      qa: n2(colAt(tr, '价格')),
      reviews: n(colAt(tr, '评分数')),
      monthNewReviews: n2(colAt(tr, '评分数')),
      rating: n(colAt(tr, '评分')),
      reviewRate: n2(colAt(tr, '评分')),
      fbaFee: money(colAt(tr, 'FBA')),
      margin: n2(colAt(tr, 'FBA')),
      listedDate: (colAt(tr, '上架时间').match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || null,
      listedRaw: colAt(tr, '上架时间'),
      fulfillment: (colAt(tr, '配送').split(/\s+/)[0] || null),
      buyerShipping: (colAt(tr, '配送').split(/\s+/)[1] || null),
      lqs,
      sellers,
      itemWeight,
      itemDims,
      packWeight,
      packDims,
      sizeTier,
      detailText: detail.slice(0, 400),
    });
  }
  return JSON.stringify(out);
})()
