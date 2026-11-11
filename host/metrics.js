/**
 * dsh-amazon-research · host/metrics.js
 * 市场度量指标：品牌级 HHI、CRn 集中度、92 分制归一化、价格/评分/评论数分布工具。
 *
 * 约束：纯函数 / ESM / 无网络 / 无第三方依赖（本文件不使用任何 import）。
 *
 * 刻度约定（务必区分，报告层再负责展示换算）：
 * - HHI：0~10000（经典 HHI 刻度：品牌份额按百分数平方后求和）。
 * - CRn、coveredShare、unitsShare、revenueShare、grossMargin：0~1 小数；报告层 ×100 展示。
 * - 传入的 Sellersprite *Crn / *Ratio 为 0~1；个别上游文件会混入百分数，本文件的
 *   防呆换算只在值 >1 时才 ÷100。
 *
 * 为什么坚持「品牌级」HHI（规避上游 bug）：
 * 上游 .eval-sorftime/repo/SKILLS/skills/category-selection/scripts/workflow.py:272
 * 的 calculate_hhi(products) 用「单个产品」的销量份额做平方和，把商品数当成了玩家数，
 * 得到的是产品集中度（Cell_Phones 样本只有 173.09），不是品牌集中度；
 * 同仓库 data_adapter.py:305 又把 0~1 份额平方和 ×100，刻度错成 0~100。
 * 本文件 brandHHI() 只接受「按品牌聚合后的行」，口径为品牌份额、刻度 0~10000，
 * 不复刻上述两种错误。
 */

/** 评级阈值：normalized 为 0~100 百分制（total / 92 * 100）。 */
export const GRADE_THRESHOLDS = Object.freeze([
  Object.freeze({ grade: '优秀', min: 80 }),
  Object.freeze({ grade: '良好', min: 60 }),
  Object.freeze({ grade: '一般', min: 40 }),
  Object.freeze({ grade: '较差', min: 0 }),
]);

/** 把任意值安全转成有限数字：支持数字与 "1,234.5" / "84.11%" 这类字符串；失败返回 null。 */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/,/g, '').replace(/%$/, '');
    if (cleaned === '') return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 按候选键顺序读取对象里的第一个有限数字；读到 null / 非法值继续尝试下一个键。 */
