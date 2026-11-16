/**
 * dsh-amazon-research · host/selection/profiles.js
 *
 * 卖家画像：同一个品，对新手、进阶、工厂型的结论不同。
 * 这里只放**阈值与适配判断**，不改十维体检本身；画像只决定「对你适不适合」。
 */
export const PROFILES = Object.freeze({
  beginner: Object.freeze({
    id: 'beginner',
    label: '新手（资金 <10 万，无稳定供应链）',
    priceMin: 15,
    priceMax: 35,
    /** 渠道专属价格带（覆盖 priceMin/priceMax） */
    priceBands: Object.freeze({
      'amazon-fba': Object.freeze({ min: 15, max: 35 }),
      'amazon-fbm': Object.freeze({ min: 15, max: 60 }),
      'tiktok-shop': Object.freeze({ min: 8, max: 25 }),
    }),
    maxWeightG: 500,
    maxVariants: 2,
    forbidCertification: true,
    forbidStrongSeasonality: true,
    marginRedline: 0.30,
    targetMonthlyUnits: 100,
    firstBatchUnits: 200,
    maxFirstBatchCNY: 20000,
    note: '首年目标是活下来：轻小、低价、全年平稳、变体少、不碰认证。',
  }),
  operator: Object.freeze({
    id: 'operator',
    label: '进阶（资金 10–50 万，有稳定供应商）',
    priceMin: 15,
    priceMax: 45,
    priceBands: Object.freeze({
      'amazon-fba': Object.freeze({ min: 15, max: 45 }),
      'amazon-fbm': Object.freeze({ min: 15, max: 80 }),
      'tiktok-shop': Object.freeze({ min: 8, max: 30 }),
    }),
    maxWeightG: 2000,
    maxVariants: 3,
    forbidCertification: false,
    forbidStrongSeasonality: false,
    marginRedline: 0.25,
    targetMonthlyUnits: 300,
    firstBatchUnits: 500,
    maxFirstBatchCNY: 100000,
    note: '可以靠差异化与广告抢位置，但仍要算清现金流。',
  }),
  factory: Object.freeze({
    id: 'factory',
    label: '工厂型（自有产线/可开模）',
    priceMin: 30,
    priceMax: 120,
    priceBands: Object.freeze({
      'amazon-fba': Object.freeze({ min: 30, max: 120 }),
      'amazon-fbm': Object.freeze({ min: 25, max: 200 }),
      'tiktok-shop': Object.freeze({ min: 15, max: 60 }),
    }),
    maxWeightG: 20000,
    maxVariants: 5,
    forbidCertification: false,
    forbidStrongSeasonality: false,
    marginRedline: 0.20,
    targetMonthlyUnits: 500,
    firstBatchUnits: 1000,
    maxFirstBatchCNY: 300000,
    note: '可以用模具、专利、MOQ 建壁垒，利润可以靠量摊薄。',
  }),
});

export function getProfile(id) {
  const key = String(id || '').trim().toLowerCase();
  return Object.hasOwn(PROFILES, key) ? PROFILES[key] : PROFILES.beginner;
}

function checkOf(candidate, key) {
  return (candidate.checks || []).find((item) => item.key === key) || null;
}

function checkNumber(candidate, key) {
  const hit = checkOf(candidate, key);
  if (!hit || hit.status === '未知') return null;
  const n = Number(String(hit.value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * 画像适配：返回适合 / 需条件 / 不适合，以及具体原因。
 * 只判「这个品适不适合你」，不重复十维的质量判断。
 */
export function evaluateProfileFit(candidate, profileInput = 'beginner', channel = 'amazon-fba') {
  const profile = typeof profileInput === 'string' ? getProfile(profileInput) : (profileInput || PROFILES.beginner);
  const fails = [];
  const warnings = [];
  const price = candidate.priceUSD;
  const band = (profile.priceBands && profile.priceBands[channel]) || { min: profile.priceMin, max: profile.priceMax };

  if (price !== null && price !== undefined) {
    if (price < band.min) fails.push({ label: '售价低于画像下限', detail: '$' + price.toFixed(2) + ' < $' + band.min + '（' + channel + '）' });
    if (price > band.max) fails.push({ label: '售价高于画像上限', detail: '$' + price.toFixed(2) + ' > $' + band.max + '（' + channel + '）' });
  }

  const weight = candidate.inputs ? candidate.inputs.weightG : null;
  if (weight !== null && weight !== undefined && weight > profile.maxWeightG) {
    fails.push({ label: '重量超出画像上限', detail: Math.round(weight) + 'g > ' + profile.maxWeightG + 'g（物流与退货吃利润）' });
  }

  const variants = checkNumber(candidate, 'variants');
  if (variants !== null && variants > profile.maxVariants) {
    fails.push({ label: '变体数超出画像上限', detail: variants + ' 个 > ' + profile.maxVariants + ' 个（压库存）' });
  }

  const cert = checkOf(candidate, 'certification');
  if (profile.forbidCertification && cert && cert.status === '警戒') {
    fails.push({ label: '需要认证', detail: String(cert.value) + '（新手先避开）' });
  }

  const season = candidate.flags ? candidate.flags.seasonality : '';
  if (profile.forbidStrongSeasonality && /强|季节|节日/.test(season || '')) {
    fails.push({ label: '强季节性', detail: season + '（备货窗口与现金流风险）' });
  }

  const margin = candidate.margin;
  if (margin !== null && margin !== undefined) {
    if (margin < profile.marginRedline) {
      fails.push({ label: '净利率低于画像红线', detail: (margin * 100).toFixed(1) + '% < ' + (profile.marginRedline * 100).toFixed(0) + '%' });
    } else if (margin < profile.marginRedline + 0.05) {
      warnings.push({ label: '净利率贴近红线', detail: (margin * 100).toFixed(1) + '%（红线 ' + (profile.marginRedline * 100).toFixed(0) + '%）' });
    }
  }

  const status = fails.length > 0 ? '不适合' : (warnings.length > 0 ? '需条件' : '适合');
  return { profileId: profile.id, channel, priceBand: band, status, fails, warnings };
}

/** 结论：把十维档位 + 画像适配合成一句人话。 */
export function decide(candidate, fit, profileInput = 'beginner') {
  const profile = typeof profileInput === 'string' ? getProfile(profileInput) : (profileInput || PROFILES.beginner);
  if (candidate.tier === '淘汰') {
    return { decision: '不做', reason: '命中一票否决：' + candidate.vetoes.map((v) => v.label).join('、') };
  }
  if (fit.status === '不适合') {
    return { decision: '不做', reason: '不适合你的画像：' + fit.fails.map((f) => f.label).join('、') };
  }
  if (candidate.tier === '待复核') {
    return { decision: '先补数', reason: candidate.tierReason };
  }
  if (candidate.tier === '一档' && fit.status === '适合') {
    return {
      decision: profile.id === 'beginner' ? '小批量测' : '做',
      reason: profile.id === 'beginner' ? '各项达标，但新手仍先小批量验证' : '各项达标，可按计划开品',
    };
  }
  if (candidate.tier === '二档' || fit.status === '需条件') {
    return { decision: '小批量测', reason: fit.status === '需条件' ? '有需条件项：' + fit.warnings.map((w) => w.label).join('、') : 'KPI 达标但未到一档，先测款' };
  }
  return { decision: '不做', reason: 'KPI 命中率不足，先换切入点' };
}
