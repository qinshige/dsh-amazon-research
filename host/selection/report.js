/**
 * dsh-amazon-research · host/selection/report.js
 *
 * 选品体检报告（Markdown / CSV）：结论 → 四途径 → 九策略 → 十维 → 差异化 → 利润 → 合规。
 * 只渲染传入的真实数据；缺失项显式写「未取到 / 待复核」。
 */

const TIER_ORDER = ['一档', '二档', '三档', '待复核', '淘汰'];

/** KPI → 输入列 → 证据类型：保证报告里每个数字都能追到采集表的一列。 */
const KPI_SOURCES = [
  ['市场容量（Top100 月销）', 'Top100月销', '采集值', '类目 Top100 月销，需备注数据源与月份'],
  ['品牌集中度', '品牌集中度%', '采集值', 'Top3 品牌销量占比'],
  ['类目前十评价数', '前10评价数', '采集值', '类目前 10 名评论数，注明采集口径'],
  ['新品占比', '新品占比%', '采集值', '近 6/12 个月上架占比，注明窗口'],
  ['产品趋势', '趋势', '人工判断', 'Google Trends / ABA 结论，需写来源'],
  ['ABA 排名', 'ABA排名', '采集值', '关键词 ABA 排名'],
  ['售价区间', '售价USD', '采集值', '当前售价，注明抓取时间'],
  ['采购成本占售价', '采购价CNY + 售价USD + 汇率', '计算值', '(采购价 ÷ 汇率) ÷ 售价'],
  ['评分星级', '评分', '采集值', '页面星级'],
  ['差评可解决性', '差评痛点', '人工判断', '3 星及以下评论归纳，附链接/条数'],
  ['季节性', '季节性', '人工判断', '历史趋势 / 节日属性'],
  ['退货率', '退货率', '采集值', '类目或竞品退货率，注明口径'],
  ['变体数', '变体数', '采集值', 'Listing 变体数量'],
  ['物流占售价', 'FBA配送费USD + 头程USD（或件重） + 售价USD', '计算值', '(头程 + FBA) ÷ 售价'],
  ['易碎 / 抛货', '易碎 + 重量g + 长/宽/高cm', '采集值', '包装形态与体积重'],
  ['大件抛货', '重量g', '计算值', '> 2000g 触发；体积重按 长×宽×高÷6000'],
  ['供应商数量', '供应商数', '人工判断', '1688/工厂确认，至少 2 家'],
  ['专利/商标风险', '专利风险', '人工判断', 'WIPO/商标检索结论，附检索号'],
  ['认证要求', '认证', '人工判断', 'CPC / EN71 / UL / FDA 等证书状态'],
  ['净利率', '售价USD + 采购价CNY + 件重g + FBA + 广告占比 + 退货率 + 佣金占比 + 头程USD + 其他USD', '计算值', '见 8.4 与默认参数'],
  ['广告占售价', '广告占比', '采集值 / 估算', '新卖家可按 12%–15% 复核'],
  ['类目层级', '类目路径', '采集值', '按 > 或 / 分隔的层级数'],
];

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function money(value) {
  const n = num(value);
  return n === null ? '—' : '$' + n.toFixed(2);
}

function pct(value, digits = 0) {
  const n = num(value);
  return n === null ? '—' : (n * 100).toFixed(digits) + '%';
}

function int(value) {
  const n = num(value);
  return n === null ? '—' : String(Math.round(n));
}

function cell(value) {
  return String(value ?? '').replace(/\|/g, '/').replace(/\r?\n/g, ' ');
}

function table(headers, rows) {
  const lines = [];
  lines.push('| ' + headers.join(' | ') + ' |');
  lines.push('| ' + headers.map(() => '---').join(' | ') + ' |');
  for (const row of rows) lines.push('| ' + row.map(cell).join(' | ') + ' |');
  return lines;
}

