/**
 * dsh-amazon-research · host/selection/kpis.js
 *
 * 选品十维体检 + 一票否决 + 分档引擎（纯函数 / 无网络 / 无第三方依赖）。
 *
 * 口径来源（与《亚马逊选品实操指南》一致）：
 *   - 第三部分「选品的十大维度」：市场容量与竞争、趋势、价格、评分与评价、
 *     新品占比、季节性、质量与退货、物流、供应链、侵权认证；
 *   - 第四部分「维度排除法」：趋势上升、新品占比、低评论占比、体量、差评可解决、
 *     认证专利、利润；
 *   - 一票否决：大类目、集中度 > 70%、评价壁垒 > 1 万、变体 > 3、专利风险、
 *     易碎/抛货、净利率 < 15%、退货率 > 10% 且差评不可解决。
 *
 * 纪律：缺失字段一律记「未知」，不计入命中率分母，并在报告「待复核」里列出；
 * 不用行业常识补 ASIN / 售价 / 评论数 / 销量。
 */
import { landedCost } from '../sourcing/cost-model.js';
import { assessDataConfidence, buildEvidenceChain } from './evidence.js';

export const OK = '达标';
export const WARN = '警戒';
export const BAD = '不达标';
export const UNKNOWN = '未知';

export const TIERS = Object.freeze(['一档', '二档', '三档', '待复核', '淘汰']);
export const MIN_JUDGED = 6;

/** 十维编号 → 名称（与你方法论第三部分一致）。 */
export const DIMENSIONS = Object.freeze({
  1: '市场容量与竞争热度',
  2: '产品趋势',
  3: '价格区间',
  4: '评分数量与星级',
  5: '新品占有率',
  6: '季节性 / 节日性',
  7: '质量、退货与变体',
  8: '运输便利性',
  9: '供应链优势',
  10: '侵权、认证与类目审核',
  11: '利润空间',
});

const ALIASES = {
  asin: ['ASIN', 'asin', '商品ASIN', '子ASIN'],
  name: ['商品名称', 'name', 'title', '标题', '产品名称'],
  url: ['链接', 'url', '商品链接', 'detailUrl'],
  sourceLabel: ['来源', '数据来源', 'source', '采集来源'],
  collectedAt: ['采集时间', '抓取时间', 'collectedAt', 'fetchedAt'],
  brand: ['品牌', 'brand', '卖家精灵品牌'],
  categoryPath: ['类目路径', 'categoryPath', '类目', 'category'],
  priceUSD: ['售价USD', 'priceUSD', '售价', 'price', '价格USD'],
  rating: ['评分', 'rating', '星级'],
  reviews: ['评论数', 'reviews', '评价数'],
  monthlySales: ['月销', 'monthlySales', '月销量', '卖家精灵销量'],
  bsrRank: ['BSR排名', 'bsrRank', 'BSR', '卖家精灵BSR'],
  monthlyPurchases: ['月购买量', 'monthlyPurchases'],
  fbaFeeUSD: ['FBA配送费USD', 'fbaFeeUSD', '配送费USD', 'FBA费USD', '卖家精灵FBA费'],
  // 卖家精灵口径毛利率（平台自算）：采购价没采到时，用它看这一段「有没有肉」
  refGrossMargin: ['卖家精灵毛利率', '毛利率', 'spriteGrossMargin'],
  weightG: ['重量g', 'weightG', '件重g'],
  lengthCm: ['长cm', 'lengthCm'],
  widthCm: ['宽cm', 'widthCm'],
  heightCm: ['高cm', 'heightCm'],
  purchaseCNY: ['采购价CNY', 'purchaseCNY', '采购价', '估算采购成本CNY'],
  // 包装对齐：Amazon 一个可售单位 = 几个 1688 单件
  packUnits: ['包装对齐', 'packUnits', '每个可售单位件数', '件数'],
  unitPriceCNY: ['单件采购价CNY', 'unitPriceCNY', '单件价CNY'],
  offerUrl: ['1688链接', 'offerUrl'],
  adPct: ['广告占比', 'adPct', '广告占比%'],
  returnPct: ['退货率', 'returnPct'],
  commissionPct: ['佣金占比', 'commissionPct'],
  firstMileUSD: ['头程USD', 'firstMileUSD'],
  otherUSD: ['其他USD', 'otherUSD', '仓储其他USD'],
  brandConcentrationPct: ['品牌集中度%', '品牌集中度', 'brandConcentrationPct'],
  sellerConcentrationPct: ['卖家集中度%', '卖家集中度'],
  top10Reviews: ['前10评价数', 'top10Reviews', '类目前十评价数'],
  newProductPct: ['新品占比%', '新品占比', 'newProductPct'],
  top100Units: ['Top100月销', 'top100Units', '类目Top100月销'],
  trend: ['趋势', 'trend'],
  seasonality: ['季节性', 'seasonality'],
  fragile: ['易碎', 'fragile'],
  variants: ['变体数', 'variants', '卖家精灵变体数'],
  patentRisk: ['专利风险', 'patentRisk'],
  certification: ['认证', 'certification', '认证要求'],
  supplierCount: ['供应商数', 'supplierCount'],
  reviewPain: ['差评痛点', 'reviewPain', '差评点'],
  abaRank: ['ABA排名', 'abaRank', 'ABA'],
  netMarginInput: ['净利率', 'netMargin'],
  tier: ['档位'],
};

