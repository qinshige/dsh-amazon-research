/**
 * Chrome DevTools Protocol 后端（远程调试端口）。
 *
 * 与 applescript.js 保持**完全相同的原语签名**（listTabs / openTab / closeTab /
 * focusTab / runJs / runJson / waitFor），因此所有既有采集器无需改动即可切换后端。
 *
 * 相对 AppleScript 的增益（对齐 dsh-browser 的能力面）：
 *   - 不需要 Chrome「View → Developer → Allow JavaScript from Apple Events」开关；
 *   - 输入/点击可以走 CDP Input 域（真实事件，React/Vue 受控组件同样生效）；
 *   - 支持标签页截图（Page.captureScreenshot）；
 *   - 不聚焦窗口也能执行脚本（后台标签页可读，必要时用 activate 唤醒扩展渲染）。
 *
 * 前提：Chrome 需要带 --remote-debugging-port=<port> 启动，且端口只监听本机。
 * 未开端口时由 chrome.js 自动回落到 AppleScript，不报错、不阻塞。
 *
 * 纪律：只读已授权页面，不绕过登录/验证码；任何 CDP 调用失败都抛出可诊断错误。
 */

const DEFAULT_PORT = 9222;
const DEFAULT_HOST = '127.0.0.1';

/** 当前后端配置（由 chrome.js 依据 config.json 注入）。 */
let config = { host: DEFAULT_HOST, port: DEFAULT_PORT, timeoutMs: 20_000 };

/** 覆盖 CDP 连接参数。 */
export function configureCdp(options = {}) {
  const port = Number(options.port);
  const next = {
    host: typeof options.host === 'string' && options.host.trim() ? options.host.trim() : DEFAULT_HOST,
    port: Number.isInteger(port) && port > 0 && port < 65_536 ? port : DEFAULT_PORT,
    timeoutMs: Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 20_000,
  };
  if (next.host !== config.host || next.port !== config.port) closeAll();
  config = next;
  return { ...config };
}

export function cdpEndpoint() {
  return { host: config.host, port: config.port, base: `http://${config.host}:${config.port}` };
}

/** 可注入的 fetch（离线测试用）。 */
let fetchImpl = (...args) => fetch(...args);
export function setCdpFetch(impl) {
  fetchImpl = typeof impl === 'function' ? impl : (...args) => fetch(...args);
}

/** 可注入的 WebSocket 工厂（离线测试用）。 */
let connectImpl = (url) => defaultConnect(url);
export function setCdpConnect(impl) {
  connectImpl = typeof impl === 'function' ? impl : (url) => defaultConnect(url);
}

/** 默认 WebSocket 连接（Node 22 全局 WebSocket）。 */
function defaultConnect(url) {
  const WS = globalThis.WebSocket;
  if (typeof WS !== 'function') {
    throw Object.assign(new Error('当前 Node 没有 WebSocket，实现 CDP 需要 Node >= 22'), { code: 'CDP_NO_WEBSOCKET' });
  }
  return new WS(url);
}

async function withTimeout(promise, ms, code, label) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(label + ' 超时（' + ms + 'ms）'), { code })), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 发一个 CDP HTTP 请求，返回 { status, text, json }。 */
async function httpRequest(pathname, { method = 'GET', timeoutMs = config.timeoutMs } = {}) {
  const url = `http://${config.host}:${config.port}${pathname}`;
  let response;
  try {
    response = await withTimeout(fetchImpl(url, { method }), timeoutMs, 'CDP_TIMEOUT', 'CDP HTTP ' + pathname);
  } catch (error) {
    if (error?.code === 'CDP_TIMEOUT') throw error;
    throw Object.assign(new Error('无法连接 Chrome 调试端口 ' + config.host + ':' + config.port + '（' + String(error?.message ?? error) + '）'), { code: 'CDP_UNREACHABLE' });
  }
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: response.ok, status: response.status, text, json };
}

/** 调试端口是否可用（不抛错）。 */
export async function cdpAvailable({ timeoutMs = 1500 } = {}) {
  try {
    const result = await httpRequest('/json/version', { timeoutMs });
    return result.ok && Boolean(result.json?.Browser);
  } catch {
    return false;
  }
}

/** 列出可操作页面标签（过滤 devtools 等非 http 目标）。 */
export async function listTabs() {
  const result = await httpRequest('/json/list');
  if (!result.ok || !Array.isArray(result.json)) {
    throw Object.assign(new Error('CDP 列出标签页失败（HTTP ' + result.status + '）'), { code: 'CDP_HTTP' });
  }
  return result.json
    .filter((target) => target && target.type === 'page' && typeof target.url === 'string' && !target.url.startsWith('devtools://'))
    .map((target) => ({ id: String(target.id), url: target.url, title: String(target.title || '') }));
}

/** 打开新标签页，返回 target id。 */
export async function openTab(url) {
  let result = await httpRequest('/json/new?' + encodeURIComponent(url), { method: 'PUT' });
  if (!result.ok && (result.status === 405 || result.status === 404)) {
    result = await httpRequest('/json/new?' + encodeURIComponent(url));
  }
  if (!result.ok || !result.json?.id) {
    throw Object.assign(new Error('CDP 打开标签页失败（HTTP ' + result.status + '）: ' + result.text.slice(0, 200)), { code: 'CDP_OPEN_FAILED' });
  }
  return String(result.json.id);
}

