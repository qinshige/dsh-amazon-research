import { scoreMarket } from './scoring.js';
import { renderCategoryReport, renderScoresJson, renderDashboardHtml, toCsv } from './report.js';
import { createRun, writeArtifacts } from './runs.js';
import { sellerspriteWebProvider } from './providers/sellersprite-web.js';
import { aggregateNetMargin, estimateFbaFee, judgeProfit, landedCost, maxPurchaseCNYForNetMargin } from './sourcing/cost-model.js';

/** 简单 slug（用于目录名） */
function slug(text) {
  return String(text || 'market').trim().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'market';
}

/**
 * 把网页取到的 Top 商品转成统一 Product 形状。
 *
 * 口径修正（重要）：卖家精灵「查竞品」表的「销量(父)」是**父体月销量**，同一父体的多个子体
 * 各自重复一行且共用同一个父体销量。若直接逐行聚合，5 个子体会把父体销量算 5 次，
 * 品牌集中度与价格带分布都会被系统性放大。
 * 因此这里以 **父 ASIN 为分析单元**：销量按父体只计一次，销额按父体销量 × 该父体代表子体价格
 * （与卖家精灵自身逐行算式一致），并保留 variants 供报告展示变体数。
 */
function toProducts(rows, limit = null) {
  const grouped = new Map();
  for (const row of rows || []) {
    const key = row.parentAsin || row.asin || 'unknown-' + (row.rank ?? grouped.size);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...row, childCount: 1 });
      continue;
    }
    existing.childCount += 1;
    // 代表子体取排名最靠前的那条
    if ((row.rank ?? 9999) < (existing.rank ?? 9999)) {
      const childCount = existing.childCount;
      grouped.set(key, { ...row, childCount });
    }
  }
  const list = [...grouped.values()].sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));
  const limited = limit ? list.slice(0, limit) : list;
  return limited.map((row) => ({
    asin: row.asin,
    parentAsin: row.parentAsin || null,
    title: row.title,
    brand: row.brand,
    price: row.price,
    rating: row.rating,
    reviews: row.reviews,
    seller: row.buyBox,
    sellerSource: row.fulfillment,
    monthlySales: row.units,
    monthlyRevenue: row.revenue,
    launchDays: null,
    listedDate: row.listedDate,
    bsrCategory: row.bsrCategory,
    fbaFee: row.fbaFee,
    margin: row.margin,
    weight: row.weight ?? null,
    packWeight: row.packWeight ?? null,
    weightG: parseWeightG(row.weight),
    packWeightG: parseWeightG(row.packWeight),
    variants: row.variants,
    childListings: row.childCount,
    sellers: row.sellers,
    rank: row.rank,
  }));
}

/** 把「0.5 kg」「500 g」「1.2kg」这类文本解析成克；解析不出返回 null。 */
function parseWeightG(text) {
  if (typeof text === 'number') return Number.isFinite(text) && text > 0 ? text : null;
  const raw = String(text ?? '').trim();
  if (raw === '') return null;
  const match = raw.match(/([0-9.]+)\s*(kg|g|克|千克|公斤|lbs|lb|磅)/i);
  if (!match) {
    const plain = Number(raw.replace(/,/g, ''));
    return Number.isFinite(plain) && plain > 0 ? plain : null;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || !(value > 0)) return null;
  const unit = match[2].toLowerCase();
  if (unit === 'kg' || unit === '千克' || unit === '公斤') return value * 1000;
  if (unit === 'lbs' || unit === 'lb' || unit === '磅') return value * 453.592;
  return value;
}

/** 数值安全转换（支持 "1,234.5" 字符串）。 */
function toNum(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/,/g, '');
    if (cleaned === '') return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 中位数（空数组返回 null）。 */
function medianOf(values) {
  const list = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 === 1 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}
/** 品牌维度行（用 Top 商品的品牌聚合，作为品牌集中度的补充证据） */
function brandRows(products) {
  const map = new Map();
  for (const p of products) {
    const key = p.brand || '未知品牌';
    const row = map.get(key) || { brand: key, products: 0, units: 0, revenue: 0 };
    row.products += 1;
    row.units += p.monthlySales || 0;
    row.revenue += p.monthlyRevenue || 0;
    map.set(key, row);
  }
  return [...map.values()]
    .map((row) => ({ ...row, unitsRatio: map.size ? row.units / [...map.values()].reduce((sum, r) => sum + r.units, 0) : null }))
    .sort((a, b) => b.revenue - a.revenue);
}

/** 验证状态归一：兼容布尔与「已进详情页验证 / 未验证」等文案。 */
function normalizeVerified(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim();
  if (/^(true|是|已验证|已进详情页|已核|验证通过)/i.test(text)) return true;
  if (/^(false|否|未验证|未核|未取到)/i.test(text)) return false;
  // 「详情页已验证」「已进详情页验证」等含词写法也要认（不锚定开头，避免漏判）
  if (/已验证|已进详情页/.test(text)) return true;
  if (/未验证|未进详情页|搜索页卡片级/.test(text)) return false;
  return null;
}
/**
 * 子市场 ↔ 1688 成本条目匹配（按名称精确 → 前缀 → 包含；匹配不到则不算销量权重）。
 */
