/**
 * dsh-amazon-research · host/selection/category-advice.js
 *
 * 把类目级数据接到「四途径 → 九策略 → 十维 → 差异化」的落地上：
 * 报告第九章只用真实类目字段，缺的写「未取到 / 需人工」。
 */
import { buildSelectionPlan, DIMENSION_CHECKLIST } from './channels.js';
import { PRECISION_LOOP } from './differentiate.js';

const OK = '达标';
const WARN = '警戒';
const BAD = '不达标';

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function money(value) {
  const n = num(value);
  if (n === null) return '—';
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  return '$' + Math.round(n).toLocaleString('en-US');
}

function pct(value, digits = 0) {
  const n = num(value);
  return n === null ? '—' : (n * 100).toFixed(digits) + '%';
}

function pointPct(value, digits = 0) {
  const n = num(value);
  return n === null ? '—' : n.toFixed(digits) + '%';
}

function cell(value) {
  return String(value ?? '').replace(/\|/g, '/').replace(/\r?\n/g, ' ');
}

function table(headers, rows) {
  return [
    '| ' + headers.join(' | ') + ' |',
    '| ' + headers.map(() => '---').join(' | ') + ' |',
    ...rows.map((row) => '| ' + row.map(cell).join(' | ') + ' |'),
  ];
}

/** 类目级十维体检：只判有数据的维度，其余显式标「未取到 / 需人工」。 */
export function categoryDimensionRows(view) {
  const rows = [];
  const revenue = num(view?.totals?.revenue);
  const brandCr3 = num(view?.concentration?.brandCr3);
  const avgRatings = num(view?.avgs?.ratings);
  const newRatio = num(view?.newRatios?.l6) ?? num(view?.newRatios?.l3);
  const avgPrice = num(view?.avgs?.price);
  const returnRatio = num(view?.structure?.returnRatio);
  const netMargin = num(view?.profit?.netMargin);

  rows.push(['1. 市场容量与竞争热度', '样本月销额 ' + money(revenue) + '；Top3 品牌 ' + pct(brandCr3),
    revenue === null ? '未取到' : (revenue < 1_000_000 ? WARN : (revenue > 10_000_000 ? WARN : OK)),
    revenue !== null && revenue < 1_000_000 ? '体量偏小，先确认是否有稳定需求' : '体量与集中度需结合单品再判']);
  rows.push(['2. 产品趋势', '类目报告未接关键词趋势', '未取到', '需补 Google Trends / ABA 10–20 万区间']);
  rows.push(['3. 价格区间', '平均价格 ' + money(avgPrice) + '；价格带分布见第五节',
    avgPrice === null ? '未取到' : (avgPrice >= 15 && avgPrice <= 45 ? OK : WARN),
    '避开无利润的基本消费带；高单价带看竞品利润与销量']);
  rows.push(['4. 评分数量与星级', '平均星级 ' + (num(view?.avgs?.rating) === null ? '—' : num(view.avgs.rating).toFixed(2)) + '；平均评论 ' + (avgRatings === null ? '—' : Math.round(avgRatings)),
    avgRatings === null ? '未取到' : (avgRatings < 1000 ? OK : (avgRatings <= 5000 ? WARN : BAD)),
    avgRatings > 5000 ? '评价壁垒高，新品机会小' : '低评分可作差异化入口']);
  rows.push(['5. 新品占有率', 'L6 新品占比 ' + pct(newRatio),
    newRatio === null ? '未取到' : (newRatio >= 0.10 && newRatio <= 0.25 ? OK : (newRatio < 0.05 ? BAD : WARN)),
    '10%–25% 说明类目仍在流动']);
  rows.push(['6. 季节性 / 节日性', '类目报告未接季节指数', '未取到', '需用关键词趋势/历史销量判断；节日品单独算备货']);
  rows.push(['7. 质量、退货与变体', '类目退货率 ' + pointPct(returnRatio),
    returnRatio === null ? '未取到' : (returnRatio <= 5 ? OK : (returnRatio <= 10 ? WARN : BAD)),
    '> 10% 需拆差评并重算利润；变体需逐 ASIN 看']);
  rows.push(['8. 运输便利性', '类目级无件重/尺寸', '未取到', '需在单品体检里按件重与 FBA 费判断']);
  rows.push(['9. 供应链优势', '类目级无法判断', '需人工', '用 research_unit_cost 采 1688，确认 ≥ 2 家供应商']);
  rows.push(['10. 侵权、认证与类目审核', '类目级无法判断', '需人工', 'WIPO / 商标 / 平台规则逐项查，本工具不做法律定性']);
  rows.push(['利润', netMargin === null ? '未接入采购价' : '净利率 ' + pct(netMargin, 1),
    netMargin === null ? '未取到' : (netMargin > 0.30 ? OK : (netMargin >= 0.15 ? WARN : BAD)),
    netMargin === null ? '跑 research_unit_cost 后重算' : '净利率 > 25% 才考虑，小体量 > 30%']);
  return rows;
}

