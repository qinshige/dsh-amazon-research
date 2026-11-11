/**
 * dsh-amazon-research · host/sourcing/cost-model.js
 * 全成本落地测算 + 净利率口径的利润判定（纯函数 / ESM / 无网络 / 无第三方依赖）。
 *
 * 口径来源（工作区既有方法论）：
 *   - research/supply/supply_成本与变体.md §2：
 *       毛利额 = 售价 − 采购成本 − 头程物流 − 平台佣金(15%) − FBA 配送费 − 广告(10%) − 退货损耗(5%)
 *       净利率 = 毛利额 ÷ 售价
 *       红线：净利率 > 25%（小体量品 > 30%）；物流占售价 10%–15%（> 20% 建议放弃）；采购占售价 ≤ 25%
 *   - 知识库《亚马逊选品实操指南》：
 *       「去掉采购、头程、配送费、佣金、10% 广告成本、5% 退货成本；建议利润率超过 25% 以上的才考虑」
 *       「利润低的产品能够去做体量也可以接受（15%-20% 利润率），体量较小（100-200 单）利润率要高于 30%」
 *       「15-20 美金的售价，采购价要控制在 30 人民币以下，配送费在 4.5 美金以下」
 *       「1688 的图片千万不要用」→ 报告层给图片/外观专利提醒
 *
 * 两个口径必须分清（评分与报告都会写明）：
 *   - 毛利率 grossMargin：只扣采购 + 头程 + FBA（上游五维「毛利率档位」口径）
 *   - 净利率 netMargin：扣完佣金 + 广告 + 退货 + 其它（**本模块口径**，更严格、更接近真实到手）
 *   两者**不可直接比较**，分数变化不代表同一口径下变高。
 *
 * 数据纪律：所有估算参数在 notes 里标注「估算值」，页面实测值标注「实测值」。
 */

const OZ_TO_G = 28.349523125;

/** 净利率红线（主红线）：> 25% 才考虑。 */
export const NET_MARGIN_REDLINE = 0.25;
/** 小体量品净利率红线：> 30%（KB：体量较小 100–200 单的产品利润率要高于 30%）。 */
export const SMALL_VOLUME_NET_MARGIN_REDLINE = 0.3;
/** 利润低但可跑体量的下限（KB：15%–20% 利润率也可接受）。 */
export const VOLUME_ACCEPTABLE_NET_MARGIN = 0.15;
/** 物流（头程 + FBA）占售价的理想带。 */
export const LOGISTICS_RATIO_MIN = 0.1;
export const LOGISTICS_RATIO_MAX = 0.15;
/** 物流占售价超过该值 → 提示放弃。 */
export const LOGISTICS_RATIO_ABORT = 0.2;
/** 采购成本占售价上限（KB 低价段约束）。 */
export const PURCHASE_RATIO_MAX = 0.25;
/** KB 硬约束：$15–20 售价段 → 采购价 ≤ ¥30 且 FBA 配送费 < $4.5。 */
export const LOW_PRICE_BAND = Object.freeze({
  minUSD: 15,
  maxUSD: 20,
  maxPurchaseCNY: 30,
  maxFbaFeeUSD: 4.5,
});

/** 默认参数（全部为经验/估算值，按实际替换）。 */
export const DEFAULT_COST_PARAMS = Object.freeze({
  fx: 7.1,
  firstMilePerKgCNY: 35,
  referralRate: 0.15,
  adRate: 0.1,
  returnRate: 0.05,
  otherUSD: 0.35,
});

/** FBA 配送费档位（**估算值**：按美国站小号标准件费率，重量取自 1688 详情页件重）。 */
export const FBA_FEE_TIERS = Object.freeze([
  Object.freeze({ key: 'small_4oz', label: '小号标准件 ≤4oz', maxOz: 4, feeUSD: 3.22 }),
  Object.freeze({ key: 'small_8oz', label: '小号标准件 4–8oz', maxOz: 8, feeUSD: 3.4 }),
  Object.freeze({ key: 'small_12oz', label: '小号标准件 8–12oz', maxOz: 12, feeUSD: 3.55 }),
  Object.freeze({ key: 'small_16oz', label: '小号标准件 12–16oz', maxOz: 16, feeUSD: 3.77 }),
  Object.freeze({ key: 'large_standard', label: '大号标准件 >16oz', maxOz: Infinity, feeUSD: 5.3 }),
]);

