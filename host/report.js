/**
 * dsh-amazon-research · host/report.js
 * 报告渲染：中文 Markdown 品类报告、scores.json、CSV 表格、纯内联 CSS 的 HTML 面板。
 *
 * 约束：纯函数 / ESM / 无网络 / 无第三方依赖（只依赖同目录 ./metrics.js）。
 * 刻度约定：Market.concentration / newRatio / distributions.unitsRatio 是 0~1 小数，展示 ×100；
 *   Market.structure.* 与 Sellersprite *Proportion / returnRatio 已是百分数（0~100），展示不再换算；
 *   HHI 为 0~10000。所有展示格式由本文件统一处理。
 * 安全：Markdown 表格会转义管道符；HTML 面板对所有插值做 HTML 转义，不使用 script/CDN/外链。
 */

import {
  aggregateBrandRows,
  brandHHI,
  crn,
  lowReviewShareFromProducts,
  lowReviewShareFromRatingsBuckets,
  priceBandStats,
  summarizeDistribution,
} from './metrics.js';
import { aggregateNetMargin } from './sourcing/cost-model.js';

/** 原始总分上限（92 分制）。 */
const SCORE_MAX = 92;

/** grade → 选品建议（与上游 scoring-standard.md 的评级建议一致）。 */
const GRADE_ADVICE = Object.freeze({
  优秀: '强烈推荐进入',
  良好: '可以考虑进入',
  一般: '谨慎进入',
  较差: '不建议进入',
});

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
function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** 是否普通对象（排除 null / 数组）。 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 安全取对象数组。 */
function toRows(value) {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

/**
 * 判断一个评分维度是否因缺数走了兜底档。
 * 优先级：inputs.missing（scoring 显式 boolean 标记）> inputs.estimated（推导估算，仅旧数据兜底）
 * > detail 文案回退（缺少/数据缺失/按最低档，兼容没有 missing 字段的旧 scores.json）。
 */
function isMissingDimension(dimension) {
  const inputs = dimension && isObject(dimension.inputs) ? dimension.inputs : {};
  if (typeof inputs.missing === 'boolean') return inputs.missing;
  if (inputs.estimated === true) return true;
  const detail = dimension && typeof dimension.detail === 'string' ? dimension.detail : '';
  return /缺少|数据缺失|按最低档/u.test(detail);
}

/** 千分位格式化整数。 */
function groupThousands(text) {
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 整数展示（千分位）；null 显示占位符。 */
function fmtInt(value) {
  const parsed = num(value);
  if (parsed === null) return '—';
  return groupThousands(String(Math.round(parsed)));
}

/** 普通数字展示（千分位 + 固定小数位）；null 显示占位符。 */
function fmtNum(value, digits = 2) {
  const parsed = num(value);
  if (parsed === null) return '—';
  const fixed = Math.abs(parsed).toFixed(digits);
  const parts = fixed.split('.');
  const sign = parsed < 0 ? '-' : '';
  return sign + groupThousands(parts[0]) + (parts.length > 1 ? '.' + parts[1] : '');
}

/** USD 金额展示（千分位 + 2 位小数）；null 显示占位符。 */
function fmtMoney(value) {
  const parsed = num(value);
  if (parsed === null) return '—';
  return '$' + fmtNum(parsed, 2);
}

/** 0~1 比例格式化成百分数（×100，保留 2 位小数）；null 显示占位符。 */
function fmtPct(ratio, digits = 2) {
  const parsed = num(ratio);
  if (parsed === null) return '—';
  return round(parsed * 100, digits).toFixed(digits) + '%';
}

/** USD 金额展示；缺数写「未取到」（第八章缺失标记口径）。 */
function fmtMoneyOrMissing(value) {
  const parsed = num(value);
  return parsed === null ? '未取到' : fmtMoney(parsed);
}

/** 0~1 比例展示；缺数写「未取到」（第八章缺失标记口径）。 */
function fmtPctOrMissing(value) {
  const parsed = num(value);
  return parsed === null ? '未取到' : fmtPct(parsed);
}

/** 已是百分数（0~100）的值直接展示；null 显示占位符。 */
function fmtPercentPoint(value, digits = 1) {
  const parsed = num(value);
  if (parsed === null) return '—';
  return parsed.toFixed(digits) + '%';
}

/** 把 0~1 或百分数（>1 时）统一成 0~1；非法值返回 null。 */
function asRatio(value) {
  const parsed = num(value);
  if (parsed === null || parsed < 0) return null;
  if (parsed > 1) return parsed <= 100 ? parsed / 100 : null;
  return parsed;
}

/** 把百分数（0~100）换算成 0~1；非法值返回 null。 */
function percentPointRatio(value) {
  const parsed = num(value);
  if (parsed === null || parsed < 0 || parsed > 100) return null;
  return parsed / 100;
}

/** 百分数原值校验（0~100）；非法返回 null。 */
function percentPointValue(value) {
  const parsed = num(value);
  if (parsed === null || parsed < 0 || parsed > 100) return null;
  return parsed;
}

/** 取行数组里第一个存在数字的键名；没有返回 null。 */
function firstNumericKey(rows, keys) {
  for (const key of keys) {
    if (rows.some((row) => num(row?.[key]) !== null)) return key;
  }
  return null;
}

/** 对行数组某键求和；都读不到数字时返回 null。 */
function sumRows(rows, key) {
  if (!key) return null;
  let total = 0;
  let seen = false;
  for (const row of rows) {
    const value = num(row?.[key]);
    if (value === null) continue;
    total += value;
    seen = true;
  }
  return seen ? total : null;
}

/** 字符串数组去重并过滤空值。 */
function uniqueStrings(values) {
  const result = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text !== '' && !result.includes(text)) result.push(text);
  }
  return result;
}

/** Markdown 表格单元格：转义管道符与换行，空值显示占位符。 */
function mdCell(value) {
  if (value === null || value === undefined || value === '') return '—';
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** 生成 Markdown 表格行数组（含表头与分隔行）。 */
function markdownTable(headers, rows) {
  const lines = [
    '| ' + headers.map(mdCell).join(' | ') + ' |',
    '| ' + headers.map(() => '---').join(' | ') + ' |',
  ];
  for (const row of rows) lines.push('| ' + row.map(mdCell).join(' | ') + ' |');
  return lines;
}

/** HTML 转义（所有面板插值都走这里，防止标签注入）。 */
function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

/** 截断长文本（用于报告里的产品标题）。 */
function truncate(text, maxLength = 46) {
  const value = String(text ?? '');
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength - 1) + '…';
}

/** HHI 集中度分档（US DOJ 经典刻度：<1500 低、<2500 中、>=2500 高）。 */
function concentrationLevel(hhi) {
  const parsed = num(hhi);
  if (parsed === null) return '数据缺失';
  if (parsed < 1500) return '低集中度';
  if (parsed < 2500) return '中度集中';
  return '高度集中';
}

