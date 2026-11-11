(() => {
  const txt = document.body.innerText;
  const grab = (label) => {
    const re = new RegExp(label + '\\s*\\n?\\s*([^\\n]+)');
    const m = re.exec(txt);
    return m ? m[1].trim() : null;
  };
  const grabNum = (label) => {
    const v = grab(label);
    if (v === null) return null;
    const m = v.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  const conc = (label) => {
    const m = new RegExp(label + '\\((\\d+\\.\\d+)%\\)').exec(txt);
    return m ? Number(m[1]) / 100 : null;
  };
  return JSON.stringify({
    title: document.title,
    marketPath: (txt.match(/Tools & Home Improvement[^\n]*/) || [])[0] || null,
    sampleProducts: grabNum('样本商品数'),
    sampleBrandsSellers: grab('样本品牌数/卖家数'),
    avgBsr: grabNum('平均BSR'),
    avgUnits: grabNum('近30天均销量'),
    avgRevenue: grabNum('近30天均销售额'),
    avgPrice: grabNum('平均价格'),
    avgRatings: grabNum('平均评分数'),
    avgRating: grabNum('平均星级'),
    avgSellers: grabNum('平均卖家数'),
    grossMargin: grabNum('平均毛利率'),
    newItems: grabNum('新品数量'),
    newRatio: grabNum('新品占比'),
    newAvgPrice: grabNum('新品平均价格'),
    newAvgUnits: grabNum('新品近30天均销量'),
    newAvgRevenue: grabNum('新品近30天均销售额'),
    firstListed: grab('商品首次上架时间'),
    lastListed: grab('商品最新上架时间'),
    productCr3: conc('商品集中度'),
    brandCr3: conc('品牌集中度'),
    sellerCr3: conc('卖家集中度'),
    peerProductCr3: conc('同级类目商品集中度'),
    peerBrandCr3: conc('同级类目品牌集中度'),
    peerSellerCr3: conc('同级类目卖家集中度'),
    topProductsCount: (txt.match(/TOP商品明细\((\d+)\)/) || [])[1] || null,
    goodsTotal: (txt.match(/商品总数:\s*([\d,]+)/) || [])[1] || null,
    keywordTrends: (txt.match(/hero hook[\s\S]{0,200}/) || [])[0] || null,
  });
})()