/** 把任意值安全转成有限数字。 */
function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/,/g, '').replace(/%$/, '');
    if (cleaned === '') return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 四舍五入到指定小数位。 */
function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** 把 0~1 比例转成 0~1；非法返回 null。 */
function asRatio(value) {
  const parsed = num(value);
  if (parsed === null || parsed < 0) return null;
  if (parsed > 1) return parsed <= 100 ? parsed / 100 : null;
  return parsed;
}

/**
 * 把可能是**负数**的比例解析成 -1~1（或 -100~100 写法）。
 *
 * 为什么需要它：净利率可以是负（售价低于全成本）。若沿用 asRatio，
 * 负净利率会被当成「非法值 → null」→ 既被判定成「数据缺失」，
 * 又会被 aggregateNetMargin 当成「未算出净利率」排除出加权，
 * 导致加权净利率被系统性高估（实测：真实 -9% 被算成 +43%）。
 */
function asSignedRatio(value) {
  const parsed = num(value);
  if (parsed === null) return null;
  if (parsed < -1) return parsed >= -100 ? parsed / 100 : null;
  if (parsed > 1) return parsed <= 100 ? parsed / 100 : null;
  return parsed;
}

/** 百分比展示。 */
function pct(ratio, digits = 2) {
  return (ratio * 100).toFixed(digits) + '%';
}

/** 金额展示（USD）。 */
function usd(value, digits = 2) {
  const parsed = num(value);
  if (parsed === null) return '未取到';
  return '$' + parsed.toFixed(digits);
}

/**
 * 按重量估算 FBA 配送费（**估算值**）。
 * 档位来源：research/supply/supply_成本与变体.md §2.3（小号标准 ≤4oz $3.22 / 4–8oz $3.40 /
 * 8–12oz $3.55 / 12–16oz $3.77；>16oz 按大号标准 $5.30 估，区间 $5.10–$5.50）。
 * @param {number|null} weightG 件重（克）
 * @returns {{feeUSD:number, tier:string, label:string, oz:number|null, weightG:number|null, estimated:boolean, reason:string|null}}
 */
export function estimateFbaFee(weightG) {
  const grams = num(weightG);
  if (grams === null || !(grams > 0)) {
    const tier = FBA_FEE_TIERS[0];
    return {
      feeUSD: tier.feeUSD,
      tier: tier.key,
      label: tier.label,
      oz: null,
      weightG: null,
      estimated: true,
      reason: '未取到件重，按小号标准件最低档 $3.22 估算（重量越大实际配送费越高）',
    };
  }
  const oz = grams / OZ_TO_G;
  const tier = FBA_FEE_TIERS.find((item) => oz <= item.maxOz) ?? FBA_FEE_TIERS[FBA_FEE_TIERS.length - 1];
  return {
    feeUSD: tier.feeUSD,
    tier: tier.key,
    label: tier.label,
    oz: round(oz, 2),
    weightG: grams,
    estimated: true,
    reason: null,
  };
}

/**
 * 单件全成本拆解（纯函数）。
 *
 * @param {object} params
 * @param {number} params.priceCNY 1688 采购价（阶梯价已选定，CNY/件）
 * @param {number|null} [params.weightG] 件重（克），用于头程与 FBA 档位
 * @param {number} [params.fx=7.1] 汇率 CNY/USD
 * @param {number} [params.firstMilePerKgCNY=35] 头程 ¥/kg（含海运 + 贴标摊销）
 * @param {number} [params.referralRate=0.15] 平台佣金
 * @param {number|null} [params.fbaFeeUSD=null] 给定则用（实测值），否则按重量档估算
 * @param {number} [params.adRate=0.10] 广告
 * @param {number} [params.returnRate=0.05] 退货损耗
 * @param {number} [params.otherUSD=0.35] 仓储/其它
 * @param {number} params.priceUSD 售价（Amazon 侧，USD）
 * @param {object} [params.sources] 每个参数的来源标注（'实测值' / '估算值'）
 * @param {string[]} [params.notes] 额外备注
 * @returns {object|null} 测算结果；售价或采购价不可用时返回 null
 */