function rawOf(row, key) {
  for (const alias of ALIASES[key] || []) {
    if (!row || !Object.hasOwn(row, alias)) continue;
    const value = row[alias];
    // 空的占位值（'' / null / undefined）不算命中，继续找下一个别名，
    // 否则「BSR=空但卖家精灵BSR 有值」这类兜底会失效。
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    return value;
  }
  return undefined;
}

/** 数字解析：去 % / 货币符号 / 千分位；空值与「未取到」返回 null。 */
export function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/[,\s]/g, '').replace(/^[¥$]/, '').replace(/%$/, '');
  if (!text || /^(na|n\/a|none|-|—|未取到|tbd)$/i.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function str(value) {
  if (value === undefined || value === null) return '';
  const text = String(value).trim();
  return /^(na|n\/a|none|-|—|未取到|tbd)$/i.test(text) ? '' : text;
}

/** 百分比输入归一：15 / 0.15 → 0.15；>1.5 视为百分数。 */
function ratio(value) {
  const n = num(value);
  if (n === null) return null;
  return n > 1.5 ? n / 100 : n;
}

/** 布尔/文字风险判断（「是/有/高/疑似/存在」都算命中）。 */
function riskText(value) {
  return /是|有|高|疑似|存在|风险|y|yes/i.test(str(value));
}

/** 「未检索 / 待确认 / 未取到」这类占位值不能当成「无风险」，一律记未知。 */
function isPendingValue(text) {
  return /未检索|未查|待查|待确认|待核实|未知|需核查|需人工|需 FTO|需FTO|TBD/i.test(String(text || ''));
}

function levelOf(path) {
  const text = str(path);
  if (!text) return 0;
  return text.replace(/>/g, '|').replace(/\//g, '|').split('|').filter((part) => part.trim()).length;
}

/** 规范化一条候选品（中英文列名都接受），只做字段搬运，不补数。 */
export function normalizeCandidate(row = {}) {
  const dims = {
    lengthCm: num(rawOf(row, 'lengthCm')),
    widthCm: num(rawOf(row, 'widthCm')),
    heightCm: num(rawOf(row, 'heightCm')),
  };
  let weightG = num(rawOf(row, 'weightG'));
  if (weightG === null && dims.lengthCm && dims.widthCm && dims.heightCm) {
    // 体积重：长 × 宽 × 高(cm) ÷ 6000 = kg → g（公式是估算值，报告会标注）
    weightG = (dims.lengthCm * dims.widthCm * dims.heightCm) / 6000 * 1000;
  }
  return {
    asin: str(rawOf(row, 'asin')),
    name: str(rawOf(row, 'name')),
    url: str(rawOf(row, 'url')),
    sourceLabel: str(rawOf(row, 'sourceLabel')),
    collectedAt: str(rawOf(row, 'collectedAt')),
    pageContract: row?.pageContract && typeof row.pageContract === 'object' ? structuredClone(row.pageContract) : null,
    fieldEvidence: row?.fieldEvidence && typeof row.fieldEvidence === 'object' ? structuredClone(row.fieldEvidence) : {},
    brand: str(rawOf(row, 'brand')),
    categoryPath: str(rawOf(row, 'categoryPath')),
    priceUSD: num(rawOf(row, 'priceUSD')),
    rating: num(rawOf(row, 'rating')),
    reviews: num(rawOf(row, 'reviews')),
    monthlySales: num(rawOf(row, 'monthlySales')),
    refGrossMargin: (() => { const v = ratio(rawOf(row, 'refGrossMargin')); return v; })(),
    bsrRank: num(rawOf(row, 'bsrRank')),
    monthlyPurchases: num(rawOf(row, 'monthlyPurchases')),
    fbaFeeUSD: num(rawOf(row, 'fbaFeeUSD')),
    weightG,
    dims,
    purchaseCNY: num(rawOf(row, 'purchaseCNY')),
    // 「包装对齐」可能是文本（如「20 个装」），先按数字取，再从文本里提取件数
    packUnits: num(rawOf(row, 'packUnits')) ?? (() => {
      const text = str(rawOf(row, 'packUnits'));
      if (!text) return null;
      const digits = text.split('').filter((ch) => ch >= '0' && ch <= '9').join('');
      const n = digits ? Number(digits) : null;
      return n !== null && n > 0 ? n : null;
    })(),
    unitPriceCNY: num(rawOf(row, 'unitPriceCNY')),
    offerUrl: str(rawOf(row, 'offerUrl')),
    adPct: ratio(rawOf(row, 'adPct')),
    returnPct: ratio(rawOf(row, 'returnPct')),
    commissionPct: ratio(rawOf(row, 'commissionPct')),
    firstMileUSD: num(rawOf(row, 'firstMileUSD')),
    otherUSD: num(rawOf(row, 'otherUSD')),
    brandConcentrationPct: num(rawOf(row, 'brandConcentrationPct')),
    sellerConcentrationPct: num(rawOf(row, 'sellerConcentrationPct')),
    top10Reviews: num(rawOf(row, 'top10Reviews')),
    newProductPct: num(rawOf(row, 'newProductPct')),
    top100Units: num(rawOf(row, 'top100Units')),
    trend: str(rawOf(row, 'trend')),
    seasonality: str(rawOf(row, 'seasonality')),
    fragile: str(rawOf(row, 'fragile')),
    variants: num(rawOf(row, 'variants')),
    patentRisk: str(rawOf(row, 'patentRisk')),
    certification: str(rawOf(row, 'certification')),
    supplierCount: num(rawOf(row, 'supplierCount')),
    reviewPain: str(rawOf(row, 'reviewPain')),
    abaRank: num(rawOf(row, 'abaRank')),
    netMarginInput: ratio(rawOf(row, 'netMarginInput')),
    tierInput: str(rawOf(row, 'tier')),
    raw: row,
  };
}

/**
 * 全成本净利测算：优先按行内参数（采购价/件重/配送费/广告/退货/佣金）算；
 * 缺采购价时退回调用方给定的「净利率」字段；都没有则返回 null（未知）。
 */
export function computeMargin(c, { fx = 6.7, costFx = null, settleFx = 6.6, channel = 'amazon-fba', profile = null, freight = null } = {}) {
  const costRate = costFx === null || costFx === undefined ? fx : costFx;
  // 包装对齐：采集表若给的是「1688 单件价」，必须乘以 Amazon 一个可售单位的件数，
  // 否则采购成本会被低估 10~100 倍（实测：20 个装手套夹，¥1.70/个 当成整包价 → 少算 20 倍）。
  // 优先级：显式可售单位成本（采购价CNY）> 单件价 × 件数。
  const packUnits = c.packUnits && c.packUnits > 0 ? c.packUnits : null;
  const unitPrice = c.unitPriceCNY;
  let purchaseCNY = c.purchaseCNY;
  let purchaseSource = '采集表采购价CNY（可售单位成本）';
  if (purchaseCNY === null && unitPrice !== null && packUnits !== null) {
    purchaseCNY = Number((unitPrice * packUnits).toFixed(4));
    purchaseSource = '单件价 ¥' + unitPrice.toFixed(2) + ' × ' + packUnits + ' 件/可售单位';
  }
  if (purchaseCNY === null) {
    if (c.netMarginInput !== null) {
      return { netMargin: c.netMarginInput, source: '行内净利率字段（未接入采购价，无法拆解）', profit: null };
    }
    return null;
  }
  // 平台佣金是**平台属性**：Amazon 用采集表里的类目佣金（服饰 17% / 家居 15% 等），
  // 非 Amazon 渠道一律用渠道模型的佣金率，不能拿 Amazon 的佣金去算 TK Shop。
  const referralRate = channel.startsWith('amazon') ? (c.commissionPct ?? undefined) : undefined;
  const calc = landedCost({
    channel,
    priceCNY: purchaseCNY,
    weightG: c.weightG,
    priceUSD: c.priceUSD,
    fbaFeeUSD: c.fbaFeeUSD ?? undefined,
    referralRate,
    adRate: c.adPct ?? undefined,
    returnRate: c.returnPct ?? undefined,
    otherUSD: c.otherUSD ?? undefined,
    costFx: costRate,
    settleFx,
    profile,
    freight,
    firstMileUSD: c.firstMileUSD ?? undefined,
    fx,
  });
  if (!calc) return null;
  let { firstMileUSD, totalCostUSD, netProfitUSD, netMargin } = calc;
  let source = purchaseSource + ' + 头程 + FBA + 佣金 + 广告 + 退货 + 其它（全成本）';
  if (c.firstMileUSD !== null) {
    totalCostUSD = calc.totalCostUSD - calc.firstMileUSD + c.firstMileUSD;
    netProfitUSD = calc.priceUSD - totalCostUSD;
    netMargin = netProfitUSD / calc.priceUSD;
    firstMileUSD = c.firstMileUSD;
    // 实测头程覆盖后，人民币口径要同步重算（结算汇率不变）
    calc.totalCostCNY = Number((totalCostUSD * calc.settleFx).toFixed(2));
    calc.netProfitCNY = Number((netProfitUSD * calc.settleFx).toFixed(2));
    calc.priceCNY_settle = Number((calc.priceUSD * calc.settleFx).toFixed(2));
    source = '采购价 + 实测头程 + FBA + 佣金 + 广告 + 退货 + 其它（全成本）';
  }
  return {
    netMargin,
    source,
    profit: {
      priceUSD: calc.priceUSD,
      purchaseCNY,
      purchaseUSD: calc.purchaseUSD,
      firstMileUSD,
      fbaFeeUSD: calc.fbaFeeUSD,
      fbaEstimated: calc.fbaEstimated,
      commissionUSD: calc.referralUSD,
      adUSD: calc.adUSD,
      returnUSD: calc.returnUSD,
      otherUSD: calc.otherUSD,
      totalCostUSD,
      netProfitUSD,
      netMargin,
      logisticsRatio: (firstMileUSD + calc.fbaFeeUSD) / calc.priceUSD,
      purchaseRatio: calc.purchaseUSD / calc.priceUSD,
      // 双汇率口径：成本项按成本汇率折美元，利润额按结算汇率折人民币
      costFx: calc.costFx,
      settleFx: calc.settleFx,
      totalCostCNY: calc.totalCostCNY,
      netProfitCNY: calc.netProfitCNY,
      priceCNY_settle: calc.priceCNY_settle,
      grossProfitCNY: calc.grossProfitCNY,
    },
  };
}

function check(key, dimension, label, status, value, note) {
  return { key, dimension, dimensionLabel: DIMENSIONS[dimension] || String(dimension), label, status, value, note: note || '' };
}

function statusFrom(condition, okStatus = OK, badStatus = BAD) {
  return condition ? okStatus : badStatus;
}

/**
 * 单个候选品的十维体检。
 * @returns {{asin:string, tier:string, hitRate:number, judgedCount:number, checks:Array, vetoes:Array, unknown:Array, margin:number|null, profit:object|null}}
 */
export function evaluateCandidate(row, { fx = 6.7, costFx = null, settleFx = 6.6, smallVolumeUnits = 200, channel = 'amazon-fba', profile = null, freight = null } = {}) {
  const c = normalizeCandidate(row);
  const checks = [];
  const vetoes = [];
  const unknown = [];
  const marginInfo = computeMargin(c, { fx, costFx, settleFx, channel, profile, freight });
  const margin = marginInfo ? marginInfo.netMargin : null;
  const smallVolume = c.monthlySales !== null && c.monthlySales > 0 && c.monthlySales <= smallVolumeUnits;

  const add = (item) => {
    checks.push(item);
    if (item.status === UNKNOWN) unknown.push(item.label);
    return item;
  };
  const veto = (code, label, detail) => vetoes.push({ code, label, detail });

  // 1) 市场容量与竞争热度 ------------------------------------------------
  if (c.top100Units === null) add(check('capacity', 1, '类目市场容量（Top100 月销）', UNKNOWN, '—'));
  else if (c.top100Units >= 100000 && c.top100Units <= 300000) add(check('capacity', 1, '类目市场容量（Top100 月销）', OK, String(Math.round(c.top100Units)), '落在 10 万–30 万理想带'));
  else if (c.top100Units < 10000) add(check('capacity', 1, '类目市场容量（Top100 月销）', BAD, String(Math.round(c.top100Units)), '需求过小（类目级）'));
  else add(check('capacity', 1, '类目市场容量（Top100 月销）', WARN, String(Math.round(c.top100Units)), '偏大或偏小，竞争/需求需再确认'));

  // —— 类目级指标：只判「这个类目值不值得进」，不逐品否决 ——
  // 品牌集中度 / 前十评价数 / 新品占比 / 市场容量 都是**类目**的属性，
  // 同一个类目里每个 ASIN 都一样。若按单品维度否决，会出现「整批候选被同一条理由全部淘汰」
  // （实测：集中度 88.7% → 38 个候选全被判「品牌集中度过高」淘汰）。
  // 正确做法：类目级风险在批次汇总里提示，淘汰与否由单品自身指标决定。
  const classRisks = [];
  if (c.brandConcentrationPct === null) add(check('concentration', 1, '类目品牌集中度', UNKNOWN, '—'));
  else if (c.brandConcentrationPct < 50) add(check('concentration', 1, '类目品牌集中度', OK, c.brandConcentrationPct.toFixed(0) + '%'));
  else if (c.brandConcentrationPct <= 70) add(check('concentration', 1, '类目品牌集中度', WARN, c.brandConcentrationPct.toFixed(0) + '%', '头部中等集中'));
  else {
    add(check('concentration', 1, '类目品牌集中度', BAD, c.brandConcentrationPct.toFixed(0) + '%', '大牌垄断（类目级风险）'));
    classRisks.push('类目品牌集中度 ' + c.brandConcentrationPct.toFixed(0) + '% > 70%，头部垄断：正面竞争不划算，需换人群/场景/价格带切入');
  }

  if (c.top10Reviews === null) add(check('reviewBarrier', 4, '类目前十评价数', UNKNOWN, '—'));
  else if (c.top10Reviews < 1000) add(check('reviewBarrier', 4, '类目前十评价数', OK, String(Math.round(c.top10Reviews))));
  else if (c.top10Reviews <= 10000) add(check('reviewBarrier', 4, '类目前十评价数', WARN, String(Math.round(c.top10Reviews)), '类目级评价壁垒'));
  else {
    add(check('reviewBarrier', 4, '类目前十评价数', BAD, String(Math.round(c.top10Reviews)), '评价壁垒过高（类目级风险）'));
    classRisks.push('类目前 10 名评价数 ' + Math.round(c.top10Reviews) + ' > 10000，评价壁垒高，新链接起量慢');
  }

  if (c.newProductPct === null) add(check('newShare', 5, '类目新品占比', UNKNOWN, '—'));
  else if (c.newProductPct >= 10 && c.newProductPct <= 25) add(check('newShare', 5, '类目新品占比', OK, c.newProductPct.toFixed(0) + '%', '10%–25%：仍有新卖家空间'));
  else if (c.newProductPct < 5) add(check('newShare', 5, '类目新品占比', BAD, c.newProductPct.toFixed(0) + '%', '阶层固化'));
  else add(check('newShare', 5, '类目新品占比', WARN, c.newProductPct.toFixed(0) + '%', '流动但拥挤/或偏冷'));

  // 2) 产品趋势 ----------------------------------------------------------
  if (!c.trend) add(check('trend', 2, '产品趋势', UNKNOWN, '—'));
  else if (/下降|衰退|下滑/.test(c.trend)) add(check('trend', 2, '产品趋势', WARN, c.trend, '趋势下行需谨慎'));
  else add(check('trend', 2, '产品趋势', OK, c.trend));

  if (c.abaRank === null) add(check('aba', 2, 'ABA 排名', UNKNOWN, '—'));
  else if (c.abaRank >= 100000 && c.abaRank <= 200000) add(check('aba', 2, 'ABA 排名', OK, String(Math.round(c.abaRank)), '落在 10–20 万'));
  else if (c.abaRank >= 50000 && c.abaRank <= 400000) add(check('aba', 2, 'ABA 排名', WARN, String(Math.round(c.abaRank)), '偏离 10–20 万'));
  else add(check('aba', 2, 'ABA 排名', BAD, String(Math.round(c.abaRank)), '过大或过小'));

  // 3) 价格区间 ----------------------------------------------------------
  if (c.priceUSD === null) add(check('priceBand', 3, '售价区间', UNKNOWN, '—'));
  else if (c.priceUSD >= 15 && c.priceUSD <= 45) add(check('priceBand', 3, '售价区间', OK, '$' + c.priceUSD.toFixed(2), '稳健价带'));
  else if (c.priceUSD < 10) add(check('priceBand', 3, '售价区间', BAD, '$' + c.priceUSD.toFixed(2), '利润被物流吃掉'));
  else add(check('priceBand', 3, '售价区间', WARN, '$' + c.priceUSD.toFixed(2), c.priceUSD > 80 ? '需品牌与售后' : '偏离 15–45 美元'));

  const purchaseRatio = marginInfo?.profit?.purchaseRatio ?? (c.priceUSD && c.purchaseCNY !== null ? (c.purchaseCNY / (costFx ?? fx)) / c.priceUSD : null);
  if (purchaseRatio === null) add(check('purchaseRatio', 3, '采购成本占售价', UNKNOWN, '—'));
  else if (purchaseRatio <= 0.25) add(check('purchaseRatio', 3, '采购成本占售价', OK, (purchaseRatio * 100).toFixed(0) + '%'));
  else if (purchaseRatio <= 0.35) add(check('purchaseRatio', 3, '采购成本占售价', WARN, (purchaseRatio * 100).toFixed(0) + '%'));
  else add(check('purchaseRatio', 3, '采购成本占售价', BAD, (purchaseRatio * 100).toFixed(0) + '%', '抗风险能力差'));

  // 4) 评分与评价 --------------------------------------------------------
  if (c.rating === null) add(check('rating', 4, '评分星级', UNKNOWN, '—'));
  else if (c.rating >= 4.3) add(check('rating', 4, '评分星级', OK, c.rating.toFixed(1)));
  else if (c.rating >= 4.0) add(check('rating', 4, '评分星级', WARN, c.rating.toFixed(1)));
  else add(check('rating', 4, '评分星级', WARN, c.rating.toFixed(1), '低评分 = 质量/体验差异化入口'));

  if (c.reviewPain) add(check('reviewPain', 7, '差评可解决性', OK, c.reviewPain, '已归纳出可解决差评点'));
  else add(check('reviewPain', 7, '差评可解决性', UNKNOWN, '—', '未抓取差评，需补'));

  // 6) 季节性 ------------------------------------------------------------
  if (!c.seasonality) add(check('seasonality', 6, '季节性', UNKNOWN, '—'));
  else if (/强|季节|节日/.test(c.seasonality)) add(check('seasonality', 6, '季节性', WARN, c.seasonality, '备货与现金流压力'));
  else add(check('seasonality', 6, '季节性', OK, c.seasonality));

  // 7) 质量、退货与变体 --------------------------------------------------
  if (c.returnPct === null) add(check('returns', 7, '退货率', UNKNOWN, '—'));
  else if (c.returnPct <= 0.05) add(check('returns', 7, '退货率', OK, (c.returnPct * 100).toFixed(0) + '%'));
  else if (c.returnPct <= 0.10) add(check('returns', 7, '退货率', WARN, (c.returnPct * 100).toFixed(0) + '%'));
  else {
    add(check('returns', 7, '退货率', BAD, (c.returnPct * 100).toFixed(0) + '%', '需重算利润'));
    if (!c.reviewPain) veto('RETURNS', '退货率过高', '退货率 ' + (c.returnPct * 100).toFixed(0) + '% > 10% 且未归纳出可解决差评点');
  }

  if (c.variants === null) add(check('variants', 7, '变体数', UNKNOWN, '—'));
  else if (c.variants > 3) {
    add(check('variants', 7, '变体数', BAD, String(c.variants), '新卖家不建议 > 3'));
    veto('VARIANTS', '变体过多', '变体数 ' + c.variants + ' > 3');
  } else add(check('variants', 7, '变体数', OK, String(c.variants)));

  // 8) 运输便利性 --------------------------------------------------------
  const logisticsRatio = marginInfo?.profit?.logisticsRatio ?? null;
  if (logisticsRatio === null) add(check('logistics', 8, '物流占售价', UNKNOWN, '—', '缺 FBA / 头程 / 售价'));
  else if (logisticsRatio >= 0.10 && logisticsRatio <= 0.15) add(check('logistics', 8, '物流占售价', OK, (logisticsRatio * 100).toFixed(0) + '%'));
  else if (logisticsRatio <= 0.20) add(check('logistics', 8, '物流占售价', WARN, (logisticsRatio * 100).toFixed(0) + '%'));
  else add(check('logistics', 8, '物流占售价', BAD, (logisticsRatio * 100).toFixed(0) + '%', '> 20% 建议放弃'));

  if (c.fragile && riskText(c.fragile)) {
    add(check('fragile', 8, '易碎 / 抛货', BAD, c.fragile, '头程与退货风险高'));
    veto('FRAGILE', '易碎 / 抛货', '标记为「' + c.fragile + '」');
  } else if (c.fragile) {
    add(check('fragile', 8, '易碎 / 抛货', OK, c.fragile));
  } else {
    add(check('fragile', 8, '易碎 / 抛货', UNKNOWN, '—', '未确认包装形态'));
  }
  if (c.weightG !== null && c.weightG > 2000) {
    add(check('oversize', 8, '大件抛货', BAD, Math.round(c.weightG) + 'g', '> 2kg 头程/FBA 费用高'));
    veto('OVERSIZE', '大件抛货', '单件 ' + Math.round(c.weightG) + 'g > 2000g');
  }

  // 9) 供应链 ------------------------------------------------------------
  if (c.supplierCount === null) add(check('supplyChain', 9, '供应商数量', UNKNOWN, '—', '需人工确认工厂资源'));
  else if (c.supplierCount >= 2) add(check('supplyChain', 9, '供应商数量', OK, String(c.supplierCount)));
  else add(check('supplyChain', 9, '供应商数量', WARN, String(c.supplierCount), '单一供应风险'));

  // 10) 侵权 / 认证 ------------------------------------------------------
  if (!c.patentRisk) add(check('patent', 10, '专利/商标风险', UNKNOWN, '—', '必须人工查 WIPO / 商标'));
  else if (isPendingValue(c.patentRisk)) add(check('patent', 10, '专利/商标风险', UNKNOWN, c.patentRisk, '尚未完成检索，不能按「无风险」计'));
  else if (riskText(c.patentRisk)) {
    add(check('patent', 10, '专利/商标风险', BAD, c.patentRisk));
    veto('PATENT', '专利 / 商标风险', c.patentRisk);
  } else add(check('patent', 10, '专利/商标风险', OK, c.patentRisk));

  if (!c.certification) add(check('certification', 10, '认证要求', UNKNOWN, '—'));
  else if (isPendingValue(c.certification)) add(check('certification', 10, '认证要求', UNKNOWN, c.certification, '未确认证书状态'));
  else if (/缺|未|无|不适用|不需要|无需/.test(c.certification) || /^(无|none)$/i.test(c.certification)) {
    add(check('certification', 10, '认证要求', OK, c.certification));
  } else add(check('certification', 10, '认证要求', WARN, c.certification, '需确认证书是否拿得到'));

  // 11) 利润 -------------------------------------------------------------
  if (margin === null) add(check('netMargin', 11, '净利率', UNKNOWN, '—'));
  else if (margin > 0.30) add(check('netMargin', 11, '净利率', OK, (margin * 100).toFixed(1) + '%', marginInfo.source));
  else if (margin > 0.25) add(check('netMargin', 11, '净利率', WARN, (margin * 100).toFixed(1) + '%', smallVolume ? '小体量需 > 30%' : '过主红线 25%，未到 30%'));
  else if (margin >= 0.15) add(check('netMargin', 11, '净利率', WARN, (margin * 100).toFixed(1) + '%', '15%–25%：只能靠体量'));
  else {
    add(check('netMargin', 11, '净利率', BAD, (margin * 100).toFixed(1) + '%', '< 15%'));
    veto('MARGIN', '净利率过低', '净利率 ' + (margin * 100).toFixed(1) + '% < 15%');
  }

  if (c.adPct === null) add(check('adRatio', 11, '广告占售价', UNKNOWN, '—'));
  else if (c.adPct >= 0.08 && c.adPct <= 0.12) add(check('adRatio', 11, '广告占售价', OK, (c.adPct * 100).toFixed(0) + '%'));
  else if (c.adPct <= 0.15) add(check('adRatio', 11, '广告占售价', WARN, (c.adPct * 100).toFixed(0) + '%'));
  else add(check('adRatio', 11, '广告占售价', BAD, (c.adPct * 100).toFixed(0) + '%', '> 15% 危险'));

  // 类目层级（一票否决：大类目不做）
  const depth = levelOf(c.categoryPath);
  if (depth === 0) add(check('categoryDepth', 1, '类目层级', UNKNOWN, '—', '未提供类目路径'));
  else if (depth >= 3) add(check('categoryDepth', 1, '类目层级', OK, depth + ' 级', c.categoryPath));
  else {
    add(check('categoryDepth', 1, '类目层级', BAD, depth + ' 级', '必须下钻到三、四级'));
    veto('CATEGORY_DEPTH', '大类目不做', '只到 ' + depth + ' 级类目，必须下钻到三、四级细分类目');
  }

  const judged = checks.filter((item) => item.status !== UNKNOWN);
  const okCount = judged.filter((item) => item.status === OK).length;
  const hitRate = judged.length > 0 ? okCount / judged.length : 0;

  let tier;
  let tierReason;
  if (vetoes.length > 0) {
    tier = '淘汰';
    tierReason = '命中一票否决：' + vetoes.map((v) => v.label).join('、');
  } else if (margin === null || judged.length < MIN_JUDGED) {
    tier = '待复核';
    tierReason = margin === null ? '缺净利率，无法给档位' : '可判定 KPI 仅 ' + judged.length + ' 项（< ' + MIN_JUDGED + '），不给档位';
  } else if (hitRate >= 0.8 && margin > 0.30) {
    tier = '一档';
    tierReason = '命中率 ' + Math.round(hitRate * 100) + '%，净利率 ' + (margin * 100).toFixed(1) + '%';
  } else if (hitRate >= 0.6 && margin >= 0.25 && !(smallVolume && margin <= 0.30)) {
    tier = '二档';
    tierReason = '命中率 ' + Math.round(hitRate * 100) + '%，净利率 ' + (margin * 100).toFixed(1) + '%';
  } else {
    tier = '三档';
    tierReason = smallVolume && margin !== null && margin > 0.25 && margin <= 0.30
      ? '小体量（≤' + smallVolumeUnits + ' 单）净利率需 > 30%，当前 ' + (margin * 100).toFixed(1) + '%'
      : '命中率 ' + Math.round(hitRate * 100) + '%，净利率 ' + (margin === null ? '未知' : (margin * 100).toFixed(1) + '%');
  }

  const evidenceChain = buildEvidenceChain({ candidate: { checks, vetoes, classRisks, fieldEvidence: c.fieldEvidence, pageContract: c.pageContract } });
  return {
    asin: c.asin,
    name: c.name,
    url: c.url,
    brand: c.brand,
    categoryPath: c.categoryPath,
    priceUSD: c.priceUSD,
    rating: c.rating,
    reviews: c.reviews,
    monthlySales: c.monthlySales,
    smallVolume,
    margin,
    marginSource: marginInfo ? marginInfo.source : null,
    profit: marginInfo ? marginInfo.profit : null,
    checks,
    judgedCount: judged.length,
    hitRate,
    vetoes: evidenceChain.vetoes,
    classRisks,
    evidenceChain,
    dataConfidence: assessDataConfidence({ checks, margin, priceUSD: c.priceUSD, provenance: { offerUrl: c.offerUrl } }),
    unknown,
    tier,
    tierReason,
    provenance: {
      source: c.sourceLabel,
      collectedAt: c.collectedAt,
      listingUrl: c.url,
      offerUrl: c.offerUrl,
      categoryPath: c.categoryPath,
      pageContract: c.pageContract,
      fieldEvidence: c.fieldEvidence,
    },
    inputs: {
      priceUSD: c.priceUSD,
      // 可售单位采购成本（已按包装对齐折算）+ 折算依据，报告里要能核
      purchaseCNY: marginInfo && marginInfo.profit ? marginInfo.profit.purchaseCNY : c.purchaseCNY,
      unitPriceCNY: c.unitPriceCNY,
      packUnits: c.packUnits,
      packAligned: Boolean(c.unitPriceCNY !== null && c.packUnits),
      weightG: c.weightG,
      fbaFeeUSD: c.fbaFeeUSD,
      adPct: c.adPct,
      returnPct: c.returnPct,
      commissionPct: c.commissionPct,
      firstMileUSD: c.firstMileUSD,
      otherUSD: c.otherUSD,
      brandConcentrationPct: c.brandConcentrationPct,
      top10Reviews: c.top10Reviews,
      newProductPct: c.newProductPct,
      top100Units: c.top100Units,
      abaRank: c.abaRank,
    },
    flags: {
      hasPain: Boolean(c.reviewPain),
      seasonality: c.seasonality,
      trend: c.trend,
      newProductPct: c.newProductPct,
      brandConcentrationPct: c.brandConcentrationPct,
      logisticsRatio,
    },
  };
}

/** 批量体检：排序（档位优先、净利率次之）+ 汇总（分档、共性短板、待复核项）。 */
export function evaluateBatch(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const results = list.map((row) => evaluateCandidate(row, opts));
  const channelId = opts.channel || 'amazon-fba';
  const order = { '一档': 0, '二档': 1, '三档': 2, '待复核': 3, '淘汰': 4 };
  results.sort((a, b) => {
    const diff = (order[a.tier] ?? 9) - (order[b.tier] ?? 9);
    if (diff !== 0) return diff;
    return (b.margin ?? -1) - (a.margin ?? -1);
  });
  const tiers = Object.fromEntries(TIERS.map((tier) => [tier, results.filter((item) => item.tier === tier).length]));
  const margins = results.map((item) => item.margin).filter((value) => typeof value === 'number');
  const gaps = new Map();
  for (const item of results) {
    for (const checkItem of item.checks) {
      if (checkItem.status !== BAD && checkItem.status !== WARN) continue;
      const hit = gaps.get(checkItem.label) || { label: checkItem.label, dimension: checkItem.dimensionLabel, fail: 0, warn: 0 };
      if (checkItem.status === BAD) hit.fail += 1;
      else hit.warn += 1;
      gaps.set(checkItem.label, hit);
    }
  }
  return {
    total: results.length,
    results,
    summary: {
      channel: channelId,
      tiers,
      avgMargin: margins.length ? margins.reduce((sum, value) => sum + value, 0) / margins.length : null,
      commonGaps: [...gaps.values()].sort((a, b) => (b.fail * 2 + b.warn) - (a.fail * 2 + a.warn)).slice(0, 8),
      vetoed: results.filter((item) => item.vetoes.length > 0).length,
      classRisks: [...new Set(results.flatMap((item) => item.classRisks || []))],
      needsReview: results.filter((item) => item.tier === '待复核').map((item) => ({ asin: item.asin, name: item.name, missing: item.unknown })),
    },
  };
}
