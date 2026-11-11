/**
 * Sellersprite 响应归一化。
 * 厂商返回结构不统一（data.items / data 数组 / 纯数组），统一在这里兜住，并保留 warnings。
 */

/** 取数组：兼容 {data:{items:[]}} / {data:[]} / {items:[]} / [] */
export function itemsOf(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.items)) return payload.items;
  const data = payload.data;
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.list)) return data.list;
  if (Array.isArray(payload.list)) return payload.list;
  return [];
}

/** 检查 Sellersprite 业务错误码 */
export function assertOk(payload, label) {
  if (!payload || typeof payload !== 'object') return payload;
  const code = payload.code;
  if (code !== undefined && code !== null && Number(code) !== 200 && Number(code) !== 0) {
    const err = new Error((label || '接口') + ' 返回错误码 ' + code + ': ' + (payload.message || payload.msg || ''));
    err.code = 'PROVIDER_ERROR';
    err.payload = payload;
    throw err;
  }
  return payload;
}

/** 数字兜底 */
export function num(value, fallback = null) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[,%$\s]/g, '').replace(/[^0-9.\-]/g, '');
    const n = Number(cleaned);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** 比例归一到 0~1：大于 1.5 视为百分数 */
export function ratio01(value) {
  const n = num(value, null);
  if (n === null) return null;
  return Math.abs(n) > 1.5 ? n / 100 : n;
}

/** 百分数归一：小于等于 1.5 视为比例 */
export function pct(value) {
  const n = num(value, null);
  if (n === null) return null;
  return Math.abs(n) <= 1.5 ? n * 100 : n;
}

function firstOf(obj, keys, fallback = null) {
  if (!obj || typeof obj !== 'object') return fallback;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return fallback;
}

/** 从 product_node 响应里提取节点候选（带商品数的叶子优先） */
export function extractNodes(payload) {
  const items = itemsOf(payload);
  return items
    .map((row) => ({
      nodeIdPath: firstOf(row, ['nodeIdPath', 'nodePath', 'nodeId', 'id']),
      label: firstOf(row, ['nodeLabelPath', 'nodeLabelName', 'label', 'name', 'title']),
      products: num(firstOf(row, ['products', 'totalProducts', 'productCount', 'asinNum']), 0),
      marketplace: firstOf(row, ['marketplace', 'market']),
      raw: row,
    }))
    .filter((node) => Boolean(node.nodeIdPath));
}

/** 在 market_research 的子市场列表里挑一行：优先 nodeIdPath 精确匹配，其次标签末尾匹配，最后取商品数最多的一行 */
export function pickMarketRow(items, { nodeIdPath, label } = {}) {
  if (!items.length) return null;
  if (nodeIdPath) {
    const exact = items.find((row) => String(firstOf(row, ['nodeIdPath', 'nodePath', 'nodeId'], '')).startsWith(String(nodeIdPath)));
    if (exact) return exact;
  }
  if (label) {
    const needle = String(label).toLowerCase();
    const byLabel = items.find((row) => String(firstOf(row, ['nodeLabelPath', 'nodeLabelName', 'label', 'name'], '')).toLowerCase().includes(needle));
    if (byLabel) return byLabel;
  }
  return items
    .filter((row) => (num(firstOf(row, ['totalProducts', 'products'], 0), 0) || 0) > 0)
    .sort((a, b) => (num(firstOf(b, ['totalUnits', 'units'], 0), 0) || 0) - (num(firstOf(a, ['totalUnits', 'units'], 0), 0) || 0))[0] || items[0];
}

/** 分布数组归一：字段名按工具不同做兼容，比例统一成 0~1 */
export function normalizeDistribution(kind, payload) {
  const rows = itemsOf(payload);
  return rows.map((row) => {
    const base = {
      products: num(firstOf(row, ['products', 'asinNum', 'productNum', 'totalProducts']), 0) || 0,
      units: num(firstOf(row, ['units', 'totalUnits']), 0) || 0,
      revenue: num(firstOf(row, ['revenue', 'totalRevenue']), 0) || 0,
    };
    const unitsRatio = ratio01(firstOf(row, ['unitsRatio', 'totalUnitsRatio', 'salesRatio']));
    const revenueRatio = ratio01(firstOf(row, ['revenueRatio', 'totalRevenueRatio']));
    const asinRatio = ratio01(firstOf(row, ['asinRatio', 'productsRatio']));
    const common = { ...base, unitsRatio, revenueRatio, asinRatio };
    if (kind === 'brand') {
      return {
        ...common,
        brand: firstOf(row, ['brand', 'brandName', 'label'], ''),
        newProducts: num(firstOf(row, ['newProducts', 'newCount']), 0) || 0,
        avgPrice: num(firstOf(row, ['avgPrice']), null),
        rating: num(firstOf(row, ['rating', 'avgRating']), null),
        ratings: num(firstOf(row, ['ratings', 'avgRatings']), null),
      };
    }
    if (kind === 'sellerCountry') {
      return { ...common, country: firstOf(row, ['country', 'label', 'sellerCountry'], '') };
    }
    if (kind === 'sellerType') {
      return { ...common, label: firstOf(row, ['label', 'type', 'fulfillment'], '') };
    }
    return { ...common, label: firstOf(row, ['label', 'name', 'priceRange', 'ratingRange'], '') };
  });
}