/** 关闭标签页（真正 close）。 */
export async function closeTab(tabId) {
  const key = String(tabId);
  const result = await httpRequest('/json/close/' + encodeURIComponent(key));
  const connection = pool.get(key);
  if (connection) {
    try { connection.socket.close(); } catch { /* ignore */ }
    pool.delete(key);
  }
  if (!result.ok) throw Object.assign(new Error('CDP 关闭标签页失败（HTTP ' + result.status + '）'), { code: 'CDP_CLOSE_FAILED' });
  return { ok: true };
}

/** 激活标签页（置前）。 */
export async function focusTab(tabId) {
  const result = await httpRequest('/json/activate/' + encodeURIComponent(tabId)).catch(() => null);
  return result?.ok ? 'focused' : 'notfound';
}

/** 每个标签页一条 WebSocket 连接。 */
const pool = new Map();

function connectSocket(wsUrl) {
  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = connectImpl(wsUrl);
    } catch (error) {
      reject(error);
      return;
    }
    const timer = setTimeout(() => reject(Object.assign(new Error('CDP WebSocket 连接超时'), { code: 'CDP_TIMEOUT' })), config.timeoutMs);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    }, { once: true });
    socket.addEventListener('error', (event) => {
      clearTimeout(timer);
      reject(Object.assign(new Error('CDP WebSocket 连接失败: ' + String(event?.message || event?.type || 'unknown')), { code: 'CDP_UNREACHABLE' }));
    }, { once: true });
  });
}

async function targetWsUrl(tabId) {
  const result = await httpRequest('/json/list');
  const target = Array.isArray(result.json) ? result.json.find((item) => String(item.id) === String(tabId)) : null;
  if (!target?.webSocketDebuggerUrl) {
    throw Object.assign(new Error('找不到标签页 ' + tabId + ' 的调试连接（标签可能已关闭）'), { code: 'CDP_NO_TAB' });
  }
  return target.webSocketDebuggerUrl;
}

async function ensureConnection(tabId) {
  const key = String(tabId);
  const existing = pool.get(key);
  if (existing && existing.socket.readyState === 1) return existing;
  if (existing) pool.delete(key);
  const wsUrl = await targetWsUrl(key);
  const socket = await connectSocket(wsUrl);
  const connection = { socket, seq: 0, pending: new Map() };
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const pending = connection.pending.get(message.id);
    if (!pending) return;
    connection.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(Object.assign(new Error('CDP ' + pending.method + ' 失败: ' + JSON.stringify(message.error)), { code: 'CDP_ERROR' }));
    else pending.resolve(message.result ?? {});
  });
  socket.addEventListener('close', () => {
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error('CDP 连接已断开'), { code: 'CDP_CLOSED' }));
    }
    connection.pending.clear();
    if (pool.get(key) === connection) pool.delete(key);
  });
  pool.set(key, connection);
  return connection;
}

/** 发一条 CDP 命令并等结果。 */
async function send(tabId, method, params = {}, { timeoutMs = config.timeoutMs } = {}) {
  const connection = await ensureConnection(tabId);
  const id = ++connection.seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.pending.delete(id);
      reject(Object.assign(new Error('CDP ' + method + ' 超时（' + timeoutMs + 'ms）'), { code: 'CDP_TIMEOUT' }));
    }, timeoutMs);
    connection.pending.set(id, { resolve, reject, timer, method });
    try {
      connection.socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      clearTimeout(timer);
      connection.pending.delete(id);
      reject(Object.assign(new Error('CDP 发送失败: ' + String(error?.message ?? error)), { code: 'CDP_SEND_FAILED' }));
    }
  });
}

/** 在标签页执行 JS，返回字符串（与 AppleScript 后端同语义）。 */
export async function runJs(tabId, js, { timeout = 120_000 } = {}) {
  const result = await send(tabId, 'Runtime.evaluate', {
    expression: String(js),
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
    timeout,
  }, { timeoutMs: Math.max(config.timeoutMs, Math.min(timeout + 5_000, 24 * 60 * 60 * 1000)) });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || '未知异常';
    throw Object.assign(new Error('页面脚本异常: ' + String(detail).slice(0, 300)), { code: 'CDP_SCRIPT_ERROR' });
  }
  const value = result.result?.value;
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** 执行 JS 并解析 JSON（与 AppleScript 后端同语义）。 */
export async function runJson(tabId, js, { timeout = 120_000, strict = true } = {}) {
  const raw = await runJs(tabId, js, { timeout });
  const text = String(raw || '').trim();
  if (!text) throw new Error('页面返回空内容（可能未登录或页面未加载）');
  try {
    return JSON.parse(text);
  } catch {
    if (!strict) return text;
    throw new Error('页面返回非 JSON: ' + text.slice(0, 200));
  }
}