function matchSubMarketRow(cost, subMarkets) {
  const name = String(cost?.name ?? '').trim();
  if (name === '') return null;
  const norm = (text) => String(text ?? '').toLowerCase().replace(/[\s（）()【】\[\]]+/g, '');
  const target = norm(name);
  const rows = Array.isArray(subMarkets) ? subMarkets : [];
  let hit = rows.find((row) => norm(row.name) === target);
  if (!hit) hit = rows.find((row) => norm(row.name).startsWith(target) || target.startsWith(norm(row.name)));
  if (!hit) hit = rows.find((row) => norm(row.name).includes(target) || target.includes(norm(row.name)));
  return hit ?? null;
}

/** 均价 ±25% 价格带内的商品（用于按细分归属 FBA 费 / 卖家精灵毛利率样本）。 */
function subMarketBandProducts(products, avgPrice) {
  if (!(avgPrice > 0)) return [];
  const min = avgPrice * 0.75;
  const max = avgPrice * 1.25;
  return (Array.isArray(products) ? products : []).filter((product) => {
    const price = toNum(product?.price);
    return price !== null && price >= min && price <= max;
  });
}

/**
 * 把 1688 采价结果（costs）与子市场 / Top 商品样本拼成「全成本净利测算」行。
 *
 * 口径：
 *   - 售价：子市场均价（卖家精灵实测）或 costs.avgPriceUSD；
 *   - 采购价：1688 详情页阶梯价（实测值）；
 *   - FBA 费：该细分价格带（均价 ±25%）内 ASIN 的卖家精灵 fbaFee 中位数（实测值），无样本时按件重档估算；
 *   - 退货率：该细分真实退货率（实测值），缺则 5% 默认；
 *   - 佣金 15% / 广告 10% / 其它 $0.35 / 头程 ¥35 每 kg：估算值。
 */