/** 构建归一化 Market。nodeRow 来自 market_research，distributions 为各工具原始返回 */
export function buildMarket({ provider, marketplace, month, nodeIdPath, label, nodeRow = {}, distributions = {}, products = [], fetchedAt, warnings = [] }) {
  const concentration = {
    top3ProductCrn: ratio01(firstOf(nodeRow, ['top3ProductCrn', 'top3ProductsCrn', 'top3ProductConcentration'])),
    top3BrandCrn: ratio01(firstOf(nodeRow, ['top3BrandCrn', 'top3BrandsCrn', 'top3BrandConcentration'])),
    top3SellerCrn: ratio01(firstOf(nodeRow, ['top3SellerCrn', 'top3SellersCrn'])),
    top5BrandCrn: ratio01(firstOf(nodeRow, ['top5BrandCrn', 'top5BrandsCrn'])),
    top10BrandCrn: ratio01(firstOf(nodeRow, ['top10BrandCrn', 'top10BrandsCrn'])),
  };
  const structure = {
    fbaProportion: pct(firstOf(nodeRow, ['fbaProportion'])),
    fbmProportion: pct(firstOf(nodeRow, ['fbmProportion'])),
    amazonSelfProportion: pct(firstOf(nodeRow, ['amazonSelfProportion'])),
    returnRatio: pct(firstOf(nodeRow, ['returnRatio'])),
  };
  const newRatio = {
    l1: ratio01(firstOf(nodeRow, ['l1NewRatio', 'l1NewProportion'])),
    l3: ratio01(firstOf(nodeRow, ['l3NewRatio', 'l3NewProportion'])),
    l6: ratio01(firstOf(nodeRow, ['l6NewRatio', 'l6NewProportion'])),
    l12: ratio01(firstOf(nodeRow, ['l12NewRatio', 'l12NewProportion'])),
  };
  const market = {
    provider,
    marketplace,
    month,
    nodeIdPath,
    label,
    totals: {
      products: num(firstOf(nodeRow, ['totalProducts', 'products']), null),
      units: num(firstOf(nodeRow, ['totalUnits', 'units']), null),
      revenue: num(firstOf(nodeRow, ['totalRevenue', 'revenue']), null),
    },
    avgs: {
      price: num(firstOf(nodeRow, ['avgPrice', 'averagePrice']), null),
      units: num(firstOf(nodeRow, ['avgUnits', 'averageUnits']), null),
      revenue: num(firstOf(nodeRow, ['avgRevenue', 'averageRevenue']), null),
      bsr: num(firstOf(nodeRow, ['avgBsr', 'averageBsr']), null),
      rating: num(firstOf(nodeRow, ['avgRating', 'averageRating']), null),
      ratings: num(firstOf(nodeRow, ['avgRatings', 'averageRatings']), null),
    },
    concentration,
    structure,
    newRatio,
    distributions: {
      price: normalizeDistribution('price', distributions.price),
      brand: normalizeDistribution('brand', distributions.brand),
      sellerCountry: normalizeDistribution('sellerCountry', distributions.sellerCountry),
      rating: normalizeDistribution('rating', distributions.rating),
      ratingsCount: normalizeDistribution('ratingsCount', distributions.ratingsCount),
      listingDate: normalizeDistribution('listingDate', distributions.listingDate),
      sellerType: normalizeDistribution('sellerType', distributions.sellerType),
      product: normalizeDistribution('product', distributions.product),
      demandTrend: normalizeDistribution('demandTrend', distributions.demandTrend),
    },
    products,
    fetchedAt: fetchedAt || new Date().toISOString(),
    warnings,
  };
  return market;
}

/** 把 product_research 的产品行映射成统一 Product（字段容错） */
export function normalizeProducts(payload, limit = 100) {
  return itemsOf(payload)
    .slice(0, limit)
    .map((row) => ({
      asin: firstOf(row, ['asin', 'ASIN'], ''),
      title: firstOf(row, ['title', 'productTitle', 'name'], ''),
      price: num(firstOf(row, ['price', 'avgPrice']), null),
      rating: num(firstOf(row, ['rating', 'star', 'avgRating']), null),
      reviews: num(firstOf(row, ['reviews', 'ratings', 'reviewCount']), null),
      brand: firstOf(row, ['brand', 'brandName'], ''),
      seller: firstOf(row, ['seller', 'sellerName'], ''),
      sellerSource: firstOf(row, ['sellerSource', 'sellerCountry', 'country'], ''),
      monthlySales: num(firstOf(row, ['units', 'monthlySales', 'sales']), null),
      monthlyRevenue: num(firstOf(row, ['revenue', 'monthlyRevenue']), null),
      launchDays: num(firstOf(row, ['listingDays', 'launchDays', 'daysOnline']), null),
    }))
    .filter((p) => Boolean(p.asin));
}
