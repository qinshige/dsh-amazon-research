/**
 * dsh-amazon-research · host/scoring.js
 * 五维评分引擎（上游档位 + 92 分制归一化）。
 *
 * 约束：纯函数 / ESM / 无网络 / 无第三方依赖（仅依赖同目录 ./metrics.js）。
 *
 * 维度与实际上限（用户已拍板：保持上游 92 分上限，不改 100 分制）：
 * - 市场规模 20（档位 20 / 17 / 14 / 10）
 * - 增长潜力 25 → 实际最高 22（档位 22 / 18 / 14）
 * - 竞争烈度 20 → 实际最高 18（档位 18 / 14 / 8）
 * - 进入壁垒 20（Amazon 自营 10/6/3 + 新品机会 10/6/3，实际范围 6~20）
 * - 利润空间 15 → 实际最高 12（档位 12 / 10 / 7 / 4）
 * 合计上限 92；评级用 normalized = total / 92 * 100：>=80 优秀、>=60 良好、>=40 一般、<40 较差。
 *
 * Sellersprite 字段 → Market 落点 → 上游维度映射（本文件的取数优先级）：
 * - top100产品月销额 / totalRevenue / 月销额合计 → Market.totals.revenue → 市场规模。
 *   注意：Sellersprite market_research 的 totalRevenue 是 topNum=10 + size N 的抽样口径，
 *   不是 Top100 全量；报告与面板按「样本月销额（抽样口径）」表述。
 * - low_reviews_sales_volume_share（评论数 < 300 的销量占比）
 *     → Market 显式字段（lowReviewsSalesShare 等，可选）
 *     → Market.distributions.ratingsCount 的销量分桶推导（阈值 300，跨阈值桶按均匀分布估算）
 *     → Market.products 的 reviews < 300 且按 monthlySales 加权推导
 *     → 增长潜力 + 进入壁垒的「新品机会」子项。
 * - top3_brands_sales_volume_share → Market.concentration.top3BrandCrn（0~1，Sellersprite *Crn 原样 0~1）
 *     → 竞争烈度；缺失时回退 distributions.brand / products 聚合的 Top3 品牌销量占比。
 *     注意：top3ProductCrn 是商品级口径，绝不能拿来代替品牌级指标。
 * - amazonOwned_sales_volume_share → Market.structure.amazonSelfProportion（百分数 0~100，调用方已按
 *     Sellersprite *Proportion 原样落库）→ 进入壁垒的「Amazon 挤压」子项；缺失时回退 sellerType / products。
 * - average_price / avgPrice → Market.avgs.price → 利润空间；缺失时按 price 分布销额/销量加权或产品均价回退。
 * - avgRating / avgRatings → Market.avgs.rating / avgs.ratings → 不参与五维评分（上游利润/竞争不用评分），
 *   仅用于报告与面板的评论门槛参考；缺失不降级评分。
 * - l1/l3/l6/l12NewRatio → Market.newRatio（0~1）→ 不参与五维评分：上游增长潜力用低评论销量占比而非新品占比，
 *   新品占比仅作报告/面板辅助信息，避免把「新品占比高」误当成增长分。
 * - 口径陷阱：Sellersprite *Crn 是 0~1、*Proportion / returnRatio 已是百分数；本文件 asRatio / percentPointRatio 分别处理。
 *
 * 刻度约定：本文件内部一律把比例换算成 0~1 再与上游百分数阈值比较（>40% 即 >0.4）；
 * 只有 Market.structure.* 与 Sellersprite *Proportion 是 0~100 百分数，percentPointRatio() 负责 ÷100。
 * 数值缺失时该维度走最低档并写 notes，禁止编造数据；缺 >=2 维仍照常输出 total/normalized/grade。
 */

import {
  aggregateBrandRows,
  crn,
  lowReviewShareFromProducts,
  lowReviewShareFromRatingsBuckets,
  normalizeScore,
} from './metrics.js';
import {
  aggregateNetMargin,
  NET_MARGIN_REDLINE,
  SMALL_VOLUME_NET_MARGIN_REDLINE,
} from './sourcing/cost-model.js';

/** 总分上限（上游五维实际档位上限之和：20 + 22 + 18 + 20 + 12）。 */
const SCORE_MAX = 92;

/** 低评论阈值（上游口径：评价数量 300 以下视为低评论）。 */
const LOW_REVIEW_THRESHOLD = 300;

/** 五维元数据：max 是上游「实际档位上限」，不是标准分值（标准分值另见 detail/报告）。 */
const DIMENSIONS = Object.freeze([
  Object.freeze({ key: 'market_size', label: '市场规模', max: 20, standardMax: 20 }),
  Object.freeze({ key: 'growth_potential', label: '增长潜力', max: 22, standardMax: 25 }),
  Object.freeze({ key: 'competition', label: '竞争烈度', max: 18, standardMax: 20 }),
  Object.freeze({ key: 'entry_barrier', label: '进入壁垒', max: 20, standardMax: 20 }),
  Object.freeze({ key: 'profit_margin', label: '利润空间', max: 12, standardMax: 15 }),
]);

const DIMENSION_MAP = new Map(DIMENSIONS.map((dimension) => [dimension.key, dimension]));

