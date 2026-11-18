/**
 * dsh-amazon-research · host/selection/brief.js
 *
 * 决策单：把十维结果压成老手能拍板、新手能照做的一页。
 * 只做**由已有数据可推导**的结论；竞品明细不足时明确说「未提供」。
 */
import { getProfile } from './profiles.js';
import { listChannels, resolveChannel } from '../sourcing/channels.js';
import { landedCost } from '../sourcing/cost-model.js';

function n(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function money(value, digits = 2) {
  const v = n(value);
  return v === null ? '—' : '$' + v.toFixed(digits);
}

function cny(value) {
  const v = n(value);
  return v === null ? '—' : '¥' + Math.round(v).toLocaleString('en-US');
}

function pct(value, digits = 1) {
  const v = n(value);
  return v === null ? '—' : (v * 100).toFixed(digits) + '%';
}

/**
 * 渠道对照：同一个品在不同渠道的净利率。
 *
 * 为什么必须有（实测：Work Glove Holders 4 件装，售价 $5.49）：
 *   Amazon FBA 的小号标准件配送费 $3.22 会吃掉 59% 收入 → 必亏；
 *   TikTok Shop 佣金 6%、无 FBA 费、跨境直发 → 可以赚。
 *   只按一个渠道判生死，会对做 TK / 独立站 / 线下渠道的卖家系统性误判。
 */
export function compareChannels(candidate, { fx = 6.7, costFx = null, settleFx = 6.6, profile = null, freight = null } = {}) {
  const inputs = candidate.inputs || {};
  if (inputs.purchaseCNY === null || inputs.purchaseCNY === undefined) return null;
  if (!candidate.priceUSD) return null;
  const rows = [];
  for (const model of listChannels()) {
    const channel = resolveChannel(model.id);
    const calc = landedCost({
      channel: channel.id,
      priceCNY: inputs.purchaseCNY,
      weightG: inputs.weightG ?? null,
      priceUSD: candidate.priceUSD,
      costFx: costFx === null || costFx === undefined ? fx : costFx,
      settleFx,
      profile: profile || undefined,
      freight: freight || undefined,
    });
    if (!calc) continue;
    rows.push({
      channel: channel.id,
      label: channel.label,
      fulfillmentUSD: calc.fbaFeeUSD,
      fulfillmentLabel: calc.fbaLabel,
      referralRate: calc.params.referralRate,
      adRate: calc.params.adRate,
      returnRate: calc.params.returnRate,
      netMargin: calc.netMargin,
      netProfitUSD: calc.netProfitUSD,
      netProfitCNY: calc.netProfitCNY,
      totalCostUSD: calc.totalCostUSD,
      totalCostCNY: calc.totalCostCNY,
      costFx: calc.costFx,
      settleFx: calc.settleFx,
      verdict: channel.id === 'amazon-fbm'
        ? '需另计买家运费与退货成本'
        : (calc.netMargin > 0.30 ? '优秀' : (calc.netMargin > 0.25 ? '可做' : (calc.netMargin > 0.15 ? '只能跑体量' : (calc.netMargin > 0 ? '几乎不赚' : '亏损')))),
      caveat: channel.id === 'amazon-fbm'
        ? '自发货：买家运费与退货处理需自行承担（若包邮请把运费加回成本），本行净利率未含，实际会低于此值'
        : (channel.id === 'tiktok-shop' ? '跨境运费为估算值，达人佣金/退货率按经验默认' : ''),
    });
  }
  return rows;
}

function checkOf(candidate, key) {
  return (candidate.checks || []).find((item) => item.key === key) || null;
}

/**
 * 利润安全边际：采购上限、售价下限、广告上限、退货上限。
 * 公式来自全成本口径；目标毛利率 = 画像净利率红线。
 */
export function safetyMargin(candidate, profile, fx = 6.7) {
  const p = candidate.profit;
  if (!p) return null;
  const price = n(p.priceUSD);
  if (!price || price <= 0) return null;
  const fixed = (n(p.purchaseUSD) || 0) + (n(p.firstMileUSD) || 0) + (n(p.fbaFeeUSD) || 0) + (n(p.otherUSD) || 0);
  const commRate = (n(p.commissionUSD) || 0) / price;
  const adRate = (n(p.adUSD) || 0) / price;
  const retRate = (n(p.returnUSD) || 0) / price;
  const varRate = commRate + adRate + retRate;
  const target = profile.marginRedline;
  const denominator = 1 - varRate - target;
  if (denominator <= 0) return null;
  const maxPurchaseUSD = price * denominator - (fixed - (n(p.purchaseUSD) || 0));
  const minPriceUSD = fixed / denominator;
  const maxAdRate = 1 - commRate - retRate - fixed / price - target;
  const maxReturnRate = 1 - commRate - adRate - fixed / price - target;
  const feasible = maxPurchaseUSD > 0 && maxAdRate > 0 && maxReturnRate > 0;
  return {
    feasible,
    targetMargin: target,
    currentMargin: candidate.margin,
    headroom: candidate.margin === null ? null : candidate.margin - target,
    maxPurchaseUSD,
    maxPurchaseCNY: maxPurchaseUSD * fx,
    minPriceUSD,
    maxAdRate,
    maxReturnRate,
    currentPurchaseCNY: candidate.inputs ? candidate.inputs.purchaseCNY : null,
    currentPriceUSD: price,
  };
}

function firstBatch(candidate, profile, targetMonthlyUnits, fx = 6.7) {
  const p = candidate.profit;
  if (!p || !candidate.inputs || candidate.inputs.purchaseCNY === null) {
    return { available: false, reason: '缺采购价，无法估算首批资金' };
  }
  const units = profile.firstBatchUnits;
  const variantCount = Math.max(1, Math.min(profile.maxVariants, Number(checkOf(candidate, 'variants')?.value) || 1));
  const goodsCNY = candidate.inputs.purchaseCNY * units;
  // 履约成本按件计，必须进首批资金：TK 渠道头程并入了履约，只算 firstMile 会低估。
  const freightCNY = ((n(p.firstMileUSD) || 0) + (n(p.fbaFeeUSD) || 0)) * fx * units;
  const capitalCNY = goodsCNY + freightCNY;
  const monthlyProfitCNY = (n(p.netProfitCNY) ?? ((n(p.netProfitUSD) || 0) * fx)) * targetMonthlyUnits;
  const paybackMonths = monthlyProfitCNY > 0 ? capitalCNY / monthlyProfitCNY : null;
  const sampleUnits = variantCount * 50;
  const sampleCapitalCNY = (candidate.inputs.purchaseCNY + ((n(p.firstMileUSD) || 0) + (n(p.fbaFeeUSD) || 0)) * fx) * sampleUnits;
  return {
    available: true,
    units,
    variantCount,
    sampleUnits,
    sampleCapitalCNY,
    goodsCNY,
    freightCNY,
    capitalCNY,
    targetMonthlyUnits,
    paybackMonths,
    overBudget: capitalCNY > profile.maxFirstBatchCNY,
  };
}

function attackSurface(candidate) {
  const items = [];
  const concentration = checkOf(candidate, 'concentration');
  const reviewBarrier = checkOf(candidate, 'reviewBarrier');
  const rating = checkOf(candidate, 'rating');
  const priceBand = checkOf(candidate, 'priceBand');
  if (concentration && concentration.status === '不达标') items.push('Top3 品牌集中度 ' + concentration.value + '，头部高度垄断：正面硬刚不划算，只能换人群/场景/价格带切入');
  else if (concentration && concentration.status === '警戒') items.push('Top3 品牌集中度 ' + concentration.value + '，头部未完全垄断，可用人群/场景切入');
  if (reviewBarrier && reviewBarrier.status === '达标') items.push('类目前十评价 ' + reviewBarrier.value + '（< 1000），评论壁垒不高');
  if (rating && rating.status === '警戒') items.push('平均评分 ' + rating.value + '，质量/体验有改进空间');
  if (priceBand && priceBand.status !== '达标') items.push('售价 ' + priceBand.value + '，价格带存在空隙（需用榜单确认）');
  if (candidate.flags && candidate.flags.hasPain) items.push('已归纳差评点：' + (checkOf(candidate, 'reviewPain')?.value || ''));
  if (items.length === 0) {
    items.push('未提供竞品明细：先在榜单里找 3 个「评论 <300、评分 <4.3、售价高于均价」的链接做对照，再定切入点');
  }
  return items;
}

function actionsFor(candidate, profile, safety, batch) {
  const priceCNY = safety ? safety.maxPurchaseCNY : null;
  const budget = batch && batch.available ? Math.min(batch.capitalCNY, profile.maxFirstBatchCNY) : null;
  if (profile.id === 'beginner') {
    return [
      '今天（30 分钟）：用 WIPO / 商标局快筛产品核心词与品牌词，发现相似外观/商标即停。',
      '本周（2 小时）：1688 询 3 家，确认采购价 ≤ ' + (priceCNY === null || priceCNY <= 0 ? '安全边际价（当前结构不可达，先改售价或成本）' : cny(priceCNY)) + '、MOQ、交期、能否改款。',
      '下周：打样 ' + (batch && batch.available ? batch.variantCount : 2) + ' 个变体 × 50 件（约 ' + (batch && batch.available ? cny(batch.sampleCapitalCNY) : '按样品') + '），拍主图；首批不超过 ' + (budget === null ? '画像上限' : cny(budget)) + '。',
      '上架前：查认证要求与类目审核；1688 图片不要直接用。',
    ];
  }
  if (profile.id === 'factory') {
    return [
      '做专利 FTO 与外观规避设计，确认能否开模/改模。',
      '锁 2 家备选工厂与排产周期，按 MOQ 算首批资金。',
      '用模具/结构/专利建壁垒，定价走中高客单。',
    ];
  }
  return [
    '做专利 FTO 与认证周期确认，红灯即停。',
    '锁 2 家供应商与账期，确认交期能赶上上架窗口。',
    '定价格带与 30 天广告预算，按小批量测款推进。',
  ];
}

function changeMyMind(candidate, profile, safety, batch) {
  const items = [];
  if (safety && safety.feasible === false) {
    items.push('按当前售价与成本结构，任何采购价都达不到目标净利率 —— 需把售价提到 ' + money(safety.minPriceUSD) + ' 以上，或改结构/换供应链');
  } else if (safety && safety.maxPurchaseCNY !== null && candidate.inputs && candidate.inputs.purchaseCNY !== null) {
    items.push('采购价超过 ' + cny(safety.maxPurchaseCNY) + '（当前 ' + cny(candidate.inputs.purchaseCNY) + '）就放弃');
  }
  if (candidate.flags && /强|季节|节日/.test(candidate.flags.seasonality || '')) {
    items.push('错过旺季备货窗口就放弃');
  }
  const cert = checkOf(candidate, 'certification');
  if (cert && cert.status === '警戒') items.push('证书/测试报告拿不到就放弃');
  if (batch && batch.available && batch.overBudget) items.push('首批资金超过画像上限，缩量或换品');
  items.push('若 30 天内出现同款低价链接且你无法差异化，放弃');
  return items;
}

/**
 * 生成一个候选的决策单。
 * @param {{candidate:object, profile:string|object, targetMonthlyUnits?:number, fx?:number}} input
 */
export function buildDecisionBrief({ candidate, profile: profileInput = 'beginner', targetMonthlyUnits, fx = 6.7 } = {}) {
  const profile = typeof profileInput === 'string' ? getProfile(profileInput) : (profileInput || getProfile('beginner'));
  const target = Number.isFinite(targetMonthlyUnits) && targetMonthlyUnits > 0 ? targetMonthlyUnits : profile.targetMonthlyUnits;
  const fit = candidate.profileFit || { status: '适合', fails: [], warnings: [] };
  const decision = candidate.decision || { decision: '先补数', reason: '' };
  const safety = safetyMargin(candidate, profile, fx);
  const batch = firstBatch(candidate, profile, target, fx);
  return {
    profile: { id: profile.id, label: profile.label, note: profile.note },
    decision: decision.decision,
    reason: decision.reason,
    fit,
    safety,
    batch,
    attackSurface: attackSurface(candidate),
    actions: actionsFor(candidate, profile, safety, batch),
    changeMyMind: changeMyMind(candidate, profile, safety, batch),
  };
}

/** 新手教练层：为什么、坑、术语。老手不看这一层。 */
export function coachFor(candidate, brief) {
  const okChecks = (candidate.checks || []).filter((item) => item.status === '达标').slice(0, 3);
  const badChecks = (candidate.checks || []).filter((item) => item.status === '不达标');
  const pitfalls = [];
  const flags = candidate.flags || {};
  if (checkOf(candidate, 'certification')?.status === '警戒') pitfalls.push('认证：' + checkOf(candidate, 'certification').value + '；拿不到证书不要上架。');
  if (/强|季节|节日/.test(flags.seasonality || '')) pitfalls.push('季节性：备货晚了会压一整年，先算清窗口。');
  if (checkOf(candidate, 'fragile')?.status === '不达标') pitfalls.push('易碎/抛货：头程与退货会吃掉利润。');
  if ((candidate.inputs?.weightG || 0) > 2000) pitfalls.push('重量：超过 2kg，FBA 与头程显著上升。');
  pitfalls.push('1688 图片不要直接用；工厂说「实拍」也不可信。');
  pitfalls.push('突然爆红、周期短、工厂做局等专利 TRO 的「杀猪盘」，直接放弃。');
  return {
    why: [
      brief.reason,
      ...okChecks.map((item) => '达标项：' + item.label + '（' + item.value + '）'),
      ...badChecks.slice(0, 2).map((item) => '短板：' + item.label + '（' + item.value + '）'),
    ],
    pitfalls,
    terms: [
      ['净利率', '扣完采购、头程、FBA、佣金、广告、退货、其它后的利润率；不是毛利率。'],
      ['低评论占比', '评论数 <300 的商品销量占比，用来判断新链接还有没有机会。'],
      ['安全边际', '采购价还能涨多少、售价还能降多少，仍然不亏。'],
      ['FTO', '自由实施检索：确认你的产品不落入他人专利。'],
    ],
  };
}
