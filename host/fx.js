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
 * 实时汇率：默认获取公开接口最新公布值（不等于逐笔市场报价），失败回落默认值并标注来源。
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
  if (!['number', 'string'].includes(typeof value)) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 归一化汇率配置。
 * @param {{costFx?:number, settleFx?:number, costFxSource?:string, settleFxSource?:string, fetchedAt?:string, dataDate?:string, endpoint?:string}} input
 */
export function resolveFx(input = {}) {
  const costFx = positive(input.costFx, DEFAULT_COST_FX);
  const settleFx = positive(input.settleFx, DEFAULT_SETTLE_FX);
  return {
    costFx,
    settleFx,
    costFxSource: positive(input.costFx, null) === null ? FX_SOURCE.default.id : (FX_SOURCE[input.costFxSource]?.id || FX_SOURCE.manual.id),
    settleFxSource: positive(input.settleFx, null) === null ? FX_SOURCE.default.id : (FX_SOURCE[input.settleFxSource]?.id || FX_SOURCE.manual.id),
    fetchedAt: input.fetchedAt || null,
    dataDate: input.dataDate || null,
    endpoint: input.endpoint || null,
  };
}

/**
 * 从公开接口取实时汇率（USD/CNY）。
 * 失败返回 null（不抛错），由调用方回落默认值。
 * @param {{timeoutMs?:number, fetchImpl?:Function, retries?:number}} options
 */
export async function fetchLiveFx({ timeoutMs = 6000, fetchImpl = null, retries = 1 } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return null;
  const endpoints = [
    'https://open.er-api.com/v6/latest/USD',
    'https://api.frankfurter.app/latest?from=USD&to=CNY',
  ];
  // 每次尝试的期限覆盖连接、响应头与响应体；即使注入的 fetch 忽略 abort 也能返回。
  const attempts = Number.isInteger(retries) && retries >= 0 ? Math.min(retries, 3) : 1;
  const deadline = positive(timeoutMs, 6000);
  for (const url of endpoints) {
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      let timer;
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('汇率请求超时'));
          }, deadline);
        });
        const data = await Promise.race([
          (async () => {
            const response = await doFetch(url, { signal: controller.signal });
            if (!response?.ok) throw new Error('HTTP ' + response?.status);
            return await response.json();
          })(),
          timeout,
        ]);
        const rate = positive(data?.rates?.CNY ?? data?.rates?.cny, null);
        if (rate === null || (data?.result && data.result !== 'success') ||
            ((data?.base_code ?? data?.base) && (data.base_code ?? data.base) !== 'USD')) {
          throw new Error('响应里没有有效 USD/CNY 汇率');
        }
        // 日期仅来自接口，缺失时不拿抓取日期冒充报价日期。
        const unix = positive(data?.time_last_update_unix, null);
        const published = unix !== null ? new Date(unix * 1000) :
          new Date(data?.date || data?.time_last_update_utc || NaN);
        const dataDate = Number.isFinite(published.getTime()) ? published.toISOString().slice(0, 10) : null;
        return { rate, dataDate, fetchedAt: new Date().toISOString(), source: url };
      } catch {
        /* 重试或换下一个接口 */
      } finally {
        clearTimeout(timer);
      }
    }
  }
  return null;
}

/**
 * 取实时汇率并生成汇率配置。取不到就用默认值。
 * @param {{live?:boolean, costFx?:number, settleFx?:number, fetchImpl?:Function, timeoutMs?:number}} options
 */
/**
 * 实时汇率的进程内缓存。
 *
 * 为什么需要缓存：一次选品体检会算 228 个候选，每个候选都要用汇率；
 * 不缓存的话就是 228 次网络请求，既慢又容易把汇率接口打挂。
 * 默认最多缓存 30 分钟；cacheTtlMs: 0 强制重新取数，缓存保留原抓取日期与数据日期。
 */
const liveCache = { value: null, expiresAt: 0 };

/** 清空实时汇率缓存（测试用）。 */
export function clearFxCache() {
  liveCache.value = null;
  liveCache.expiresAt = 0;
}

/**
 * 取实时汇率并生成汇率配置。
 *
 * 默认走**实时汇率**（用户口径「汇率可以按照实时的计算」）：
 *   - 实时取到 → 成本汇率与结算汇率都用实时值，来源标 live；
 *   - 手动传入 costFx / settleFx → 以手动值为准，来源标 manual；
 *   - 取不到实时汇率 → 回落默认值（成本 6.7 / 结算 6.6），来源标 default，**不报错**。
 *
 * @param {{live?:boolean, costFx?:number, settleFx?:number, fetchImpl?:Function, timeoutMs?:number, cacheTtlMs?:number, retries?:number}} options
 */
export async function getFx(options = {}) {
  const manualCost = positive(options.costFx, null);
  const manualSettle = positive(options.settleFx, null);
  const live = options.live !== false;

  if (!live) {
    return resolveFx({
      costFx: manualCost ?? DEFAULT_COST_FX,
      settleFx: manualSettle ?? DEFAULT_SETTLE_FX,
      costFxSource: manualCost ? FX_SOURCE.manual.id : FX_SOURCE.default.id,
      settleFxSource: manualSettle ? FX_SOURCE.manual.id : FX_SOURCE.default.id,
    });
  }

  // 手动指定优先，且不再走网络（省一次请求，也避免手填值被实时值覆盖）
  if (manualCost !== null && manualSettle !== null) {
    return resolveFx({
      costFx: manualCost,
      settleFx: manualSettle,
      costFxSource: FX_SOURCE.manual.id,
      settleFxSource: FX_SOURCE.manual.id,
    });
  }

  const ttl = Number.isFinite(Number(options.cacheTtlMs)) ? Number(options.cacheTtlMs) : 30 * 60 * 1000;
  const now = Date.now();
  let liveRate = null;
  if (ttl > 0 && !options.fetchImpl && liveCache.value && liveCache.expiresAt > now) {
    liveRate = liveCache.value;
  } else {
    liveRate = await fetchLiveFx({ fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs, retries: options.retries });
    if (liveRate && !options.fetchImpl) {
      liveCache.value = liveRate;
      liveCache.expiresAt = Date.now() + Math.max(0, ttl);
    }
  }

  if (!liveRate) {
    return resolveFx({
      costFx: manualCost ?? DEFAULT_COST_FX,
      settleFx: manualSettle ?? DEFAULT_SETTLE_FX,
      costFxSource: manualCost ? FX_SOURCE.manual.id : FX_SOURCE.default.id,
      settleFxSource: manualSettle ? FX_SOURCE.manual.id : FX_SOURCE.default.id,
    });
  }

  return resolveFx({
    costFx: manualCost ?? liveRate.rate,
    settleFx: manualSettle ?? liveRate.rate,
    costFxSource: manualCost ? FX_SOURCE.manual.id : FX_SOURCE.live.id,
    settleFxSource: manualSettle ? FX_SOURCE.manual.id : FX_SOURCE.live.id,
    fetchedAt: liveRate.fetchedAt,
    dataDate: liveRate.dataDate,
    endpoint: liveRate.source,
  });
}

/**
 * 汇率口径一句话说明（写进报告与 provenance，便于核对）。
 */
export function fxNote(fx) {
  const label = (id) => (FX_SOURCE[id] || FX_SOURCE.default).label;
  return '成本汇率 ' + fx.costFx + '（' + label(fx.costFxSource) + '）｜结算汇率 ' + fx.settleFx + '（' + label(fx.settleFxSource) + '）';
}