export function landedCost(params = {}) {
  const source = params && typeof params === 'object' ? params : {};
  const purchaseCNY = num(source.priceCNY);
  const sellingUSD = num(source.priceUSD);
  if (purchaseCNY === null || purchaseCNY < 0 || sellingUSD === null || !(sellingUSD > 0)) return null;

  const def = DEFAULT_COST_PARAMS;
  const fx = positiveOr(source.fx, def.fx);
  const firstMilePerKgCNY = positiveOr(source.firstMilePerKgCNY, def.firstMilePerKgCNY);
  const referralRate = rateOr(source.referralRate, def.referralRate);
  const adRate = rateOr(source.adRate, def.adRate);
  const returnRate = rateOr(source.returnRate, def.returnRate);
  const otherUSD = nonNegativeOr(source.otherUSD, def.otherUSD);

  const weightGrams = num(source.weightG);
  const hasWeight = weightGrams !== null && weightGrams > 0;

  const givenFba = num(source.fbaFeeUSD);
  const useGivenFba = givenFba !== null && givenFba >= 0;
  const fba = useGivenFba
    ? { feeUSD: givenFba, label: '按给定值', estimated: false, reason: null, oz: null, weightG: hasWeight ? weightGrams : null }
    : estimateFbaFee(hasWeight ? weightGrams : null);

  const purchaseUSD = purchaseCNY / fx;
  // 件重未知时，头程**不能按 0 计**——那会系统性高估净利率（实测：浴巾挂钩重量未取到，
  // 头程按 0 算会让净利率从 -84% 虚高到 +31%）。这里按保守假设 500g（中号标准件档）计，
  // 并在 notes 里标注「件重未取到，头程按 500g 保守假设」。
  const assumedWeightG = hasWeight ? weightGrams : (num(source.assumedWeightG) ?? 500);
  const firstMileUSD = (assumedWeightG / 1000) * firstMilePerKgCNY / fx;
  const referralUSD = sellingUSD * referralRate;
  const adUSD = sellingUSD * adRate;
  const returnUSD = sellingUSD * returnRate;
  const totalCostUSD = purchaseUSD + firstMileUSD + referralUSD + fba.feeUSD + adUSD + returnUSD + otherUSD;
  const netProfitUSD = sellingUSD - totalCostUSD;
  // 毛利率：只扣货与物流（上游五维口径）；净利率：扣完全部科目（本模块口径）
  const grossProfitUSD = sellingUSD - purchaseUSD - firstMileUSD - fba.feeUSD;
  const grossMargin = grossProfitUSD / sellingUSD;
  const netMargin = netProfitUSD / sellingUSD;
  const logisticsUSD = firstMileUSD + fba.feeUSD;
  const logisticsRatio = logisticsUSD / sellingUSD;
  const purchaseRatio = purchaseUSD / sellingUSD;

  const src = (source.sources && typeof source.sources === 'object') ? source.sources : {};
  const notes = [];
  const push = (text) => {
    if (typeof text === 'string' && text !== '' && !notes.includes(text)) notes.push(text);
  };

  push(`采购价 ¥${purchaseCNY.toFixed(2)}（${src.purchase ?? '实测值'}，1688 阶梯价已选定）`);
  push(hasWeight
    ? `件重 ${round(weightGrams, 1)} g（${src.weight ?? '实测值'}，1688 详情页商品件重尺）`
    : `件重未取到：头程按 ${round(assumedWeightG, 0)}g 保守假设计（${src.weight ?? '未取到'}），FBA 按小号标准件最低档估算；本行净利率置信度低`);
  push(`汇率 ${fx} CNY/USD（${src.fx ?? '估算值'}，按当期汇率替换）`);
  push(`头程 ¥${firstMilePerKgCNY}/kg（${src.firstMile ?? '估算值'}，含海运 + 贴标 + 操作摊销）`);
  push(`平台佣金 ${pct(referralRate)}（${src.referral ?? '估算值'}，经验默认值：家居 15% / 服饰 17% / 美妆 8% / 电子 8%）`);
  push(`FBA 配送费 ${usd(fba.feeUSD)}（${src.fba ?? (useGivenFba ? '实测值' : '估算值')}，${fba.label}${fba.reason ? '；' + fba.reason : ''}）`);
  push(`广告 ${pct(adRate)}（${src.ad ?? '估算值'}，经验默认值：新卖家按 12%–15% 更稳）`);
  push(`退货损耗 ${pct(returnRate)}（${src.return ?? '估算值'}，质量差/易碎调到 8%–10%）`);
  push(`仓储/其它 ${usd(otherUSD)}（${src.other ?? '估算值'}，经验默认值 $0.30–$0.50）`);
  push('口径：净利率 = （售价 − 采购 − 头程 − FBA − 佣金 − 广告 − 退货 − 其它）÷ 售价（扣完全部科目）');
  if (Array.isArray(source.notes)) {
    for (const note of source.notes) push(note);
  }

  return {
    priceUSD: round(sellingUSD, 2),
    priceCNY: round(purchaseCNY, 2),
    purchaseUSD: round(purchaseUSD, 4),
    firstMileUSD: round(firstMileUSD, 4),
    referralUSD: round(referralUSD, 4),
    fbaFeeUSD: round(fba.feeUSD, 4),
    adUSD: round(adUSD, 4),
    returnUSD: round(returnUSD, 4),
    otherUSD: round(otherUSD, 4),
    totalCostUSD: round(totalCostUSD, 4),
    grossProfitUSD: round(netProfitUSD, 4),
    netProfitUSD: round(netProfitUSD, 4),
    grossMargin: round(grossMargin, 4),
    netMargin: round(netMargin, 4),
    logisticsUSD: round(logisticsUSD, 4),
    logisticsRatio: round(logisticsRatio, 4),
    purchaseRatio: round(purchaseRatio, 4),
    fbaEstimated: fba.estimated,
    fbaTier: fba.tier,
    fbaLabel: fba.label,
    weightG: hasWeight ? round(weightGrams, 1) : null,
    assumedWeightG: hasWeight ? null : round(assumedWeightG, 0),
    weightMissing: !hasWeight,
    params: {
      fx,
      firstMilePerKgCNY,
      referralRate,
      adRate,
      returnRate,
      otherUSD,
    },
    sources: {
      purchase: src.purchase ?? '实测值',
      weight: src.weight ?? '实测值',
      fx: src.fx ?? '估算值',
      firstMile: src.firstMile ?? '估算值',
      referral: src.referral ?? '估算值',
      fba: src.fba ?? (useGivenFba ? '实测值' : '估算值'),
      ad: src.ad ?? '估算值',
      return: src.return ?? '估算值',
      other: src.other ?? '估算值',
    },
    notes,
  };
}