/** 把任意值安全转成有限数字（支持 "1,234.5" / "84.11%" 字符串）；失败返回 null。 */
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

/** 是否普通对象（排除 null / 数组）。 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 安全取数组（非数组返回空数组）。 */
function rowsOf(value) {
  return Array.isArray(value) ? value.filter((row) => row && typeof row === 'object') : [];
}

/** 把 0~1 或百分数（>1 时）统一成 0~1；非法值返回 null。 */
function asRatio(value) {
  const parsed = num(value);
  if (parsed === null || parsed < 0) return null;
  if (parsed > 1) return parsed <= 100 ? parsed / 100 : null;
  return parsed;
}

/**
 * 把可能是**负数**的比例解析成 -1~1（或 -100~100 写法）。
 * 净利率可能为负（售价低于全成本），此时不能当成「非法值」，
 * 否则负利润的细分会被判成数据缺失并被排除出加权。
 */
function asSignedRatio(value) {
  const parsed = num(value);
  if (parsed === null) return null;
  if (parsed < -1) return parsed >= -100 ? parsed / 100 : null;
  if (parsed > 1) return parsed <= 100 ? parsed / 100 : null;
  return parsed;
}

/** 把 Market.structure.* 的百分数（0~100）换算成 0~1；非法值返回 null。 */
function percentPointRatio(value) {
  const parsed = num(value);
  if (parsed === null || parsed < 0 || parsed > 100) return null;
  return parsed / 100;
}

/** 按候选键顺序对行数组求和；一行都读不到数字时返回 null（0 是合法值）。 */
function sumRows(rows, keys) {
  let total = 0;
  let seen = false;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const key of keys) {
      const value = num(row[key]);
      if (value !== null) {
        total += value;
        seen = true;
        break;
      }
    }
  }
  return seen ? total : null;
}

/** 取行数组里第一个存在数字的键名；没有返回 null。 */
function firstNumericKey(rows, keys) {
  for (const key of keys) {
    if (rows.some((row) => num(row?.[key]) !== null)) return key;
  }
  return null;
}

