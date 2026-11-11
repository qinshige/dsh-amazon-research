import { scoreMarket } from './scoring.js';
import { renderCategoryReport, renderScoresJson, renderDashboardHtml, toCsv } from './report.js';
import { assertOk, buildMarket, extractNodes, itemsOf, normalizeProducts, pickMarketRow } from './normalize.js';
import { createRun, writeArtifacts } from './runs.js';

/** 并发上限 map */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 简单 slug（用于表头/文件名） */
function slug(text) {
  return String(text || 'market').trim().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'market';
}

/** 递归展开表格行（品牌/价格带等） */
function flattenRows(kind, rows) {
  return (rows || []).map((row) => ({ kind, ...row }));
}

/**
 * Amazon 品类选品主流程（Sellersprite）：
 * 找节点 → market_research → 6 个分布工具 → product_research（可选）→ 归一化 → 五维评分 → 报告落盘。
 */
export async function selectCategory({ providers, dataDir, outputRoot, provider = 'sellersprite', marketplace = 'US', category, nodeIdPath, limit = 50, month, unitCost = null, signal } = {}) {
  const usage = { calls: 0, byTool: {}, errors: [] };
  const warnings = [];
  const t0 = Date.now();

  const callTool = async (tool, args) => {
    const started = Date.now();
    usage.calls += 1;
    usage.byTool[tool] = (usage.byTool[tool] || 0) + 1;
    try {
      const payload = await providers.call(provider, tool, args, { signal });
      usage.byTool[tool + ':ms'] = (usage.byTool[tool + ':ms'] || 0) + (Date.now() - started);
      return assertOk(payload, tool);
    } catch (error) {
      usage.errors.push({ tool, message: String(error && error.message ? error.message : error) });
      throw error;
    }
  };

  if (!category && !nodeIdPath) {
    const err = new Error('缺少参数：请提供 category（类目关键词，如 "Cell Phones"）或 nodeIdPath（类目节点路径）');
    err.code = 'INVALID_ARGS';
    throw err;
  }

  // 1) 节点解析
  let resolvedPath = nodeIdPath ? String(nodeIdPath).trim() : '';
  let resolvedLabel = category || resolvedPath;
  let candidates = [];
  if (!resolvedPath) {
    const nodePayload = await callTool('product_node', { request: { marketplace, keyword: category } });
    const nodes = extractNodes(nodePayload).filter((node) => String(node.nodeIdPath).includes(':'));
    const leaf = nodes.filter((node) => (node.products || 0) > 0).sort((a, b) => (b.products || 0) - (a.products || 0));
    candidates = (leaf.length ? leaf : nodes).slice(0, 8).map((node) => ({ nodeIdPath: node.nodeIdPath, label: node.label, products: node.products }));
    if (!candidates.length) {
      const err = new Error('未找到类目节点：' + category + '。请换英文关键词，或直接提供 nodeIdPath（可从卖家精灵类目页复制）。');
      err.code = 'NODE_NOT_FOUND';
      err.usage = usage;
      throw err;
    }
    resolvedPath = candidates[0].nodeIdPath;
    resolvedLabel = candidates[0].label || category;
  }

  // 2) 市场大盘
  const marketPayload = await callTool('market_research', { request: { marketplace, nodeIdPath: resolvedPath, topNum: 10, newProduct: 6, size: Math.max(10, Math.min(100, Number(limit) || 50)), ...(month ? { month } : {}) } });
  const marketItems = itemsOf(marketPayload);
  if (!marketItems.length) {
    const err = new Error('market_research 未返回数据。可能原因：节点不是叶子节点（根节点统计为 0）、月份未就绪、或账号额度不足。');
    err.code = 'EMPTY_MARKET';
    err.usage = usage;
    throw err;
  }
  const nodeRow = pickMarketRow(marketItems, { nodeIdPath: resolvedPath, label: category });
  if (!nodeRow) {
    const err = new Error('类目市场数据为空，请换叶子节点重试');
    err.code = 'EMPTY_MARKET';
    err.usage = usage;
    throw err;
  }
  if (marketItems.length > 1) warnings.push('market_research 返回 ' + marketItems.length + ' 行（含子市场/父节点汇总），已按 nodeIdPath 选择一行；其余候选见 market.json.rawMarketItems');
  if (String(resolvedPath).split(':').length < 2) warnings.push('当前 nodeIdPath 层级较浅，根节点统计可能全 0，建议下钻到叶子类目');
  if (month) warnings.push('本月度参数为 ' + month + '；若该月未就绪，厂商会回退最近自然月');

  // 3) 分布工具（并发 3，单项失败不致命）
  const distributionTools = [
    ['price', 'market_price_distribution'],
    ['brand', 'market_brand_concentration'],
    ['rating', 'market_rating_distribution'],
    ['ratingsCount', 'market_ratings_count_distribution'],
    ['listingDate', 'market_listing_date_distribution'],
    ['sellerCountry', 'market_seller_country_distribution'],
  ];
  const distributionResults = await mapLimit(distributionTools, 3, async ([key, tool]) => {
    try {
      const payload = await callTool(tool, { request: { marketplace, nodeIdPath: resolvedPath, ...(month ? { month } : {}) } });
      return [key, itemsOf(payload)];
    } catch (error) {
      warnings.push('分布数据缺失（' + tool + '）：' + String(error && error.message ? error.message : error));
      return [key, []];
    }
  });
  const distributions = Object.fromEntries(distributionResults);

  // 4) 头部商品（可选，失败不影响评分）
  let products = [];
  try {
    const productPayload = await callTool('product_research', { request: { marketplace, nodeIdPath: resolvedPath, size: Math.max(10, Math.min(100, Number(limit) || 50)) } });
    products = normalizeProducts(productPayload, Number(limit) || 50);
  } catch (error) {
    warnings.push('头部商品列表未取到（product_research）：' + String(error && error.message ? error.message : error));
  }

  // 5) 归一化 + 评分
  const market = buildMarket({
    provider,
    marketplace,
    month: month || '',
    nodeIdPath: resolvedPath,
    label: resolvedLabel,
    nodeRow,
    distributions,
    products,
    fetchedAt: new Date().toISOString(),
    warnings,
  });
  market.rawMarketItems = marketItems.slice(0, 20);

  const score = scoreMarket(market, { unitCost });
  if (unitCost === null || unitCost === undefined) warnings.push('未提供采购成本（unitCost），利润维度按价格带估算，仅供初筛；接入 1688 成本后请重跑');

  // 6) 落盘
  const generatedAt = new Date().toISOString();
  const run = await createRun({ rootDir: outputRoot, kind: 'category', title: resolvedLabel || category || resolvedPath, site: marketplace, label: slug(resolvedLabel || category || 'market'), registryDir: dataDir });
  const reportMd = renderCategoryReport({ market, score, site: marketplace, generatedAt, warnings });
  const manifest = {
    runId: run.runId,
    kind: 'category',
    title: resolvedLabel || category || resolvedPath,
    site: marketplace,
    marketplace,
    provider,
    nodeIdPath: resolvedPath,
    month: month || '',
    params: { category: category || '', limit: Number(limit) || 50, unitCost: unitCost ?? null },
    usage: { ...usage, totalMs: Date.now() - t0 },
    fetchedAt: market.fetchedAt,
    createdAt: generatedAt,
    warnings,
    score: { total: score.total, max: score.max, normalized: score.normalized, grade: score.grade },
  };
  const tables = {
    'tables/market.csv': toCsv([{ metric: '月销量', value: market.totals.units }, { metric: '月销额', value: market.totals.revenue }, { metric: '在售商品数', value: market.totals.products }, { metric: '均价', value: market.avgs.price }, { metric: 'Top3 品牌集中度', value: market.concentration.top3BrandCrn }], ['metric', 'value']),
    'tables/brands.csv': toCsv(flattenRows('brand', market.distributions.brand), ['kind', 'brand', 'products', 'units', 'revenue', 'unitsRatio', 'rating', 'avgPrice']),
    'tables/price_bands.csv': toCsv(flattenRows('price', market.distributions.price), ['kind', 'label', 'products', 'units', 'revenue', 'unitsRatio']),
    'tables/top_products.csv': toCsv(market.products, ['asin', 'title', 'price', 'rating', 'reviews', 'brand', 'monthlySales', 'monthlyRevenue']),
  };
  const artifacts = await writeArtifacts(run, {
    'manifest.json': manifest,
    'market.json': market,
    'scores.json': renderScoresJson(score),
    'report.md': reportMd,
    'dashboard.html': renderDashboardHtml({ market, score, generatedAt }),
    ...tables,
  });

  return {
    ok: true,
    stage: 'completed',
    runId: run.runId,
    dir: run.dir,
    site: marketplace,
    provider,
    label: market.label,
    nodeIdPath: resolvedPath,
    candidates,
    score: { total: score.total, max: score.max, normalized: score.normalized, grade: score.grade, dimensions: score.dimensions, notes: score.notes },
    market: {
      totals: market.totals,
      avgs: market.avgs,
      concentration: market.concentration,
      structure: market.structure,
      newRatio: market.newRatio,
    },
    artifacts,
    warnings,
    usage: { calls: usage.calls, errors: usage.errors.length, totalMs: Date.now() - t0 },
    reportPath: run.dir + '/report.md',
  };
}