function readNumber(row, keys) {
  if (!row || typeof row !== 'object') return null;
  for (const key of keys) {
    if (!(key in row)) continue;
    const parsed = toNumber(row[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** 按候选键顺序读取对象里的第一个非空字符串或数字（用于分布 label / 品牌名）。 */
function readText(row, keys) {
  if (!row || typeof row !== 'object') return null;
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** 把数字钳制到 [min, max]。 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 四舍五入到指定小数位（先加 EPSILON，避免 1.005 这类浮点误差）。 */
function roundTo(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * 把若干行里的比例字段求和，返回 0~1；若数据是百分数（和 >1.5）自动 ÷100。
 * 用于 brandHHI 的 coveredShare：Sellersprite 品牌分布带 totalUnitsRatio（0~1）。
 */
function sumRatio(rows, keys) {
  let total = 0;
  let seen = 0;
  for (const row of rows) {
    const value = readNumber(row, keys);
    if (value === null || value < 0) continue;
    total += value;
    seen += 1;
  }
  if (seen === 0 || !(total > 0)) return null;
  if (total > 1.5 && total <= 150) return clamp(total / 100, 0, 1);
  return clamp(total, 0, 1);
}

/** 校验并归一化 HHI 入参里的 options.basis：'revenue' / 'units' / 'auto'。 */
function normalizeBasis(basis) {
  if (basis === 'units' || basis === 'brand_units') return 'units';
  if (basis === 'revenue' || basis === 'brand_revenue') return 'revenue';
  return 'auto';
}

/**
 * 按品牌级份额计算 HHI（0~10000），返回覆盖份额与是否估算标记。
 * @param {Array<object>} brandRows 品牌聚合行：优先取 totalRevenue / totalUnits（兼容 revenue / units / monthlyRevenue / monthlySales）；也可带 totalRevenueRatio / totalUnitsRatio（0~1）
 * @param {object} [opts] { basis?: 'revenue'|'units'|'auto'（默认 auto，优先销额）, totalRevenue?: number, totalUnits?: number }
 * @returns {{hhi:number, basis:'brand_revenue'|'brand_units', coveredShare:number, estimated:boolean}} hhi 为 0~10000；coveredShare 为 0~1；estimated=true 表示份额覆盖不足或发生过口径回退
 */
export function brandHHI(brandRows, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const rows = Array.isArray(brandRows) ? brandRows.filter((row) => row && typeof row === 'object') : [];
  const readMetric = (row, basis) => (basis === 'revenue'
    ? readNumber(row, ['totalRevenue', 'revenue', 'monthlyRevenue'])
    : readNumber(row, ['totalUnits', 'units', 'monthlySales', 'sales']));

  let basis = normalizeBasis(options.basis) === 'units' ? 'units' : 'revenue';
  let values = rows.map((row) => Math.max(0, readMetric(row, basis) ?? 0));
  let sum = values.reduce((acc, value) => acc + value, 0);
  let basisFallback = false;

  if (!(sum > 0)) {
    const otherBasis = basis === 'revenue' ? 'units' : 'revenue';
    const otherValues = rows.map((row) => Math.max(0, readMetric(row, otherBasis) ?? 0));
    const otherSum = otherValues.reduce((acc, value) => acc + value, 0);
    if (otherSum > 0) {
      basis = otherBasis;
      values = otherValues;
      sum = otherSum;
      basisFallback = true;
    }
  }

  const basisLabel = basis === 'revenue' ? 'brand_revenue' : 'brand_units';
  if (!(sum > 0)) return { hhi: 0, basis: basisLabel, coveredShare: 0, estimated: true };

  // coveredShare：优先用调用方给的类目总量（可信分母），其次用行内占比之和，
  // 两者都没有时按「传入行即完整品牌集合」假设 coveredShare=1 并标 estimated。
  let coveredShare = null;
  let coverageKnown = false;
  const totalKey = basis === 'revenue' ? 'totalRevenue' : 'totalUnits';
  const explicitTotal = toNumber(options[totalKey]);
  if (explicitTotal !== null && explicitTotal > 0) {
    coveredShare = clamp(sum / explicitTotal, 0, 1);
    coverageKnown = true;
  }
  if (!coverageKnown) {
    const ratioKeys = basis === 'revenue'
      ? ['totalRevenueRatio', 'revenueRatio']
      : ['totalUnitsRatio', 'unitsRatio'];
    coveredShare = sumRatio(rows, ratioKeys);
    coverageKnown = coveredShare !== null;
  }
  if (!coverageKnown || !(coveredShare > 0)) {
    coveredShare = 1;
    coverageKnown = false;
  }

  // 用覆盖份额还原类目总分母，再算份额平方和；覆盖不足时 HHI 是下限估计而非放大。
  const denominator = sum / coveredShare;
  const hhiRaw = values.reduce((acc, value) => {
    const percentShare = (value / denominator) * 100;
    return acc + percentShare * percentShare;
  }, 0);

  const estimated = basisFallback || !coverageKnown || coveredShare < 0.95;
  return {
    hhi: roundTo(hhiRaw, 2),
    basis: basisLabel,
    coveredShare: roundTo(clamp(coveredShare, 0, 1), 4),
    estimated,
  };
}

/**
 * 计算前 n 名集中度 CRn（0~1 小数）。
 * @param {Array<object>} rows 数据行
 * @param {string} key 取数字段的键名（如 totalUnits / totalRevenue）
 * @param {number} [n] 前 n 名，默认 3
 * @returns {number} 0~1；无有效数据返回 0
 */
export function crn(rows, key, n = 3) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return 0;
  const take = Math.max(1, Math.floor(toNumber(n) ?? 3));
  const values = [];
  for (const row of list) {
    const value = row && typeof row === 'object' ? toNumber(row[key]) : null;
    if (value !== null && value > 0) values.push(value);
  }
  const total = values.reduce((acc, value) => acc + value, 0);
  if (!(total > 0)) return 0;
  values.sort((a, b) => b - a);
  const topSum = values.slice(0, take).reduce((acc, value) => acc + value, 0);
  return roundTo(topSum / total, 4);
}

/**
 * 92 分制归一化：normalized = total / max * 100（0~100，保留 1 位小数）。
 * @param {number} total 原始总分（0~92）
 * @param {number} [max] 原始满分，默认 92；非法值回退 92
 * @returns {{normalized:number, grade:string, thresholds:Array<{grade:string,min:number}>}} grade 按 >=80 优秀 / >=60 良好 / >=40 一般 / <40 较差
 */
export function normalizeScore(total, max = 92) {
  const parsedMax = toNumber(max);
  const safeMax = parsedMax !== null && parsedMax > 0 ? parsedMax : 92;
  const rawTotal = toNumber(total) ?? 0;
  const normalized = roundTo(clamp((rawTotal / safeMax) * 100, 0, 100), 1);
  let grade = '较差';
  for (const threshold of GRADE_THRESHOLDS) {
    if (normalized >= threshold.min) {
      grade = threshold.grade;
      break;
    }
  }
  return {
    normalized,
    grade,
    thresholds: GRADE_THRESHOLDS.map((threshold) => ({ grade: threshold.grade, min: threshold.min })),
  };
}

/**
 * 把产品明细按品牌聚合为品牌行（供 HHI、集中度与报告品牌表使用）。
 * 行内 totalUnitsRatio / totalRevenueRatio 是相对「传入产品样本」的占比（0~1），不是全类目份额。
 * @param {Array<object>} products 产品行（兼容 Market 英文字段与 Sorftime 中文字段）
 * @returns {Array<object>} 品牌行：brand/products/newProducts/avgPrice/ratings/rating/totalUnits/totalRevenue/totalUnitsRatio/totalRevenueRatio，按销额降序
 */
export function aggregateBrandRows(products) {
  const list = Array.isArray(products) ? products.filter((product) => product && typeof product === 'object') : [];
  const map = new Map();
  for (const product of list) {
    const brand = readText(product, ['brand', '品牌']) ?? '未知品牌';
    const units = Math.max(0, readNumber(product, ['monthlySales', 'units', 'sales', '月销量']) ?? 0);
    const revenue = Math.max(0, readNumber(product, ['monthlyRevenue', 'revenue', '月销额']) ?? 0);
    const price = readNumber(product, ['price', '价格']);
    const rating = readNumber(product, ['rating', '星级']);
    const reviews = Math.max(0, readNumber(product, ['reviews', 'ratingsCount', '评论数']) ?? 0);
    const launchDays = readNumber(product, ['launchDays', '上线天数']);

    let row = map.get(brand);
    if (!row) {
      row = {
        brand,
        products: 0,
        newProducts: 0,
        avgPrice: null,
        ratings: 0,
        rating: null,
        totalUnits: 0,
        totalRevenue: 0,
        _priceWeighted: 0,
        _priceUnits: 0,
        _ratingSum: 0,
        _ratingCount: 0,
      };
      map.set(brand, row);
    }
    row.products += 1;
    row.totalUnits += units;
    row.totalRevenue += revenue;
    row.ratings += reviews;
    if (price !== null && price > 0) {
      row._priceWeighted += price * (units > 0 ? units : 1);
      row._priceUnits += units > 0 ? units : 1;
    }
    if (rating !== null && rating > 0) {
      row._ratingSum += rating;
      row._ratingCount += 1;
    }
    if (launchDays !== null && launchDays >= 0 && launchDays <= 180) row.newProducts += 1;
  }

  const rows = [...map.values()];
  const totalUnits = rows.reduce((acc, row) => acc + row.totalUnits, 0);
  const totalRevenue = rows.reduce((acc, row) => acc + row.totalRevenue, 0);
  for (const row of rows) {
    row.avgPrice = row._priceUnits > 0 ? roundTo(row._priceWeighted / row._priceUnits, 2) : null;
    row.rating = row._ratingCount > 0 ? roundTo(row._ratingSum / row._ratingCount, 2) : null;
    row.totalUnitsRatio = totalUnits > 0 ? roundTo(row.totalUnits / totalUnits, 4) : null;
    row.totalRevenueRatio = totalRevenue > 0 ? roundTo(row.totalRevenue / totalRevenue, 4) : null;
    delete row._priceWeighted;
    delete row._priceUnits;
    delete row._ratingSum;
    delete row._ratingCount;
  }
  rows.sort((a, b) => b.totalRevenue - a.totalRevenue || b.totalUnits - a.totalUnits);
  return rows;
}

/**
 * 汇总价格/评分/评论数等分布数组：统一输出 0~1 的销量占比与销额占比，并给出累计占比。
 * @param {Array<object>} rows 分布行（label/products/units/revenue/unitsRatio 等）
 * @param {object} [opts] { labelKey?, unitsKey?, revenueKey?, productKey? } 覆盖默认字段名
 * @returns {{rows:Array<object>, totalUnits:number, totalRevenue:number, totalProducts:number, estimated:boolean}} rows[].unitsShare / revenueShare / cumulativeShare 为 0~1；estimated=true 表示占比由 unitsRatio 回退推导
 */
export function summarizeDistribution(rows, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const list = Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : [];
  const labelKeys = options.labelKey ? [options.labelKey] : ['label', 'range', 'country', 'sellerType', 'brand'];
  const unitKeys = options.unitsKey ? [options.unitsKey] : ['units', 'totalUnits', 'asinNum'];
  const revenueKeys = options.revenueKey ? [options.revenueKey] : ['revenue', 'totalRevenue'];
  const productKeys = options.productKey ? [options.productKey] : ['products', 'productNum', 'asinNum'];

  const units = list.map((row) => Math.max(0, readNumber(row, unitKeys) ?? 0));
  const revenue = list.map((row) => Math.max(0, readNumber(row, revenueKeys) ?? 0));
  const products = list.map((row) => Math.max(0, readNumber(row, productKeys) ?? 0));
  const totalUnits = units.reduce((acc, value) => acc + value, 0);
  const totalRevenue = revenue.reduce((acc, value) => acc + value, 0);
  const totalProducts = products.reduce((acc, value) => acc + value, 0);

  // 销量全为 0 时回退到上游 unitsRatio（0~1，个别百分数自动换算），仅作估算。
  let ratioShares = null;
  let estimated = list.length === 0;
  if (!(totalUnits > 0)) {
    const rawRatios = list.map((row) => readNumber(row, ['unitsRatio', 'ratio']));
    if (rawRatios.some((value) => value !== null)) {
      const ratioSum = rawRatios.reduce((acc, value) => acc + Math.max(0, value ?? 0), 0);
      const divisor = ratioSum > 1.5 && ratioSum <= 150 ? 100 : 1;
      const normalized = rawRatios.map((value) => Math.max(0, value ?? 0) / divisor);
      const normalizedSum = normalized.reduce((acc, value) => acc + value, 0);
      ratioShares = normalizedSum > 0 ? normalized.map((value) => value / normalizedSum) : normalized.map(() => 0);
      estimated = true;
    }
  }

  const resultRows = [];
  let cumulative = 0;
  for (let index = 0; index < list.length; index += 1) {
    const label = readText(list[index], labelKeys) ?? ('分桶 ' + (index + 1));
    const unitsShare = totalUnits > 0 ? units[index] / totalUnits : (ratioShares ? ratioShares[index] : 0);
    cumulative += unitsShare;
    resultRows.push({
      label,
      products: products[index],
      units: units[index],
      revenue: revenue[index],
      unitsShare: roundTo(clamp(unitsShare, 0, 1), 4),
      revenueShare: totalRevenue > 0 ? roundTo(clamp(revenue[index] / totalRevenue, 0, 1), 4) : null,
      cumulativeShare: roundTo(clamp(cumulative, 0, 1), 4),
    });
  }
  if (resultRows.length > 0 && !(totalUnits > 0)) estimated = true;

  return { rows: resultRows, totalUnits, totalRevenue, totalProducts, estimated };
}

/**
 * 价格带分布统计：在 summarizeDistribution 基础上给出销量占比最高的价格带与前 3 带合计占比。
 * @param {Array<object>} rows 价格带分布行
 * @param {object} [opts] 同 summarizeDistribution
 * @returns {object} summarizeDistribution 结果 + { topBand, top3UnitsShare }（top3UnitsShare 为 0~1）
 */
export function priceBandStats(rows, opts = {}) {
  const summary = summarizeDistribution(rows, opts);
  let topBand = null;
  for (const row of summary.rows) {
    if (!topBand || row.unitsShare > topBand.unitsShare) topBand = row;
  }
  const top3UnitsShare = summary.rows
    .map((row) => row.unitsShare)
    .sort((a, b) => b - a)
    .slice(0, 3)
    .reduce((acc, value) => acc + value, 0);
  return { ...summary, topBand, top3UnitsShare: roundTo(clamp(top3UnitsShare, 0, 1), 4) };
}

/**
 * 评分值分布汇总（0~1 占比），等价于对 distributions.rating 调用 summarizeDistribution。
 * @param {Array<object>} rows 评分分布行
 * @param {object} [opts] 同 summarizeDistribution
 * @returns {object} 同 summarizeDistribution
 */
export function ratingDistributionSummary(rows, opts = {}) {
  return summarizeDistribution(rows, opts);
}

/**
 * 评论数分布汇总（0~1 占比），等价于对 distributions.ratingsCount 调用 summarizeDistribution。
 * @param {Array<object>} rows 评论数分布行
 * @param {object} [opts] 同 summarizeDistribution
 * @returns {object} 同 summarizeDistribution
 */
export function reviewsDistributionSummary(rows, opts = {}) {
  return summarizeDistribution(rows, opts);
}

/**
 * 解析评论数分桶 label，如 "0-100" / "101~300" / "300+" / ">1000" / "100 以下"。
 * @param {string} label 分桶标签
 * @returns {{min:number, max:number}|null} 近似区间；无数字返回 null
 */
function parseRatingsBucket(label) {
  if (label === null || label === undefined) return null;
  const text = String(label).trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, '');
  if (text === '') return null;
  if (/无(评论|评价)|none|no review/.test(text) && !/\d/.test(text)) return { min: 0, max: 0 };
  const numbers = text.match(/\d+(?:\.\d+)?/g);
  if (!numbers) return null;
  const values = numbers.map(Number).filter((value) => Number.isFinite(value));
  if (values.length === 0) return null;
  if (/\+|以上|≥|>=|more/.test(text)) return { min: values[0], max: Infinity };
  if (/<|＜|以下|以内|less|under/.test(text)) return { min: 0, max: values[0] };
  if (/^[-–—]\s*\d/.test(text)) return { min: 0, max: values[0] };
  if (/-\s*$/.test(text)) return { min: values[0], max: Infinity };
  if (values.length >= 2) return { min: Math.min(values[0], values[1]), max: Math.max(values[0], values[1]) };
  return { min: values[0], max: values[0] };
}

/**
 * 由评论数分布（distributions.ratingsCount）推导「低评论产品」销量占比。
 * 推导方式：完全落在阈值以下的桶全量计入；完全在阈值以上的桶不计；
 * 跨阈值的桶按区间内均匀分布估算落入阈值的比例（会置 estimated=true）。
 * @param {Array<object>} rows 评论数分布行（label + units）
 * @param {object} [opts] { threshold?: number } 低评论阈值，默认 300（上游口径：评论数 < 300）
 * @returns {{share:number|null, threshold:number, matchedShare:number, estimated:boolean}} share 为 0~1；销量数据缺失时 share=null
 */
export function lowReviewShareFromRatingsBuckets(rows, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const parsedThreshold = toNumber(options.threshold);
  const threshold = parsedThreshold !== null && parsedThreshold > 0 ? parsedThreshold : 300;
  const list = Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : [];
  const units = list.map((row) => Math.max(0, readNumber(row, ['units', 'totalUnits', 'monthlySales']) ?? 0));
  const totalUnits = units.reduce((acc, value) => acc + value, 0);
  if (!(totalUnits > 0)) return { share: null, threshold, matchedShare: 0, estimated: true };

  let lowUnits = 0;
  let matchedUnits = 0;
  let estimated = false;
  list.forEach((row, index) => {
    const bucket = parseRatingsBucket(row.label ?? row.range);
    if (!bucket) {
      estimated = true;
      return;
    }
    const rowUnits = units[index];
    matchedUnits += rowUnits;
    if (bucket.max <= threshold) {
      lowUnits += rowUnits;
    } else if (bucket.min >= threshold) {
      // 整桶都在阈值以上，不计入。
    } else {
      const span = bucket.max - bucket.min;
      const fraction = span > 0 ? clamp((threshold - bucket.min) / span, 0, 1) : 0.5;
      lowUnits += rowUnits * fraction;
      estimated = true;
    }
  });

  return {
    share: roundTo(clamp(lowUnits / totalUnits, 0, 1), 4),
    threshold,
    matchedShare: roundTo(clamp(matchedUnits / totalUnits, 0, 1), 4),
    estimated,
  };
}

/**
 * 由产品明细推导「低评论产品」销量占比（评论数 < threshold 的月销量合计 / 总月销量）。
 * @param {Array<object>} products 产品行（reviews + monthlySales）
 * @param {object} [opts] { threshold?: number } 默认 300
 * @returns {{share:number|null, threshold:number, matchedShare:number, estimated:boolean}} share 为 0~1；无有效销量数据时 null
 */
export function lowReviewShareFromProducts(products, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const parsedThreshold = toNumber(options.threshold);
  const threshold = parsedThreshold !== null && parsedThreshold > 0 ? parsedThreshold : 300;
  const list = Array.isArray(products) ? products.filter((product) => product && typeof product === 'object') : [];
  let lowUnits = 0;
  let totalUnits = 0;
  let matched = 0;
  for (const product of list) {
    const reviews = readNumber(product, ['reviews', 'ratingsCount', 'reviewCount']);
    const units = readNumber(product, ['monthlySales', 'units', 'monthlyUnits']);
    if (reviews === null || units === null || !(units > 0)) continue;
    matched += 1;
    totalUnits += units;
    if (reviews < threshold) lowUnits += units;
  }
  if (!(totalUnits > 0)) return { share: null, threshold, matchedShare: 0, estimated: true };
  return {
    share: roundTo(clamp(lowUnits / totalUnits, 0, 1), 4),
    threshold,
    matchedShare: roundTo(matched / list.length, 4),
    estimated: matched < list.length,
  };
}