function buildSourcingAndProfit({ costs, subMarkets, products, avgsPrice }) {
  const sourcing = [];
  const profitRows = [];
  const list = Array.isArray(costs) ? costs.filter((item) => item && typeof item === 'object') : [];
  list.forEach((cost, index) => {
    const sub = matchSubMarketRow(cost, subMarkets);
    const name = String(cost.name ?? sub?.name ?? ('子市场 ' + (index + 1)));
    const keyword = String(cost.keyword ?? '');
    const priceCNY = toNum(cost.priceCNY);
    const weightFromCost = toNum(cost.weightG);
    const subAvgPrice = toNum(sub?.averagePrice);
    // 售价口径统一：**优先用卖家精灵子市场均价**（与 FBA 费价格带样本、FBA 费分母同源）。
    // 调用方传入的 avgPriceUSD（来自 Amazon 前台搜索中位价）只作为交叉参考，不参与测算——
    // 两个来源口径不同（搜索页 vs 子市场统计），混用会让价格带归属与售价不自洽。
    const refPriceUSD = toNum(cost.avgPriceUSD);
    const priceUSD = subAvgPrice ?? refPriceUSD ?? toNum(avgsPrice);
    const priceSource = subAvgPrice !== null
      ? '卖家精灵子市场均价（实测值）'
      : (refPriceUSD !== null ? '调用方传入 avgPriceUSD' : '类目均价（实测值）');
    const band = subMarketBandProducts(products, priceUSD);

    const bandWeights = band.map((product) => toNum(product.weightG)).filter((value) => value !== null && value > 0);
    const weightG = weightFromCost ?? (bandWeights.length ? medianOf(bandWeights) : null);
    const weightSource = weightFromCost !== null ? '实测值（1688 详情页件重）'
      : (bandWeights.length ? '估算值（细分价格带 ASIN 件重中位数）' : '未取到');

    const bandFees = band.map((product) => toNum(product.fbaFee)).filter((value) => value !== null && value > 0);
    const measuredFee = bandFees.length ? medianOf(bandFees) : null;
    const fbaEstimated = measuredFee === null;
    const fbaFeeUSD = measuredFee !== null ? measuredFee : estimateFbaFee(weightG).feeUSD;
    const fbaSource = measuredFee !== null
      ? '实测值（卖家精灵逐 ASIN fbaFee 中位数，样本 ' + bandFees.length + ' 个 ASIN，按细分均价 ±25% 价格带归属）'
      : '估算值（按件重档位推算，细分价格带内无可用 fbaFee 样本）';

    const bandMargins = band.map((product) => toNum(product.margin)).filter((value) => value !== null);
    const sellerSpriteMargin = bandMargins.length ? medianOf(bandMargins) : null;

    const rawReturn = toNum(cost.returnRate);
    const subReturn = toNum(sub?.returnRate);
    const returnRate = rawReturn !== null && rawReturn >= 0 && rawReturn <= 1 ? rawReturn
      : (subReturn !== null && subReturn >= 0 ? subReturn / 100 : 0.05);
    const returnSource = rawReturn !== null ? '实测值（调用方传入）'
      : (subReturn !== null ? '实测值（卖家精灵子市场退货率 ' + subReturn + '%）' : '估算值（经验默认 5%）');

    sourcing.push({
      name,
      keyword,
      offerId: cost.offerId ?? null,
      title: cost.title ?? null,
      priceCNY,
      moq: toNum(cost.moq),
      moqText: cost.moqText ?? (typeof cost.moq === 'string' && cost.moq.trim() !== '' ? cost.moq.trim() : null),
      material: cost.material ?? null,
      weightG,
      weightSource,
      offerUrl: cost.offerUrl ?? null,
      verified: normalizeVerified(cost.verified),
      supplier: cost.supplier ?? null,
      location: cost.location ?? null,
      source: cost.source ?? '1688:详情页',
      fetchedAt: cost.fetchedAt ?? null,
      packSize: cost.packSize ?? null,
      alignNote: cost.alignNote ?? null,
      amazonPackMedian: toNum(cost.amazonPackMedian),
      amazonPackQuantiles: cost.amazonPackQuantiles ?? null,
      amazonQuery: cost.amazonQuery ?? null,
      targetPack: toNum(cost.targetPack),
      packsBought: toNum(cost.packsBought),
      packUnitQty: toNum(cost.packUnitQty),
      packUnitPriceCNY: toNum(cost.packUnitPriceCNY),
      weightBasis: cost.weightBasis ?? null,
      title: cost.title ?? null,
    });

    const calc = landedCost({
      priceCNY,
      weightG,
      priceUSD,
      returnRate,
      fbaFeeUSD: fbaEstimated ? null : fbaFeeUSD,
      sources: {
        purchase: priceCNY === null ? '未取到' : '实测值',
        weight: weightSource,
        fba: fbaEstimated ? '估算值' : '实测值',
        return: returnSource,
      },
      notes: [
        '售价来源：' + priceSource + (refPriceUSD !== null && subAvgPrice !== null
          ? '；Amazon 前台搜索中位价 $' + refPriceUSD + '（交叉参考，未参与测算）'
          : ''),
        'FBA 费来源：' + fbaSource,
        '退货损耗来源：' + returnSource,
      ],
    });

    if (calc === null) {
      profitRows.push({
        name, keyword, units: toNum(sub?.totalUnits), priceUSD,
        missing: true,
        reason: priceCNY === null ? '未取到 1688 采购价，无法测算全成本' : '未取到售价，无法测算全成本',
        verdict: '数据缺失',
        verdictStatus: 'unknown',
        checks: [], notes: [],
      });
      return;
    }

    const judge = judgeProfit({
      netMargin: calc.netMargin,
      logisticsRatio: calc.logisticsRatio,
      purchaseRatio: calc.purchaseRatio,
      priceUSD: calc.priceUSD,
      purchaseCNY: cost.priceCNY,
      fbaFeeUSD: calc.fbaFeeUSD,
      smallVolume: cost.smallVolume === true,
      volumeUnits: null,
    });

    profitRows.push({
      name,
      keyword,
      units: toNum(sub?.totalUnits),
      priceUSD: calc.priceUSD,
      priceCNY: calc.priceCNY,
      purchaseUSD: calc.purchaseUSD,
      firstMileUSD: calc.firstMileUSD,
      fbaFeeUSD: calc.fbaFeeUSD,
      fbaEstimated,
      fbaSource,
      referralUSD: calc.referralUSD,
      adUSD: calc.adUSD,
      returnUSD: calc.returnUSD,
      otherUSD: calc.otherUSD,
      totalCostUSD: calc.totalCostUSD,
      netProfitUSD: calc.netProfitUSD,
      grossProfitUSD: calc.grossProfitUSD,
      netMargin: calc.netMargin,
      grossMargin: calc.grossMargin,
      logisticsUSD: calc.logisticsUSD,
      logisticsRatio: calc.logisticsRatio,
      purchaseRatio: calc.purchaseRatio,
      returnRate,
      returnSource,
      weightG,
      weightSource,
      sellerSpriteMargin,
      sellerSpriteMarginSample: bandMargins.length,
      maxPurchaseCNY: maxPurchaseCNYForNetMargin({
        priceUSD: calc.priceUSD,
        weightG: calc.weightG,
        fbaFeeUSD: calc.fbaFeeUSD,
        returnRate,
      })?.maxPurchaseCNY ?? null,
      offerUrl: cost.offerUrl ?? null,
      verified: normalizeVerified(cost.verified),
      missing: false,
      verdict: judge.verdict,
      verdictStatus: judge.status,
      checks: judge.checks,
      reasons: judge.reasons,
      notes: calc.notes,
    });
  });
  return { sourcing, profitRows };
}
/**
 * Amazon 品类选品（卖家精灵网页登录态 provider）。
 *
 * 取数三步：
 *   1. 选市场页 → 细分市场列表（子市场级指标 + nodeIdPath）
 *   2. 类目报告页 → 类目大盘（样本数、均价、均销、均销额、集中度、新品指标）
 *   3. 查竞品页 → Top 商品明细（用于价格带/评论数分布、品牌聚合、Top50 明细）
 *
 * 与 MCP 路径的差异：网页版不提供 market_* 分布工具，因此价格带/评论数分布由 Top 商品样本推导，
 * 报告中会标注为「Top N 样本推导口径」。
 */
