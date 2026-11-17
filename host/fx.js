/**
 * dsh-amazon-research · host/fx.js
 *
 * 双汇率管理：**成本汇率**与**结算汇率**分开。
 *
 * 为什么必须分开（用户口径）：
 *   - 成本汇率 6.7：采购、头程、FBA 等**成本项**折算人民币时用；
 *   - 结算汇率 6.6：售价、平台佣金、广告、退货等**收入项**回款结算时用；
 *   - 两个汇率不一致时，净利率与净利额会有系统性偏差：成本按 6.7 折算偏高、
 *     收入按 6.6 折算偏低，等于两头都往不利方向偏，**利润会被系统性低估**。
 *
 * 口径：所有内部计算统一以**美元**为基准做成本/收入相减，再用结算汇率折人民币出利润额；
 * 成本项的**人民币金额**（如 1688 采购价）直接是人民币，不参与汇率折算，
 * 折美元时用成本汇率。
 *
 * 实时汇率：可选从公开汇率接口取，取不到就回落到默认值并在报告里标注「默认值」。
 */

export const DEFAULT_COST_FX = 6.7;
export const DEFAULT_SETTLE_FX = 6.6;

/** 汇率来源标注。 */
export const FX_SOURCE = Object.freeze({
  live: { id: 'live', label: '实时汇率', note: '接口实时取数' },
  manual: { id: 'manual', label: '手动指定', note: '调用方传入' },
  default: { id: 'default', label: '默认值', note: '取不到实时汇率，使用内置默认值' },
});

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 归一化汇率配置。
 * @param {{costFx?:number, settleFx?:number, costFxSource?:string, settleFxSource?:string, fetchedAt?:string}} input
 */
export function resolveFx(input = {}) {
  const costFx = positive(input.costFx, DEFAULT_COST_FX);
  const settleFx = positive(input.settleFx, DEFAULT_SETTLE_FX);
  return {
    costFx,
    settleFx,
    costFxSource: input.costFxSource || (input.costFx ? FX_SOURCE.manual.id : FX_SOURCE.default.id),
    settleFxSource: input.settleFxSource || (input.settleFx ? FX_SOURCE.manual.id : FX_SOURCE.default.id),
    fetchedAt: input.fetchedAt || null,
  };
}

/**
 * 从公开接口取实时汇率（USD/CNY）。
 * 失败返回 null（不抛错），由调用方回落默认值。
 * @param {{timeoutMs?:number, fetchImpl?:Function}} options
 */
export async function fetchLiveFx({ timeoutMs = 6000, fetchImpl = null } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return null;
  const endpoints = [
    'https://open.er-api.com/v6/latest/USD',
    'https://api.frankfurter.app/latest?from=USD&to=CNY',
  ];
  for (const url of endpoints) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await doFetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!response || !response.ok) continue;
      const data = await response.json();
      const rate = Number(data?.rates?.CNY ?? data?.rates?.cny);
      if (Number.isFinite(rate) && rate > 0) {
        return { rate: Number(rate.toFixed(4)), fetchedAt: new Date().toISOString(), source: url };
      }
    } catch {
      /* 换下一个接口 */
    }
  }
  return null;
}

/**
 * 取实时汇率并生成汇率配置。取不到就用默认值。
 * @param {{live?:boolean, costFx?:number, settleFx?:number, fetchImpl?:Function, timeoutMs?:number}} options
 */
export async function getFx(options = {}) {
  const manualCost = positive(options.costFx, null);
  const manualSettle = positive(options.settleFx, null);
  if (options.live === false) {
    return resolveFx({
      costFx: manualCost ?? DEFAULT_COST_FX,
      settleFx: manualSettle ?? DEFAULT_SETTLE_FX,
      costFxSource: manualCost ? FX_SOURCE.manual.id : FX_SOURCE.default.id,
      settleFxSource: manualSettle ? FX_SOURCE.manual.id : FX_SOURCE.default.id,
    });
  }
  const live = await fetchLiveFx({ fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs });
  if (!live) {
    return resolveFx({
      costFx: manualCost ?? DEFAULT_COST_FX,
      settleFx: manualSettle ?? DEFAULT_SETTLE_FX,
      costFxSource: manualCost ? FX_SOURCE.manual.id : FX_SOURCE.default.id,
      settleFxSource: manualSettle ? FX_SOURCE.manual.id : FX_SOURCE.default.id,
    });
  }
  return resolveFx({
    costFx: manualCost ?? live.rate,
    settleFx: manualSettle ?? live.rate,
    costFxSource: manualCost ? FX_SOURCE.manual.id : FX_SOURCE.live.id,
    settleFxSource: manualSettle ? FX_SOURCE.manual.id : FX_SOURCE.live.id,
    fetchedAt: live.fetchedAt,
  });
}

/**
 * 汇率口径一句话说明（写进报告与 provenance，便于核对）。
 */
export function fxNote(fx) {
  const label = (id) => (FX_SOURCE[id] || FX_SOURCE.default).label;
  return '成本汇率 ' + fx.costFx + '（' + label(fx.costFxSource) + '）｜结算汇率 ' + fx.settleFx + '（' + label(fx.settleFxSource) + '）';
}