/** 利润敏感性：采购 +20% / 售价 -10% / 广告 15%。 */
export function sensitivity(profit) {
  if (!profit) return null;
  const price = num(profit.priceUSD);
  const base = num(profit.totalCostUSD);
  const purchase = num(profit.purchaseUSD) ?? 0;
  const ad = num(profit.adUSD) ?? 0;
  if (!price || base === null) return null;
  const variable = (num(profit.commissionUSD) ?? 0) + ad + (num(profit.returnUSD) ?? 0);
  const fixed = purchase + (num(profit.firstMileUSD) ?? 0) + (num(profit.fbaFeeUSD) ?? 0) + (num(profit.otherUSD) ?? 0);
  const purchaseUp = (price - (base + purchase * 0.2)) / price;
  const priceDownPrice = price * 0.9;
  const priceDown = (priceDownPrice - (fixed + variable * 0.9)) / priceDownPrice;
  const adUp = (price - (base - ad + price * 0.15)) / price;
  return { purchaseUp, priceDown, adUp };
}

function planSection(plan) {
  const lines = [];
  if (!plan) return lines;
  lines.push('## 二、四途径执行路线', '');
  lines.push('> 链接只是入口；页面数字必须真实抓取，抓不到写「未取到」，不要用记忆补。', '');
  lines.push('### 2.1 站内榜单与热搜', '');
  lines.push(...table(['入口', '链接', '抓什么', '注意'], plan.channels.map((channel) => [
    channel.name,
    channel.url || '需关键词工具（卖家精灵 / ABA 后台）',
    channel.fields.join('、'),
    channel.caution,
  ])));
  lines.push('');
  lines.push('### 2.2 站外 / 软件 / 线下', '');
  const off = [...plan.offAmazon.map((item) => [item.name, item.examples, item.use])];
  lines.push(...table(['站外渠道', '代表平台', '用途'], off));
  lines.push('');
  lines.push(...table(['软件', '用途'], plan.software.map((item) => [item.name, item.use])));
  lines.push('');
  lines.push('### 2.3 九种选品方式', '');
  lines.push(...table(['策略', '状态', '为什么', '执行步骤', '对应工具'], plan.strategies.map((item) => [
    item.name,
    item.status,
    item.why,
    item.steps.join('；'),
    item.tool,
  ])));
  lines.push('');
  lines.push('### 2.4 下一步动作', '');
  for (const action of plan.nextActions) lines.push('- ' + action);
  lines.push('');
  return lines;
}

/**
 * 渲染选品体检报告。
 * @param {{title:string, marketplace:string, generatedAt:string, batch:object, plan?:object, source?:string, fx?:number}} params
 */