/** 等待页面出现某个 DOM 标志（timeout 秒）。 */
export async function waitFor(tabId, readyJs, { timeout = 45, intervalMs = 2000, check = runJs, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const deadline = now() + timeout * 1000;
  while (now() < deadline) {
    try {
      const raw = await check(tabId, readyJs, { timeout: Math.max(1, Math.min(40_000, deadline - now())) });
      const value = String(raw || '').trim();
      if (value && value !== 'false' && value !== 'null' && value !== 'undefined' && value !== '__NOT_FOUND__') return true;
    } catch {
      /* 页面未就绪，继续等 */
    }
    await sleep(Math.max(0, Math.min(intervalMs, deadline - now())));
  }
  return false;
}

/** 真实鼠标点击（CDP Input 域）。 */
export async function clickAt(tabId, x, y) {
  const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...base });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  return { ok: true, x: Math.round(x), y: Math.round(y) };
}

/** 真实滚轮滚动。 */
export async function wheelAt(tabId, x, y, deltaY) {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY: Math.round(deltaY) });
  return { ok: true };
}

/** 真实键盘输入（插入文本）。 */
export async function insertText(tabId, text) {
  await send(tabId, 'Input.insertText', { text: String(text) });
  return { ok: true };
}

/** 真实按键（如 Enter / Escape / ArrowDown）。 */
export async function pressKey(tabId, keyName) {
  const map = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
    PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
    PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
    Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
    End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  };
  const spec = map[keyName] || { key: String(keyName), code: String(keyName) };
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...spec });
  if (spec.text) await send(tabId, 'Input.dispatchKeyEvent', { type: 'char', ...spec });
  await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...spec });
  return { ok: true, key: keyName };
}

/** 返回完整 frame 树；用于读取普通 DOM 无法访问的跨域 iframe。 */
export async function listFrames(tabId) {
  const result = await send(tabId, 'Page.getFrameTree', {}, { timeoutMs: 20_000 });
  const rows = [];
  const visit = (node, parentId = null, depth = 0) => {
    if (!node?.frame) return;
    rows.push({
      id: String(node.frame.id), parentId: parentId ? String(parentId) : null,
      url: String(node.frame.url || ''), name: String(node.frame.name || ''), depth,
    });
    for (const child of node.childFrames || []) visit(child, node.frame.id, depth + 1);
  };
  visit(result.frameTree);
  return rows;
}

/** 在指定 frame 的隔离世界执行只读脚本。不会绕过 frame 自身的登录/验证。 */
export async function evaluateInFrame(tabId, frameId, expression, { timeout = 30_000 } = {}) {
  const world = await send(tabId, 'Page.createIsolatedWorld', {
    frameId: String(frameId), worldName: 'dsh-amazon-research-readonly', grantUniveralAccess: false,
  }, { timeoutMs: 20_000 });
  if (!world?.executionContextId) throw Object.assign(new Error('无法创建 frame 执行上下文'), { code: 'CDP_FRAME_CONTEXT_FAILED' });
  const result = await send(tabId, 'Runtime.evaluate', {
    expression: String(expression), contextId: world.executionContextId,
    returnByValue: true, awaitPromise: true, userGesture: false, timeout,
  }, { timeoutMs: Math.max(config.timeoutMs, timeout + 5_000) });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || '未知异常';
    throw Object.assign(new Error('frame 页面脚本异常: ' + String(detail).slice(0, 300)), { code: 'CDP_FRAME_SCRIPT_ERROR' });
  }
  const value = result.result?.value;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

/** 标签页截图（PNG base64）。clip 为空时取可视区域，fullPage 时尽量含可视区之外。 */
export async function captureScreenshot(tabId, { fullPage = false, clip = null } = {}) {
  const params = {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: fullPage === true || Boolean(clip),
  };
  if (clip && Number.isFinite(Number(clip.width)) && Number.isFinite(Number(clip.height))) {
    params.clip = {
      x: Number(clip.x) || 0,
      y: Number(clip.y) || 0,
      width: Math.max(1, Number(clip.width)),
      height: Math.max(1, Number(clip.height)),
      scale: Number.isFinite(Number(clip.scale)) && Number(clip.scale) > 0 ? Number(clip.scale) : 1,
    };
  }
  const result = await send(tabId, 'Page.captureScreenshot', params, { timeoutMs: 60_000 });
  if (!result?.data) throw Object.assign(new Error('截图失败：没有返回图像数据'), { code: 'CDP_SCREENSHOT_FAILED' });
  return Buffer.from(result.data, 'base64');
}

/** 导航（CDP Page.navigate，可等加载）。 */
export async function navigate(tabId, url) {
  const result = await send(tabId, 'Page.navigate', { url: String(url) }, { timeoutMs: 90_000 });
  if (result.errorText) throw Object.assign(new Error('导航失败: ' + result.errorText), { code: 'CDP_NAVIGATE_FAILED' });
  return { ok: true, url: String(url), frameId: result.frameId || null };
}

/** 断开所有连接（插件卸载/测试用）。 */
export function closeAll() {
  for (const connection of pool.values()) {
    try {
      connection.socket.close();
    } catch {
      /* ignore */
    }
  }
  pool.clear();
}