/** 千分位格式化整数。 */
function groupThousands(text) {
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 把数字格式化成带千分位的 USD 金额（保留 2 位小数）。 */
function fmtUsd(value) {
  const parsed = num(value);
  if (parsed === null) return '—';
  const fixed = Math.abs(parsed).toFixed(2);
  const parts = fixed.split('.');
  const sign = parsed < 0 ? '-' : '';
  return sign + '$' + groupThousands(parts[0]) + '.' + parts[1];
}

/** 把 0~1 比例格式化成百分数（0~100%，保留 2 位小数）。 */
function fmtPercent(ratio) {
  const parsed = num(ratio);
  if (parsed === null) return '—';
  return (parsed * 100).toFixed(2) + '%';
}

/** 组装一个维度对象：max 取上游实际档位上限，normalized 为该维度相对实际满分的 0~100。 */
function makeDimension(key, score, detail, inputs) {
  const meta = DIMENSION_MAP.get(key);
  const safeScore = Math.min(meta.max, Math.max(0, num(score) ?? 0));
  return {
    key,
    label: meta.label,
    score: safeScore,
    max: meta.max,
    normalized: round((safeScore / meta.max) * 100, 1),
    detail,
    inputs,
  };
}

/** 市场规模档位：样本月销额严格大于阈值才升档（与上游 Top100 月销额档位一致）。 */
function marketSizeTier(revenue) {
  if (revenue > 10_000_000) return { score: 20, tier: '> $10,000,000' };
  if (revenue > 5_000_000) return { score: 17, tier: '> $5,000,000' };
  if (revenue > 1_000_000) return { score: 14, tier: '> $1,000,000' };
  return { score: 10, tier: '<= $1,000,000' };
}

/** 增长潜力档位：低评论销量占比（0~1）>40% 得 22、>20% 得 18、其余 14。 */
function growthTier(share) {
  const percent = share * 100;
  if (percent > 40) return { score: 22, tier: '> 40%' };
  if (percent > 20) return { score: 18, tier: '> 20%' };
  return { score: 14, tier: '<= 20%' };
}

/** 竞争烈度档位：Top3 品牌销量占比（0~1）<30% 得 18、<50% 得 14、其余 8。 */
function competitionTier(share) {
  const percent = share * 100;
  if (percent < 30) return { score: 18, tier: '< 30%' };
  if (percent < 50) return { score: 14, tier: '< 50%' };
  return { score: 8, tier: '>= 50%' };
}

/** 进入壁垒子项：Amazon 自营占比（0~1）10/6/3 + 低评论占比（0~1）10/6/3；缺失子项按最低 3 分计。 */
function barrierSubscores(amazonShare, lowReviewShare) {
  const amazonPoints = amazonShare === null
    ? 3
    : (amazonShare < 0.2 ? 10 : (amazonShare < 0.4 ? 6 : 3));
  const newProductPoints = lowReviewShare === null
    ? 3
    : (lowReviewShare > 0.4 ? 10 : (lowReviewShare > 0.2 ? 6 : 3));
  return { amazonPoints, newProductPoints };
}

/** 利润空间价格带档位（无采购成本时的兜底）：均价 >300 得 12、>150 得 10、>50 得 7、其余 4。 */
function profitPriceTier(price) {
  if (price > 300) return { score: 12, tier: '> $300' };
  if (price > 150) return { score: 10, tier: '> $150' };
  if (price > 50) return { score: 7, tier: '> $50' };
  return { score: 4, tier: '<= $50' };
}

/** 利润空间毛利率档位（接入采购成本时）：毛利 >60% 得 12、>45% 得 10、>30% 得 7、其余 4。 */
function profitMarginTier(margin) {
  if (margin > 0.6) return { score: 12, tier: '> 60%' };
  if (margin > 0.45) return { score: 10, tier: '> 45%' };
  if (margin > 0.3) return { score: 7, tier: '> 30%' };
  return { score: 4, tier: '<= 30%' };
}

/**
 * 净利率档位表（**与上游毛利率档位不是同一口径**）。
 *
 * 本档位是**净利率**：售价 − 采购 − 头程 − FBA − 佣金 − 广告 − 退货 − 其它，再除以售价；
 * 上游「毛利率档位」只扣采购成本（+ 头程/FBA），两者**不可直接比较**。
 *
 * 阈值与用户知识库《亚马逊选品实操指南》一致：
 *   - 「建议利润率超过 25% 以上的才考虑」→ 25% 主红线
 *   - 「体量较小（100-200 单）利润率要高于 30%」→ 30% 体量红线
 *   - 「利润低的产品能够去做体量也可以接受（15%-20% 利润率）」→ 15% 是「可跑体量」下限
 */
export const PROFIT_NET_MARGIN_TIERS = Object.freeze([
  Object.freeze({ min: 0.3, score: 12, tier: '> 30%' }),
  Object.freeze({ min: 0.25, score: 10, tier: '> 25%' }),
  Object.freeze({ min: 0.15, score: 7, tier: '> 15%' }),
  Object.freeze({ min: 0, score: 4, tier: '> 0%' }),
]);

/**
 * CONTRACTS-2 §3 原始档位（>30 / >20 / >12 / >0）。
 * 本次实现改用与知识库一致的双红线档位（见 PROFIT_NET_MARGIN_TIERS），
 * 这套档位保留下来做对照，方便回溯两个口径的分数差异。
 */
export const PROFIT_NET_MARGIN_TIERS_V2 = Object.freeze([
  Object.freeze({ min: 0.3, score: 12, tier: '> 30%' }),
  Object.freeze({ min: 0.2, score: 10, tier: '> 20%' }),
  Object.freeze({ min: 0.12, score: 7, tier: '> 12%' }),
  Object.freeze({ min: 0, score: 4, tier: '> 0%' }),
]);

/** 按档位表取档（严格大于阈值才升档；≤ 0% 记 0 分）。 */
function pickNetMarginTier(margin, tiers) {
  for (const tier of tiers) {
    if (margin > tier.min) return tier;
  }
  return { score: 0, tier: '<= 0%' };
}

/**
 * 用真实全成本净利率替换「利润空间」维度（92 分制里的 12 分档）。
 *
 * 口径（与上游毛利率档位**不同**，detail/notes 里必须写明）：
 *   净利率 = （售价 − 采购 − 头程 − FBA − 佣金 − 广告 − 退货 − 其它）÷ 售价
 *
 * @param {object} input
 * @param {number} input.netMargin 净利率（0~1；也接受 25.3 这种百分数写法）
 * @param {number|null} [input.priceUSD] 售价（USD），用于 detail 文案
 * @param {boolean} [input.smallVolume=false] 体量小（≤200 单）→ 按 > 30% 红线提示
 * @returns {{score:number, max:number, basis:string, detail:string, notes:string[], tier:string, netMargin:number|null, missing:boolean, contractV2Score:number|null, contractV2Tier:string|null}}
 */
export function profitScoreFromNetMargin(input = {}) {
  const src = isObject(input) ? input : {};
  const margin = asSignedRatio(src.netMargin);
  const priceUSD = num(src.priceUSD);
  const smallVolume = src.smallVolume === true;
  const priceText = priceUSD === null ? '' : '（售价 ' + fmtUsd(priceUSD) + '）';

  if (margin === null) {
    return {
      score: 0,
      max: 12,
      basis: 'net_margin',
      tier: '数据缺失',
      netMargin: null,
      priceUSD: priceUSD === null ? null : round(priceUSD, 2),
      missing: true,
      contractV2Score: null,
      contractV2Tier: null,
      detail: '缺少真实全成本净利率，无法按净利率档位评分（不编造数据）',
      notes: ['利润空间：缺少净利率（未接入 1688 采购成本或成本项不全），净利率档位按最低 0/12 计。'],
    };
  }

  const tier = pickNetMarginTier(margin, PROFIT_NET_MARGIN_TIERS);
  const v2 = pickNetMarginTier(margin, PROFIT_NET_MARGIN_TIERS_V2);
  const notes = [];
  notes.push('利润空间：按真实全成本净利率重算 —— 净利率 ' + fmtPercent(margin) + ' → ' + tier.score + '/12 分（档位 ' + tier.tier + '）。');
  notes.push('利润空间：本次是净利率口径（扣完采购/头程/FBA/佣金/广告/退货/其它），与上游毛利率口径（只扣采购成本）不可直接比较；分数变化不代表同一口径下变高。');
  if (tier.score !== v2.score) {
    notes.push('利润空间：对照 CONTRACTS-2 v2 原始净利率档位（>30%/>20%/>12%/>0%），同一净利率为 ' + v2.score + '/12 分（本次采用与知识库一致的 25%/30% 双红线档位）。');
  }
  if (smallVolume) {
    notes.push('利润空间：该细分体量较小（≤200 单），按 ' + fmtPercent(SMALL_VOLUME_NET_MARGIN_REDLINE) + ' 体量红线判定。');
  }
  notes.push('利润空间：净利率红线 ' + fmtPercent(NET_MARGIN_REDLINE) + '（体量小需 ' + fmtPercent(SMALL_VOLUME_NET_MARGIN_REDLINE) + '），物流占售价目标 10%–15%、>20% 提示放弃。');

  const detail = '全成本净利率 ' + fmtPercent(margin) + priceText
    + '（净利率口径：售价 − 采购 − 头程 − FBA − 佣金 − 广告 − 退货 − 其它），' + tier.tier + ' → ' + tier.score + '/12 分';

  return {
    score: tier.score,
    max: 12,
    basis: 'net_margin',
    tier: tier.tier,
    netMargin: round(margin, 4),
    priceUSD: priceUSD === null ? null : round(priceUSD, 2),
    smallVolume,
    missing: false,
    contractV2Score: v2.score,
    contractV2Tier: v2.tier,
    detail,
    notes,
  };
}

/** 市场规模取数：totals.revenue → 价格带销额合计 → 产品月销额合计；都没有返回 null。 */
function resolveRevenue(market) {
  const totals = isObject(market.totals) ? market.totals : {};
  const priceRows = rowsOf(market.distributions?.price);
  const products = rowsOf(market.products);
  const candidates = [
    { value: num(totals.revenue), source: 'totals.revenue' },
    { value: sumRows(priceRows, ['revenue']), source: 'distributions.price[].revenue 合计' },
    { value: sumRows(products, ['monthlyRevenue']), source: 'products[].monthlyRevenue 合计' },
  ];
  let zeroCandidate = null;
  for (const candidate of candidates) {
    if (candidate.value !== null && candidate.value > 0) return candidate;
    if (candidate.value === 0 && zeroCandidate === null) zeroCandidate = candidate;
  }
  return zeroCandidate;
}

/** 低评论占比取数：显式字段 → ratingsCount 分桶推导 → products 逐品推导；都没有返回 null。 */
function resolveLowReview(market) {
  const stats = isObject(market.stats) ? market.stats : {};
  const explicit = [
    { raw: market.lowReviewsSalesShare, source: 'market.lowReviewsSalesShare' },
    { raw: market.lowReviewsShare, source: 'market.lowReviewsShare' },
    { raw: stats.low_reviews_sales_volume_share, source: 'stats.low_reviews_sales_volume_share' },
  ];
  for (const item of explicit) {
    const share = asRatio(item.raw);
    if (share !== null) {
      return { share, source: item.source, derived: false, estimated: false, threshold: LOW_REVIEW_THRESHOLD };
    }
  }
  const bucketResult = lowReviewShareFromRatingsBuckets(rowsOf(market.distributions?.ratingsCount), { threshold: LOW_REVIEW_THRESHOLD });
  if (bucketResult.share !== null) {
    return {
      share: bucketResult.share,
      threshold: bucketResult.threshold,
      matchedShare: bucketResult.matchedShare,
      estimated: bucketResult.estimated,
      source: 'distributions.ratingsCount 销量分桶推导',
      derived: true,
    };
  }
  const productResult = lowReviewShareFromProducts(rowsOf(market.products), { threshold: LOW_REVIEW_THRESHOLD });
  if (productResult.share !== null) {
    return {
      share: productResult.share,
      threshold: productResult.threshold,
      matchedShare: productResult.matchedShare,
      estimated: productResult.estimated,
      source: 'products[].reviews 按 monthlySales 加权推导',
      derived: true,
    };
  }
  return null;
}

/** Amazon 自营占比取数：structure.amazonSelfProportion（百分数）→ sellerType 分布 → products 卖家来源；都没有返回 null。 */
function resolveAmazonSelf(market) {
  const structure = isObject(market.structure) ? market.structure : {};
  const direct = percentPointRatio(structure.amazonSelfProportion);
  if (direct !== null) {
    return { share: direct, source: 'structure.amazonSelfProportion（百分数 ÷100）', derived: false, estimated: false };
  }
  for (const row of rowsOf(market.distributions?.sellerType)) {
    const label = String(row.label ?? row.sellerType ?? row.type ?? '');
    if (!/amazon|亚马逊/i.test(label)) continue;
    const share = asRatio(row.unitsRatio ?? row.asinRatio);
    if (share !== null) {
      return {
        share,
        source: 'distributions.sellerType「' + label + '」unitsRatio',
        derived: true,
        estimated: false,
      };
    }
  }
  const products = rowsOf(market.products);
  let amazonUnits = 0;
  let totalUnits = 0;
  for (const product of products) {
    const units = num(product.monthlySales);
    if (units === null || !(units > 0)) continue;
    const sellerSource = String(product.sellerSource ?? '');
    const seller = String(product.seller ?? '');
    totalUnits += units;
    if (/amazon|亚马逊/i.test(sellerSource) || /amazon/i.test(seller)) amazonUnits += units;
  }
  if (totalUnits > 0) {
    return {
      share: round(amazonUnits / totalUnits, 4),
      source: 'products[].sellerSource 按 monthlySales 加权推导',
      derived: true,
      estimated: false,
    };
  }
  return null;
}

/** Top3 品牌销量占比取数：concentration.top3BrandCrn（0~1）→ brand 分布 → products 聚合；都没有返回 null。 */
function resolveTop3Brand(market) {
  const concentration = isObject(market.concentration) ? market.concentration : {};
  const direct = asRatio(concentration.top3BrandCrn);
  if (direct !== null) {
    return { value: direct, source: 'concentration.top3BrandCrn（0~1）', derived: false, estimated: false };
  }
  const brandRows = rowsOf(market.distributions?.brand);
  const brandKey = firstNumericKey(brandRows, ['totalUnits', 'units']);
  if (brandKey !== null && sumRows(brandRows, [brandKey]) > 0) {
    return {
      value: crn(brandRows, brandKey, 3),
      source: 'distributions.brand 按品牌销量推导',
      derived: true,
      estimated: false,
    };
  }
  const products = rowsOf(market.products);
  if (products.length > 0) {
    const rows = aggregateBrandRows(products);
    if (sumRows(rows, ['totalUnits']) > 0) {
      return {
        value: crn(rows, 'totalUnits', 3),
        source: 'products 按品牌聚合推导',
        derived: true,
        estimated: false,
      };
    }
  }
  return null;
}

/** 平均价格取数：avgs.price → price 分布销额/销量加权 → products 均价 → totals 加权；都没有返回 null。 */
function resolveAvgPrice(market) {
  const avgs = isObject(market.avgs) ? market.avgs : {};
  const direct = num(avgs.price);
  if (direct !== null && direct > 0) return { value: direct, source: 'avgs.price', derived: false };
  const priceRows = rowsOf(market.distributions?.price);
  const revenue = sumRows(priceRows, ['revenue']);
  const units = sumRows(priceRows, ['units']);
  if (revenue !== null && revenue > 0 && units !== null && units > 0) {
    return { value: revenue / units, source: 'distributions.price 销额/销量 加权', derived: true };
  }
  const products = rowsOf(market.products);
  const prices = products.map((product) => num(product.price)).filter((price) => price !== null && price > 0);
  if (prices.length > 0) {
    return {
      value: prices.reduce((acc, price) => acc + price, 0) / prices.length,
      source: 'products[].price 均值',
      derived: true,
    };
  }
  const totals = isObject(market.totals) ? market.totals : {};
  const totalRevenue = num(totals.revenue);
  const totalUnits = num(totals.units);
  if (totalRevenue !== null && totalRevenue > 0 && totalUnits !== null && totalUnits > 0) {
    return { value: totalRevenue / totalUnits, source: 'totals.revenue / totals.units 加权', derived: true };
  }
  return null;
}

/**
 * 真实净利率取数（利润维度优先口径）：
 *   1) opts.profitBySubMarket / market.profitBySubMarket → 按子市场加权（优先按月销量）
 *   2) opts.netMargin（直接给的净利率，0~1 或百分数写法）
 *   都没有 → 返回 null（走毛利率档位 / 价格带兜底）
 */
function resolveNetMargin(options, market) {
  const rows = Array.isArray(options.profitBySubMarket)
    ? options.profitBySubMarket
    : (Array.isArray(market.profitBySubMarket) ? market.profitBySubMarket : null);
  if (rows && rows.length > 0) {
    const totalUnits = num(options.totalUnits) ?? sumSubMarketUnits(market);
    const aggregate = aggregateNetMargin(rows, { totalUnits });
    if (aggregate.netMargin !== null) {
      return {
        value: aggregate.netMargin,
        source: '子市场净利率加权（' + aggregate.basis + '）',
        aggregate,
        rows,
      };
    }
  }
  const direct = asSignedRatio(options.netMargin);
  if (direct !== null) {
    return { value: direct, source: 'opts.netMargin（调用方给定的全成本净利率）', aggregate: null, rows: null };
  }
  return null;
}

/** 子市场月总销量合计（用于算净利率加权覆盖度）。 */
function sumSubMarketUnits(market) {
  const rows = rowsOf(market.subMarkets);
  let total = 0;
  let seen = false;
  for (const row of rows) {
    const units = num(row.totalUnits);
    if (units !== null && units > 0) {
      total += units;
      seen = true;
    }
  }
  return seen ? total : null;
}

/**
 * 五维评分主函数：完全纯函数，不读文件、不发网络；缺失数据走最低档并写入 notes。
 * @param {object} market 归一化对象 Market（见 CONTRACTS.md §1；可为 null / 空对象）
 * @param {object} [opts]
 *   - unitCost?: number 单件采购成本（USD/件）
 *   - extraCostPerUnit?: number 头程/FBA 等附加成本（USD/件，默认 0）
 *   - netMargin?: number 真实全成本净利率（0~1；也接受 25.3 这种百分数写法）→ 直接替换利润空间维度
 *   - profitBySubMarket?: Array<object> 子市场测算行（含 netMargin / units / priceUSD）→ 按销量加权出类目净利率
 *   - totalUnits?: number 子市场总销量（算加权覆盖度用）
 *   - smallVolume?: boolean 体量小（≤200 单），净利率档位按 > 30% 红线提示
 * @returns {{dimensions:Array<object>, total:number, max:number, normalized:number, grade:string, notes:Array<string>}} dimensions[].max 为上游实际上限（20/22/18/20/12），total 上限 92
 */
export function scoreMarket(market, opts = {}) {
  const input = isObject(market) ? market : {};
  const options = isObject(opts) ? opts : {};
  const notes = [];
  const addNote = (text) => {
    if (typeof text === 'string' && text !== '' && !notes.includes(text)) notes.push(text);
  };
  const dimensions = [];

  // 1) 市场规模（20 分）：样本月销额档位（抽样口径，上游以 Top100 月销额为输入）。
  const revenueInfo = resolveRevenue(input);
  {
    let score = 10;
    let detail = '';
    let dimInputs = { revenue: null, revenueSource: null, tier: '数据缺失', missing: true };
    if (revenueInfo === null) {
      detail = '缺少样本月销额，按最低档 10/20 分计（不编造数据）';
      addNote('市场规模：缺少样本月销额（totals.revenue 及可推导字段均为空），按上游最低档 10/20 计，未编造数据。');
    } else {
      const tier = marketSizeTier(revenueInfo.value);
      score = tier.score;
      dimInputs = { revenue: revenueInfo.value, revenueSource: revenueInfo.source, tier: tier.tier, missing: !(revenueInfo.value > 0) };
      if (revenueInfo.value > 0) {
        detail = `样本月销额 ${fmtUsd(revenueInfo.value)}（抽样口径），${tier.tier} → ${score}/20 分`;
      } else {
        detail = `样本月销额 $0（疑似取数失败，按最低档计），${tier.tier} → 10/20 分`;
        addNote('市场规模：月销额为 0，疑似取数失败，按最低档 10/20 计。');
      }
      if (revenueInfo.source !== 'totals.revenue') {
        addNote('市场规模：totals.revenue 缺失或为 0，改用 ' + revenueInfo.source + ' 推导，口径为样本合计。');
      }
    }
    dimensions.push(makeDimension('market_size', score, detail, dimInputs));
  }

  // 2) 增长潜力（22 分）：低评论产品销量占比档位。
  const lowReviewInfo = resolveLowReview(input);
  {
    let score = 14;
    let detail = '';
    let dimInputs = { lowReviewShare: null, lowReviewThreshold: LOW_REVIEW_THRESHOLD, lowReviewSource: null, estimated: true, missing: true };
    if (lowReviewInfo === null) {
      detail = '缺少低评论占比（既无 ratingsCount 分布，也无产品评论数明细），按最低档 14/22 分计（不编造数据）';
      addNote('增长潜力：缺少低评论销量占比（ratingsCount 分布与产品评论数明细均不可用），按上游最低档 14/22 计。');
    } else {
      const tier = growthTier(lowReviewInfo.share);
      score = tier.score;
      dimInputs = {
        lowReviewShare: lowReviewInfo.share,
        lowReviewThreshold: lowReviewInfo.threshold,
        lowReviewSource: lowReviewInfo.source,
        estimated: lowReviewInfo.estimated,
        missing: false,
      };
      detail = `低评论（评论数 < ${lowReviewInfo.threshold}）产品销量占比 ${fmtPercent(lowReviewInfo.share)}，${tier.tier} → ${score}/22 分`;
      if (lowReviewInfo.derived) {
        addNote('增长潜力：低评论占比推导来源 ' + lowReviewInfo.source + '（阈值 ' + lowReviewInfo.threshold + '）；'
          + (lowReviewInfo.estimated ? '跨阈值分桶按区间内均匀分布估算，属估算值。' : '分桶均未跨阈值，推导可复算。'));
      }
    }
    dimensions.push(makeDimension('growth_potential', score, detail, dimInputs));
  }

  // 3) 竞争烈度（18 分）：Top3 品牌销量占比档位。
  const top3Info = resolveTop3Brand(input);
  {
    let score = 8;
    let detail = '';
    let dimInputs = { top3BrandCrn: null, source: null, estimated: true, missing: true };
    if (top3Info === null) {
      detail = '缺少 Top3 品牌销量占比，按最低档 8/18 分计（不编造数据）';
      addNote('竞争烈度：缺少 Top3 品牌销量占比（concentration.top3BrandCrn、品牌分布与产品明细均不可用），按上游最低档 8/18 计。');
    } else {
      const tier = competitionTier(top3Info.value);
      score = tier.score;
      dimInputs = { top3BrandCrn: top3Info.value, source: top3Info.source, estimated: top3Info.estimated, missing: false };
      detail = `Top3 品牌销量占比 ${fmtPercent(top3Info.value)}，${tier.tier} → ${score}/18 分`;
      if (top3Info.derived) {
        addNote('竞争烈度：Top3 品牌占比由 ' + top3Info.source + ' 计算（品牌级销量口径，非产品级）。');
      }
    }
    dimensions.push(makeDimension('competition', score, detail, dimInputs));
  }

  // 4) 进入壁垒（20 分）：Amazon 自营挤压 10/6/3 + 新品机会（低评论占比）10/6/3。
  const amazonInfo = resolveAmazonSelf(input);
  {
    const { amazonPoints, newProductPoints } = barrierSubscores(
      amazonInfo === null ? null : amazonInfo.share,
      lowReviewInfo === null ? null : lowReviewInfo.share,
    );
    const score = amazonPoints + newProductPoints;
    const amazonText = amazonInfo === null ? '数据缺失' : fmtPercent(amazonInfo.share);
    const lowReviewText = lowReviewInfo === null ? '数据缺失' : fmtPercent(lowReviewInfo.share);
    const detail = `Amazon 自营销量占比 ${amazonText} → ${amazonPoints}/10 分；低评论占比 ${lowReviewText} → ${newProductPoints}/10 分；合计 ${score}/20 分`;
    const dimInputs = {
      amazonSelfShare: amazonInfo === null ? null : amazonInfo.share,
      amazonSelfSource: amazonInfo === null ? null : amazonInfo.source,
      lowReviewShare: lowReviewInfo === null ? null : lowReviewInfo.share,
      lowReviewSource: lowReviewInfo === null ? null : lowReviewInfo.source,
      amazonPoints,
      newProductPoints,
      missing: amazonInfo === null || lowReviewInfo === null,
    };
    if (amazonInfo === null) {
      addNote('进入壁垒：缺少 Amazon 自营销量占比，Amazon 挤压子项按最低 3/10 计。');
    } else if (amazonInfo.derived) {
      addNote('进入壁垒：Amazon 自营占比由 ' + amazonInfo.source + ' 推导（按销量加权）。');
    }
    dimensions.push(makeDimension('entry_barrier', score, detail, dimInputs));
  }

  // 5) 利润空间（12 分）：优先级 = 真实全成本净利率 > 毛利率档位（opts.unitCost）> 均价价格带兜底。
  //    净利率口径与上游毛利率口径不是一回事，detail/notes 里必须写明，避免误读成「同一口径分数变高」。
  const avgPriceInfo = resolveAvgPrice(input);
  const netMarginInfo = resolveNetMargin(options, input);
  {
    const rawUnitCost = num(options.unitCost);
    const unitCostInvalid = options.unitCost !== undefined && options.unitCost !== null && (rawUnitCost === null || rawUnitCost < 0);
    const rawExtra = num(options.extraCostPerUnit ?? options.extraCost);
    const extraCostPerUnit = rawExtra !== null && rawExtra > 0 ? rawExtra : 0;
    const unitCostUsable = rawUnitCost !== null && rawUnitCost >= 0
      && avgPriceInfo !== null && avgPriceInfo.value > 0;
    const noCostNote = '利润空间：未接入采购成本（1688/供应商报价），当前按平均价格带初筛评分（未接入采购成本，仅供初筛）。可通过 opts.unitCost 传入单件综合成本以获得毛利分档。';

    if (netMarginInfo !== null) {
      // 真实净利率口径：直接替换「利润空间」维度，并保留上游毛利率档位做对照。
      const priceForDetail = num(options.priceUSD) ?? (avgPriceInfo !== null ? avgPriceInfo.value : null);
      const scored = profitScoreFromNetMargin({
        netMargin: netMarginInfo.value,
        priceUSD: priceForDetail,
        smallVolume: options.smallVolume === true,
      });
      let grossMargin = null;
      let upstreamTier = null;
      if (unitCostUsable) {
        const totalCost = rawUnitCost + extraCostPerUnit;
        grossMargin = (avgPriceInfo.value - totalCost) / avgPriceInfo.value;
        upstreamTier = profitMarginTier(grossMargin);
      }
      // 原「按均价档位」兜底档位：保留下来做对照，避免被误读成同一口径下分数变高/变低。
      const fallbackTier = avgPriceInfo === null ? null : profitPriceTier(avgPriceInfo.value);
      let detail = scored.detail;
      if (upstreamTier) {
        detail += '；对照上游毛利率档位 ' + upstreamTier.tier + ' → ' + upstreamTier.score + '/12 分（口径不同，不可直接比较）';
      } else if (fallbackTier) {
        detail += '；对照原「按均价档位」兜底档位 ' + fallbackTier.tier + ' → ' + fallbackTier.score + '/12 分（该档位只反映售价高低，非真实盈利）';
      }
      const dimInputs = {
        avgPrice: avgPriceInfo === null ? null : avgPriceInfo.value,
        avgPriceSource: avgPriceInfo === null ? null : avgPriceInfo.source,
        basis: 'net_margin',
        netMargin: scored.netMargin,
        netMarginSource: netMarginInfo.source,
        netMarginBasis: 'net_margin',
        netMarginTier: scored.tier,
        netMarginContractV2Score: scored.contractV2Score,
        unitCost: rawUnitCost,
        extraCostPerUnit,
        grossMargin: grossMargin === null ? null : round(grossMargin, 4),
        upstreamGrossMarginTier: upstreamTier === null ? null : upstreamTier.tier,
        upstreamGrossMarginScore: upstreamTier === null ? null : upstreamTier.score,
        fallbackAvgPriceTier: fallbackTier === null ? null : fallbackTier.tier,
        fallbackAvgPriceScore: fallbackTier === null ? null : fallbackTier.score,
        tier: scored.tier,
        missing: false,
      };
      for (const note of scored.notes) addNote(note);
      if (upstreamTier) {
        addNote('利润空间：档位对照 —— 原上游毛利率档位 ' + upstreamTier.tier + ' → ' + upstreamTier.score + '/12 分，'
          + '本次净利率档位 → ' + scored.score + '/12 分；两者口径不同（毛利率只扣采购成本，净利率扣完全部科目），分数不可直接比较。');
      } else if (fallbackTier) {
        addNote('利润空间：档位对照 —— 原「按均价档位」兜底为 ' + fallbackTier.tier + ' → ' + fallbackTier.score + '/12 分（只反映售价高低），'
          + '本次净利率档位 → ' + scored.score + '/12 分；两者口径不同，分数不可直接比较。');
      }
      if (netMarginInfo.aggregate) {
        addNote('利润空间：加权方式为' + netMarginInfo.aggregate.basis + '，参与加权 ' + netMarginInfo.aggregate.count + ' 个子市场'
          + (netMarginInfo.aggregate.coverageRatio !== null
            ? '，覆盖子市场总销量 ' + fmtPercent(netMarginInfo.aggregate.coverageRatio) + '（非全类目净利率）'
            : ''));
        for (const note of netMarginInfo.aggregate.notes) addNote('利润空间：' + note);
      }
      dimensions.push(makeDimension('profit_margin', scored.score, detail, dimInputs));
    } else if (unitCostUsable) {
      const totalCost = rawUnitCost + extraCostPerUnit;
      const grossMargin = (avgPriceInfo.value - totalCost) / avgPriceInfo.value;
      const tier = profitMarginTier(grossMargin);
      const detail = `平均价格 ${fmtUsd(avgPriceInfo.value)}，单件综合成本 ${fmtUsd(totalCost)}（采购 ${fmtUsd(rawUnitCost)} + 附加 ${fmtUsd(extraCostPerUnit)}），毛利率 ${(grossMargin * 100).toFixed(2)}%，${tier.tier} → ${tier.score}/12 分`;
      const dimInputs = {
        avgPrice: avgPriceInfo.value,
        avgPriceSource: avgPriceInfo.source,
        basis: 'unit_cost',
        unitCost: rawUnitCost,
        extraCostPerUnit,
        grossMargin: round(grossMargin, 4),
        tier: tier.tier,
        missing: false,
      };
      if (avgPriceInfo.derived) addNote('利润空间：平均价格由 ' + avgPriceInfo.source + ' 推导。');
      dimensions.push(makeDimension('profit_margin', tier.score, detail, dimInputs));
    } else {
      let score = 4;
      let detail = '';
      let dimInputs = {
        avgPrice: null,
        avgPriceSource: null,
        basis: 'avg_price',
        unitCost: rawUnitCost,
        extraCostPerUnit,
        grossMargin: null,
        tier: '数据缺失',
        missing: true,
      };
      if (avgPriceInfo === null) {
        detail = '缺少平均价格数据，按最低档 4/12 分计 · 未接入采购成本，仅供初筛';
        addNote('利润空间：缺少平均价格（avgs.price 及可推导字段为空），且未接入采购成本，按上游最低档 4/12 计。');
        if (rawUnitCost !== null) addNote('利润空间：已传入 opts.unitCost，但缺少平均价格，无法计算毛利率，回退最低档。');
        addNote(noCostNote);
        if (unitCostInvalid) addNote('利润空间：opts.unitCost 非法（需为非负数，USD/件），已忽略。');
      } else {
        const tier = profitPriceTier(avgPriceInfo.value);
        score = tier.score;
        dimInputs = {
          avgPrice: avgPriceInfo.value,
          avgPriceSource: avgPriceInfo.source,
          basis: 'avg_price',
          unitCost: rawUnitCost,
          extraCostPerUnit,
          grossMargin: null,
          tier: tier.tier,
          missing: false,
        };
        detail = `平均价格 ${fmtUsd(avgPriceInfo.value)}，${tier.tier} → ${score}/12 分 · 未接入采购成本，仅供初筛`;
        if (avgPriceInfo.derived) addNote('利润空间：平均价格由 ' + avgPriceInfo.source + ' 推导。');
        addNote(noCostNote);
        if (unitCostInvalid) addNote('利润空间：opts.unitCost 非法（需为非负数，USD/件），已忽略并按价格带兜底。');
        if (rawUnitCost !== null && (avgPriceInfo === null || !(avgPriceInfo.value > 0))) {
          addNote('利润空间：已传入 opts.unitCost，但平均价格不可用，无法计算毛利率。');
        }
      }
      dimensions.push(makeDimension('profit_margin', score, detail, dimInputs));
    }
  }

  const total = dimensions.reduce((acc, dimension) => acc + dimension.score, 0);
  const normalized = normalizeScore(total, SCORE_MAX);
  return {
    dimensions,
    total,
    max: SCORE_MAX,
    normalized: normalized.normalized,
    grade: normalized.grade,
    notes,
  };
}
