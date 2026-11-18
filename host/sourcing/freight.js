/** 海空运报价。接口需返回 CNY/kg；没有报价时保持未知，不套用历史估算。 */
export const FREIGHT_MODES = Object.freeze({
  sea: Object.freeze({ id: 'sea', label: '海运' }),
  air: Object.freeze({ id: 'air', label: '空运' }),
  express: Object.freeze({ id: 'express', label: '国际快递' }),
});
export const DEFAULT_FREIGHT_MODE = 'sea';
export const FREIGHT_SOURCE = Object.freeze({
  live: { id: 'live', label: '接口报价' },
  manual: { id: 'manual', label: '手动指定' },
  missing: { id: 'missing', label: '未取到' },
});
function positive(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
export function parseFreightPayload(payload) {
  if (!payload || typeof payload !== 'object' || payload.success === false) return null;
  const roots = [payload, payload.rates, payload.data, payload.result, payload.freight].filter(x => x && typeof x === 'object');
  // 本接口协议为 CNY/kg，拒绝显式标注为其它币种/单位的数据。
  if (roots.some(x => (x.currency && !['CNY', 'RMB'].includes(String(x.currency).toUpperCase())) || (x.unit && !['kg', 'CNY/kg', 'RMB/kg'].includes(x.unit)))) return null;
  const rates = {};
  for (const root of roots) for (const mode of Object.keys(FREIGHT_MODES)) {
    for (const key of [mode, mode + 'PerKg', mode + 'PerKgCNY', mode + '_per_kg']) {
      const n = positive(root[key]);
      if (n !== null && rates[mode] === undefined) rates[mode] = n;
    }
  }
  return Object.keys(rates).length ? rates : null;
}
export async function fetchLiveFreight({ apiUrl = '', timeoutMs = 6000, fetchImpl = null } = {}) {
  let url;
  try { url = new URL(apiUrl); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') return null;
  const controller = new AbortController();
  let timer;
  try {
    const request = (async () => {
      const response = await doFetch(url.href, { signal: controller.signal });
      if (!response?.ok) return null;
      const data = await response.json();
      const rates = parseFreightPayload(data);
      if (!rates) return null;
      const date = data.quotedAt || data.updatedAt || data.date || data.data?.quotedAt || null;
      const quotedAt = typeof date === 'string' && Number.isFinite(Date.parse(date)) ? date : null;
      // 不将已过期的报价算成实时运价。
      if (data.validUntil && (!Number.isFinite(Date.parse(data.validUntil)) || Date.parse(data.validUntil) < Date.now())) return null;
      // 省略查询串，防止接口密钥出现在报告中。
      return { rates, fetchedAt: new Date().toISOString(), quotedAt, source: url.origin + url.pathname };
    })();
    const timeout = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, positive(timeoutMs) || 6000); });
    return await Promise.race([request, timeout]);
  } catch { return null; }
  finally { clearTimeout(timer); }
}
export function resolveFreight(options = {}) {
  const mode = Object.hasOwn(FREIGHT_MODES, options.mode) ? options.mode : DEFAULT_FREIGHT_MODE;
  const manual = positive(options.perKgCNY);
  const liveValue = positive(options.liveRates?.[mode]);
  const perKgCNY = manual ?? liveValue;
  const source = manual !== null ? 'manual' : liveValue !== null ? 'live' : 'missing';
  return {
    mode, label: FREIGHT_MODES[mode].label, perKgCNY, source,
    transitDays: '未取到',
    note: perKgCNY === null ? '未取到头程报价；请提供目标线路的 CNY/kg 报价或物流接口，不能据此计算净利。' : '按所选线路报价和件重折算；体积重、最低计费重及附加费需由报价方确认。',
    fetchedAt: source === 'live' ? options.fetchedAt || null : null,
    quotedAt: source === 'live' ? options.quotedAt || null : null,
    endpoint: source === 'live' ? options.endpoint || null : null,
    rates: options.liveRates || null,
  };
}
export async function getFreight(options = {}) {
  const live = options.live !== false && options.apiUrl && positive(options.perKgCNY) === null
    ? await fetchLiveFreight(options) : null;
  return resolveFreight({ ...options, liveRates: live?.rates, fetchedAt: live?.fetchedAt, quotedAt: live?.quotedAt, endpoint: live?.source });
}
export function freightTable(resolved) {
  return Object.values(FREIGHT_MODES).map(mode => {
    const selected = resolved?.mode === mode.id;
    const value = selected ? resolved.perKgCNY : positive(resolved?.rates?.[mode.id]);
    const source = selected ? resolved.source : value !== null ? 'live' : 'missing';
    return { ...mode, perKgCNY: value, transitDays: '未取到', source: FREIGHT_SOURCE[source]?.label || '未取到' };
  });
}
