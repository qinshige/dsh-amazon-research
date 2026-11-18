/**
 * dsh-amazon-research · host/sourcing/cost-profile.js
 *
 * 成本口径档：把「佣金 / 广告 / 退货 / 其它 / 头程运输方式」抽成一份可配置、可追溯的口径。
 *
 * 为什么独立成模块（用户口径 v0.4.9）：
 *   - 佣金 6%、广告 10%、退货 5%、其它费用 0 —— 这是用户指定的测算假设，并非平台官方费率；
 *   - 头程按**实时海运 / 空运运价**折算（缺少报价时不计算净利）；
 *   - 口径必须写进报告与 provenance，否则看到净利率却不知道用的什么费率。
 *
 * 平台差异必须提示：Amazon 美国站的**平台佣金按类目在 8%~17%**（工具/家居 15%），
 * 与跨境直发的 6% 不同 —— 用错渠道费率会直接高估净利率。
 */

export const DEFAULT_COST_PROFILE = Object.freeze({
  /** 平台佣金 */
  referralRate: 0.06,
  /** 广告占比 */
  adRate: 0.10,
  /** 退货损耗 */
  returnRate: 0.05,
  /** 其它费用（仓储/操作等）：暂不计 */
  otherUSD: 0,
  /** 头程运输方式：sea | air | express */
  freightMode: 'sea',
});

/** 各平台的标准佣金（用于报告里提示口径差异）。 */
export const PLATFORM_REFERRAL = Object.freeze({
  amazon: { label: 'Amazon 美国站', note: '平台佣金按类目 8%~17%（工具/家居 15%、服饰 17%、美妆电子 8%）' },
  tiktok: { label: 'TikTok Shop 美国站', note: '佣金 6% 为用户测算口径，实际以平台与类目规则为准' },
});

function ratio(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return fallback;
  if (n > 100) return fallback;
  return n > 1 ? n / 100 : n;
}

function nonNegative(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * 归一化成本口径。
 * @param {object} input
 * @returns {{referralRate:number, adRate:number, returnRate:number, otherUSD:number, freightMode:string, source:string}}
 */
export function resolveCostProfile(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const def = DEFAULT_COST_PROFILE;
  const profile = {
    referralRate: ratio(src.referralRate, def.referralRate),
    adRate: ratio(src.adRate, def.adRate),
    returnRate: ratio(src.returnRate, def.returnRate),
    otherUSD: nonNegative(src.otherUSD, def.otherUSD),
    freightMode: ['sea', 'air', 'express'].includes(src.freightMode) ? src.freightMode : def.freightMode,
  };
  const provided = ['referralRate', 'adRate', 'returnRate', 'otherUSD', 'freightMode'].filter((key) => src[key] !== undefined && src[key] !== null);
  profile.source = provided.length === 0 ? 'default' : (provided.length === 5 ? 'full' : 'partial');
  profile.provided = provided;
  return profile;
}

/** 一行说明（写进报告与 notes）。 */
export function costProfileNote(profile) {
  return '佣金 ' + (profile.referralRate * 100).toFixed(0) + '%'
    + '｜广告 ' + (profile.adRate * 100).toFixed(0) + '%'
    + '｜退货 ' + (profile.returnRate * 100).toFixed(0) + '%'
    + '｜其它 ' + (profile.otherUSD > 0 ? '$' + profile.otherUSD.toFixed(2) : '不计')
    + '｜头程 ' + profile.freightMode;
}
