import test from 'node:test';
import assert from 'node:assert/strict';
import * as cdp from '../host/web/cdp.js';

/** 极简 WebSocket 替身：只实现 cdp.js 用到的接口。 */
class FakeSocket {
  constructor(url, responder) {
    this.url = url;
    this.readyState = 0;
    this.responder = responder;
    this.listeners = new Map();
    setTimeout(() => {
      this.readyState = 1;
      this.emit('open', {});
    }, 0);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  emit(type, event) {
    for (const fn of this.listeners.get(type) || []) fn(event);
  }
  send(raw) {
    const message = JSON.parse(raw);
    const result = this.responder(message);
    setTimeout(() => this.emit('message', { data: JSON.stringify({ id: message.id, result }) }), 0);
  }
  close() {
    this.readyState = 3;
    this.emit('close', {});
  }
}

function fakeHttp(routes) {
  return async (url, init = {}) => {
    const method = init.method || 'GET';
    const match = routes.find((route) => url.endsWith(route.path) && (route.method || 'GET') === method)
      || routes.find((route) => url.endsWith(route.path));
    if (!match) return { ok: false, status: 404, text: async () => 'not found' };
    return { ok: match.status === undefined || match.status < 400, status: match.status ?? 200, text: async () => typeof match.body === 'string' ? match.body : JSON.stringify(match.body) };
  };
}

function setup({ routes, responder }) {
  cdp.configureCdp({ port: 9222, timeoutMs: 500 });
  cdp.setCdpFetch(fakeHttp(routes));
  cdp.setCdpConnect((url) => new FakeSocket(url, responder));
}

test.afterEach(() => {
  cdp.closeAll();
  cdp.setCdpFetch(null);
  cdp.setCdpConnect(null);
});

test('listTabs 只返回 page 目标并过滤 devtools', async () => {
  setup({
    routes: [{ path: '/json/list', body: [
      { id: 'A', type: 'page', url: 'https://a.test', title: 'A' },
      { id: 'B', type: 'page', url: 'devtools://x', title: 'dev' },
      { id: 'C', type: 'service_worker', url: 'https://c.test' },
    ] }],
    responder: () => ({}),
  });
  const tabs = await cdp.listTabs();
  assert.deepEqual(tabs, [{ id: 'A', url: 'https://a.test', title: 'A' }]);
});

test('openTab 先试 PUT，405 时回退 GET', async () => {
  let calls = [];
  setup({
    routes: [
      { path: '/json/new?https%3A%2F%2Fa.test', method: 'PUT', status: 405, body: 'no' },
      { path: '/json/new?https%3A%2F%2Fa.test', body: { id: 'NEW' } },
    ],
    responder: () => ({}),
  });
  const id = await cdp.openTab('https://a.test');
  assert.equal(id, 'NEW');
});

test('cdpAvailable 依据 /json/version', async () => {
  setup({ routes: [{ path: '/json/version', body: { Browser: 'Chrome/1' } }], responder: () => ({}) });
  assert.equal(await cdp.cdpAvailable(), true);
  cdp.setCdpFetch(async () => { throw new Error('refused'); });
  assert.equal(await cdp.cdpAvailable(), false);
});

test('runJs 返回字符串；对象序列化；异常抛出可诊断错误', async () => {
  setup({
    routes: [{ path: '/json/list', body: [{ id: 'A', type: 'page', url: 'https://a.test', webSocketDebuggerUrl: 'ws://x' }] }],
    responder: (message) => {
      if (message.method !== 'Runtime.evaluate') return {};
      if (message.params.expression === 'boom') return { exceptionDetails: { exception: { description: 'ReferenceError: boom' } } };
      if (message.params.expression === 'obj') return { result: { value: { a: 1 } } };
      return { result: { value: String(message.params.expression) === '2+2' ? '4' : 'text' } };
    },
  });
  assert.equal(await cdp.runJs('A', '2+2'), '4');
  assert.equal(await cdp.runJs('A', 'obj'), '{"a":1}');
  await assert.rejects(() => cdp.runJs('A', 'boom'), /ReferenceError: boom/);
});

test('screenshot 返回 PNG Buffer', async () => {
  const png = Buffer.from('fake-png');
  setup({
    routes: [{ path: '/json/list', body: [{ id: 'A', type: 'page', url: 'https://a.test', webSocketDebuggerUrl: 'ws://x' }] }],
    responder: (message) => message.method === 'Page.captureScreenshot' ? { data: png.toString('base64') } : {},
  });
  const buffer = await cdp.captureScreenshot('A', { fullPage: true });
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.toString(), 'fake-png');
});

test('列出 frame 树并在跨域 frame 隔离世界执行只读脚本', async () => {
  setup({
    routes: [{ path: '/json/list', body: [{ id: 'A', type: 'page', url: 'https://a.test', webSocketDebuggerUrl: 'ws://x' }] }],
    responder: (message) => {
      if (message.method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root', url: 'https://a.test' }, childFrames: [{ frame: { id: 'child', url: 'https://b.test/frame', name: 'foreign' } }] } };
      if (message.method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
      if (message.method === 'Runtime.evaluate') return { result: { value: JSON.stringify({ title: 'Frame' }) } };
      return {};
    },
  });
  const frames = await cdp.listFrames('A');
  assert.deepEqual(frames, [
    { id: 'root', parentId: null, url: 'https://a.test', name: '', depth: 0 },
    { id: 'child', parentId: 'root', url: 'https://b.test/frame', name: 'foreign', depth: 1 },
  ]);
  assert.deepEqual(await cdp.evaluateInFrame('A', 'child', 'JSON.stringify({title:document.title})'), { title: 'Frame' });
});

test('CDP 端口变化会关闭旧 WebSocket 连接', async () => {
  const sockets = [];
  cdp.configureCdp({ port: 9222, timeoutMs: 500 });
  cdp.setCdpFetch(fakeHttp([{ path: '/json/list', body: [{ id: 'A', type: 'page', url: 'https://a.test', webSocketDebuggerUrl: 'ws://x' }] }]));
  cdp.setCdpConnect((url) => { const socket = new FakeSocket(url, () => ({ result: { value: 'ok' } })); sockets.push(socket); return socket; });
  await cdp.runJs('A', '1');
  assert.equal(sockets[0].readyState, 1);
  cdp.configureCdp({ port: 9333, timeoutMs: 500 });
  assert.equal(sockets[0].readyState, 3);
});
