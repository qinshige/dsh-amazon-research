/**
 * 极简 MCP 客户端（Streamable HTTP / JSON-RPC 2.0）。
 * 只做本插件需要的事：initialize → tools/call；支持 SSE 与纯 JSON 两种响应形态。
 * 不注册工具到模型，避免把厂商上百个工具塞进上下文。
 */

const DEFAULT_TIMEOUT_MS = 60_000;

/** 解析 SSE 文本，返回 data 负载数组（忽略 event/注释/空行） */
export function parseSse(text) {
  const events = [];
  const blocks = String(text || '').split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length) events.push(dataLines.join('\n'));
  }
  return events;
}

/** 从 SSE 文本中取出与请求 id 匹配的 JSON-RPC 响应（取最后一个可解析的） */
export function pickResponse(text, id) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('空响应');
  // 纯 JSON
  if (raw.startsWith('{') || raw.startsWith('[')) {
    const parsed = Array.isArray(raw) ? raw : JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const hit = list.find((item) => item && item.id === id && (item.result || item.error)) || list.find((item) => item && (item.result || item.error));
    if (!hit) throw new Error('响应中没有 JSON-RPC 结果');
    return hit;
  }
  // SSE
  const payloads = parseSse(raw);
  let last = null;
  for (const payload of payloads) {
    if (!payload || payload === '[DONE]') continue;
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch {
      continue;
    }
    if (msg && msg.id !== undefined && msg.id !== id) continue;
    if (msg && (msg.result || msg.error)) last = msg;
  }
  if (!last) throw new Error('SSE 响应中没有 JSON-RPC 结果');
  return last;
}

/** 把 MCP tools/call 的 result 转成普通 JSON（content[0].text 里的 JSON 字符串会被解析） */
export function unwrapToolResult(result) {
  if (!result || typeof result !== 'object') return result;
  if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const content = Array.isArray(result.content) ? result.content : [];
  const texts = content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text);
  if (!texts.length) return result;
  const text = texts.join('\n');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export class McpHttpClient {
  /**
   * @param {{url:string, headers?:Record<string,string>, name?:string, timeoutMs?:number, retries?:number, fetchImpl?:typeof fetch}} opts
   */
  constructor(opts) {
    this.url = opts.url;
    this.headers = { ...(opts.headers || {}) };
    this.name = opts.name || 'mcp';
    this.timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.retries = Number.isFinite(opts.retries) ? opts.retries : 2;
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this._nextId = 1;
    this._initPromise = null;
    this._sessionId = null;
    this.stats = { calls: 0, failures: 0, lastError: null, lastLatencyMs: null };
  }

  _headers(extra) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...this.headers,
      ...(extra || {}),
    };
    if (this._sessionId) headers['mcp-session-id'] = this._sessionId;
    return headers;
  }

  async _post(body, signal) {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(new Error('MCP 请求超时')), this.timeoutMs);
    const signals = [timeoutController.signal];
    if (signal) signals.push(signal);
    const merged = typeof AbortSignal !== 'undefined' && AbortSignal.any ? AbortSignal.any(signals) : timeoutController.signal;
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(body),
        signal: merged,
      });
      const sessionId = response.headers && typeof response.headers.get === 'function' ? response.headers.get('mcp-session-id') : null;
      if (sessionId) this._sessionId = sessionId;
      const text = await response.text();
      if (!response.ok) {
        throw new Error('MCP HTTP ' + response.status + ': ' + text.slice(0, 300));
      }
      return pickResponse(text, body.id);
    } finally {
      clearTimeout(timer);
    }
  }

  async _request(method, params, opts = {}) {
    const id = this._nextId++;
    const body = { jsonrpc: '2.0', id, method, params: params || {} };
    let lastError = null;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const started = Date.now();
      try {
        const msg = await this._post(body, opts.signal);
        this.stats.calls += 1;
        this.stats.lastLatencyMs = Date.now() - started;
        if (msg.error) {
          const err = new Error('MCP 错误 ' + (msg.error.code ?? '') + ': ' + (msg.error.message || JSON.stringify(msg.error)));
          err.rpcError = msg.error;
          throw err;
        }
        return msg.result;
      } catch (error) {
        lastError = error;
        this.stats.failures += 1;
        this.stats.lastError = String(error && error.message ? error.message : error);
        const retryable = /HTTP (429|5\d\d)/.test(String(error && error.message)) || /超时|ECONN|fetch failed/i.test(String(error && error.message));
        if (!retryable || attempt === this.retries) break;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    throw lastError || new Error('MCP 调用失败');
  }

  /** initialize 只做一次；失败不阻塞后续 tools/call（部分服务端无状态） */
  async initialize(opts = {}) {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      try {
        return await this._request(
          'initialize',
          {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'dsh-amazon-research', version: '0.1.0' },
          },
          { signal: opts.signal },
        );
      } catch {
        return null;
      }
    })();
    return this._initPromise;
  }

  async listTools(opts = {}) {
    await this.initialize(opts);
    const result = await this._request('tools/list', {}, { signal: opts.signal });
    return Array.isArray(result && result.tools) ? result.tools : [];
  }

  /** 调用工具，自动拆包 content[0].text */
  async callTool(name, args, opts = {}) {
    await this.initialize(opts);
    const result = await this._request('tools/call', { name, arguments: args || {} }, { signal: opts.signal });
    const unwrapped = unwrapToolResult(result);
    if (result && result.isError) {
      const message = typeof unwrapped === 'string' ? unwrapped : JSON.stringify(unwrapped).slice(0, 500);
      const err = new Error('MCP 工具返回错误: ' + message);
      err.toolError = unwrapped;
      throw err;
    }
    return unwrapped;
  }
}