/** 类目级差异化方向：每条都带当前类目的真实数字作为证据。 */
export function categoryDifferentiation(view) {
  const items = [];
  const brandCr3 = num(view?.concentration?.brandCr3);
  const newRatio = num(view?.newRatios?.l6) ?? num(view?.newRatios?.l3);
  const rating = num(view?.avgs?.rating);
  const returnRatio = num(view?.structure?.returnRatio);
  const lowReview = num(view?.lowReview?.share);
  const topBand = view?.priceStats?.topBand;

  if (brandCr3 !== null && brandCr3 >= 0.5) items.push('**人群 / 场景细分**：品牌集中度 ' + pct(brandCr3) + '，正面硬刚不划算，换人群或场景重新定义卖点');
  if (newRatio !== null && newRatio < 0.1) items.push('**材质 / 外观微创新**：L6 新品占比 ' + pct(newRatio) + '，类目偏固化，靠材质、配色、细节结构切入');
  if (rating !== null && rating < 4.3) items.push('**质量与说明书**：平均星级 ' + rating.toFixed(2) + '，拆 3 星以下评论修高频问题');
  if (returnRatio !== null && returnRatio > 10) items.push('**防退货设计**：类目退货率 ' + pointPct(returnRatio) + '，加固包装、补尺寸/适配说明');
  if (lowReview !== null && lowReview > 0.4) items.push('**低评论窗口**：低评论商品销量占比 ' + pct(lowReview) + '，新链接仍有曝光机会，主图与卖点要快');
  if (topBand && topBand.label) items.push('**避开主价格带正面竞争**：销量最高价格带是 ' + topBand.label + '（占比 ' + pct(topBand.unitsShare) + '），用组合装 / 套装切到相邻价格带');
  items.push('**基础项**：包装、主图、说明书永远可做；上架前自查 1688 图片版权');
  return items;
}

/**
 * 渲染报告第九章（类目报告的落地区）。
 * @param {object} view resolveReportMetrics 的返回
 * @returns {string[]} markdown 行
 */
export function renderCategorySelectionSection(view) {
  const lines = [];
  const push = (...items) => lines.push(...items);
  const plan = buildSelectionPlan({
    marketplace: view?.site || 'US',
    category: view?.label || '',
    nodeIdPath: view?.nodeIdPath || '',
    signals: {
      brandCr3: num(view?.concentration?.brandCr3),
      avgPrice: num(view?.avgs?.price),
    },
  });

  push('## 九、选品落地（四途径 → 九策略 → 十维 → 差异化）', '');
  push('> 本章把类目数据接到选品 SOP：类目级只能回答「这个类目值不值得进」，单品结论需用 research_product_select（action=screen）做体检。', '');

  push('### 9.1 四途径入口', '');
  push(...table(['途径', '入口', '用途 / 链接'], [
    ...plan.channels.map((channel) => [channel.part, channel.name, (channel.url || '需关键词工具') + ' — ' + channel.purpose]),
    ['站外', '其他平台 / 社媒', plan.offAmazon.map((item) => item.name).join('、')],
    ['站外', '线下', plan.offAmazon.find((item) => item.id === 'offline')?.examples || '产业带 / 展会 / 商超 / 工厂'],
    ['软件', '卖家精灵 / Sorftime / H10 / 鸥鹭', '只做交叉验证，不替代类目分析'],
  ]));
  push('');
  push('> 一级类目只作场景，必须下钻到三、四级再看榜；榜单里同款链接已多、价格易卷、专利 TRO 的品直接避开。', '');

  push('### 9.2 九策略适配', '');
  push(...table(['策略', '状态', '为什么', '对应工具'], plan.strategies.map((strategy) => [
    strategy.name, strategy.status, strategy.why, strategy.tool,
  ])));
  push('');

  push('### 9.3 类目级十维体检', '');
  push(...table(['维度', '当前值', '判定', '说明'], categoryDimensionRows(view)));
  push('');
  push('> 十维清单（逐项阈值）：', '');
  for (const item of DIMENSION_CHECKLIST) push('- **' + item.no + '. ' + item.name + '**：' + item.kpi + '（来源：' + item.source + '）');
  push('');

  push('### 9.4 差异化方向', '');
  for (const item of categoryDifferentiation(view)) push('- ' + item);
  push('');

  push('### 9.5 落地动作', '');
  const sample = (view?.products || []).slice(0, 5).map((product) => product.asin).filter(Boolean);
  if (sample.length > 0) {
    push('- 从附录 Top 产品里挑 3–5 个先体检：research_product_select（action=screen），本报告 Top ASIN：' + sample.join('、'));
  } else {
    push('- 先从前台榜单/竞品店铺采 3–5 个 ASIN，再调 research_product_select（action=screen）做十维体检');
  }
  push('- 对一档/二档候选跑 research_unit_cost 采 1688 真实采购价，把利润空间换成净利率口径重算');
  push('- 人工查 WIPO（外观 / 发明 / 实用新型）与商标，确认认证与类目审核；1688 图片不要直接用');
  push('');
  push('精铺闭环：', '');
  for (const step of PRECISION_LOOP) push('- ' + step);
  push('');

  return lines;
}
