import { McpHttpClient } from './mcp/client.js';
import { sellerspriteWebProvider } from './providers/sellersprite-web.js';

/** 数据源定义：端点、鉴权形态、能力矩阵 */
export const PROVIDER_DEFS = {
  sellersprite: {
    id: 'sellersprite',
    label: '卖家精灵 SellerSprite',
    url: 'https://mcp.sellersprite.com/mcp',
    auth: 'header',
    headerName: 'secret-key',
    keyRef: 'SELLERSPRITE_SECRET_KEY',
    capabilities: ['market', 'product', 'keyword', 'review', 'traffic', 'aba', 'trademark'],
    docs: 'https://www.sellersprite.com',
  },
  sorftime: {
    id: 'sorftime',
    label: 'Sorftime',
    url: 'https://mcp.sorftime.com',
    auth: 'query',
    queryParam: 'key',
    keyRef: 'SORFTIME_MCP_KEY',
    capabilities: ['category', 'product', 'keyword', 'review', 'trend', 'sourcing1688'],
  },
};

/** 网页登录态 provider（不需要 key，但需要用户在 Chrome 里已登录） */
export const WEB_PROVIDER_IDS = ['sellersprite-web'];

export class Providers {
  constructor({ secrets, settings, fetchImpl } = {}) {
    this.secrets = secrets;
    this.settings = settings || {};
    this.fetchImpl = fetchImpl;
    this._clients = new Map();
  }

  list() {
    return [
      ...Object.values(PROVIDER_DEFS).map((d) => ({ id: d.id, label: d.label, capabilities: d.capabilities })),
      { id: sellerspriteWebProvider.id, label: sellerspriteWebProvider.label, capabilities: sellerspriteWebProvider.capabilities },
    ];
  }

  async _client(id) {
    const def = PROVIDER_DEFS[id];
    if (!def) throw new Error('未知数据源: ' + id);
    const hit = await this.secrets.get(id);
    if (!hit) {
      const err = new Error('未配置 ' + def.label + ' 的密钥（' + def.keyRef + '）。请在设置页填写，或设置环境变量。');
      err.code = 'NO_CREDENTIAL';
      throw err;
    }
    const cacheKey = id + '|' + hit.value.slice(0, 4) + '|' + hit.value.length;
    if (this._clients.has(cacheKey)) return this._clients.get(cacheKey);
    const headers = {};
    let url = def.url;
    if (def.auth === 'header') headers[def.headerName] = hit.value;
    if (def.auth === 'query') {
      const u = new URL(def.url);
      u.searchParams.set(def.queryParam, hit.value);
      url = u.toString();
    }
    const client = new McpHttpClient({ url, headers, name: def.id, fetchImpl: this.fetchImpl });
    this._clients.set(cacheKey, client);
    return client;
  }

  /** 数据源健康状态（未配置 key 时不发请求） */
  async status(id) {
    if (id === sellerspriteWebProvider.id) {
      // 网页链路的健康检查要驱动浏览器，必须有超时兜底，
      // 否则一次卡住的 AppleScript 调用会让面板整体请求超时。
      const health = await Promise.race([
        sellerspriteWebProvider.health().catch((error) => ({ ok: false, error: String(error?.message ?? error) })),
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: '网页登录态探测超时' }), 2000)),
      ]);
      return {
        id,
        label: sellerspriteWebProvider.label,
        configured: true,
        ok: health.ok,
        capabilities: sellerspriteWebProvider.capabilities,
        lastError: health.ok ? null : health.error,
        note: health.note || null,
      };
    }
    const def = PROVIDER_DEFS[id];
    if (!def) throw new Error('未知数据源: ' + id);
    const described = await this.secrets.describe(id);
    if (!described.configured) {
      return { id, label: def.label, configured: false, ok: false, capabilities: def.capabilities, lastError: null, usage: null };
    }
    try {
      const client = await this._client(id);
      const started = Date.now();
      await client.listTools();
      return {
        id,
        label: def.label,
        configured: true,
        ok: true,
        latencyMs: Date.now() - started,
        capabilities: def.capabilities,
        stats: client.stats,
        lastError: null,
      };
    } catch (error) {
      return {
        id,
        label: def.label,
        configured: true,
        ok: false,
        capabilities: def.capabilities,
        lastError: String(error && error.message ? error.message : error),
      };
    }
  }

  /** 统一调用入口：provider + 工具名 + 参数（Sellersprite 的 request 包裹由调用方负责） */
  async call(id, tool, args, opts = {}) {
    const client = await this._client(id);
    return client.callTool(tool, args, opts);
  }

  async listTools(id, opts = {}) {
    const client = await this._client(id);
    return client.listTools(opts);
  }
}