/** 取正数；非法回退默认值。 */
function positiveOr(value, fallback) {
  const parsed = num(value);
  return parsed !== null && parsed > 0 ? parsed : fallback;
}

/** 取 0~1 的比例；非法回退默认值。 */
function rateOr(value, fallback) {
  const parsed = num(value);
  if (parsed === null || parsed < 0) return fallback;
  if (parsed > 1) return parsed <= 100 ? parsed / 100 : fallback;
  return parsed;
}

/** 取非负数；非法回退默认值。 */
function nonNegativeOr(value, fallback) {
  const parsed = num(value);
  return parsed !== null && parsed >= 0 ? parsed : fallback;
}

/**
 * 利润判定（红线四查）。口径与《亚马逊选品实操指南》一致：
 *   ① 净利率：> 25% 才考虑；体量小（100–200 单）需 > 30%；15%–20% 可跑体量
 *   ② 物流（头程 + FBA）占售价：目标 10%–15%，> 20% 提示放弃
 *   ③ 采购价占售价：≤ 25%
 *   ④ $15–20 售价段硬约束：采购价 ≤ ¥30 且 FBA < $4.5
 *
 * @param {object} input
 * @returns {object} { verdict, status, checks[], reasons[], thresholds }
 */
export function judgeProfit(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const margin = asSignedRatio(src.netMargin);
  const logistics = asRatio(src.logisticsRatio);
  const purchase = asRatio(src.purchaseRatio);
  const priceUSD = num(src.priceUSD);
  const purchaseCNY = num(src.purchaseCNY);
  const fbaFeeUSD = num(src.fbaFeeUSD);
  const smallVolume = src.smallVolume === true || (num(src.volumeUnits) !== null && num(src.volumeUnits) <= 200);

  const checks = [];
  const reasons = [];

  // ① 净利率判定
  if (margin === null) {
    checks.push({
      key: 'net_margin',
      name: '净利率判定',
      rule: '净利率 > 25%（体量小需 > 30%）',
      value: '未取到',
      status: '数据缺失',
      note: '缺净利率，无法判定红线',
    });
  } else {
    let status;
    let note;
    if (margin > SMALL_VOLUME_NET_MARGIN_REDLINE) {
      status = '通过';
      note = '同时满足主红线 25% 与体量红线 30%';
    } else if (margin > NET_MARGIN_REDLINE) {
      status = smallVolume ? '未达小体量红线' : '通过';
      note = smallVolume ? '过主红线 25%，未达体量小所需的 30%' : '过主红线 25%';
    } else if (margin >= VOLUME_ACCEPTABLE_NET_MARGIN) {
      status = '可以做体量';
      note = '15%–25% 区间：利润低但可跑体量（KB：15%–20% 利润率也可接受）';
    } else {
      status = '未达标';
      note = '低于 25% 主红线';
    }
    checks.push({
      key: 'net_margin',
      name: '净利率判定',
      rule: smallVolume
        ? '净利率 > 25%（体量小需 > 30%）'
        : '净利率 > 25%（体量小需 > 30%）',
      value: pct(margin),
      status,
      note,
      threshold: smallVolume ? SMALL_VOLUME_NET_MARGIN_REDLINE : NET_MARGIN_REDLINE,
    });
  }

  // ② 物流占售价比
  if (logistics === null) {
    checks.push({
      key: 'logistics',
      name: '物流占售价比',
      rule: '目标 10%–15%，> 20% 提示放弃',
      value: '未取到',
      status: '数据缺失',
      note: '缺头程或 FBA 费，无法判定',
    });
  } else if (logistics > LOGISTICS_RATIO_ABORT) {
    checks.push({
      key: 'logistics',
      name: '物流占售价比',
      rule: '目标 10%–15%，> 20% 提示放弃',
      value: pct(logistics),
      status: '提示放弃',
      note: '物流（头程 + FBA）占售价超过 20%，建议放弃',
      threshold: LOGISTICS_RATIO_ABORT,
    });
  } else if (logistics > LOGISTICS_RATIO_MAX) {
    checks.push({
      key: 'logistics',
      name: '物流占售价比',
      rule: '目标 10%–15%，> 20% 提示放弃',
      value: pct(logistics),
      status: '偏离理想带',
      note: '超出 10%–15% 理想带但未超 20%',
    });
  } else if (logistics < LOGISTICS_RATIO_MIN) {
    checks.push({
      key: 'logistics',
      name: '物流占售价比',
      rule: '目标 10%–15%，> 20% 提示放弃',
      value: pct(logistics),
      status: '通过',
      note: '低于 10% 理想带下限（多为件重很轻或售价偏高）',
    });
  } else {
    checks.push({
      key: 'logistics',
      name: '物流占售价比',
      rule: '目标 10%–15%，> 20% 提示放弃',
      value: pct(logistics),
      status: '通过',
      note: '落在 10%–15% 理想带',
    });
  }

  // ③ 采购价占售价比
  if (purchase === null) {
    checks.push({
      key: 'purchase',
      name: '采购价占售价比',
      rule: '≤ 25%',
      value: '未取到',
      status: '数据缺失',
      note: '缺采购价，无法判定',
    });
  } else if (purchase <= PURCHASE_RATIO_MAX) {
    checks.push({
      key: 'purchase',
      name: '采购价占售价比',
      rule: '≤ 25%',
      value: pct(purchase),
      status: '通过',
      note: '采购成本占比可控',
    });
  } else {
    checks.push({
      key: 'purchase',
      name: '采购价占售价比',
      rule: '≤ 25%',
      value: pct(purchase),
      status: '未达标',
      note: '采购成本占售价超过 25%',
      threshold: PURCHASE_RATIO_MAX,
    });
  }

  // ④ $15–20 售价段硬约束
  const inBand = priceUSD !== null && priceUSD >= LOW_PRICE_BAND.minUSD && priceUSD <= LOW_PRICE_BAND.maxUSD;
  if (!inBand) {
    checks.push({
      key: 'low_price_band',
      name: '$15–20 售价硬约束',
      rule: `采购价 ≤ ¥${LOW_PRICE_BAND.maxPurchaseCNY} 且 FBA < $${LOW_PRICE_BAND.maxFbaFeeUSD}`,
      value: priceUSD === null ? '未取到' : usd(priceUSD),
      status: '不适用',
      note: priceUSD === null ? '缺售价，无法判定适用性' : '售价不在 $15–20 区间，该约束不适用',
    });
  } else {
    const purchaseOk = purchaseCNY === null ? null : purchaseCNY <= LOW_PRICE_BAND.maxPurchaseCNY;
    const fbaOk = fbaFeeUSD === null ? null : fbaFeeUSD < LOW_PRICE_BAND.maxFbaFeeUSD;
    if (purchaseOk === null || fbaOk === null) {
      checks.push({
        key: 'low_price_band',
        name: '$15–20 售价硬约束',
        rule: `采购价 ≤ ¥${LOW_PRICE_BAND.maxPurchaseCNY} 且 FBA < $${LOW_PRICE_BAND.maxFbaFeeUSD}`,
        value: usd(priceUSD),
        status: '数据缺失',
        note: '缺采购价或 FBA 费，无法完整判定',
      });
    } else if (purchaseOk && fbaOk) {
      checks.push({
        key: 'low_price_band',
        name: '$15–20 售价硬约束',
        rule: `采购价 ≤ ¥${LOW_PRICE_BAND.maxPurchaseCNY} 且 FBA < $${LOW_PRICE_BAND.maxFbaFeeUSD}`,
        value: usd(priceUSD),
        status: '通过',
        note: `采购价 ¥${purchaseCNY.toFixed(2)}、FBA ${usd(fbaFeeUSD)} 均在约束内`,
      });
    } else {
      checks.push({
        key: 'low_price_band',
        name: '$15–20 售价硬约束',
        rule: `采购价 ≤ ¥${LOW_PRICE_BAND.maxPurchaseCNY} 且 FBA < $${LOW_PRICE_BAND.maxFbaFeeUSD}`,
        value: usd(priceUSD),
        status: '未达标',
        note: [
          purchaseOk === false ? `采购价 ¥${purchaseCNY.toFixed(2)} 超 ¥${LOW_PRICE_BAND.maxPurchaseCNY}` : null,
          fbaOk === false ? `FBA ${usd(fbaFeeUSD)} 不低于 $${LOW_PRICE_BAND.maxFbaFeeUSD}` : null,
        ].filter(Boolean).join('；'),
      });
    }
  }

  for (const check of checks) {
    if (check.status === '提示放弃') reasons.push(check.name + '：' + check.note);
    else if (check.status === '未达标' || check.status === '未达小体量红线') reasons.push(check.name + '：' + check.note);
  }

  const marginCheck = checks[0];
  let verdict = '通过';
  let status = 'pass';
  if (checks.some((check) => check.status === '提示放弃')) {
    verdict = '提示放弃';
    status = 'fail';
  } else if (marginCheck.status === '未达标') {
    verdict = '未达标';
    status = 'fail';
  } else if (marginCheck.status === '未达小体量红线') {
    verdict = '未达小体量红线';
    status = 'warn';
  } else if (marginCheck.status === '可以做体量') {
    verdict = '可以做体量';
    status = 'warn';
  } else if (marginCheck.status === '数据缺失') {
    verdict = '数据缺失';
    status = 'unknown';
  } else if (checks.some((check) => check.status === '未达标')) {
    verdict = '有条件通过';
    status = 'warn';
  }

  return {
    verdict,
    status,
    checks,
    reasons,
    thresholds: {
      netMargin: NET_MARGIN_REDLINE,
      smallVolumeNetMargin: SMALL_VOLUME_NET_MARGIN_REDLINE,
      volumeAcceptableNetMargin: VOLUME_ACCEPTABLE_NET_MARGIN,
      logisticsRatioMin: LOGISTICS_RATIO_MIN,
      logisticsRatioMax: LOGISTICS_RATIO_MAX,
      logisticsRatioAbort: LOGISTICS_RATIO_ABORT,
      purchaseRatioMax: PURCHASE_RATIO_MAX,
      lowPriceBand: LOW_PRICE_BAND,
    },
    smallVolume,
  };
}