/** 产品均值兜底：对指定字段求算术平均。 */
function averageOf(products, keys) {
  const values = [];
  for (const product of products) {
    for (const key of keys) {
      const parsed = num(product?.[key]);
      if (parsed !== null) {
        values.push(parsed);
        break;
      }
    }
  }
  if (values.length === 0) return null;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

/** 从 products 的卖家来源/卖家名推导 Amazon 自营销量占比（0~1）；无法推导返回 null。 */
function amazonRatioFromProducts(products) {
  let amazonUnits = 0;
  let totalUnits = 0;
  for (const product of products) {
    const units = num(product?.monthlySales);
    if (units === null || !(units > 0)) continue;
    totalUnits += units;
    const sellerSource = String(product.sellerSource ?? '');
    const seller = String(product.seller ?? '');
    if (/amazon|亚马逊/i.test(sellerSource) || /amazon/i.test(seller)) amazonUnits += units;
  }
  return totalUnits > 0 ? round(amazonUnits / totalUnits, 4) : null;
}

/** Amazon 自营占比取数：structure 百分数 → sellerType 分布 → products；都没有返回 null。 */
function deriveAmazonRatio(structure, sellerTypeRows, products) {
  const direct = percentPointRatio(structure.amazonSelfProportion);
  if (direct !== null) return direct;
  for (const row of sellerTypeRows) {
    const label = String(row.label ?? row.sellerType ?? row.type ?? '');
    if (!/amazon|亚马逊/i.test(label)) continue;
    const share = asRatio(row.unitsRatio ?? row.asinRatio);
    if (share !== null) return share;
  }
  return amazonRatioFromProducts(products);
}

/** 低评论销量占比取数（报告展示用）：显式字段 → ratingsCount 分桶 → products；都没有返回 null。 */
function deriveLowReviewRatio(market, ratingsCountRows, products) {
  const stats = isObject(market.stats) ? market.stats : {};
  for (const rawValue of [market.lowReviewsSalesShare, market.lowReviewsShare, stats.low_reviews_sales_volume_share]) {
    const share = asRatio(rawValue);
    if (share !== null) return { share, source: '显式字段' };
  }
  const bucket = lowReviewShareFromRatingsBuckets(ratingsCountRows, { threshold: 300 });
  if (bucket.share !== null) return { share: bucket.share, source: 'ratingsCount 分桶推导' };
  const product = lowReviewShareFromProducts(products, { threshold: 300 });
  if (product.share !== null) return { share: product.share, source: 'products 逐品推导' };
  return null;
}

/** 汇总报告/面板共用的数据视图（一次计算，两种渲染复用）。 */
function resolveReportMetrics(params) {
  const source = isObject(params) ? params : {};
  const market = isObject(source.market) ? source.market : {};
  const score = isObject(source.score) ? source.score : null;
  const site = String(source.site || market.marketplace || 'US');
  const generatedAt = String(source.generatedAt || market.fetchedAt || '');
  const label = String(market.label || market.nodeLabelPath || '未命名类目');
  const provider = String(market.provider || 'sellersprite');
  // 样本口径：market_research 的 totalUnits/totalRevenue 是 topNum=10 + size N 的抽样口径，
  // 不是 Top100 全量；size 优先从 market 上可能挂载的字段取，取不到时由报告提示以 manifest 为准。
  const sampleSize = (() => {
    for (const candidate of [market.params?.limit, market.limit, market.sampleSize, market.sampleLimit]) {
      const parsed = num(candidate);
      if (parsed !== null && parsed > 0) return parsed;
    }
    return null;
  })();

  const totals = isObject(market.totals) ? market.totals : {};
  const avgs = isObject(market.avgs) ? market.avgs : {};
  const concentration = isObject(market.concentration) ? market.concentration : {};
  const structure = isObject(market.structure) ? market.structure : {};
  const newRatio = isObject(market.newRatio) ? market.newRatio : {};
  const distributions = isObject(market.distributions) ? market.distributions : {};
  const products = toRows(market.products);

  const priceStats = priceBandStats(toRows(distributions.price));
  const ratingStats = summarizeDistribution(toRows(distributions.rating));
  const reviewStats = summarizeDistribution(toRows(distributions.ratingsCount));
  const sellerCountryStats = summarizeDistribution(toRows(distributions.sellerCountry));
  const sellerTypeStats = summarizeDistribution(toRows(distributions.sellerType));
  const ratingsCountRows = toRows(distributions.ratingsCount);
  const sellerTypeRows = toRows(distributions.sellerType);

  // 品牌行：优先用分布数据，缺失时用 products 聚合；HHI 一律按品牌级口径计算。
  let brandRows = toRows(distributions.brand);
  let brandSource = 'distributions.brand';
  if (brandRows.length === 0 && products.length > 0) {
    brandRows = aggregateBrandRows(products);
    brandSource = 'products 按品牌聚合';
  }
  const brandUnitsKey = firstNumericKey(brandRows, ['totalUnits', 'units']);
  const brandRevenueKey = firstNumericKey(brandRows, ['totalRevenue', 'revenue']);
  const brandUnitsSum = sumRows(brandRows, brandUnitsKey);
  const brandRevenueSum = sumRows(brandRows, brandRevenueKey);

  const totalRevenue = (() => {
    for (const candidate of [num(totals.revenue), priceStats.totalRevenue, brandRevenueSum, sumRows(products, 'monthlyRevenue')]) {
      if (typeof candidate === 'number' && candidate > 0) return candidate;
    }
    return null;
  })();
  const totalUnits = (() => {
    for (const candidate of [num(totals.units), brandUnitsSum, priceStats.totalUnits, sumRows(products, 'monthlySales')]) {
      if (typeof candidate === 'number' && candidate > 0) return candidate;
    }
    return null;
  })();
  // 品牌行若只覆盖 Top-N 样本（distributions.brandCoverage='sample'），
  // 不能拿类目全量做分母——那会把 HHI 压到接近 0。此时按样本内份额计算，并标注 estimated。
  const brandCoverage = market && market.distributions && typeof market.distributions.brandCoverage === 'string'
    ? market.distributions.brandCoverage
    : 'full';
  const hhiInfo = brandRows.length > 0
    ? brandHHI(
        brandRows,
        brandCoverage === 'sample'
          ? {}
          : { totalRevenue: totalRevenue ?? undefined, totalUnits: totalUnits ?? undefined },
      )
    : null;
  const hhiBasisLabel = hhiInfo && hhiInfo.basis === 'brand_revenue' ? '品牌月销额' : '品牌月销量';

  const derivedUnitsCr3 = brandRows.length > 0 && brandUnitsSum > 0 ? crn(brandRows, brandUnitsKey, 3) : null;
  const derivedRevenueCr3 = brandRows.length > 0 && brandRevenueSum > 0 ? crn(brandRows, brandRevenueKey, 3) : null;
  const brandCr3 = asRatio(concentration.top3BrandCrn) ?? ((derivedUnitsCr3 ?? 0) > 0 ? derivedUnitsCr3 : (derivedRevenueCr3 ?? 0) > 0 ? derivedRevenueCr3 : null);
  const brandCr5 = asRatio(concentration.top5BrandCrn) ?? (brandRows.length > 0 && brandUnitsSum > 0 ? crn(brandRows, brandUnitsKey, 5) : null);
  const brandCr10 = asRatio(concentration.top10BrandCrn) ?? (brandRows.length > 0 && brandUnitsSum > 0 ? crn(brandRows, brandUnitsKey, 10) : null);
  const productCr3 = asRatio(concentration.top3ProductCrn);
  const sellerCr3 = asRatio(concentration.top3SellerCrn);

  const amazonRatio = deriveAmazonRatio(structure, sellerTypeRows, products);
  const lowReview = deriveLowReviewRatio(market, ratingsCountRows, products);

  const avgPrice = (() => {
    const direct = num(avgs.price);
    if (direct !== null && direct > 0) return direct;
    const weighted = priceStats.totalRevenue > 0 && priceStats.totalUnits > 0
      ? priceStats.totalRevenue / priceStats.totalUnits
      : null;
    if (weighted !== null) return weighted;
    const fromProducts = averageOf(products, ['price']);
    if (fromProducts !== null) return fromProducts;
    return totalRevenue !== null && totalUnits !== null ? totalRevenue / totalUnits : null;
  })();
  const avgRating = num(avgs.rating) ?? averageOf(products, ['rating']);
  const avgRatings = num(avgs.ratings) ?? averageOf(products, ['reviews']);

  const structureValues = {
    fba: percentPointValue(structure.fbaProportion),
    fbm: percentPointValue(structure.fbmProportion),
    amazonSelf: percentPointValue(structure.amazonSelfProportion),
    returnRatio: percentPointValue(structure.returnRatio),
  };
  const newRatios = {
    l1: asRatio(newRatio.l1),
    l3: asRatio(newRatio.l3),
    l6: asRatio(newRatio.l6),
    l12: asRatio(newRatio.l12),
  };

  const scoreDimensions = (score && Array.isArray(score.dimensions) ? score.dimensions : [])
    .filter(isObject)
    .map((dimension) => {
      const dimScore = num(dimension.score) ?? 0;
      const dimMax = num(dimension.max) ?? 0;
      return {
        key: String(dimension.key ?? ''),
        label: String(dimension.label ?? dimension.key ?? '维度'),
        score: dimScore,
        max: dimMax,
        normalized: num(dimension.normalized) ?? (dimMax > 0 ? round((dimScore / dimMax) * 100, 1) : 0),
        detail: typeof dimension.detail === 'string' ? dimension.detail : '',
        inputs: isObject(dimension.inputs) ? dimension.inputs : {},
      };
    });
  const scoreAvailable = score !== null && (scoreDimensions.length > 0 || num(score.total) !== null);
  const total = num(score?.total) ?? scoreDimensions.reduce((acc, dimension) => acc + dimension.score, 0);
  const totalMax = num(score?.max) ?? SCORE_MAX;
  const normalized = num(score?.normalized) ?? (totalMax > 0 ? round((total / totalMax) * 100, 1) : 0);
  const grade = scoreAvailable
    ? (typeof score.grade === 'string' && score.grade !== '' ? score.grade : (normalized >= 80 ? '优秀' : normalized >= 60 ? '良好' : normalized >= 40 ? '一般' : '较差'))
    : '未评分';
  const scoreNotes = score && Array.isArray(score.notes) ? score.notes.filter((note) => typeof note === 'string') : [];

  // 数据质量守卫：维度 inputs.estimated===true 表示该维度因缺数走了最低档。
  // 缺 2 个维度起，兜底评级可能偏乐观，结论不再为「进入」背书（与 SKILL.md 的数据纪律一致）。
  const estimatedDimensions = scoreDimensions.filter((dimension) => isMissingDimension(dimension));
  const missingDimensions = estimatedDimensions.length;
  const dataQuality = scoreAvailable ? (missingDimensions >= 3 ? 'D' : missingDimensions === 2 ? 'C' : missingDimensions === 1 ? 'B' : 'A') : null;
  const qualitySuppressed = dataQuality === 'C' || dataQuality === 'D';
  const advice = qualitySuppressed
    ? '数据质量 ' + dataQuality + '（' + missingDimensions + ' 个维度缺数）：兜底评级仅供参考，建议补数后再评，不构成进入建议'
    : (GRADE_ADVICE[grade] ?? '需先完成取数与评分');

  const warnings = uniqueStrings([
    ...(Array.isArray(market.warnings) ? market.warnings : []),
    ...(Array.isArray(source.warnings) ? source.warnings : []),
  ]);

  const rankedDimensions = [...scoreDimensions].sort((a, b) => b.normalized - a.normalized);
  const bestDimension = rankedDimensions.length > 0 ? rankedDimensions[0] : null;
  const worstDimension = rankedDimensions.length > 0 ? rankedDimensions[rankedDimensions.length - 1] : null;

  const checks = [
    {
      name: '类目容量过小',
      rule: '样本月销额 < $1,000,000（抽样口径）',
      value: fmtMoney(totalRevenue),
      status: totalRevenue === null ? '数据缺失' : (totalRevenue < 1_000_000 ? '触发' : '未触发'),
    },
    {
      name: '品牌高度集中',
      rule: 'Top3 品牌销量占比 ≥ 60%',
      value: fmtPct(brandCr3),
      status: brandCr3 === null ? '数据缺失' : (brandCr3 >= 0.6 ? '触发' : '未触发'),
    },
    {
      name: 'Amazon 自营挤压',
      rule: 'Amazon 自营销量占比 ≥ 40%',
      value: fmtPct(amazonRatio),
      status: amazonRatio === null ? '数据缺失' : (amazonRatio >= 0.4 ? '触发' : '未触发'),
    },
    {
      name: '价格带过低',
      rule: '平均价格 < $15',
      value: fmtMoney(avgPrice),
      status: avgPrice === null ? '数据缺失' : (avgPrice < 15 ? '触发' : '未触发'),
    },
    {
      name: 'HHI 高集中',
      rule: '品牌 HHI ≥ 2,500（0~10000）',
      value: hhiInfo ? fmtNum(hhiInfo.hhi, 2) : '—',
      status: hhiInfo === null ? '数据缺失' : (hhiInfo.hhi >= 2500 ? '触发' : '未触发'),
    },
    {
      name: '退货率偏高',
      rule: '退货率 > 10%',
      value: structureValues.returnRatio === null ? '—' : fmtPercentPoint(structureValues.returnRatio),
      status: structureValues.returnRatio === null ? '数据缺失' : (structureValues.returnRatio > 10 ? '触发' : '未触发'),
    },
  ];

  const missing = [];
  if (totalRevenue === null) missing.push('totals.revenue（样本月销额）');
  if (totalUnits === null) missing.push('totals.units（样本月销量）');
  if (!(num(avgs.price) > 0)) missing.push('avgs.price（平均价格）');
  if (products.length === 0) missing.push('products（头部商品明细，product_research 可选）');
  if (brandRows.length === 0) missing.push('distributions.brand（品牌分布）');
  if (priceStats.rows.length === 0) missing.push('distributions.price（价格带分布）');
  if (ratingStats.rows.length === 0) missing.push('distributions.rating（评分分布）');
  if (reviewStats.rows.length === 0) missing.push('distributions.ratingsCount（评论数分布）');
  if (sellerCountryStats.rows.length === 0) missing.push('distributions.sellerCountry（卖家所属地分布）');
  if (sellerTypeStats.rows.length === 0) missing.push('distributions.sellerType（发货/卖家类型分布）');
  if (brandCr3 === null) missing.push('concentration.top3BrandCrn（Top3 品牌集中度）');
  if (productCr3 === null) missing.push('concentration.top3ProductCrn（Top3 商品集中度）');
  if (sellerCr3 === null) missing.push('concentration.top3SellerCrn（Top3 卖家集中度）');
  if (amazonRatio === null) missing.push('structure.amazonSelfProportion（Amazon 自营占比）');
  if (lowReview === null) missing.push('低评论销量占比（ratingsCount / products 均不可推导）');
  if (Object.values(newRatios).every((value) => value === null)) missing.push('newRatio（新品占比 l1/l3/l6/l12）');

  // 第八章数据：1688 采价明细 + 全成本净利测算（没有 costs 时整章不产出）。
  const sourcingRows = toRows(market.sourcing).length > 0 ? toRows(market.sourcing) : toRows(source.sourcing);
  const profitRows = toRows(market.profitBySubMarket).length > 0 ? toRows(market.profitBySubMarket) : toRows(source.profitBySubMarket);
  const profitTotalUnits = num(market.profitTotalUnits ?? source.profitTotalUnits)
    ?? (() => {
      let total = 0;
      let seen = false;
      for (const row of toRows(market.subMarkets)) {
        const units = num(row.totalUnits);
        if (units !== null && units > 0) {
          total += units;
          seen = true;
        }
      }
      return seen ? total : null;
    })();
  const profitAggregate = profitRows.length > 0 ? aggregateNetMargin(profitRows, { totalUnits: profitTotalUnits }) : null;
  const profit = {
    available: profitRows.length > 0 || sourcingRows.length > 0,
    rows: profitRows,
    sourcing: sourcingRows,
    aggregate: profitAggregate,
    netMargin: num(market.profitNetMargin ?? source.profitNetMargin) ?? (profitAggregate ? profitAggregate.netMargin : null),
    basis: String(market.profitBasis ?? source.profitBasis ?? (profitAggregate ? profitAggregate.basis : '')),
    coverageRatio: num(market.profitCoverage ?? source.profitCoverage) ?? (profitAggregate ? profitAggregate.coverageRatio : null),
    coveredUnits: num(market.profitCoveredUnits ?? source.profitCoveredUnits) ?? (profitAggregate ? profitAggregate.coveredUnits : null),
    totalUnits: profitTotalUnits,
    subMarketCount: profitRows.length,
    scopeNote: String(market.profitScopeNote ?? source.profitScopeNote ?? ''),
  };

  return {
    label,
    site,
    generatedAt,
    provider,
    sampleSize,
    marketplace: String(market.marketplace || ''),
    month: String(market.month || ''),
    nodeIdPath: String(market.nodeIdPath || ''),
    fetchedAt: String(market.fetchedAt || ''),
    totals: { products: num(totals.products), units: totalUnits, revenue: totalRevenue },
    avgs: { price: avgPrice, rating: avgRating, ratings: avgRatings, units: num(avgs.units), revenue: num(avgs.revenue), bsr: num(avgs.bsr) },
    concentration: { productCr3, brandCr3, brandCr5, brandCr10, sellerCr3 },
    structure: structureValues,
    newRatios,
    hhiInfo,
    hhiBasisLabel,
    brandRows,
    brandSource,
    brandUnitsKey,
    brandRevenueKey,
    brandUnitsSum,
    brandRevenueSum,
    priceStats,
    ratingStats,
    reviewStats,
    sellerCountryStats,
    sellerTypeStats,
    amazonRatio,
    lowReview,
    products,
    dimensions: scoreDimensions,
    scoreAvailable,
    total,
    totalMax,
    normalized,
    grade,
    advice,
    dataQuality,
    missingDimensions,
    qualitySuppressed,
    bestDimension,
    worstDimension,
    weakDimensions: scoreDimensions.filter((dimension) => dimension.normalized < 50),
    checks,
    missing,
    warnings,
    scoreNotes,
    profit,
  };
}

/** 生成 Markdown 报告的「Top 品牌」表格行。 */
function brandTableRows(view) {
  const rows = [...view.brandRows].sort((a, b) => {
    const revenueA = num(a?.[view.brandRevenueKey]) ?? 0;
    const revenueB = num(b?.[view.brandRevenueKey]) ?? 0;
    if (revenueA !== revenueB) return revenueB - revenueA;
    return (num(b?.[view.brandUnitsKey]) ?? 0) - (num(a?.[view.brandUnitsKey]) ?? 0);
  }).slice(0, 10);
  return rows.map((row, index) => {
    const units = num(row[view.brandUnitsKey]);
    const share = view.brandUnitsSum > 0 && units !== null ? units / view.brandUnitsSum : null;
    return [
      index + 1,
      String(row.brand ?? row.label ?? '未知品牌'),
      fmtInt(row.products ?? row.productNum),
      fmtInt(units),
      fmtMoney(row[view.brandRevenueKey]),
      fmtPct(share),
      fmtMoney(row.avgPrice),
      num(row.rating) === null ? '—' : fmtNum(row.rating, 2),
    ];
  });
}

/** 渲染中文 Markdown 品类报告（结论先行，含五维评分表、大盘、集中度、价格带、风险与数据来源）。 */
export function renderCategoryReport(params = {}) {
  const view = resolveReportMetrics(params);
  const lines = [];
  const push = (...items) => lines.push(...items);

  push('# ' + view.label + '（' + view.site + '）品类选品分析报告', '');
  push('> 数据来源：' + view.provider + ' ｜ 数据月份：' + (view.month || '—') + ' ｜ 报告生成：' + (view.generatedAt || '—'), '');
  push('---', '');

  // 一、结论摘要（结论先行）
  push('## 一、结论摘要', '');
  if (view.scoreAvailable) {
    push('**评级：' + view.grade + (view.qualitySuppressed ? '（兜底，数据质量 ' + view.dataQuality + '）' : '') + '** ｜ 原始总分 **' + view.total + ' / ' + view.totalMax + '** ｜ 归一化 **' + view.normalized + ' / 100** ｜ 建议：**' + view.advice + '**', '');
    if (view.bestDimension && view.worstDimension) {
      push('> ' + view.label + ' 在「' + view.bestDimension.label + '」维度表现最好（归一化 ' + view.bestDimension.normalized + '%），短板在「' + view.worstDimension.label + '」（归一化 ' + view.worstDimension.normalized + '%）；综合评级「' + view.grade + '」，建议' + view.advice + '。', '');
    }
  } else {
    push('**未评分**：本次运行未提供评分结果，请先完成取数与五维评分。', '');
  }
  push('- **市场容量**：样本月销额 ' + fmtMoney(view.totals.revenue) + '，样本月销量 ' + fmtInt(view.totals.units) + '，在售商品 ' + fmtInt(view.totals.products) + '（抽样口径，见第七节）。');
  push('- **竞争格局**：Top3 品牌销量占比 ' + fmtPct(view.concentration.brandCr3) + '，Amazon 自营占比 ' + fmtPct(view.amazonRatio) + '，品牌 HHI ' + (view.hhiInfo ? fmtNum(view.hhiInfo.hhi, 2) + '（' + concentrationLevel(view.hhiInfo.hhi) + '）' : '—') + '。');
  push('- **价格与需求**：平均价格 ' + fmtMoney(view.avgs.price) + '，平均星级 ' + (num(view.avgs.rating) === null ? '—' : fmtNum(view.avgs.rating, 2)) + '，平均评论数 ' + fmtInt(view.avgs.ratings) + '，低评论销量占比 ' + (view.lowReview ? fmtPct(view.lowReview.share) + '（' + view.lowReview.source + '）' : '—') + '。');
  push('- **数据质量**：市场警告 ' + view.warnings.length + ' 条，评分备注 ' + view.scoreNotes.length + ' 条，缺失字段 ' + view.missing.length + ' 项，兜底维度 ' + view.missingDimensions + ' 个' + (view.dataQuality ? '（质量等级 ' + view.dataQuality + '）' : '') + '（见第七节）。');
  push('');

  // 二、五维评分
  push('## 二、五维评分', '');
  push('> 评分口径：上游五维模型原始上限 **92 分**（增长潜力实际最高 22/25、竞争烈度 18/20、利润空间 12/15）；归一化 = 总分 ÷ 92 × 100。评级：≥80 优秀、≥60 良好、≥40 一般、<40 较差（用户已拍板保持 92 分上限，不改为 100 分制）。', '');
  if (view.scoreAvailable && view.dimensions.length > 0) {
    const rows = view.dimensions.map((dimension) => [
      dimension.label,
      dimension.score + ' / ' + dimension.max,
      dimension.normalized + '%',
      dimension.detail,
    ]);
    push(...markdownTable(['维度', '得分 / 实际满分', '归一化', '判读与取数依据'], rows));
    push('| **总分** | **' + view.total + ' / ' + view.totalMax + '** | **' + view.normalized + '%** | **' + view.grade + ' · ' + view.advice + '** |', '');
  } else {
    push('（未提供五维评分结果：dimensions 为空。）', '');
  }
  if (view.scoreNotes.length > 0) {
    push('评分备注：', '');
    for (const note of view.scoreNotes) push('- ' + note);
    push('');
  }

  // 三、市场大盘
  push('## 三、市场大盘', '');
  push('### 3.1 类目与样本', '');
  push(...markdownTable(['项目', '数值'], [
    ['类目', view.label],
    ['站点', view.site],
    ['数据月份', view.month || '—'],
    ['类目节点路径', view.nodeIdPath || '—'],
    ['在售商品总数', fmtInt(view.totals.products)],
    ['样本月销量（抽样口径）', fmtInt(view.totals.units)],
    ['样本月销额（抽样口径）', fmtMoney(view.totals.revenue)],
  ]));
  push('');
  push('### 3.2 均值与卖家结构', '');
  push(...markdownTable(['指标', '数值'], [
    ['平均价格', fmtMoney(view.avgs.price)],
    ['平均月销量', fmtInt(view.avgs.units)],
    ['平均月销额', fmtMoney(view.avgs.revenue)],
    ['平均 BSR', fmtInt(view.avgs.bsr)],
    ['平均星级', num(view.avgs.rating) === null ? '—' : fmtNum(view.avgs.rating, 2)],
    ['平均评论数', fmtInt(view.avgs.ratings)],
    ['FBA 占比（百分数原样）', fmtPercentPoint(view.structure.fba)],
    ['FBM 占比（百分数原样）', fmtPercentPoint(view.structure.fbm)],
    ['Amazon 自营占比（百分数原样）', fmtPercentPoint(view.structure.amazonSelf)],
    ['退货率（百分数原样）', fmtPercentPoint(view.structure.returnRatio)],
    ['L1 新品占比', fmtPct(view.newRatios.l1)],
    ['L3 新品占比', fmtPct(view.newRatios.l3)],
    ['L6 新品占比', fmtPct(view.newRatios.l6)],
    ['L12 新品占比', fmtPct(view.newRatios.l12)],
  ]));
  push('');

  // 四、品牌 / 卖家集中度
  push('## 四、品牌与卖家集中度', '');
  push('### 4.1 集中度指标', '');
  const hhiValue = view.hhiInfo
    ? fmtNum(view.hhiInfo.hhi, 2) + '（' + concentrationLevel(view.hhiInfo.hhi) + '）'
    : '—';
  const hhiNote = view.hhiInfo
    ? '0~10000，按' + view.hhiBasisLabel + '；覆盖 ' + fmtPct(view.hhiInfo.coveredShare) + (view.hhiInfo.estimated ? '（估算值）' : '（非估算）')
    : '品牌行缺失，无法计算';
  push(...markdownTable(['指标', '数值', '口径说明'], [
    ['Top3 商品集中度', fmtPct(view.concentration.productCr3), '0~1 字段 ×100，头部 3 个 ASIN 销量占比'],
    ['Top3 品牌集中度', fmtPct(view.concentration.brandCr3), '0~1 字段 ×100，品牌级销量占比（非产品级）'],
    ['Top5 品牌集中度', fmtPct(view.concentration.brandCr5), '0~1 字段 ×100'],
    ['Top10 品牌集中度', fmtPct(view.concentration.brandCr10), '0~1 字段 ×100'],
    ['Top3 卖家集中度', fmtPct(view.concentration.sellerCr3), '0~1 字段 ×100'],
    ['品牌 HHI', hhiValue, hhiNote],
  ]));
  push('');
  if (view.brandRows.length > 0) {
    push('### 4.2 Top 品牌（最多 10 个，按' + (view.brandRevenueKey ? '月销额' : '月销量') + '）', '');
    push(...markdownTable(['排名', '品牌', '商品数', '月销量', '月销额', '销量占比', '均价', '平均星级'], brandTableRows(view)));
    push('');
  } else {
    push('### 4.2 Top 品牌', '', '（品牌分布与产品明细均缺失，无法列出 Top 品牌。）', '');
  }
  push('### 4.3 卖家所属地分布', '');
  if (view.sellerCountryStats.rows.length > 0) {
    push(...markdownTable(['卖家所属地', '商品数', '月销量', '销量占比', '月销额'], view.sellerCountryStats.rows.map((row) => [
      row.label, fmtInt(row.products), fmtInt(row.units), fmtPct(row.unitsShare), fmtMoney(row.revenue),
    ])));
  } else {
    push('（数据缺失：distributions.sellerCountry 为空。）');
  }
  push('');
  push('### 4.4 发货 / 卖家类型分布', '');
  if (view.sellerTypeStats.rows.length > 0) {
    push(...markdownTable(['类型', 'ASIN 数', '月销量', '销量占比'], view.sellerTypeStats.rows.map((row) => [
      row.label, fmtInt(row.products), fmtInt(row.units), fmtPct(row.unitsShare),
    ])));
  } else {
    push('（数据缺失：distributions.sellerType 为空。）');
  }
  push('');

  // 五、价格带与评论结构
  push('## 五、价格带与评论结构', '');
  push('### 5.1 价格带分布', '');
  if (view.priceStats.rows.length > 0) {
    push(...markdownTable(['价格带', '商品数', '月销量', '销量占比', '月销额', '销额占比'], view.priceStats.rows.map((row) => [
      row.label, fmtInt(row.products), fmtInt(row.units), fmtPct(row.unitsShare), fmtMoney(row.revenue), row.revenueShare === null ? '—' : fmtPct(row.revenueShare),
    ])));
    push('');
    if (view.priceStats.topBand) {
      push('销量最高的价格带：**' + view.priceStats.topBand.label + '**（销量占比 ' + fmtPct(view.priceStats.topBand.unitsShare) + '）；前 3 个价格带合计销量占比 ' + fmtPct(view.priceStats.top3UnitsShare) + '。', '');
    }
  } else {
    push('（数据缺失：distributions.price 为空。）', '');
  }
  push('### 5.2 评分分布', '');
  if (view.ratingStats.rows.length > 0) {
    push(...markdownTable(['评分区间', '商品数', '月销量', '销量占比'], view.ratingStats.rows.map((row) => [
      row.label, fmtInt(row.products), fmtInt(row.units), fmtPct(row.unitsShare),
    ])));
  } else {
    push('（数据缺失：distributions.rating 为空。）');
  }
  push('');
  push('### 5.3 评论数分布', '');
  if (view.reviewStats.rows.length > 0) {
    push(...markdownTable(['评论数区间', '商品数', '月销量', '销量占比'], view.reviewStats.rows.map((row) => [
      row.label, fmtInt(row.products), fmtInt(row.units), fmtPct(row.unitsShare),
    ])));
  } else {
    push('（数据缺失：distributions.ratingsCount 为空。）');
  }
  push('');
  if (view.lowReview) {
    push('低评论（评论数 < 300）产品销量占比：**' + fmtPct(view.lowReview.share) + '**（来源：' + view.lowReview.source + '）。', '');
  } else {
    push('低评论占比无法推导（ratingsCount 与 products 评论数明细均缺失，评分该维度已按最低档处理）。', '');
  }

  // 六、风险与一票否决
  push('## 六、风险与一票否决提示', '');
  push(...markdownTable(['检查项', '判定阈值', '当前值', '判定'], view.checks.map((check) => [check.name, check.rule, check.value, check.status])));
  push('');
  const triggered = view.checks.filter((check) => check.status === '触发');
  const unknown = view.checks.filter((check) => check.status === '数据缺失');
  if (triggered.length > 0) {
    push('**触发的一票否决提示（初筛拦截，需人工复核）**：', '');
    for (const check of triggered) push('- ' + check.name + '：当前 ' + check.value + '，阈值 ' + check.rule + '。');
    push('');
  } else {
    push('未触发上述一票否决项（仍建议结合供应链、合规与资金做二次尽调）。', '');
  }
  if (unknown.length > 0) {
    push('数据缺失导致无法判定的检查项：' + unknown.map((check) => check.name).join('、') + '。', '');
  }
  if (view.weakDimensions.length > 0) {
    push('**维度短板**：', '');
    for (const dimension of view.weakDimensions) {
      push('- ' + dimension.label + '：' + dimension.score + ' / ' + dimension.max + '（归一化 ' + dimension.normalized + '%）。');
    }
    push('');
  }
  if (view.warnings.length > 0) {
    push('**市场数据警告**：', '');
    for (const warning of view.warnings) push('- ' + warning);
    push('');
  }

  // 七、数据来源与缺失清单
  push('## 七、数据来源与缺失清单', '');
  push('### 7.1 数据来源', '');
  push(...markdownTable(['项目', '值'], [
    ['数据源 provider', view.provider],
    ['站点 marketplace', view.marketplace || view.site],
    ['数据月份', view.month || '—'],
    ['类目', view.label],
    ['类目节点', view.nodeIdPath || '—'],
    ['数据抓取时间', view.fetchedAt || '—'],
    ['报告生成时间', view.generatedAt || '—'],
    ['样本口径', 'topNum 10 / size ' + (view.sampleSize !== null ? String(view.sampleSize) : '以 manifest.params.limit 为准')],
  ]));
  push('');
  push('### 7.2 缺失字段清单', '');
  if (view.missing.length > 0) {
    for (const item of view.missing) push('- ' + item);
  } else {
    push('无（核心字段齐全）。');
  }
  push('');
  push('### 7.3 口径与免责声明', '');
  push('- 五维评分为上游模型的 92 分制档位评分：增长潜力实际最高 22、竞争烈度 18、利润空间 12；归一化 = 总分 ÷ 92 × 100，评级 ≥80 优秀 / ≥60 良好 / ≥40 一般 / <40 较差。');
  push('- 缺失数据一律走该维度最低档并写入评分备注，不编造数据；缺 ≥2 个维度时仍输出评级，但结论仅供初筛。');
  push('- HHI 为品牌级口径（0~10000）；上游历史上曾误用产品级份额，本报告不复刻该错误。');
  push('- 本报告由 dsh-amazon-research 分析引擎生成，仅供选品初筛，不构成投资或经营建议。');
  push('');

  // 八、1688 采购价与净利测算
  push('## 八、1688 采购价与净利测算', '');
  if (!view.profit.available) {
    push('未接入 1688 采购成本，本章不产出。', '');
    push('> 说明：利润空间维度当前按「平均价格带」兜底评分（第二节），仅供初筛；接入 1688 真实采购价后可重算为**净利率口径**（售价 − 采购 − 头程 − FBA − 佣金 − 广告 − 退货 − 其它）。', '');
  } else {
    push('> **口径（务必先读）**：本章是**净利率口径** —— 净利率 = （售价 − 采购 − 头程 − FBA − 佣金 − 广告 − 退货 − 其它）÷ 售价；第二节上游五维的「毛利率」只扣采购成本，**两者不可直接比较**，本页数值低于「卖家精灵毛利率」属正常（我们额外扣了佣金 / 广告 / 退货）。', '');
    push('> **红线（与《亚马逊选品实操指南》一致）**：净利率 > 25% 才考虑；体量小（100–200 单）需 > 30%；物流（头程 + FBA）占售价目标 10%–15%，> 20% 提示放弃；$15–20 售价段采购价 ≤ ¥30 且 FBA < $4.5。', '');
    if (view.profit.basis) {
      push('> **加权方式**：' + view.profit.basis
        + (view.profit.coverageRatio !== null
          ? '，覆盖 ' + view.profit.subMarketCount + ' 个细分市场，占子市场总销量 ' + fmtPct(view.profit.coverageRatio)
            + '（**非全类目净利率**，只是这 ' + view.profit.subMarketCount + ' 个主力细分的加权值）'
          : '，覆盖 ' + view.profit.subMarketCount + ' 个细分市场'), '');
    }
    if (view.profit.scopeNote) push('> ' + view.profit.scopeNote, '');

    if (view.profit.rows.length > 0) {
      push('### 8.1 逐子市场全成本测算', '');
      const rows = view.profit.rows.map((row) => {
        const fbaCell = num(row.fbaFeeUSD) === null
          ? '未取到'
          : fmtMoney(row.fbaFeeUSD) + '（' + (row.fbaEstimated === false ? '实测' : '估算') + '）';
        return [
          String(row.name ?? '—'),
          fmtMoneyOrMissing(row.priceUSD),
          fmtMoneyOrMissing(row.purchaseUSD),
          fmtMoneyOrMissing(row.firstMileUSD),
          fbaCell,
          fmtMoneyOrMissing(row.referralUSD),
          fmtMoneyOrMissing(row.adUSD),
          fmtMoneyOrMissing(row.returnUSD),
          fmtMoneyOrMissing(row.otherUSD),
          fmtMoneyOrMissing(row.totalCostUSD),
          fmtMoneyOrMissing(row.netProfitUSD ?? row.grossProfitUSD),
          fmtPctOrMissing(row.netMargin),
          fmtPctOrMissing(row.logisticsRatio),
          fmtPctOrMissing(row.purchaseRatio),
          num(row.sellerSpriteMargin) === null ? '未取到' : fmtPercentPoint(row.sellerSpriteMargin) + '（参照）',
          String(row.verdict ?? '未判定'),
        ];
      });
      push(...markdownTable(
        ['子市场', '售价', '采购$', '头程$', 'FBA$', '佣金$', '广告$', '退货$', '其它$', '全成本$', '净利$', '净利率', '物流占售价', '采购占售价', '卖家精灵毛利率（参照）', '判定'],
        rows,
      ));
      push('');
      push('> 表内「净利$」= 售价 − 全成本$；「净利率」= 净利$ ÷ 售价。FBA 费标注（实测/估算）：实测 = 卖家精灵逐 ASIN fbaFee 中位数，估算 = 按件重档位推算。', '');
      push('> 「卖家精灵毛利率（参照）」是卖家精灵自有口径的毛利率，**不是净利率**，仅作行业参照，不要与本页净利率混算。', '');

      push('### 8.2 逐子市场红线判定明细', '');
      for (const row of view.profit.rows) {
        const checks = Array.isArray(row.checks) ? row.checks : [];
        push('**' + String(row.name ?? '—') + '**（售价 ' + fmtMoney(row.priceUSD) + '，判定：**' + String(row.verdict ?? '未判定') + '**）', '');
        if (checks.length === 0) {
          push('- ' + (row.reason ? String(row.reason) : '（无判定明细）'), '');
          continue;
        }
        for (const check of checks) {
          push('- ' + check.name + '：' + check.value + '（阈值 ' + check.rule + '）→ **' + check.status + '**' + (check.note ? '；' + check.note : ''));
        }
        if (num(row.maxPurchaseCNY) !== null) {
          push('- 净利率 25% 红线倒推：采购价上限 **¥' + num(row.maxPurchaseCNY).toFixed(2) + '/件**（含头程与 FBA；实际 1688 采购价高于此值即过不了红线）');
        }
        push('');
      }

      push('### 8.3 类目加权净利率与利润空间维度', '');
      const agg = view.profit.aggregate;
      const netMarginText = num(view.profit.netMargin) === null ? '未取到' : fmtPct(view.profit.netMargin);
      push(...markdownTable(['项目', '数值'], [
        ['加权净利率', netMarginText + (view.profit.basis ? '（' + view.profit.basis + '）' : '')],
        ['参与加权子市场数', String(view.profit.subMarketCount)],
        ['覆盖子市场总销量', view.profit.coverageRatio === null ? '未取到' : fmtPct(view.profit.coverageRatio)],
        ['净利率区间（子市场最小–最大）', agg && agg.min !== null ? fmtPct(agg.min) + ' – ' + fmtPct(agg.max) : '未取到'],
        ['未算出净利率的子市场数', agg ? String(agg.missingCount) : '0'],
        ['主红线', '净利率 > 25%（体量小需 > 30%）'],
        ['物流红线', '占售价 10%–15% 为理想带，> 20% 提示放弃'],
      ]));
      push('');
      if (view.profit.scopeNote) push('> ' + view.profit.scopeNote, '');
    }

    if (view.profit.sourcing.length > 0) {
      push('### 8.4 1688 采购明细', '');
      push(...markdownTable(
        ['子市场', '关键词', 'offerId', '采购价（元）/可售单位', '包装规格对齐', 'Amazon 包装数', '起批量', '材质', '件重（g）', '链接', '验证状态'],
        view.profit.sourcing.map((row) => [
          String(row.name ?? '—'),
          String(row.keyword ?? '—'),
          String(row.offerId ?? '未取到'),
          num(row.priceCNY) === null ? '未取到' : num(row.priceCNY).toFixed(2),
          row.packSize ? String(row.packSize) : '未取到',
          num(row.amazonPackMedian) === null ? '未取到' : num(row.amazonPackMedian) + ' 件（中位）',
          row.moq !== undefined && row.moq !== null ? String(row.moq) : String(row.moqText ?? '未取到'),
          String(row.material ?? '未取到'),
          num(row.weightG) === null ? '未取到' : num(row.weightG).toFixed(1),
          row.offerUrl ? String(row.offerUrl) : '未取到',
          row.verified === true ? '已进详情页验证' : (row.verified === false ? '未验证（仅搜索页卡片级）' : '未取到'),
        ]),
      ));
      push('');
      push('> **「采购价（元）/可售单位」是本页最关键的一列**：1688 的入口价几乎都是**单件价**，而 Amazon 售价对应的是**一个可售单位**（例如脚垫常见 48/104/162 片装、挂架 20/50 个装）。直接拿单件价对 Amazon 售价算利润会把采购成本低估 10~100 倍。本页价格已按「包装规格对齐」换算：先从 1688 详情页取多件装档（如「4个装¥1 / 8个装¥2.2 / 16个装¥4.5 / 20个装¥5.5」），再按 Amazon 侧实测包装数选整包数；Amazon 侧包装数来自前台搜索页标题实测（每细分 48 条结果）。', '');
      const alignNotes = view.profit.sourcing
        .map((row) => (row.alignNote ? '**' + String(row.name ?? '—') + '**：' + String(row.alignNote) : null))
        .filter(Boolean);
      if (alignNotes.length) {
        push('逐细分对齐说明：', '');
        for (const note of alignNotes) push('- ' + note);
        push('');
      }
      const weightNotes = view.profit.sourcing
        .map((row) => (row.weightBasis ? '**' + String(row.name ?? '—') + '**：' + String(row.weightBasis) : null))
        .filter(Boolean);
      if (weightNotes.length) {
        push('件重口径：', '');
        for (const note of weightNotes) push('- ' + note);
        push('');
      }
    }

    push('> **合规提醒**：1688 的图片不要直接用（工厂自述「实拍」不可信），上架前需自查图片素材版权与外观专利；外观专利存在 5 个以上结构差异才不构成侵权，实用新型 / 发明专利另查。', '');
  }

  // 附录：Top 产品
  if (view.products.length > 0) {
    push('## 附录：Top 10 产品', '');
    const rows = [...view.products].sort((a, b) => {
      const revenueA = num(a.monthlyRevenue) ?? 0;
      const revenueB = num(b.monthlyRevenue) ?? 0;
      if (revenueA !== revenueB) return revenueB - revenueA;
      return (num(b.monthlySales) ?? 0) - (num(a.monthlySales) ?? 0);
    }).slice(0, 10).map((product, index) => [
      index + 1,
      String(product.asin ?? product['ASIN'] ?? '—'),
      truncate(product.title ?? product['标题'] ?? '—'),
      String(product.brand ?? product['品牌'] ?? '—'),
      fmtMoney(product.price ?? product['价格']),
      fmtInt(product.monthlySales ?? product['月销量']),
      fmtMoney(product.monthlyRevenue ?? product['月销额']),
      num(product.rating ?? product['星级']) === null ? '—' : fmtNum(product.rating ?? product['星级'], 2),
      fmtInt(product.reviews ?? product['评论数']),
    ]);
    push(...markdownTable(['排名', 'ASIN', '标题', '品牌', '价格', '月销量', '月销额', '星级', '评论数'], rows));
    push('');
  }

  return lines.join('\n');
}

/** 输出可写入 scores.json 的纯 JSON 对象（与 scoreMarket 返回结构一致，只保留 JSON 安全字段）。 */
export function renderScoresJson(score) {
  const source = isObject(score) ? score : null;
  if (source === null) {
    return { total: 0, max: SCORE_MAX, normalized: 0, grade: '较差', dataQuality: null, missingDimensions: 0, dimensions: [], notes: ['缺少评分数据，scoreMarket 未返回结果。'] };
  }
  const dimensions = (Array.isArray(source.dimensions) ? source.dimensions : []).filter(isObject).map((dimension) => {
    const dimMax = num(dimension.max) ?? 0;
    const dimScore = num(dimension.score) ?? 0;
    return {
      key: String(dimension.key ?? ''),
      label: String(dimension.label ?? dimension.key ?? ''),
      score: dimScore,
      max: dimMax,
      normalized: num(dimension.normalized) ?? (dimMax > 0 ? round((dimScore / dimMax) * 100, 1) : 0),
      detail: typeof dimension.detail === 'string' ? dimension.detail : '',
      inputs: isObject(dimension.inputs) ? dimension.inputs : {},
    };
  });
  const total = num(source.total) ?? dimensions.reduce((acc, dimension) => acc + dimension.score, 0);
  const max = num(source.max) ?? SCORE_MAX;
  const missingDimensions = dimensions.filter((dimension) => isMissingDimension(dimension)).length;
  const dataQuality = missingDimensions >= 3 ? 'D' : missingDimensions === 2 ? 'C' : missingDimensions === 1 ? 'B' : 'A';
  return {
    total,
    max,
    normalized: num(source.normalized) ?? (max > 0 ? round((total / max) * 100, 1) : 0),
    grade: typeof source.grade === 'string' ? source.grade : '较差',
    dataQuality,
    missingDimensions,
    dimensions,
    notes: Array.isArray(source.notes) ? source.notes.filter((note) => typeof note === 'string') : [],
  };
}

/** 把列定义（字符串或 {key,label}）标准化；未提供时按行数据首次出现顺序推导。 */
function normalizeColumns(columns, rows) {
  if (Array.isArray(columns) && columns.length > 0) {
    const defs = [];
    for (const item of columns) {
      if (typeof item === 'string' && item !== '') {
        defs.push({ key: item, label: item });
      } else if (isObject(item)) {
        const key = String(item.key ?? item.field ?? item.id ?? item.label ?? '');
        if (key !== '') defs.push({ key, label: String(item.label ?? item.title ?? key) });
      }
    }
    return defs;
  }
  const seen = new Set();
  const keys = [];
  for (const row of rows) {
    if (!isObject(row)) continue;
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return keys.map((key) => ({ key, label: key }));
}

/** 按列 key 取单元格值，支持 "a.b" 形式的浅层路径。 */
function getCellValue(row, key) {
  if (!isObject(row) && !Array.isArray(row)) return undefined;
  if (typeof key !== 'string') return undefined;
  if (!key.includes('.')) return row[key];
  return key.split('.').reduce((current, part) => (isObject(current) || Array.isArray(current) ? current[part] : undefined), row);
}

/** CSV 单元格转义：含逗号/引号/换行时加引号，内部引号双写。 */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text;
  if (typeof value === 'object') {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  } else {
    text = String(value);
  }
  if (/[",\n\r]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}

/** 把对象数组渲染为 UTF-8 CSV 文本（首行表头，行尾 \n，空值写空串）。 */
export function toCsv(rows, columns) {
  const list = Array.isArray(rows) ? rows.filter((row) => isObject(row)) : [];
  const defs = normalizeColumns(columns, list);
  if (defs.length === 0) return '';
  const lines = [defs.map((definition) => csvCell(definition.label)).join(',')];
  for (const row of list) {
    lines.push(defs.map((definition) => csvCell(getCellValue(row, definition.key))).join(','));
  }
  return lines.join('\n') + '\n';
}

/** 渲染纯 HTML + 内联 CSS 的数据面板（无 script / CDN / 外链，所有插值经 HTML 转义）。 */
export function renderDashboardHtml(params = {}) {
  const view = resolveReportMetrics(params);
  const dimensionsHtml = view.dimensions.map((dimension) => {
    const width = Math.max(0, Math.min(100, num(dimension.normalized) ?? 0)).toFixed(1);
    return `
      <div class="dim">
        <div class="dim-head"><span>${escHtml(dimension.label)}</span><span class="dim-score">${dimension.score} / ${dimension.max}（归一化 ${dimension.normalized}%）</span></div>
        <div class="bar"><span style="width:${width}%"></span></div>
        <p class="dim-detail">${escHtml(dimension.detail)}</p>
      </div>`;
  }).join('');

  const kpis = [
    ['样本月销额', fmtMoney(view.totals.revenue)],
    ['样本月销量', fmtInt(view.totals.units)],
    ['在售商品', fmtInt(view.totals.products)],
    ['平均价格', fmtMoney(view.avgs.price)],
    ['平均星级', num(view.avgs.rating) === null ? '—' : fmtNum(view.avgs.rating, 2)],
    ['平均评论数', fmtInt(view.avgs.ratings)],
    ['Top3 品牌占比', fmtPct(view.concentration.brandCr3)],
    ['品牌 HHI', view.hhiInfo ? fmtNum(view.hhiInfo.hhi, 2) : '—'],
    ['Amazon 自营占比', fmtPct(view.amazonRatio)],
    ['低评论销量占比', view.lowReview ? fmtPct(view.lowReview.share) : '—'],
  ];
  const kpisHtml = kpis.map(([name, value]) => `
    <div class="kpi"><span class="kpi-name">${escHtml(name)}</span><span class="kpi-value">${escHtml(value)}</span></div>`).join('');

  const priceRowsHtml = view.priceStats.rows.map((row) => {
    const width = Math.max(0, Math.min(100, (num(row.unitsShare) ?? 0) * 100)).toFixed(1);
    return `
      <tr>
        <td>${escHtml(row.label)}</td>
        <td class="num">${fmtInt(row.products)}</td>
        <td class="num">${fmtInt(row.units)}</td>
        <td class="bar-cell"><div class="bar small"><span style="width:${width}%"></span></div><span class="pct">${fmtPct(row.unitsShare)}</span></td>
        <td class="num">${fmtMoney(row.revenue)}</td>
      </tr>`;
  }).join('');

  const brandRowsHtml = [...view.brandRows].sort((a, b) => {
    const revenueA = num(a?.[view.brandRevenueKey]) ?? 0;
    const revenueB = num(b?.[view.brandRevenueKey]) ?? 0;
    return revenueB - revenueA;
  }).slice(0, 10).map((row, index) => {
    const units = num(row[view.brandUnitsKey]);
    const share = view.brandUnitsSum > 0 && units !== null ? units / view.brandUnitsSum : null;
    const width = Math.max(0, Math.min(100, (share ?? 0) * 100)).toFixed(1);
    return `
      <li class="brand">
        <span class="brand-rank">${index + 1}</span>
        <span class="brand-name">${escHtml(String(row.brand ?? row.label ?? '未知品牌'))}</span>
        <div class="bar small"><span style="width:${width}%"></span></div>
        <span class="pct">${fmtPct(share)}</span>
      </li>`;
  }).join('');

  const checksHtml = view.checks.map((check) => `
    <li class="check check-${check.status === '触发' ? 'triggered' : check.status === '数据缺失' ? 'missing' : 'ok'}">
      <strong>${escHtml(check.name)}</strong>
      <span class="check-rule">${escHtml(check.rule)}</span>
      <span class="check-value">当前：${escHtml(check.value)}</span>
      <span class="check-status">${escHtml(check.status)}</span>
    </li>`).join('');

  const warningsHtml = view.warnings.length > 0
    ? view.warnings.map((warning) => `<li>${escHtml(warning)}</li>`).join('')
    : '<li class="muted">无</li>';
  const scoreNotesHtml = view.scoreNotes.length > 0
    ? view.scoreNotes.map((note) => `<li>${escHtml(note)}</li>`).join('')
    : '<li class="muted">无</li>';
  const missingHtml = view.missing.length > 0
    ? view.missing.map((item) => `<li>${escHtml(item)}</li>`).join('')
    : '<li class="muted">无</li>';

  const gradeClass = view.grade === '优秀' ? 'excellent' : view.grade === '良好' ? 'good' : view.grade === '一般' ? 'fair' : view.grade === '较差' ? 'poor' : 'unknown';
  const generatedText = view.generatedAt || '—';
  const title = view.label + '（' + view.site + '）品类选品面板';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<style>
  :root { --bg:#f5f7fb; --card:#ffffff; --text:#1f2937; --muted:#6b7280; --line:#e5e7eb; --accent:#2563eb; --good:#16a34a; --warn:#d97706; --bad:#dc2626; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; line-height:1.55; }
  main { max-width:1080px; margin:0 auto; }
  .hero { background:linear-gradient(135deg,#1d4ed8,#2563eb); color:#fff; border-radius:16px; padding:24px 28px; margin-bottom:18px; }
  .hero h1 { margin:0 0 6px; font-size:24px; font-weight:700; }
  .hero p { margin:0; opacity:.9; font-size:13px; }
  .hero .score-line { display:flex; flex-wrap:wrap; align-items:baseline; gap:12px; margin-top:16px; }
  .hero .big { font-size:40px; font-weight:800; }
  .badge { padding:4px 12px; border-radius:999px; font-weight:700; font-size:14px; background:rgba(255,255,255,.18); }
  .badge.excellent { background:#bbf7d0; color:#166534; }
  .badge.good { background:#dbeafe; color:#1e40af; }
  .badge.fair { background:#fef3c7; color:#92400e; }
  .badge.poor { background:#fee2e2; color:#991b1b; }
  section { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px 20px; margin-bottom:16px; }
  section h2 { font-size:16px; margin:0 0 12px; }
  .kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:10px; }
  .kpi { border:1px solid var(--line); border-radius:10px; padding:10px 12px; background:#fafbff; }
  .kpi-name { display:block; font-size:12px; color:var(--muted); }
  .kpi-value { display:block; font-size:18px; font-weight:700; margin-top:2px; }
  .dim { margin-bottom:14px; }
  .dim-head { display:flex; justify-content:space-between; gap:12px; font-size:13px; font-weight:600; }
  .dim-score { color:var(--muted); font-weight:500; }
  .bar { height:10px; border-radius:999px; background:#eef2f7; overflow:hidden; margin-top:6px; }
  .bar span { display:block; height:100%; background:linear-gradient(90deg,#2563eb,#60a5fa); border-radius:999px; }
  .bar.small { height:7px; flex:1; }
  .dim-detail { margin:6px 0 0; font-size:12px; color:var(--muted); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { padding:8px 10px; border-bottom:1px solid var(--line); text-align:left; vertical-align:middle; }
  th { color:var(--muted); font-weight:600; background:#fafbff; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; }
  .bar-cell { display:flex; align-items:center; gap:8px; }
  .pct { font-variant-numeric:tabular-nums; color:var(--muted); min-width:58px; text-align:right; }
  ul { margin:0; padding-left:18px; font-size:13px; }
  li { margin:4px 0; }
  .brand-list { list-style:none; padding:0; }
  li.brand { display:flex; align-items:center; gap:10px; }
  .brand-rank { width:22px; color:var(--muted); }
  .brand-name { width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
  .check-list { list-style:none; padding:0; }
  li.check { display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center; border-bottom:1px dashed var(--line); padding:8px 0; }
  .check-rule, .check-value { color:var(--muted); font-size:12px; }
  .check-status { margin-left:auto; font-weight:700; font-size:12px; }
  li.check.none { display:none; }
  li.triggered .check-status { color:var(--bad); }
  li.missing .check-status { color:var(--warn); }
  li.ok .check-status { color:var(--good); }
  .muted { color:var(--muted); }
  .two-col { display:grid; grid-template-columns:1fr 1fr; gap:0 28px; }
  footer { text-align:center; color:var(--muted); font-size:12px; padding:8px 0 24px; }
  @media (max-width:720px) { .two-col { grid-template-columns:1fr; } body { padding:12px; } .brand-name { width:110px; } }
</style>
</head>
<body>
<main>
  <header class="hero">
    <h1>${escHtml(title)}</h1>
    <p>数据来源 ${escHtml(view.provider)} ｜ 月份 ${escHtml(view.month || '—')} ｜ 生成时间 ${escHtml(generatedText)}</p>
    <div class="score-line">
      <span class="big">${view.scoreAvailable ? view.total : '—'} / ${view.scoreAvailable ? view.totalMax : '—'}</span>
      <span>归一化 ${view.scoreAvailable ? view.normalized : '—'} / 100</span>
      <span class="badge ${gradeClass}">${escHtml(view.grade)} · ${escHtml(view.advice)}</span>
    </div>
  </header>

  <section>
    <h2>关键指标</h2>
    <div class="kpis">${kpisHtml}</div>
  </section>

  <section>
    <h2>五维评分（92 分制归一化）</h2>
    ${dimensionsHtml || '<p class="muted">未提供评分结果。</p>'}
    <p class="muted" style="font-size:12px;margin:10px 0 0;">增长潜力实际最高 22/25、竞争烈度 18/20、利润空间 12/15；归一化 = 总分 ÷ 92 × 100，评级 ≥80 优秀 / ≥60 良好 / ≥40 一般 / <40 较差。</p>
  </section>

  <section>
    <h2>集中度</h2>
    <div class="kpis">
      <div class="kpi"><span class="kpi-name">Top3 商品集中度</span><span class="kpi-value">${fmtPct(view.concentration.productCr3)}</span></div>
      <div class="kpi"><span class="kpi-name">Top3 品牌集中度</span><span class="kpi-value">${fmtPct(view.concentration.brandCr3)}</span></div>
      <div class="kpi"><span class="kpi-name">Top10 品牌集中度</span><span class="kpi-value">${fmtPct(view.concentration.brandCr10)}</span></div>
      <div class="kpi"><span class="kpi-name">Top3 卖家集中度</span><span class="kpi-value">${fmtPct(view.concentration.sellerCr3)}</span></div>
    </div>
    <p class="muted" style="font-size:12px;">品牌 HHI：${view.hhiInfo ? escHtml(fmtNum(view.hhiInfo.hhi, 2) + ' / 10000（' + concentrationLevel(view.hhiInfo.hhi) + '，按' + view.hhiBasisLabel + '，覆盖 ' + fmtPct(view.hhiInfo.coveredShare) + (view.hhiInfo.estimated ? '，估算值' : '，非估算') + '）') : '—'}</p>
    <h2 style="margin-top:14px;">Top 品牌（按销量份额）</h2>
    <ul class="brand-list">${brandRowsHtml || '<li class="muted">品牌数据缺失</li>'}</ul>
  </section>

  <section>
    <h2>价格带分布</h2>
    ${view.priceStats.rows.length > 0 ? '<table><thead><tr><th>价格带</th><th class="num">商品数</th><th class="num">月销量</th><th>销量占比</th><th class="num">月销额</th></tr></thead><tbody>' + priceRowsHtml + '</tbody></table>' : '<p class="muted">数据缺失：distributions.price 为空。</p>'}
  </section>

  <section>
    <h2>风险与一票否决提示</h2>
    <ul class="check-list">${checksHtml}</ul>
  </section>

  <section>
    <div class="two-col">
      <div>
        <h2>市场数据警告</h2>
        <ul>${warningsHtml}</ul>
      </div>
      <div>
        <h2>评分备注</h2>
        <ul>${scoreNotesHtml}</ul>
      </div>
    </div>
    <h2 style="margin-top:14px;">缺失字段清单</h2>
    <ul>${missingHtml}</ul>
  </section>

  <footer>本面板由 dsh-amazon-research 分析引擎生成 ｜ 仅供选品初筛，不构成投资或经营建议 ｜ 品牌 HHI 为 0~10000 品牌级口径</footer>
</main>
</body>
</html>`;
}