export async function selectCategoryWeb({ marketplace = 'US', category, nodeIdPath, limit = 50, unitCost = null, costs = [], outputRoot, dataDir = null, cachedProducts = null, cachedDistributions = null, log = () => {} } = {}) {
  const t0 = Date.now();
  const warnings = [];
  const usage = { calls: 0, byTool: {}, errors: [] };
  const bump = (tool) => {
    usage.calls += 1;
    usage.byTool[tool] = (usage.byTool[tool] || 0) + 1;
  };

  if (!category && !nodeIdPath) {
    const err = new Error('缺少参数：请提供 category（类目关键词，如 "Hardware"）或 nodeIdPath');
    err.code = 'INVALID_ARGS';
    throw err;
  }

  // 1) 细分市场列表（顺带解析节点）
  bump('market-research:选市场');
  const list = await sellerspriteWebProvider.marketList({ keyword: category, nodeIdPath, limit: Math.max(20, Math.min(100, limit)), log });
  if (!list.rows.length) {
    const err = new Error('选市场未返回细分市场。请确认类目关键词，或直接提供 nodeIdPath。');
    err.code = 'NODE_NOT_FOUND';
    err.usage = usage;
    throw err;
  }
  const candidates = list.rows.map((row) => ({
    nodeIdPath: row.nodeIdPath,
    label: row.name,
    totalUnits: row.totalUnits,
    averagePrice: row.averagePrice,
    brandCr3: row.concentration.brandCr3,
    newRatio: row.newItems.ratio,
  }));
  // 选市场页在按关键词过滤后列出的是「所选节点的下一级细分市场」。
  // 因此所选节点本身 = 所有行 nodeIdPath 的最长公共前缀（选中叶子节点时前缀就是它自己）。
  const commonPath = commonNodePath(list.rows.map((row) => row.nodeIdPath).filter(Boolean));
  let resolvedPath = nodeIdPath ? String(nodeIdPath) : commonPath || list.rows[0].nodeIdPath;
  let resolvedLabel = category || resolvedPath;
  const exactRow = list.rows.find((row) => row.nodeIdPath === resolvedPath);
  if (exactRow) resolvedLabel = exactRow.name || resolvedLabel;
  if (!resolvedPath) {
    const err = new Error('未能解析 nodeIdPath，请手动提供');
    err.code = 'NODE_NOT_FOUND';
    err.usage = usage;
    throw err;
  }
  if (!nodeIdPath && commonPath) {
    warnings.push('所选节点按筛选结果的最长公共前缀推断为 ' + resolvedPath + '；若与页面实际选中项不符，请直接传 nodeIdPath');
  }

  // 2) 类目大盘
  bump('market-research:类目报告');
  const report = await sellerspriteWebProvider.nodeReport({ nodeIdPath: resolvedPath, log });

  // 3) Top 商品
  // 查竞品默认按父体销量排序且「展示所有变体」：同一父体的每个子体各占一行，
  // 且共用同一个父体销量。因此抓取行数要比目标分析单元大（抓 3 倍再按父体去重），
  // 否则 50 行往往只对应十几个父体，样本太薄。
  bump('competitor-lookup:查竞品');
  const targetParents = Math.max(20, Math.min(100, limit));
  let topProducts = { rows: [], count: 0 };
  // 调用方可传入上一轮抓好的父体样本（cachedProducts）——重算利润维度时无需再打卖家精灵，
  // 既省网页端查询次数，也避免频控把样本抓空。
  if (Array.isArray(cachedProducts) && cachedProducts.length > 0) {
    warnings.push('Top 商品样本复用上一轮已抓取结果（' + cachedProducts.length + ' 个父体），本次未重复请求卖家精灵查竞品');
  } else {
    try {
      topProducts = await sellerspriteWebProvider.topProducts({ nodeIdPath: resolvedPath, limit: Math.min(200, targetParents * 3), log });
    } catch (error) {
      warnings.push('Top 商品明细未取到（查竞品）：' + String(error?.message ?? error));
    }
  }
  const rawRows = topProducts.rows || [];
  const products = Array.isArray(cachedProducts) && cachedProducts.length > 0
    ? cachedProducts.slice(0, targetParents)
    : toProducts(rawRows, targetParents);
  const parentCount = products.length;
  if (rawRows.length > parentCount) {
    warnings.push('查竞品返回 ' + rawRows.length + ' 行，其中 ' + (rawRows.length - parentCount) + ' 行为同父体的子体；已按父 ASIN 去重，父体销量只计一次（分析单元 ' + parentCount + ' 个父体）');
  }
  if (parentCount < targetParents) {
    warnings.push('该类目可取到的父体样本仅 ' + parentCount + ' 个（少于目标 ' + targetParents + '），分布与 HHI 的样本代表性有限');
  }

  // 4) 归一化 Market
  // 口径说明：卖家精灵类目报告页给的是「样本商品数 × 近30天均量」的样本口径，
  // 而选市场页的细分市场列表给的是该子市场全量月总销量。两者不可混用：
  //   totals.units/revenue 采用「细分市场列表中该节点及其子市场之和」（全量口径），
  //   若拿不到则退回样本口径并在 warnings 标注。
  const avgPrice = report.avgPrice;
  const sampleProducts = report.sampleProducts;
  const sampleUnits = report.avgUnits !== null && sampleProducts !== null ? Math.round(report.avgUnits * sampleProducts) : null;
  const sampleRevenue = report.avgRevenue !== null && sampleProducts !== null ? Math.round(report.avgRevenue * sampleProducts) : null;

  // 全量口径：子市场列表里所有属于该节点（含后代）的月总销量求和
  const ownRow = list.rows.find((row) => row.nodeIdPath === resolvedPath);
  const descendantRows = list.rows.filter((row) => row.nodeIdPath && row.nodeIdPath.startsWith(resolvedPath + ':'));
  const fullUnits = descendantRows.length ? descendantRows.reduce((sum, row) => sum + (row.totalUnits || 0), 0) : null;
  const ownUnits = ownRow ? ownRow.totalUnits : null;
  let units = fullUnits;
  let revenue = null;
  let scaleBasis = 'submarket_sum';
  if (!units) {
    units = sampleUnits;
    revenue = sampleRevenue;
    scaleBasis = 'sample';
    warnings.push('市场规模采用「样本 ' + sampleProducts + ' 件 × 近30天均量」的样本口径，非类目全量');
  } else {
    // 子市场列表只有销量没有销额；用均价 × 销量估算销额，并标注为估算
    revenue = avgPrice !== null && units !== null ? Math.round(avgPrice * units) : null;
    warnings.push('类目月销额由「子市场月总销量 × 类目均价」估算（卖家精灵网页未直接给出节点级月销额）');
    if (ownUnits !== null) {
      warnings.push('所选节点自身月总销量 ' + ownUnits.toLocaleString('en-US') + '；含子市场合计 ' + units.toLocaleString('en-US') + '（用于市场规模维度）');
    }
  }

  const priceDistribution = buildPriceBands(products);
  const ratingsCount = buildReviewBuckets(products);
  const ratingDistribution = buildRatingBuckets(products);
  const listingDate = buildListingBuckets(products);

  const market = {
    provider: 'sellersprite-web',
    marketplace,
    month: '',
    nodeIdPath: resolvedPath,
    label: resolvedLabel,
    totals: { products: report.goodsTotal ? Number(String(report.goodsTotal).replace(/,/g, '')) : sampleProducts, units, revenue },
    avgs: {
      price: avgPrice,
      units: report.avgUnits,
      revenue: report.avgRevenue,
      bsr: report.avgBsr,
      rating: report.avgRating,
      ratings: report.avgRatings,
    },
    concentration: {
      top3ProductCrn: report.productCr3,
      top3BrandCrn: report.brandCr3,
      top3SellerCrn: report.sellerCr3,
      top5BrandCrn: null,
      top10BrandCrn: null,
    },
    structure: {
      fbaProportion: (exactRow || list.rows[0]).structure.fbaProportion,
      fbmProportion: (exactRow || list.rows[0]).structure.fbmProportion,
      amazonSelfProportion: (exactRow || list.rows[0]).structure.amazonSelfProportion,
      returnRatio: (exactRow || list.rows[0]).returnRate,
    },
    newRatio: {
      l1: report.newRatio !== null && report.newRatio !== undefined ? report.newRatio / 100 : null,
      l3: null,
      l6: null,
      l12: null,
    },
    distributions: {
      price: priceDistribution,
      brand: brandRows(products),
      brandCoverage: 'sample',
      sellerCountry: [],
      rating: ratingDistribution,
      ratingsCount,
      listingDate,
      sellerType: [],
      product: [],
      demandTrend: [],
    },
    products,
    fetchedAt: new Date().toISOString(),
    warnings,
  };
  market.newItems = { count: report.newItems, ratio: report.newRatio };
  market.scaleBasis = scaleBasis;
  market.sampleProducts = sampleProducts;
  market.sampleUnits = sampleUnits;
  market.sampleRevenue = sampleRevenue;
  market.grossMargin = report.grossMargin;
  market.goodsTotal = report.goodsTotal;
  market.topProductsCount = report.topProductsCount;
  market.subMarkets = list.rows.map((row) => ({
    rank: row.rank,
    name: row.name,
    nodeIdPath: row.nodeIdPath,
    totalUnits: row.totalUnits,
    averagePrice: row.averagePrice,
    brandCr3: row.concentration.brandCr3,
    productCr3: row.concentration.productCr3,
    sellerCr3: row.concentration.sellerCr3,
    newRatio: row.newItems.ratio,
    returnRate: row.returnRate,
    fbaProportion: row.structure.fbaProportion,
    amazonSelfProportion: row.structure.amazonSelfProportion,
  }));

  // 1688 采价 + 全成本净利测算（costs 为空 → 本块不产出，报告第八章写「未接入 1688 采购成本」）
  const costRows = Array.isArray(costs) ? costs.filter((item) => item && typeof item === 'object') : [];
  const { sourcing, profitRows } = buildSourcingAndProfit({
    costs: costRows,
    subMarkets: market.subMarkets,
    products,
    avgsPrice: market.avgs.price,
  });
  const subMarketTotalUnits = market.subMarkets.reduce((sum, row) => sum + (row.totalUnits || 0), 0);
  const profitAggregate = aggregateNetMargin(profitRows, { totalUnits: subMarketTotalUnits > 0 ? subMarketTotalUnits : null });
  market.sourcing = sourcing;
  market.profitBySubMarket = profitRows;
  market.profitNetMargin = profitAggregate.netMargin;
  market.profitBasis = profitAggregate.netMargin === null ? '' : profitAggregate.basis;
  market.profitCoverage = profitAggregate.coverageRatio;
  market.profitCoveredUnits = profitAggregate.coveredUnits;
  market.profitTotalUnits = subMarketTotalUnits > 0 ? subMarketTotalUnits : null;
  market.profitScopeNote = profitAggregate.netMargin === null
    ? ''
    : ('覆盖 ' + profitAggregate.count + ' 个主力细分，占子市场总销量 '
      + (profitAggregate.coverageRatio === null ? '未取到' : (profitAggregate.coverageRatio * 100).toFixed(1) + '%')
      + '；这是这几个主力细分的加权净利率，不是全类目净利率');

  if (report.newRatio !== null && report.newRatio !== undefined) {
    warnings.push('新品口径：卖家精灵页面「新品占比 ' + report.newRatio + '%」对应页面当前的新品定义窗口（默认 1 个月），与 6 个月口径不可直接比较');
  }
  warnings.push('价格带/评论数/上架时间分布由 Top 父体样本（' + products.length + ' 个父体）推导，非全量类目分布');
  warnings.push('品牌 HHI 按 Top ' + products.length + ' 父体样本内的品牌销量份额计算（estimated），不等于类目全量品牌集中度；类目级品牌集中度以页面 Top3 品牌占比 ' + (report.brandCr3 !== null ? (report.brandCr3 * 100).toFixed(1) + '%' : '未取到') + ' 为准');
  if (profitRows.length > 0) {
    warnings.push('利润空间维度已按 1688 真实采购价重算为净利率口径（' + profitAggregate.basis + '，覆盖 '
      + profitAggregate.count + ' 个细分、占子市场总销量 '
      + (profitAggregate.coverageRatio === null ? '未取到' : (profitAggregate.coverageRatio * 100).toFixed(1) + '%')
      + '）；净利率口径扣完佣金/广告/退货，与上游毛利率口径不可直接比较');
    warnings.push('1688 图片与外观专利：工厂自述「实拍」不可信，上架前需自查图片素材版权与外观专利（外观专利 5 个以上结构差异才不侵权）');
  } else if (!unitCost || unitCost === null) {
    warnings.push('未提供采购成本（unitCost），利润维度按价格带估算，仅供初筛');
  }

  const score = scoreMarket(market, {
    unitCost,
    profitBySubMarket: profitRows,
    totalUnits: subMarketTotalUnits > 0 ? subMarketTotalUnits : null,
  });

  // 5) 落盘
  const generatedAt = new Date().toISOString();
  const run = await createRun({
    rootDir: outputRoot,
    kind: 'category',
    title: resolvedLabel,
    site: marketplace,
    label: slug(resolvedLabel || category || 'market'),
    registryDir: dataDir,
  });
  const reportMd = renderCategoryReport({ market, score, site: marketplace, generatedAt, warnings });
  const manifest = {
    runId: run.runId,
    kind: 'category',
    title: resolvedLabel,
    site: marketplace,
    marketplace,
    provider: 'sellersprite-web',
    nodeIdPath: resolvedPath,
    month: '',
    params: { category: category || '', limit, unitCost: unitCost ?? null, costSubMarkets: costRows.length },
    usage: { ...usage, totalMs: Date.now() - t0 },
    fetchedAt: market.fetchedAt,
    createdAt: generatedAt,
    warnings,
    score: { total: score.total, max: score.max, normalized: score.normalized, grade: score.grade },
    sources: {
      marketList: list.source,
      nodeReport: report.source,
      topProducts: topProducts.source || null,
    },
  };
  const artifacts = await writeArtifacts(run, {
    'manifest.json': manifest,
    'market.json': market,
    'scores.json': renderScoresJson(score),
    'report.md': reportMd,
    'dashboard.html': renderDashboardHtml({ market, score, generatedAt }),
    'tables/sub_markets.csv': toCsv(
      market.subMarkets.map((row) => ({ ...row })),
      ['rank', 'name', 'nodeIdPath', 'totalUnits', 'averagePrice', 'brandCr3', 'productCr3', 'sellerCr3', 'newRatio', 'returnRate'],
    ),
    'tables/top_products.csv': toCsv(products, [
      'rank', 'asin', 'parentAsin', 'title', 'brand', 'price', 'monthlySales', 'monthlyRevenue',
      'rating', 'reviews', 'listedDate', 'sellerSource', 'seller', 'fbaFee', 'margin',
      'sellers', 'variants', 'childListings', 'weight', 'packWeight', 'weightG', 'packWeightG',
    ]),
    'tables/sourcing_1688.csv': toCsv(
      market.sourcing.map((row) => ({
        name: row.name ?? '未取到',
        keyword: row.keyword || '未取到',
        offerId: row.offerId ?? '未取到',
        priceCNY: row.priceCNY === null || row.priceCNY === undefined ? '未取到' : Number(row.priceCNY).toFixed(2),
        packSize: row.packSize || '未取到',
        amazonPackMedian: row.amazonPackMedian === null || row.amazonPackMedian === undefined
          ? '未取到'
          : Number(row.amazonPackMedian) + ' 件（中位）',
        moq: row.moq === null || row.moq === undefined ? (row.moqText ?? '未取到') : String(row.moq),
        material: row.material ?? '未取到',
        weightG: row.weightG === null || row.weightG === undefined ? '未取到' : Number(row.weightG).toFixed(1),
        offerUrl: row.offerUrl ?? '未取到',
        verified: row.verified === true ? '已进详情页验证' : (row.verified === false ? '未验证（仅搜索页卡片级）' : '未取到'),
        alignNote: row.alignNote || '未取到',
      })),
      [
        { key: 'name', label: '子市场' },
        { key: 'keyword', label: '关键词' },
        { key: 'offerId', label: 'offerId' },
        { key: 'priceCNY', label: '采购价(元)/可售单位' },
        { key: 'packSize', label: '包装规格对齐' },
        { key: 'amazonPackMedian', label: 'Amazon包装数' },
        { key: 'moq', label: '起批量' },
        { key: 'material', label: '材质' },
        { key: 'weightG', label: '件重(g)' },
        { key: 'offerUrl', label: '链接' },
        { key: 'verified', label: '验证状态' },
        { key: 'alignNote', label: '对齐说明' },
      ],
    ),
    'tables/pack_alignment.csv': toCsv(
      market.sourcing.map((row) => ({
        name: row.name ?? '未取到',
        amazonQuery: row.amazonQuery || '未取到',
        amazonPackMedian: row.amazonPackMedian === null || row.amazonPackMedian === undefined
          ? '未取到'
          : String(row.amazonPackMedian) + ' 件（中位）',
        packSize: row.packSize || '未取到',
        offerId: row.offerId ?? '未取到',
        offerUrl: row.offerUrl ?? '未取到',
        priceCNY: row.priceCNY === null || row.priceCNY === undefined ? '未取到' : Number(row.priceCNY).toFixed(2),
        alignNote: row.alignNote || '未取到',
        weightBasis: row.weightBasis || '未取到',
      })),
      [
        { key: 'name', label: '子市场' },
        { key: 'amazonQuery', label: 'Amazon搜索词' },
        { key: 'amazonPackMedian', label: 'Amazon实测包装数中位' },
        { key: 'packSize', label: '包装规格对齐规则' },
        { key: 'offerId', label: '1688 offerId' },
        { key: 'offerUrl', label: '1688链接' },
        { key: 'priceCNY', label: '采购价(元)/可售单位' },
        { key: 'alignNote', label: '对齐说明' },
        { key: 'weightBasis', label: '件重口径' },
      ],
    ),
    'tables/profit_by_submarket.csv': toCsv(
      market.profitBySubMarket.map((row) => ({
        name: row.name ?? '未取到',
        priceUSD: row.priceUSD === null || row.priceUSD === undefined ? '未取到' : Number(row.priceUSD).toFixed(2),
        purchaseUSD: row.purchaseUSD === null || row.purchaseUSD === undefined ? '未取到' : Number(row.purchaseUSD).toFixed(2),
        firstMileUSD: row.firstMileUSD === null || row.firstMileUSD === undefined ? '未取到' : Number(row.firstMileUSD).toFixed(2),
        fbaFeeUSD: row.fbaFeeUSD === null || row.fbaFeeUSD === undefined ? '未取到' : Number(row.fbaFeeUSD).toFixed(2) + (row.fbaEstimated === false ? '（实测）' : '（估算）'),
        referralUSD: row.referralUSD === null || row.referralUSD === undefined ? '未取到' : Number(row.referralUSD).toFixed(2),
        adUSD: row.adUSD === null || row.adUSD === undefined ? '未取到' : Number(row.adUSD).toFixed(2),
        returnUSD: row.returnUSD === null || row.returnUSD === undefined ? '未取到' : Number(row.returnUSD).toFixed(2),
        otherUSD: row.otherUSD === null || row.otherUSD === undefined ? '未取到' : Number(row.otherUSD).toFixed(2),
        totalCostUSD: row.totalCostUSD === null || row.totalCostUSD === undefined ? '未取到' : Number(row.totalCostUSD).toFixed(2),
        netProfitUSD: row.netProfitUSD === null || row.netProfitUSD === undefined ? '未取到' : Number(row.netProfitUSD).toFixed(2),
        netMargin: row.netMargin === null || row.netMargin === undefined ? '未取到' : (Number(row.netMargin) * 100).toFixed(2) + '%',
        logisticsRatio: row.logisticsRatio === null || row.logisticsRatio === undefined ? '未取到' : (Number(row.logisticsRatio) * 100).toFixed(2) + '%',
        purchaseRatio: row.purchaseRatio === null || row.purchaseRatio === undefined ? '未取到' : (Number(row.purchaseRatio) * 100).toFixed(2) + '%',
        sellerSpriteMargin: row.sellerSpriteMargin === null || row.sellerSpriteMargin === undefined ? '未取到' : Number(row.sellerSpriteMargin).toFixed(1) + '%（参照）',
        maxPurchaseCNY: row.maxPurchaseCNY === null || row.maxPurchaseCNY === undefined ? '未取到' : Number(row.maxPurchaseCNY).toFixed(2),
        verdict: row.verdict ?? '未判定',
      })),
      [
        { key: 'name', label: '子市场' },
        { key: 'priceUSD', label: '售价' },
        { key: 'purchaseUSD', label: '采购$' },
        { key: 'firstMileUSD', label: '头程$' },
        { key: 'fbaFeeUSD', label: 'FBA$' },
        { key: 'referralUSD', label: '佣金$' },
        { key: 'adUSD', label: '广告$' },
        { key: 'returnUSD', label: '退货$' },
        { key: 'otherUSD', label: '其它$' },
        { key: 'totalCostUSD', label: '全成本$' },
        { key: 'netProfitUSD', label: '净利$' },
        { key: 'netMargin', label: '净利率' },
        { key: 'logisticsRatio', label: '物流占售价' },
        { key: 'purchaseRatio', label: '采购占售价' },
        { key: 'sellerSpriteMargin', label: '卖家精灵毛利率(参照)' },
        { key: 'maxPurchaseCNY', label: '采购价上限(¥@25%红线)' },
        { key: 'verdict', label: '判定' },
      ],
    ),
  });

  return {
    ok: true,
    stage: 'completed',
    runId: run.runId,
    dir: run.dir,
    site: marketplace,
    provider: 'sellersprite-web',
    label: resolvedLabel,
    nodeIdPath: resolvedPath,
    candidates,
    score: { total: score.total, max: score.max, normalized: score.normalized, grade: score.grade, dimensions: score.dimensions, notes: score.notes },
    market: {
      totals: market.totals,
      avgs: market.avgs,
      concentration: market.concentration,
      structure: market.structure,
      newRatio: market.newRatio,
      newItems: market.newItems,
      grossMargin: market.grossMargin,
      scaleBasis: market.scaleBasis,
      sampleProducts: market.sampleProducts,
      subMarketCount: market.subMarkets.length,
      profitNetMargin: market.profitNetMargin,
      profitBasis: market.profitBasis,
      profitCoverage: market.profitCoverage,
      profitSubMarketCount: market.profitBySubMarket.length,
    },
    profit: {
      available: market.profitBySubMarket.length > 0,
      netMargin: market.profitNetMargin,
      basis: market.profitBasis,
      coverage: market.profitCoverage,
      scopeNote: market.profitScopeNote,
      rows: market.profitBySubMarket.map((row) => ({
        name: row.name,
        priceUSD: row.priceUSD,
        purchaseUSD: row.purchaseUSD,
        firstMileUSD: row.firstMileUSD,
        fbaFeeUSD: row.fbaFeeUSD,
        fbaEstimated: row.fbaEstimated,
        totalCostUSD: row.totalCostUSD,
        netProfitUSD: row.netProfitUSD,
        netMargin: row.netMargin,
        logisticsRatio: row.logisticsRatio,
        purchaseRatio: row.purchaseRatio,
        verdict: row.verdict,
      })),
    },
    artifacts,
    warnings,
    usage: { calls: usage.calls, errors: usage.errors.length, totalMs: Date.now() - t0 },
    reportPath: run.dir + '/report.md',
  };
}