/**
 * 按目标净利率倒推「采购价上限」（元/件）。
 *
 * 公式（照抄 research/supply/supply_成本与变体.md §2.2 反推式）：
 *   采购$ + 头程$ + FBA$ = 售价 × (1 − 佣金 − 广告 − 退货 − 目标净利率) − 其它$
 * 用法：1688 真实采购价还没拿到时，先看「这个细分最多能花多少钱采购」。
 *
 * @param {object} input
 * @returns {{maxPurchaseUSD:number, maxPurchaseCNY:number, firstMileUSD:number, fbaFeeUSD:number, targetNetMargin:number}|null} 售价撑不起目标净利率时返回 null
 */
export function maxPurchaseCNYForNetMargin(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const price = num(src.priceUSD);
  if (price === null || !(price > 0)) return null;
  const def = DEFAULT_COST_PARAMS;
  const fx = positiveOr(src.fx, def.fx);
  const firstMilePerKgCNY = positiveOr(src.firstMilePerKgCNY, def.firstMilePerKgCNY);
  const referralRate = rateOr(src.referralRate, def.referralRate);
  const adRate = rateOr(src.adRate, def.adRate);
  const returnRate = rateOr(src.returnRate, def.returnRate);
  const otherUSD = nonNegativeOr(src.otherUSD, def.otherUSD);
  const target = asRatio(src.targetNetMargin ?? NET_MARGIN_REDLINE);
  if (target === null) return null;
  const givenFee = num(src.fbaFeeUSD);
  const fbaFeeUSD = givenFee !== null && givenFee >= 0 ? givenFee : estimateFbaFee(src.weightG).feeUSD;
  const grams = num(src.weightG);
  const firstMileUSD = grams !== null && grams > 0 ? (grams / 1000) * firstMilePerKgCNY / fx : 0;
  const headroom = price * (1 - referralRate - adRate - returnRate - target) - firstMileUSD - fbaFeeUSD - otherUSD;
  if (!(headroom > 0)) return null;
  return {
    maxPurchaseUSD: round(headroom, 4),
    maxPurchaseCNY: round(headroom * fx, 2),
    firstMileUSD: round(firstMileUSD, 4),
    fbaFeeUSD: round(fbaFeeUSD, 4),
    targetNetMargin: target,
  };
}
/**
 * 子市场净利率汇总（加权）：优先按月总销量加权，其次按售价加权，最后取算术平均。
 * 用于把「多个细分市场的净利率」折成类目层面的代表净利率。
 *
 * @param {Array<object>} rows 每条至少含 netMargin（0~1）；可选 units / priceUSD / name
 * @param {{totalUnits?:number|null}} [options] totalUnits 用于算覆盖度
 * @returns {{netMargin:number|null, basis:string, count:number, missingCount:number, min:number|null, max:number|null, coveredUnits:number, totalUnits:number|null, coverageRatio:number|null, notes:string[]}}
 */
