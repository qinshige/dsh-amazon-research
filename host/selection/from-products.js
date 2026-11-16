/**
 * dsh-amazon-research · host/selection/from-products.js
 *
 * 把卖家精灵「查竞品」的 Top 商品明细，转成采集表行（screen 的输入）。
 *
 * 为什么需要：这条链路一次就拿到 ASIN、售价、月销、月销售额、评分数、评分、
 * 变体数、FBA 费、毛利率、上架时间、商品重量与包装尺寸 —— 正是采集表最全的字段，
 * 不用再让人手工填 CSV。
 */

/** "15.2 pounds" / "11.3 ounces" / "0.25 kg" → 克 */
export function parseWeightG(text) {
  const s = String(text || '');
  const m = s.match(/([\d.]+)\s*(pounds|lbs|ounces|oz|grams|g|kg|千克|克)/i);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const unit = m[2].toLowerCase();
  if (unit === 'pounds' || unit === 'lbs') return Math.round(value * 453.592);
  if (unit === 'ounces' || unit === 'oz') return Math.round(value * 28.3495);
  if (unit === 'kg' || unit === '千克') return Math.round(value * 1000);
  return Math.round(value);
}

/** "15 x 10.5 x 10.5 inches" → { l, w, h }（厘米） */
export function parseDimsCm(text) {
  const s = String(text || '');
  const m = s.match(/([\d.]+)\s*x\s*([\d.]+)\s*x\s*([\d.]+)\s*(inches|inch|cm)/i);
  if (!m) return null;
  const nums = [m[1], m[2], m[3]].map((v) => Number(v));
  if (nums.some((v) => !Number.isFinite(v))) return null;
  const isCm = /cm/i.test(m[4]);
  const factor = isCm ? 1 : 2.54;
  return { l: Math.round(nums[0] * factor), w: Math.round(nums[1] * factor), h: Math.round(nums[2] * factor) };
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 类目级聚合值（用于采集表里的集中度 / 新品占比 / 前十评价数）。
 * @param {{market:object, products:Array<object>}} input
 */
export function classAggregates(market, products) {
  const list = Array.isArray(products) ? products : [];
  const top10 = [...list].sort((a, b) => (num(b.monthlySales) ?? 0) - (num(a.monthlySales) ?? 0)).slice(0, 10);
  const reviews = top10.map((p) => num(p.reviews)).filter((v) => v !== null);
  const avgTop10Reviews = reviews.length ? Math.round(reviews.reduce((a, b) => a + b, 0) / reviews.length) : null;
  const newRatio = market?.newRatio || {};
  // 新品占比窗口必须标清：L1 = 1 个月口径，与方法论的 6/12 个月口径不可直接比较
  const newShare = num(newRatio.l6) ?? num(newRatio.l3) ?? num(newRatio.l1) ?? null;
  const newWindow = newRatio.l6 !== null && newRatio.l6 !== undefined ? 'L6(6个月)'
    : (newRatio.l3 !== null && newRatio.l3 !== undefined ? 'L3(3个月)'
      : (newRatio.l1 !== null && newRatio.l1 !== undefined ? 'L1(1个月)' : ''));
  const brandCr3 = num(market?.concentration?.top3BrandCrn);
  return {
    '品牌集中度%': brandCr3 === null ? null : Math.round(brandCr3 * 1000) / 10,
    '前10评价数': avgTop10Reviews,
    '新品占比%': newShare === null ? null : Math.round(newShare * 1000) / 10,
    '新品占比口径': newWindow,
    '退货率%': num(market?.structure?.returnRatio),
  };
}

/**
 * Top 商品 → 采集表行。
 * @param {{market:object, products:Array<object>, marketplace?:string, categoryPath?:string, source?:string, purchased?:Map<string,object>}} input
 *   purchased: 可选，按 ASIN 提供 1688 实测采购价（{priceCNY, weightG, offerUrl}）
 */
export function productsToSelectionRows({ market, products, marketplace = 'US', categoryPath = '', source = '卖家精灵查竞品页', purchased = {} } = {}) {
  const list = Array.isArray(products) ? products : [];
  const agg = classAggregates(market, list);
  const domain = marketplace.toUpperCase() === 'US' ? 'amazon.com' : 'amazon.com';
  return list.map((p) => {
    const weightG = parseWeightG(p.packWeight) ?? parseWeightG(p.itemWeight);
    const dims = parseDimsCm(p.packDims) ?? parseDimsCm(p.itemDims);
    const bought = purchased[p.asin] || null;
    const row = {
      ASIN: p.asin || '',
      商品名称: p.title || '',
      链接: p.asin ? 'https://www.' + domain + '/dp/' + p.asin : '',
      采集时间: new Date().toISOString(),
      来源: source,
      售价USD: num(p.price),
      评分: num(p.rating),
      评论数: num(p.reviews),
      月销: num(p.monthlySales),
      月销额: num(p.monthlyRevenue),
      BSR排名: num(p.bsrBig) ?? num(p.bsrCategoryRank),
      变体数: num(p.variants),
      上架时间: p.listedDate || '',
      品牌: p.brand || '',
      类目路径: categoryPath,
      重量g: weightG,
      长cm: dims ? dims.l : null,
      宽cm: dims ? dims.w : null,
      高cm: dims ? dims.h : null,
      FBA配送费USD: num(p.fbaFee),
      '品牌集中度%': agg['品牌集中度%'],
      '前10评价数': agg['前10评价数'],
      '新品占比%': agg['新品占比%'],
      '新品占比口径': agg['新品占比口径'],
      退货率: agg['退货率%'] === null ? null : agg['退货率%'] / 100,
      采购价CNY: bought ? bought.priceCNY : null,
      '1688链接': bought ? bought.offerUrl : '',
      备注: [
        p.bsrCategory ? '子类排名 #' + p.bsrCategoryRank + ' ' + p.bsrCategory : '',
        p.qa ? 'Q&A ' + p.qa : '',
        agg['新品占比口径'] ? '新品占比口径 ' + agg['新品占比口径'] : '',
        p.reviewRate ? '留评率 ' + p.reviewRate + '%' : '',
        p.margin !== null && p.margin !== undefined ? '卖家精灵毛利率 ' + p.margin + '%' : '',
        p.fulfillment ? '配送 ' + p.fulfillment : '',
        p.sellers ? '卖家数 ' + p.sellers : '',
        p.lqs ? 'LQS ' + p.lqs : '',
        p.itemWeight ? '商品重量 ' + p.itemWeight : '',
      ].filter(Boolean).join('；'),
    };
    return row;
  });
}