/** 求一组 nodeIdPath 的最长公共前缀（如 228013:511228:2380872011 与 228013:511228:xxx → 228013:511228） */
function commonNodePath(paths) {
  const clean = paths.filter(Boolean).map((p) => String(p).split(':').filter(Boolean));
  if (!clean.length) return null;
  const first = clean[0];
  const prefix = [];
  for (let i = 0; i < first.length; i += 1) {
    const segment = first[i];
    if (clean.every((parts) => parts[i] === segment)) prefix.push(segment);
    else break;
  }
  return prefix.join(':') || first.join(':');
}

/** 价格带分布（由 Top 样本推导） */
function buildPriceBands(products) {
  const bands = [
    { label: '0-15', min: 0, max: 15 },
    { label: '15-30', min: 15, max: 30 },
    { label: '30-50', min: 30, max: 50 },
    { label: '50-100', min: 50, max: 100 },
    { label: '100+', min: 100, max: Infinity },
  ];
  const totalUnits = products.reduce((sum, p) => sum + (p.monthlySales || 0), 0);
  const totalRevenue = products.reduce((sum, p) => sum + (p.monthlyRevenue || 0), 0);
  return bands
    .map((band) => {
      const rows = products.filter((p) => p.price !== null && p.price >= band.min && p.price < band.max);
      const units = rows.reduce((sum, p) => sum + (p.monthlySales || 0), 0);
      const revenue = rows.reduce((sum, p) => sum + (p.monthlyRevenue || 0), 0);
      return {
        label: band.label,
        products: rows.length,
        units,
        revenue,
        unitsRatio: totalUnits ? units / totalUnits : null,
        revenueRatio: totalRevenue ? revenue / totalRevenue : null,
      };
    })
    .filter((band) => band.products > 0);
}