export function renderSelectionReport({ title = '选品', marketplace = 'US', generatedAt = '', batch, plan = null, source = '手动/采集表', fx = 7.1, runId = '', inputHash = '', artifacts = [] } = {}) {
  const results = batch?.results || [];
  const summary = batch?.summary || { tiers: {}, commonGaps: [], vetoed: 0, needsReview: [], avgMargin: null };
  const lines = [];
  const push = (...items) => lines.push(...items);

  push('# ' + title + ' 选品体检报告（' + marketplace + '）', '');
  push('> 生成时间：' + (generatedAt || '—') + ' ｜ 候选数：' + results.length + ' ｜ 数据来源：' + source + ' ｜ 汇率：1 USD = ' + fx + ' CNY', '');
  push('> 运行 ID：' + (runId || '—') + ' ｜ 输入指纹：' + (inputHash || '—'), '');
  push('---', '');

  // 一、结论
  push('## 一、结论摘要', '');
  push('**分档：' + TIER_ORDER.map((tier) => tier + ' ' + (summary.tiers[tier] || 0)).join(' ｜ ') + '**', '');
  if (summary.avgMargin !== null) push('- 平均净利率：**' + pct(summary.avgMargin, 1) + '**（全成本口径：采购 + 头程 + FBA + 佣金 + 广告 + 退货 + 其它）。');
  push('- 一票否决：**' + summary.vetoed + '** 个；待复核：**' + summary.needsReview.length + '** 个。');
  const picks = results.filter((item) => item.tier === '一档' || item.tier === '二档').slice(0, 5);
  if (picks.length > 0) {
    push('');
    push('**优先候选（一档 / 二档，最多 5 个）**：', '');
    push(...table(['ASIN', '商品', '档位', '售价', '净利率', 'KPI 命中率', '理由'], picks.map((item) => [
      item.asin || '—', item.name || '—', item.tier, money(item.priceUSD), pct(item.margin, 1), pct(item.hitRate), item.tierReason,
    ])));
  } else {
    push('');
    push('本批没有一档 / 二档候选：先补齐缺失字段，或按第五节差异化方向换切入点后重跑。', '');
  }
  push('');

  // 二、四途径
  push(...planSection(plan));

  // 三、十维明细
  push('## 三、十维体检明细', '');
  if (results.length === 0) {
    push('（无候选数据。）', '');
  } else {
    push(...table(['ASIN', '商品', '档位', '售价', '净利率', '命中率', '否决', '待复核'], results.map((item) => [
      item.asin || '—',
      item.name || '—',
      item.tier,
      money(item.priceUSD),
      pct(item.margin, 1),
      pct(item.hitRate) + '（' + item.judgedCount + ' 项）',
      item.vetoes.length ? item.vetoes.map((v) => v.label).join('、') : '—',
      item.unknown.length ? item.unknown.join('、') : '—',
    ])));
    push('');
    const detail = results.slice(0, 12);
    for (const item of detail) {
      push('### ' + (item.asin || '未命名') + ' ' + (item.name || '') + '（' + item.tier + '）', '');
      push(...table(['维度', '检查项', '状态', '数值', '说明'], item.checks.map((check) => [
        check.dimension + '. ' + check.dimensionLabel,
        check.label,
        check.status,
        check.value,
        check.note,
      ])));
      push('');
    }
    if (results.length > detail.length) push('（其余 ' + (results.length - detail.length) + ' 个候选的逐项明细见 selection.csv。）', '');
  }

  // 四、否决
  push('## 四、一票否决清单', '');
  const vetoed = results.filter((item) => item.vetoes.length > 0);
  if (vetoed.length === 0) {
    push('本批未命中一票否决项。', '');
  } else {
    for (const item of vetoed) {
      push('- **' + (item.asin || '未命名') + '**：' + item.vetoes.map((v) => v.label + '（' + v.detail + '）').join('；'));
    }
    push('');
  }

  // 五、差异化
  push('## 五、差异化方向（按证据生成）', '');
  const withDiff = results.filter((item) => (item.tier === '一档' || item.tier === '二档') && item.differentiation?.length).slice(0, 5);
  if (withDiff.length === 0) {
    push('（没有一档/二档候选，暂不输出差异化建议；先补数据或按「外在 / 内在」清单人工拆解。）', '');
  } else {
    for (const item of withDiff) {
      push('### ' + (item.asin || '未命名') + ' ' + (item.name || ''), '');
      push(...table(['优先级', '轴', '方向', '证据', '验证动作'], item.differentiation.map((diff) => [
        diff.priority, diff.axis, diff.direction, diff.evidence, diff.action,
      ])));
      push('');
    }
  }

  // 六、利润
  push('## 六、利润与敏感性', '');
  const profitRows = results.filter((item) => item.profit);
  if (profitRows.length === 0) {
    push('（没有可测算的利润数据：缺采购价或售价。先跑 research_unit_cost 采 1688 真实采购价。）', '');
  } else {
    push(...table(['ASIN', '售价', '采购', '头程', 'FBA', '佣金', '广告', '退货', '其它', '总成本', '净利', '净利率', '物流占比'], profitRows.map((item) => [
      item.asin || '—',
      money(item.profit.priceUSD),
      money(item.profit.purchaseUSD),
      money(item.profit.firstMileUSD),
      money(item.profit.fbaFeeUSD) + (item.profit.fbaEstimated ? '（估）' : ''),
      money(item.profit.commissionUSD),
      money(item.profit.adUSD),
      money(item.profit.returnUSD),
      money(item.profit.otherUSD),
      money(item.profit.totalCostUSD),
      money(item.profit.netProfitUSD),
      pct(item.profit.netMargin, 1),
      pct(item.profit.logisticsRatio),
    ])));
    push('');
    const senseRows = profitRows.map((item) => {
      const s = sensitivity(item.profit);
      return [
        item.asin || '—',
        s ? pct(s.purchaseUp, 1) : '—',
        s ? pct(s.priceDown, 1) : '—',
        s ? pct(s.adUp, 1) : '—',
        s && s.purchaseUp > 0.20 && s.priceDown > 0.20 && s.adUp > 0.20 ? '三项均 > 20%' : '有项跌破 20%',
      ];
    });
    push('敏感性（采购 +20% / 售价 -10% / 广告 15%）：', '');
    push(...table(['ASIN', '采购 +20%', '售价 -10%', '广告 15%', '判读'], senseRows));
    push('');
    push('> 红线：净利率 > 25% 才考虑；体量小（100–200 单）需 > 30%；物流占售价 10%–15%，> 20% 建议放弃；$15–20 售价段采购价 ≤ ¥30、FBA < $4.5。', '');
  }

  // 七、合规与风控
  push('## 七、合规与风控清单', '');
  push('- **图片**：1688 图片不要直接用（工厂自述「实拍」不可信），上架前自查素材版权。');
  push('- **专利**：外观 / 实用新型 / 发明专利用 WIPO、Google Patents、商标局逐项检索；「外观结构差异」不是免责结论，需专业检索。');
  push('- **认证**：CPC / EN71 / UL / FDA 等先确认证书与测试报告拿得到，再定品。');
  push('- **变体**：新卖家不超过 3 个变体；补货「多补少发」，后期做包装优化。');
  push('- **物流**：首批可走美森快船（30–40 天）；轻小/热销/季节性可空运（10–15 天）或快递。');
  push('- **杀猪盘**：网红带货突然爆红、周期短、工厂做局推高再等专利 TRO 的产品，直接放弃。');
  push('- **类目**：一级类目只作场景，必须下钻三、四级；受限/危险品类目先查平台规则。');
  push('');

  // 八、数据来源、追溯与待复核
  push('## 八、数据来源、追溯与待复核', '');
  push('### 8.1 追溯信息', '');
  push(...table(['项目', '值'], [
    ['运行 ID', runId || '—'],
    ['输入指纹（SHA-256）', inputHash || '—'],
    ['候选数', String(results.length)],
    ['候选来源', source],
    ['站点', marketplace],
    ['生成时间', generatedAt || '—'],
    ['汇率', '1 USD = ' + fx + ' CNY（估算值，按实际汇率改）'],
    ['产物', artifacts.length ? artifacts.map((item) => item.name).join('、') : 'report.md、selection.csv、selection-scores.json、provenance.json、manifest.json'],
  ]));
  push('');
  push('> 同一份采集表 + 同一汇率会得到同一个输入指纹，可用它核对报告是否被改过；原始输入行与逐项判定另存 provenance.json。', '');
  push('### 8.2 逐品来源', '');
  push(...table(['ASIN', '商品链接', '1688 链接', '采集时间', '来源标注', '缺失字段'], results.map((item) => {
    const prov = item.provenance || {};
    return [
      item.asin || '—',
      prov.listingUrl || '未提供',
      prov.offerUrl || '未提供',
      prov.collectedAt || '未提供',
      prov.source || '未标注',
      item.unknown.length ? item.unknown.join('、') : '—',
    ];
  })));
  push('');
  push('> 「未提供」表示采集表里没有填对应列；没有链接的记录无法回溯到原页面，只能作为内部线索，不能当成已核证据。', '');
  push('### 8.3 指标取数列（每个数字追到输入列）', '');
  push(...table(['KPI', '输入列', '证据类型', '口径说明'], KPI_SOURCES));
  push('');
  push('> 报告里的 KPI 数值都来自上表「输入列」；列为空或没有该列时显示「未知」，不参与命中率分母，不用常识补齐。', '');
  push('### 8.4 净利率计算输入', '');
  const traceRows = results.filter((item) => item.profit);
  if (traceRows.length === 0) {
    push('（没有可测算的利润数据：缺采购价或售价，净利率记为「未知」。）', '');
  } else {
    push(...table(['ASIN', '售价', '采购¥', '件重g', 'FBA$', '广告%', '退货%', '佣金%', '头程$', '其它$', '净利率'], traceRows.map((item) => [
      item.asin || '—',
      money(item.inputs?.priceUSD ?? item.priceUSD),
      item.inputs?.purchaseCNY ?? '—',
      item.inputs?.weightG === null || item.inputs?.weightG === undefined ? '—' : Math.round(item.inputs.weightG),
      money(item.profit.fbaFeeUSD) + (item.profit.fbaEstimated ? '（估）' : ''),
      pct(item.inputs?.adPct),
      pct(item.inputs?.returnPct),
      pct(item.inputs?.commissionPct),
      money(item.inputs?.firstMileUSD),
      money(item.inputs?.otherUSD),
      pct(item.profit.netMargin, 1),
    ])));
    push('');
    push('> 公式：净利率 =（售价 − 采购 − 头程 − FBA − 佣金 − 广告 − 退货 − 其它）÷ 售价。采购价按汇率折算；FBA 未填时按件重档位估算（标「估」）；广告 / 退货 / 佣金未填时用默认 10% / 5% / 15%。', '');
  }
  push('### 8.5 待复核项', '');
  if (summary.needsReview.length === 0 && summary.commonGaps.length === 0) {
    push('无。');
  } else {
    for (const item of summary.needsReview) {
      push('- ' + (item.asin || '未命名') + '：' + (item.missing.length ? item.missing.join('、') : '可判定 KPI 不足 6 项'));
    }
    if (summary.commonGaps.length > 0) {
      push('');
      push('共性短板（按影响排序）：', '');
      for (const gap of summary.commonGaps) push('- ' + gap.label + '（' + gap.dimension + '）：不达标 ' + gap.fail + ' 个、警戒 ' + gap.warn + ' 个');
    }
  }
  push('');
  push('### 8.6 免责声明', '');
  push('- 本报告由 dsh-amazon-research 规则引擎生成，只做初筛与风险提示，不构成投资或经营建议。');
  push('- 缺失字段一律按「未知」处理，不参与命中率分母；未取到的数字不要当成 0。');
  push('- 专利、认证、类目审核必须人工复核，本工具不做法律定性。');
  push('');

  return lines.join('\n');
}

