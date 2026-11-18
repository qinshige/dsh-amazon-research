/**
 * dsh-amazon-research · host/selection/report.js
 *
 * 选品体检报告（Markdown / CSV）：结论 → 四途径 → 九策略 → 十维 → 差异化 → 利润 → 合规。
 * 只渲染传入的真实数据；缺失项显式写「未取到 / 待复核」。
 */

import { CONFIDENCE } from './evidence.js';

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

function cny(value) {
  const n = num(value);
  return n === null ? '—' : '¥' + Math.round(n).toLocaleString('en-US');
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
function costDataNotes(fxInfo, freight, costProfile) {
  const lines = [];
  if (costProfile) lines.push('> 费用按用户口径：佣金、广告、退货为售价占比；其它暂不计。不是平台官方统一费率。FBA/履约成本仍单独列示；不代表最终完整财务利润。');
  if (fxInfo) lines.push('> 汇率来源：' + cell(fxInfo.endpoint || '手动/默认值') + '｜接口数据日期：' + cell(fxInfo.dataDate || '未取到') + '｜抓取时间：' + cell(fxInfo.fetchedAt || '未取到') + '（最新公布值，缓存最多30分钟）');
  if (freight) lines.push('> 头程报价来源：' + cell(freight.endpoint || freight.source) + '｜报价日期：' + cell(freight.quotedAt || '未取到') + '｜抓取时间：' + cell(freight.fetchedAt || '未取到') + '｜' + cell(freight.note || ''));
  return [...lines, ''];
}

export function renderSelectionReport({ title = '选品', marketplace = 'US', generatedAt = '', batch, plan = null, source = '手动/采集表', fx = 6.7, costFx = null, settleFx = 6.6, fxInfo = null, costProfile = null, freight = null, runId = '', inputHash = '', artifacts = [], profile = null, targetMonthlyUnits = null, channel = 'amazon-fba' } = {}) {
  const results = batch?.results || [];
  const summary = batch?.summary || { tiers: {}, commonGaps: [], vetoed: 0, needsReview: [], avgMargin: null };
  const lines = [];
  const push = (...items) => lines.push(...items);
  // 附录 A（保守档画像的补充说明）：正文不放教学内容，统一在这里渲染。
  const coachAppendix = [];

  push('# ' + title + ' 选品体检报告（' + marketplace + '）', '');
  push('> 生成时间：' + (generatedAt || '—') + ' ｜ 候选数：' + results.length + ' ｜ 数据来源：' + source + ' ｜ 成本汇率：' + (costFx === null || costFx === undefined ? fx : costFx) + ' ｜ 结算汇率：' + settleFx, '');
  push('> 运行 ID：' + (runId || '—') + ' ｜ 输入指纹：' + (inputHash || '—'), '');
  push(...costDataNotes(fxInfo, freight, costProfile));
  push('---', '');

  // 一、决策摘要与结论
  push('## 一、决策摘要与结论', '');
  const top = results[0] || null;
  const brief = top && top.brief ? top.brief : null;
  if (brief) {
    push('### 1.1 决策单（先看这页）', '');
    push('**结论：' + brief.decision + '** ｜ 资金与能力：' + brief.profile.label, '');
    push('> ' + brief.reason, '');
    if (top.asin) push('> 当前排序第一：' + top.asin + ' ' + (top.name || '') + '；其余候选见第三节。', '');
    push('');
    const fatal = [
      ...top.vetoes.map((v) => v.label + '（' + v.detail + '）'),
      ...(brief.fit && brief.fit.fails ? brief.fit.fails.map((f) => f.label + '（' + f.detail + '）') : []),
    ];
    push('**致命项**：' + (fatal.length > 0 ? fatal.join('；') : '无（仍需人工查专利/认证）'), '');
    if (brief.safety) {
      push('**安全边际**（目标净利率 ' + pct(brief.safety.targetMargin, 0) + '）：', '');
      const s = brief.safety;
      const feas = s.feasible !== false;
      push(...table(['项目', '阈值', '当前'], [
        ['采购价上限', feas && s.maxPurchaseCNY > 0 ? cny(s.maxPurchaseCNY) : '不可达', cny(s.currentPurchaseCNY)],
        ['售价下限', money(s.minPriceUSD), money(s.currentPriceUSD)],
        ['广告上限', feas && s.maxAdRate > 0 ? pct(s.maxAdRate, 1) : '不可达', '—'],
        ['退货上限', feas && s.maxReturnRate > 0 ? pct(s.maxReturnRate, 1) : '不可达', '—'],
      ]));
      if (!feas) push('> **按目标净利率 ' + pct(s.targetMargin, 0) + '，当前售价与成本结构无法覆盖**（采购价为 0 也达不到）：必须提价到 ' + money(s.minPriceUSD) + ' 以上，或换材料/改包装/换供应商。', '');
      push('');
    } else {
      push('**安全边际**：缺采购价或售价，先补 1688 报价再算。', '');
    }
    const batchLabel = brief.decision === '不做' ? '首批（若坚持做，仅供估算）' : '首批';
    if (brief.batch && brief.batch.available) {
      push('**' + batchLabel + '**：' + brief.batch.variantCount + ' 个变体 × ' + brief.batch.units + ' 件，资金约 ' + cny(brief.batch.capitalCNY)
        + '（货款 ' + cny(brief.batch.goodsCNY) + ' + 头程 ' + cny(brief.batch.freightCNY) + '）；目标月销 '
        + brief.batch.targetMonthlyUnits + ' 单，回本约 '
        + (brief.batch.paybackMonths === null ? '无法估算' : brief.batch.paybackMonths.toFixed(1) + ' 个月')
        + (brief.batch.overBudget ? '；**超过画像资金上限**' : '') + '。', '');
    } else {
      push('**首批**：' + (brief.batch && brief.batch.reason ? brief.batch.reason : '缺数据') + '。', '');
    }
    push('> 假设：按目标月销全部售出，不含广告固定投入、退货二次成本与仓储；样品费单独估算。', '');
    push('');
    push('**可攻击面**：', '');
    for (const item of brief.attackSurface) push('- ' + item);
    push('');
    push('**改变结论的条件**：', '');
    for (const item of brief.changeMyMind) push('- ' + item);
    push('');

  // 1.2 数据可信度总览
  const confidenceCounts = {};
  for (const item of results) {
    const level = item.dataConfidence ? item.dataConfidence.level : 'unknown';
    confidenceCounts[level] = (confidenceCounts[level] || 0) + 1;
  }
  push('### 1.2 数据可信度总览', '');
  push(...table(['可信度', '品数', '含义'], [
    ['高', String(confidenceCounts.high || 0), '价格 / 采购价 / 净利率齐备，结论可直接采信'],
    ['中', String(confidenceCounts.medium || 0), '缺 1 项关键数据，结论仅供参考'],
    ['低', String(confidenceCounts.low || 0), '缺 2 项以上，只能当线索'],
  ].filter((row) => Number(row[1]) > 0)));
  push('');
  const gaps = {};
  for (const item of results) {
    for (const gap of (item.dataConfidence && item.dataConfidence.gaps) || []) gaps[gap] = (gaps[gap] || 0) + 1;
  }
  if (Object.keys(gaps).length > 0) {
    push('缺什么（按影响排序）：', '');
    for (const [gap, count] of Object.entries(gaps).sort((a, b) => b[1] - a[1])) push('- ' + gap + '：' + count + ' 个');
    push('');
  }
    // 教练层（保守档画像）不放在正文第一页：正文只给结论，
    // 教学性内容全部下沉到附录 A，避免报告一眼看上去像新手教程。
    if (brief.profile.id === 'beginner' && top.coach) {
      coachAppendix.push('**为什么是这个结论**', '');
      for (const item of top.coach.why) coachAppendix.push('- ' + item);
      coachAppendix.push('');
      coachAppendix.push('**这个类目的坑**', '');
      for (const item of top.coach.pitfalls) coachAppendix.push('- ' + item);
      coachAppendix.push('');
      coachAppendix.push('**今天 / 本周 / 下周**', '');
      for (const item of brief.actions) coachAppendix.push('- ' + item);
      coachAppendix.push('');
      coachAppendix.push('**术语**', '');
      coachAppendix.push(...table(['术语', '一句话解释'], top.coach.terms));
      coachAppendix.push('');
    }
  } else {
    push('本批没有候选数据：先按第二节抓候选、填采集表。', '');
  }

    if (brief.channels && brief.channels.length > 1) {
      push('### 1.3 渠道对照（同一个品，换渠道就是另一门生意）', '');
      push(...table(['渠道', '履约成本', '佣金', '广告', '退货', '净利率', '判读'], brief.channels.map((row) => [
        row.label,
        money(row.fulfillmentUSD) + '（' + row.fulfillmentLabel + '）',
        pct(row.referralRate, 0),
        pct(row.adRate, 0),
        pct(row.returnRate, 0),
        pct(row.netMargin, 1),
        row.verdict,
      ])));
      push('');
      const best = brief.channels.slice().sort((a, b) => b.netMargin - a.netMargin)[0];
      const worst = brief.channels.slice().sort((a, b) => a.netMargin - b.netMargin)[0];
      push('> 当前按 **' + channel + '** 判定；在 **' + best.label + '** 净利率为 ' + pct(best.netMargin, 1) + '，在 **' + worst.label + '** 为 ' + pct(worst.netMargin, 1) + '。渠道选错，结论就反了。', '');
      push('> 口径说明：本表按**各渠道默认费率**测算（未套用采集表里的类目退货率等实测值），与第一节的净利率可能有小幅差异；跨境运费、达人佣金均为估算值，须用你的实际账单替换。', '');
      const caveats = brief.channels.filter((row) => row.caveat);
      if (caveats.length > 0) {
        for (const row of caveats) push('> ⚠️ ' + row.label + '：' + row.caveat);
        push('');
      }
      push('');
    }
  if (summary.classRisks && summary.classRisks.length > 0) {
    push('### 1.4 类目级风险（对整批候选生效，不是单品否决）', '');
    for (const risk of summary.classRisks) push('- ' + risk);
    push('');
    push('> 这些是**类目**层面的结论：集中度、评价壁垒这类指标同一个类目里每个 ASIN 都一样，');
    push('> 所以不用于淘汰单品 —— 要不要做这个类目，看这里；具体做哪个品，看下一节的单品档位。', '');
    push('');
  }
  // 1.5 分段利润（回答「第 50–100 名还有没有利润」）
  if (batch.segmentAnalysis && batch.segmentAnalysis.segments) {
    const segs = batch.segmentAnalysis.segments.filter((seg) => seg.count > 0);
    if (segs.length > 0) {
      push('### 1.5 分段利润：这个类目里，长尾还有没有利润？', '');
      const noPrice = segs.every((seg) => seg.pricedCount === 0);
      if (noPrice) {
        push('> ⚠️ **本批没有任何一个品拿到通过校验的采购价**，所以净利率全部为空。下面这张表只给出**价格带、评论数、变体数**（这些是页面实测值）；「能不能做」要等 1688 采价通过校验后才能给。', '');
      }
      push(...table(['分段', '品数', '已测算', '平均售价', '中位售价', '平均评论', '平均变体', '月销均值', '平均净利率', '中位净利率', '正利润占比', '≥25%占比', '参考毛利率(卖家精灵)', '能不能做'], segs.map((seg) => [
        seg.label,
        String(seg.count),
        String(seg.pricedCount),
        money(seg.avgPrice),
        money(seg.medianPrice),
        seg.avgReviews === null ? '—' : String(Math.round(seg.avgReviews)),
        seg.avgVariants === null ? '—' : seg.avgVariants.toFixed(1),
        seg.avgUnits === null ? '—' : String(Math.round(seg.avgUnits)),
        seg.avgMargin === null ? '—' : pct(seg.avgMargin, 1),
        seg.medianMargin === null ? '—' : pct(seg.medianMargin, 1),
        seg.positiveRatio === null ? '—' : pct(seg.positiveRatio, 0),
        seg.goodRatio === null ? '—' : pct(seg.goodRatio, 0),
        seg.refGrossAvg === null || seg.refGrossAvg === undefined ? '—' : pct(seg.refGrossAvg, 1) + '（' + (seg.refGrossCount || 0) + '/' + seg.count + '）',
        seg.verdict + '（' + seg.why + '）',
      ])));
      push('');
      push('> **两列口径不一样，别混用**：「平均净利率」是本插件的全成本口径（采购 + 头程 + FBA + 佣金 + 广告 + 退货 + 其它），只对拿到 1688 实测采购价的候选有效；「参考毛利率」是卖家精灵平台自己算的毛利率，覆盖面大得多，但没有扣广告/退货/头程，所以**一定高于本插件的净利率**，只能用来判断「这一段有没有肉」，不能直接当利润。', '');
      push('> ' + batch.segmentAnalysis.note, '');
      push('> 读法：头部（1–10）集中度高说明**头部很贵**（评论壁垒高），真正的机会常在腰部/长尾 —— 那里评论少、售价接近头部、利润反而更高。**不要因为 Top3 集中度高就否掉整个类目**。', '');
      push('');
    }
  }
  push('### 1.6 分档统计与候选（插件的选品结论）', '');
  push('**分档：' + TIER_ORDER.map((tier) => tier + ' ' + (summary.tiers[tier] || 0)).join(' ｜ ') + '**', '');
  if (summary.decisions) {
    push('**结论分布：' + Object.entries(summary.decisions).map(([key, value]) => key + ' ' + value).join(' ｜ ') + '**', '');
  }
  if (summary.avgMargin !== null) push('- 平均净利率：**' + pct(summary.avgMargin, 1) + '**（全成本口径：采购 + 头程 + FBA + 佣金 + 广告 + 退货 + 其它）。');
  push('- 一票否决：**' + summary.vetoed + '** 个；待复核：**' + summary.needsReview.length + '** 个。');
  const picks = results.filter((item) => item.tier === '一档' || item.tier === '二档').slice(0, 5);
  if (picks.length > 0) {
    push('');
    push('**优先候选（一档 / 二档，最多 5 个）** —— 这些才是插件选出来的品：', '');
    push(...table(['ASIN', '商品', '档位', '结论', '售价', '净利率', 'KPI 命中率', '理由'], picks.map((item) => [
      item.asin || '—', item.name || '—', item.tier, item.decision ? item.decision.decision : '—', money(item.priceUSD), pct(item.margin, 1), pct(item.hitRate), item.tierReason,
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

  // 四、否决（含依据链）
  push('## 四、一票否决清单（含依据）', '');
  push('> 每条否决都给出：依据数值、阈值、数据来源、可信度。**类目级风险不淘汰单品**（见 1.4），只看单品自身指标。', '');
  const vetoed = results.filter((item) => item.vetoes.length > 0);
  if (vetoed.length === 0) {
    push('本批未命中一票否决项。', '');
  } else {
    for (const item of vetoed) {
      push('### ' + (item.asin || '未命名') + ' ' + (item.name || ''), '');
      push(...table(['否决项', '依据数值', '阈值', '数据来源', '可信度'], item.vetoes.map((v) => {
        const ev = v.evidence || {};
        return [
          v.label,
          (ev.value === null || ev.value === undefined || ev.value === '') ? '—' : String(ev.value) + (ev.unit || ''),
          ev.threshold || '—',
          ev.source || '—',
          (ev.confidence && ev.confidence !== 'unknown' ? (CONFIDENCE[ev.confidence] || CONFIDENCE.unknown).label : '未知'),
        ];
      })));
      push('');
    }
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
    ['成本汇率', (costFx === null || costFx === undefined ? fx : costFx) + ' CNY/USD（人民币成本折美元）｜来源：' + (fxInfo?.costFxSource || 'default')],
    ['结算汇率', settleFx + ' CNY/USD（美元收入折人民币结算）｜来源：' + (fxInfo?.settleFxSource || 'default')],
    ['平台佣金', costProfile ? pct(costProfile.referralRate, 0) + '（用户口径档）' : '-'],
    ['广告', costProfile ? pct(costProfile.adRate, 0) + '（用户口径档）' : '-'],
    ['退货损耗', costProfile ? pct(costProfile.returnRate, 0) + '（用户口径档）' : '-'],
    ['其它费用', costProfile ? (costProfile.otherUSD > 0 ? '$' + costProfile.otherUSD.toFixed(2) : '暂不计') : '-'],
    ['头程', freight ? freight.label + (freight.perKgCNY == null ? ' 未取到' : ' ¥' + freight.perKgCNY + '/kg') + '｜时效 ' + freight.transitDays + '｜来源 ' + freight.source : '-'],
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
    push(...table(['ASIN', '售价', '采购¥（可售单位）', '包装对齐', '件重g', 'FBA$', '广告%', '退货%', '佣金%', '头程$', '其它$', '净利率'], traceRows.map((item) => [
      item.asin || '—',
      money(item.inputs?.priceUSD ?? item.priceUSD),
      item.inputs?.purchaseCNY === null || item.inputs?.purchaseCNY === undefined ? '—' : '¥' + Number(item.inputs.purchaseCNY).toFixed(2),
      item.inputs?.packAligned
        ? '¥' + Number(item.inputs.unitPriceCNY).toFixed(2) + '/个 × ' + item.inputs.packUnits + ' 件'
        : (item.inputs?.purchaseCNY ? '直接给可售单位成本' : '—'),
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
    push('> **包装对齐**：1688 入口价常常是**单件价**，而 Amazon 卖的是**一个可售单位**（如 20 个装）。「包装对齐」列给出折算依据（单件价 × 件数 = 可售单位成本）；未对齐会把采购成本低估 10~100 倍。', '');
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

  if (coachAppendix.length > 0) {
    push('---', '');
    push('## 附录 A · 补充说明', '');
    push('> 正文已经给了结论与依据，这一段是给第一次做这类目的人看的补充，老手可跳过。', '');
    push(...coachAppendix);
  }

  return lines.join('\n');
}

/**
 * 数据版报告（默认）：只给表格、数字与判定，不写解释性段落。
 *
 * 为什么有两种版式（用户明确要求「我只需要看数据」）：
 * 完整版适合第一次做某个类目的人（四途径、九策略、教练层、术语、免责声明）；
 * 对已经知道自己要什么的卖家，那些段落只是干扰。数据版保留全部**可核对的数据**：
 * 决策单、安全边际、分档、分段利润、渠道对照、否决依据链、净利率输入、待复核；
 * 去掉的是解释性文字，**不省略任何数字**。
 */
export function renderDataReport({ title = '选品', marketplace = 'US', generatedAt = '', batch, source = '手动/采集表', fx = 6.7, costFx = null, settleFx = 6.6, fxInfo = null, costProfile = null, freight = null, runId = '', inputHash = '', profile = null, channel = 'amazon-fba' } = {}) {
  const results = batch?.results || [];
  const summary = batch?.summary || { tiers: {}, decisions: {}, commonGaps: [], vetoed: 0, needsReview: [], avgMargin: null, classRisks: [] };
  const lines = [];
  const push = (...items) => lines.push(...items);
  const top = results[0] || null;
  const brief = top && top.brief ? top.brief : null;

  push('# ' + title + ' ｜ ' + marketplace + ' ｜ ' + channel, '');
  const costRate = costFx === null || costFx === undefined ? fx : costFx;
  const fxSrc = (id) => ({ live: '实时', manual: '手动', default: '默认' }[id] || '默认');
  push('| 生成时间 | 候选数 | 成本汇率 | 结算汇率 | 运行 ID | 输入指纹 |', '| --- | --- | --- | --- | --- | --- |');
  push('| ' + cell(generatedAt || '—') + ' | ' + results.length + ' | ' + costRate + '（' + fxSrc(fxInfo?.costFxSource) + '） | ' + settleFx + '（' + fxSrc(fxInfo?.settleFxSource) + '） | ' + cell(runId || '—') + ' | ' + cell(inputHash || '—') + ' |', '');
  push('> 成本汇率用于把人民币成本（1688 采购价、头程）折成美元；结算汇率用于把美元收入与利润折成人民币。人民币口径的利润额按结算汇率计算。', '');
  if (costProfile) {
    push('| 平台佣金 | 广告 | 退货 | 其它费用 | 头程方式 | 头程费率 | 头程时效 | 头程来源 |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    const otherLabel = costProfile.otherUSD > 0 ? '$' + costProfile.otherUSD.toFixed(2) : '不计';
    const freightLabel = freight ? freight.label : (costProfile.freightMode || '-');
    const freightRate = freight?.perKgCNY != null ? '¥' + freight.perKgCNY + '/kg' : '未取到';
    const freightDays = freight ? freight.transitDays : '-';
    const freightSource = freight ? (freight.source === 'live' ? '实时接口' : freight.source === 'manual' ? '手动指定' : '未取到') : '-';
    push('| ' + pct(costProfile.referralRate, 0) + ' | ' + pct(costProfile.adRate, 0) + ' | ' + pct(costProfile.returnRate, 0) + ' | '
      + otherLabel + ' | ' + freightLabel + ' | ' + freightRate + ' | ' + freightDays + ' | ' + freightSource + ' |', '');
  }
  push(...costDataNotes(fxInfo, freight, costProfile));
  push('> 数据来源：' + cell(source), '');

  if (brief) {
    push('## 1 决策单', '');
    const rows = [
      ['结论', brief.decision],
      ['资金与能力', brief.profile.label],
      ['首要候选', top.asin ? top.asin + ' ' + (top.name || '') : '—'],
      ['致命项', top.vetoes.length ? top.vetoes.map((v) => v.label).join('；') : '无'],
    ];
    const fatalFit = brief.fit && brief.fit.fails ? brief.fit.fails : [];
    if (fatalFit.length) rows.push(['画像不适配', fatalFit.map((f) => f.label + '：' + f.detail).join('；')]);
    push(...table(['项目', '值'], rows));
    push('');
    if (brief.safety) {
      const sf = brief.safety;
      const feas = sf.feasible !== false;
      push('## 2 安全边际（目标净利率 ' + pct(sf.targetMargin, 0) + '）', '');
      push(...table(['项目', '阈值', '当前'], [
        ['采购价上限', feas && sf.maxPurchaseCNY > 0 ? cny(sf.maxPurchaseCNY) : '不可达', cny(sf.currentPurchaseCNY)],
        ['售价下限', money(sf.minPriceUSD), money(sf.currentPriceUSD)],
        ['广告上限', feas && sf.maxAdRate > 0 ? pct(sf.maxAdRate, 1) : '不可达', '—'],
        ['退货上限', feas && sf.maxReturnRate > 0 ? pct(sf.maxReturnRate, 1) : '不可达', '—'],
      ]));
      push('');
    }
    if (brief.batch && brief.batch.available) {
      push('## 3 首批', '');
      push(...table(['变体数', '件数', '资金合计', '货款', '头程', '目标月销', '回本月数'], [[
        String(brief.batch.variantCount), String(brief.batch.units), cny(brief.batch.capitalCNY),
        cny(brief.batch.goodsCNY), cny(brief.batch.freightCNY), String(brief.batch.targetMonthlyUnits),
        brief.batch.paybackMonths === null ? '—' : brief.batch.paybackMonths.toFixed(1),
      ]]));
      push('');
    }
  }

  push('## 4 分档', '');
  push('| 分档 | ' + TIER_ORDER.join(' | ') + ' | 平均净利率 |', '| --- | ' + TIER_ORDER.map(() => '---').join(' | ') + ' | --- |');
  push('| 品数 | ' + TIER_ORDER.map((tier) => String(summary.tiers[tier] || 0)).join(' | ') + ' | ' + pct(summary.avgMargin, 1) + ' |', '');
  if (summary.decisions) {
    const keys = Object.keys(summary.decisions);
    push('| 结论 | ' + keys.join(' | ') + ' |', '| --- | ' + keys.map(() => '---').join(' | ') + ' |');
    push('| 品数 | ' + Object.values(summary.decisions).join(' | ') + ' |', '');
  }

  if (batch.segmentAnalysis && batch.segmentAnalysis.segments) {
    const segs = batch.segmentAnalysis.segments.filter((seg) => seg.count > 0);
    if (segs.length) {
      push('## 5 分段利润（' + cell(batch.segmentAnalysis.basis) + '）', '');
      push(...table(
        ['分段', '品数', '已测算', '均价', '中位价', '均评论', '均变体', '月销均值', '净利率', '中位净利率', '正利润占比', '≥25%占比', '参考毛利率', '判定'],
        segs.map((seg) => [
          seg.label, seg.count, seg.pricedCount, money(seg.avgPrice), money(seg.medianPrice),
          int(seg.avgReviews), seg.avgVariants === null ? '—' : seg.avgVariants.toFixed(1), int(seg.avgUnits),
          seg.avgMargin === null ? '—' : pct(seg.avgMargin, 1),
          seg.medianMargin === null ? '—' : pct(seg.medianMargin, 1),
          seg.positiveRatio === null ? '—' : pct(seg.positiveRatio, 0),
          seg.goodRatio === null ? '—' : pct(seg.goodRatio, 0),
          seg.refGrossAvg === null || seg.refGrossAvg === undefined ? '—' : pct(seg.refGrossAvg, 1) + ' (' + (seg.refGrossCount || 0) + '/' + seg.count + ')',
          seg.verdict,
        ]),
      ));
      push('');
    }
  }

  if (brief && brief.channels && brief.channels.length > 1) {
    push('## 6 渠道对照', '');
    push(...table(['渠道', '履约成本', '佣金', '广告', '退货', '净利率', '单件净利¥', '单件总成本¥'], brief.channels.map((row) => [
      row.label, money(row.fulfillmentUSD) + '（' + row.fulfillmentLabel + '）',
      pct(row.referralRate, 0), pct(row.adRate, 0), pct(row.returnRate, 0), pct(row.netMargin, 1),
      row.netProfitCNY === null || row.netProfitCNY === undefined ? '—' : cny(row.netProfitCNY),
      row.totalCostCNY === null || row.totalCostCNY === undefined ? '—' : cny(row.totalCostCNY),
    ])));
    push('');
  }

  const picks = results.filter((item) => item.tier === '一档' || item.tier === '二档');
  if (picks.length) {
    push('## 7 优先候选（一档 / 二档）', '');
    push(...table(['ASIN', '档位', '结论', '售价', '采购¥', '单件净利¥', '净利率', '命中率', '商品'], picks.map((item) => [
      item.asin || '—', item.tier, item.decision ? item.decision.decision : '—', money(item.priceUSD),
      item.inputs && item.inputs.purchaseCNY !== null && item.inputs.purchaseCNY !== undefined ? '¥' + Number(item.inputs.purchaseCNY).toFixed(2) : '—',
      item.profit && item.profit.netProfitCNY !== undefined && item.profit.netProfitCNY !== null ? cny(item.profit.netProfitCNY) : '—',
      pct(item.margin, 1), pct(item.hitRate), (item.name || '').slice(0, 60),
    ])));
    push('');
  }

  const confidenceCounts = {};
  const gaps = {};
  for (const item of results) {
    const level = item.dataConfidence ? item.dataConfidence.level : 'unknown';
    confidenceCounts[level] = (confidenceCounts[level] || 0) + 1;
    for (const gap of (item.dataConfidence && item.dataConfidence.gaps) || []) gaps[gap] = (gaps[gap] || 0) + 1;
  }
  push('## 8 数据可信度', '');
  push(...table(['可信度', '品数'], [['高', confidenceCounts.high || 0], ['中', confidenceCounts.medium || 0], ['低', confidenceCounts.low || 0]].filter((row) => Number(row[1]) > 0)));
  push('');
  const gapRows = Object.entries(gaps).sort((a, b) => b[1] - a[1]);
  if (gapRows.length) {
    push('| 缺失项 | 品数 |', '| --- | --- |');
    for (const [gap, count] of gapRows) push('| ' + cell(gap) + ' | ' + count + ' |');
    push('');
  }

  if (summary.classRisks && summary.classRisks.length) {
    push('## 9 类目级风险', '');
    push('| # | 风险 |', '| --- | --- |');
    summary.classRisks.forEach((risk, i) => push('| ' + (i + 1) + ' | ' + cell(risk) + ' |'));
    push('');
  }

  const vetoed = results.filter((item) => item.vetoes.length > 0);
  push('## 10 一票否决（' + vetoed.length + ' 个）', '');
  if (!vetoed.length) push('无。', '');
  else {
    const rows = [];
    for (const item of vetoed) {
      for (const veto of item.vetoes) {
        const ev = veto.evidence || null;
        const evValue = ev && ev.value !== null && ev.value !== undefined && ev.value !== ''
          ? String(ev.value) + (ev.unit ? ' ' + ev.unit : '')
          : '—';
        rows.push([
          item.asin || '—',
          veto.label,
          evValue,
          ev && ev.threshold ? ev.threshold : '—',
          ev && ev.source ? ev.source : '—',
          ev && ev.confidence ? (CONFIDENCE[ev.confidence] ? CONFIDENCE[ev.confidence].label : ev.confidence) : '—',
        ]);
      }
    }
    push(...table(['ASIN', '否决项', '依据数值', '阈值', '数据来源', '可信度'], rows));
    push('');
  }

  push('## 11 全部候选（' + results.length + ' 个）', '');
  push(...table(['ASIN', '档位', '结论', '售价', '采购¥', '单件净利¥', '净利率', '命中率', '否决', '待复核'], results.map((item) => [
    item.asin || '—',
    item.tier,
    item.decision ? item.decision.decision : '—',
    money(item.priceUSD),
    item.inputs && item.inputs.purchaseCNY !== null && item.inputs.purchaseCNY !== undefined ? '¥' + Number(item.inputs.purchaseCNY).toFixed(2) : '—',
    item.profit && item.profit.netProfitCNY !== undefined && item.profit.netProfitCNY !== null ? cny(item.profit.netProfitCNY) : '—',
    pct(item.margin, 1),
    pct(item.hitRate),
    item.vetoes.length ? item.vetoes.map((v) => v.label).join('、') : '—',
    item.unknown.length ? item.unknown.join('、') : '—',
  ])));
  push('');

  const traceRows = results.filter((item) => item.profit);
  if (traceRows.length) {
    push('## 12 净利率计算输入', '');
    push(...table(['ASIN', '售价', '采购¥', '包装对齐', '件重g', 'FBA费', '广告%', '退货%', '佣金%', '头程费', '其它费', '总成本¥', '净利¥', '净利率'], traceRows.map((item) => [
      item.asin || '—',
      money(item.inputs?.priceUSD ?? item.priceUSD),
      item.inputs?.purchaseCNY === null || item.inputs?.purchaseCNY === undefined ? '—' : '¥' + Number(item.inputs.purchaseCNY).toFixed(2),
      item.inputs?.packAligned ? '¥' + Number(item.inputs.unitPriceCNY).toFixed(2) + '/个 × ' + item.inputs.packUnits + ' 件' : '直接给可售单位成本',
      int(item.inputs?.weightG),
      money(item.profit.fbaFeeUSD) + (item.profit.fbaEstimated ? '（估）' : ''),
      pct(item.inputs?.adPct), pct(item.inputs?.returnPct), pct(item.inputs?.commissionPct),
      money(item.inputs?.firstMileUSD), money(item.inputs?.otherUSD),
      item.profit.totalCostCNY === undefined || item.profit.totalCostCNY === null ? '—' : cny(item.profit.totalCostCNY),
      item.profit.netProfitCNY === undefined || item.profit.netProfitCNY === null ? '—' : cny(item.profit.netProfitCNY),
      pct(item.profit.netMargin, 1),
    ])));
    push('');
  }

  if (summary.needsReview.length) {
    push('## 13 待复核（' + summary.needsReview.length + ' 个）', '');
    push(...table(['ASIN', '缺什么'], summary.needsReview.map((item) => [
      item.asin || '—',
      item.missing.length ? item.missing.join('、') : '可判定 KPI 不足 6 项',
    ])));
    push('');
  }

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