/** 评论数分桶（与上游阈值 300 对齐） */
function buildReviewBuckets(products) {
  const buckets = [
    { label: '0-50', min: 0, max: 50 },
    { label: '51-100', min: 51, max: 100 },
    { label: '101-300', min: 101, max: 300 },
    { label: '301-1000', min: 301, max: 1000 },
    { label: '1001+', min: 1001, max: Infinity },
  ];
  const totalUnits = products.reduce((sum, p) => sum + (p.monthlySales || 0), 0);
  return buckets
    .map((bucket) => {
      const rows = products.filter((p) => p.reviews !== null && p.reviews >= bucket.min && p.reviews <= bucket.max);
      const units = rows.reduce((sum, p) => sum + (p.monthlySales || 0), 0);
      return {
        label: bucket.label,
        products: rows.length,
        units,
        revenue: 0,
        unitsRatio: totalUnits ? units / totalUnits : null,
        revenueRatio: null,
      };
    })
    .filter((bucket) => bucket.products > 0);
}

/** 评分分桶 */
function buildRatingBuckets(products) {
  const buckets = [
    { label: '<4.0', min: 0, max: 4 },
    { label: '4.0-4.3', min: 4, max: 4.3 },
    { label: '4.3-4.6', min: 4.3, max: 4.6 },
    { label: '4.6-5.0', min: 4.6, max: 5.01 },
  ];
  const totalUnits = products.reduce((sum, p) => sum + (p.monthlySales || 0), 0);
  return buckets
    .map((bucket) => {
      const rows = products.filter((p) => p.rating !== null && p.rating >= bucket.min && p.rating < bucket.max);
      const units = rows.reduce((sum, p) => sum + (p.monthlySales || 0), 0);
      return {
        label: bucket.label,
        products: rows.length,
        units,
        revenue: 0,
        unitsRatio: totalUnits ? units / totalUnits : null,
        revenueRatio: null,
      };
    })
    .filter((bucket) => bucket.products > 0);
}

/** 上架时间分桶（按年月） */
function buildListingBuckets(products) {
  const map = new Map();
  for (const p of products) {
    if (!p.listedDate) continue;
    const key = p.listedDate.slice(0, 7);
    const row = map.get(key) || { label: key, products: 0, units: 0, revenue: 0 };
    row.products += 1;
    row.units += p.monthlySales || 0;
    row.revenue += p.monthlyRevenue || 0;
    map.set(key, row);
  }
  const totalUnits = products.reduce((sum, p) => sum + (p.monthlySales || 0), 0);
  return [...map.values()]
    .map((row) => ({ ...row, unitsRatio: totalUnits ? row.units / totalUnits : null, revenueRatio: null }))
    .sort((a, b) => (a.label < b.label ? 1 : -1));
}