/** 选品明细 CSV（含计算列；列名保持中文，方便直接回填模板）。 */
export function renderSelectionCsv(batch) {
  const headers = [
    '档位', 'ASIN', '商品名称', '售价USD', '净利率', 'KPI命中率', '可判定项数',
    '否决项', '待复核项', '差异化方向', '采购价CNY', '总成本USD', '净利USD', '物流占比',
    '商品链接', '1688链接', '采集时间', '来源标注',
  ];
  const rows = (batch?.results || []).map((item) => [
    item.tier,
    item.asin,
    item.name,
    item.priceUSD ?? '',
    item.margin === null ? '' : (item.margin * 100).toFixed(2) + '%',
    (item.hitRate * 100).toFixed(0) + '%',
    item.judgedCount,
    item.vetoes.map((v) => v.label).join('；'),
    item.unknown.join('；'),
    (item.differentiation || []).map((d) => d.axis + '·' + d.direction).join('；'),
    item.profit ? item.profit.purchaseUSD.toFixed(2) : '',
    item.profit ? item.profit.totalCostUSD.toFixed(2) : '',
    item.profit ? item.profit.netProfitUSD.toFixed(2) : '',
    item.profit ? (item.profit.logisticsRatio * 100).toFixed(1) + '%' : '',
    item.provenance?.listingUrl || '',
    item.provenance?.offerUrl || '',
    item.provenance?.collectedAt || '',
    item.provenance?.source || '',
  ]);
  const escape = (value) => {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  };
  return [headers, ...rows].map((row) => row.map(escape).join(',')).join('\n') + '\n';
}