export function aggregateNetMargin(rows, options = {}) {
  const list = Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : [];
  const valid = [];
  let missingCount = 0;
  for (const row of list) {
    const margin = asSignedRatio(row.netMargin);
    if (margin === null) {
      missingCount += 1;
      continue;
    }
    valid.push({
      margin,
      units: num(row.units),
      priceUSD: num(row.priceUSD),
      name: String(row.name ?? ''),
    });
  }
  const notes = [];
  if (valid.length === 0) {
    return {
      netMargin: null,
      basis: '无有效净利率',
      count: 0,
      missingCount,
      min: null,
      max: null,
      coveredUnits: 0,
      totalUnits: num(options.totalUnits),
      coverageRatio: null,
      notes: ['没有任何子市场算出净利率，无法加权'],
    };
  }

  const margins = valid.map((row) => row.margin);
  const min = Math.min(...margins);
  const max = Math.max(...margins);
  let basis = '子市场净利率算术平均';
  let weighted = 0;
  let weightSum = 0;
  if (valid.every((row) => row.units !== null && row.units > 0)) {
    basis = '按子市场月总销量加权';
    for (const row of valid) {
      weighted += row.margin * row.units;
      weightSum += row.units;
    }
  } else if (valid.every((row) => row.priceUSD !== null && row.priceUSD > 0)) {
    basis = '按子市场售价加权';
    for (const row of valid) {
      weighted += row.margin * row.priceUSD;
      weightSum += row.priceUSD;
    }
  } else {
    for (const row of valid) {
      weighted += row.margin;
      weightSum += 1;
    }
  }
  const netMargin = weightSum > 0 ? weighted / weightSum : null;

  const coveredUnits = valid.reduce((sum, row) => sum + (row.units !== null && row.units > 0 ? row.units : 0), 0);
  const totalUnits = num(options.totalUnits);
  const coverageRatio = totalUnits !== null && totalUnits > 0 && coveredUnits > 0 ? coveredUnits / totalUnits : null;

  notes.push(`加权方式：${basis}（参与加权 ${valid.length} 个子市场）`);
  if (missingCount > 0) notes.push(`另有 ${missingCount} 个子市场未算出净利率，未参与加权`);
  notes.push(`净利率区间 ${pct(min)} – ${pct(max)}`);
  if (coverageRatio !== null) {
    notes.push(`覆盖 ${coveredUnits.toLocaleString('en-US')} 件，占子市场总销量 ${pct(coverageRatio)}`);
  }

  return {
    netMargin: netMargin === null ? null : round(netMargin, 4),
    basis,
    count: valid.length,
    missingCount,
    min: round(min, 4),
    max: round(max, 4),
    coveredUnits,
    totalUnits,
    coverageRatio: coverageRatio === null ? null : round(coverageRatio, 4),
    notes,
  };
}

/**
 * 从 1688 阶梯价里取「起批量对应价」（最小 qty 档 = MOQ 档）。
 * 不取搜索页卡片价：卡片价只是入口 SKU 最低价，不是实际拿货价。
 */
export function pickTierPrice(priceTiers) {
  const tiers = (Array.isArray(priceTiers) ? priceTiers : [])
    .map((tier) => ({ qty: num(tier?.qty), priceCNY: num(tier?.priceCNY) }))
    .filter((tier) => tier.priceCNY !== null && tier.priceCNY >= 0);
  if (tiers.length === 0) return null;
  const sorted = [...tiers].sort((a, b) => (a.qty ?? 0) - (b.qty ?? 0));
  const first = sorted[0];
  return {
    qty: first.qty,
    priceCNY: first.priceCNY,
    tiers: sorted,
  };
}
