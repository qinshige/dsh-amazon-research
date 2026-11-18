import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { snapshotExpression, formatSnapshot, INTERACTIVE_SELECTOR } from '../host/web/snapshot.js';

class FakeElement {
  constructor(tagName, { attrs = {}, text = '', value = '', type = '', rect = { width: 100, height: 20, top: 10, bottom: 30 }, disabled = false, checked = null, required = false, shadowRoot = null, contentDocument = null, contentWindow = null } = {}) {
    this.tagName = tagName.toUpperCase();
    this._attrs = new Map(Object.entries(attrs));
    this.innerText = text;
    this.textContent = text;
    this.value = value;
    this.type = type || (this.tagName === 'INPUT' ? 'text' : undefined);
    this.rect = rect;
    this.disabled = disabled;
    this.checked = checked;
    this.required = required;
    this.isContentEditable = false;
    this.shadowRoot = shadowRoot;
    this.contentDocument = contentDocument;
    this.contentWindow = contentWindow;
  }
  getAttribute(name) { return this._attrs.has(name) ? this._attrs.get(name) : null; }
  setAttribute(name, value) { this._attrs.set(name, String(value)); }
  getBoundingClientRect() { return this.rect; }
}

class FakeRoot {
  constructor(elements = [], text = '') {
    this.elements = elements;
    this.innerText = text;
    this.textContent = text;
    this.mode = 'open';
  }
  querySelectorAll(selector) {
    if (selector === '*') return this.elements;
    return this.elements.filter((el) => el.tagName !== 'DIV' && el.tagName !== 'IFRAME');
  }
}

function makeWindow() {
  return { innerHeight: 800, innerWidth: 1200, scrollY: 0, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
}

function makeDocument(elements = [], text = '第一行\n第二行') {
  return {
    title: '测试页', readyState: 'complete',
    body: { innerText: text, textContent: text },
    documentElement: { scrollHeight: 2000 },
    querySelectorAll(selector) {
      if (selector === '*') return elements;
      return elements.filter((el) => el.tagName !== 'DIV' && el.tagName !== 'IFRAME');
    },
  };
}

function makeDom() {
  const elements = [];
  const window = makeWindow();
  const document = makeDocument(elements);
  const location = { href: 'https://example.test/p?q=1' };
  const sandbox = { window, document, location, Date, JSON, Math, String, Number, Object, Array, RegExp, WeakMap, Map, WeakRef, console };
  return { elements, window, document, location, sandbox };
}

function run(expr, dom) {
  return JSON.parse(vm.runInNewContext(expr, dom.sandbox));
}

test('快照脚本合法且不再写 data-dsh-ref', () => {
  const code = snapshotExpression({});
  assert.doesNotThrow(() => new Function(code));
  assert.doesNotMatch(code, /setAttribute\([^)]*data-dsh-ref/);
  assert.match(code, /__dshRefRegistry/);
  assert.match(code, /new WeakMap/);
  assert.match(code, /••••/);
  assert.ok(INTERACTIVE_SELECTOR.includes('button'));
});

test('registry 稳定编号、反向解析且页面 DOM 不被污染', () => {
  const dom = makeDom();
  const a = new FakeElement('button', { text: '加载更多' });
  const b = new FakeElement('a', { text: '详情', attrs: { href: '/p/1' } });
  dom.elements.push(a, b);
  assert.deepEqual(run(snapshotExpression({}), dom).items.map((x) => x.ref), ['e1', 'e2']);
  assert.deepEqual(run(snapshotExpression({}), dom).items.map((x) => x.ref), ['e1', 'e2']);
  dom.elements.push(new FakeElement('button', { text: '下一页' }));
  assert.deepEqual(run(snapshotExpression({}), dom).items.map((x) => x.ref), ['e1', 'e2', 'e3']);
  assert.equal(dom.window.__dshRefRegistry.resolve('e1'), a);
  assert.equal(a.getAttribute('data-dsh-ref'), null);
});

test('password/otp/pin/card/token 等字段的 value 与 accessibleName 都脱敏', () => {
  const dom = makeDom();
  dom.elements.push(
    new FakeElement('input', { attrs: { name: 'password', 'aria-label': 'secret123' }, value: 'secret123', type: 'password' }),
    new FakeElement('input', { attrs: { autocomplete: 'one-time-code', placeholder: '654321' }, value: '654321' }),
    new FakeElement('input', { attrs: { name: 'security_pin' }, value: '9988' }),
    new FakeElement('input', { attrs: { name: 'cardNumber' }, value: '4111111111111111' }),
    new FakeElement('input', { attrs: { id: 'refresh_token' }, value: 'tok-secret' }),
    new FakeElement('input', { attrs: { name: 'keyword' }, value: '手套' }),
  );
  const view = run(snapshotExpression({}), dom);
  for (const item of view.items.slice(0, 5)) {
    assert.equal(item.value, '••••');
    assert.equal(item.name, '••••');
    assert.equal(item.sensitive, true);
  }
  assert.equal(view.items[5].value, '手套');
  assert.equal(view.forms.filter((x) => x.masked).length, 5);
  assert.doesNotMatch(JSON.stringify(view), /secret123|654321|4111111111111111|tok-secret/);
});

test('正文把误入的 CSS/JS 代码块当作噪声剔除，保留真实文本', () => {
  const dom = makeDom();
  const css = '#root{-webkit-text-size-adjust:100%;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#1a1a1a;margin:0;padding:0;line-height:1.5;background:#fff}';
  dom.document.body.innerText = '第一行正文\n' + css + '\n第二行正文';
  const view = run(snapshotExpression({}), dom);
  assert.match(view.main, /第一行正文/);
  assert.match(view.main, /第二行正文/);
  assert.doesNotMatch(view.main, /text-size-adjust/);
});

test('递归读取 open shadow DOM 与同源 iframe，并报告跨域 iframe', () => {
  const dom = makeDom();
  const shadowButton = new FakeElement('button', { text: '影子按钮' });
  const shadow = new FakeRoot([shadowButton], '影子正文');
  const host = new FakeElement('div', { attrs: { id: 'host' }, shadowRoot: shadow });

  const childButton = new FakeElement('button', { text: '框内按钮' });
  const childDoc = makeDocument([childButton], '框内正文');
  childDoc.title = '子页面';
  const childWin = makeWindow();
  const sameFrame = new FakeElement('iframe', { attrs: { src: '/same' }, contentDocument: childDoc, contentWindow: childWin });

  const denied = new FakeElement('iframe', { attrs: { src: 'https://other.test/x' } });
  Object.defineProperty(denied, 'contentDocument', { get() { throw new Error('cross origin'); } });
  dom.elements.push(host, sameFrame, denied);

  const view = run(snapshotExpression({}), dom);
  const shadowItem = view.items.find((x) => x.name === '影子按钮');
  const frameItem = view.items.find((x) => x.name === '框内按钮');
  assert.deepEqual(shadowItem.shadow, ['div#host']);
  assert.deepEqual(frameItem.framePath, ['iframe[0]']);
  assert.match(view.main, /影子正文/);
  assert.match(view.main, /框内正文/);
  assert.equal(view.inaccessibleFrames.length, 1);
  assert.deepEqual(view.inaccessibleFrames[0].framePath, ['iframe[1]']);
});

test('delta 返回正文分块 added/removed，并将新增正文放入 main', () => {
  const dom = makeDom();
  const btn = new FakeElement('button', { text: '加载更多' });
  const link = new FakeElement('a', { text: '详情', attrs: { href: '/p/1' } });
  dom.elements.push(btn, link);
  dom.document.body.innerText = '保留段落\n旧段落';
  run(snapshotExpression({}), dom);
  btn.innerText = '已加载';
  dom.elements.splice(1, 1);
  dom.document.body.innerText = '保留段落\n新增段落';
  const delta = run(snapshotExpression({ delta: true }), dom);
  assert.deepEqual(delta.changed, ['e1']);
  assert.deepEqual(delta.removed, ['e2']);
  assert.deepEqual(delta.textDelta.added, ['新增段落']);
  assert.deepEqual(delta.textDelta.removed, ['旧段落']);
  assert.equal(delta.main, '新增段落');
});

test('识别 captcha/login/rateLimited/accessDenied/paywall 风险标志', () => {
  const cases = [
    ['captcha', 'Verify you are human CAPTCHA'],
    ['login', 'Sign in to your account'],
    ['rateLimited', 'Too many requests, retry later'],
    ['accessDenied', 'Access Denied'],
    ['paywall', 'Subscribe to continue'],
  ];
  for (const [flag, text] of cases) {
    const dom = makeDom();
    dom.document.body.innerText = text;
    assert.equal(run(snapshotExpression({}), dom).pageFlags[flag], true, flag);
  }
});

test('正文和控件超限时有界并如实标注', () => {
  const dom = makeDom();
  dom.document.body.innerText = 'x'.repeat(600);
  for (let i = 0; i < 5; i += 1) dom.elements.push(new FakeElement('button', { text: 'B' + i }));
  const view = run(snapshotExpression({ maxChars: 500, maxItems: 3 }), dom);
  assert.equal(view.main.length, 500);
  assert.equal(view.truncated.mainChars, 100);
  assert.equal(view.items.length, 3);
  assert.equal(view.truncated.itemsDropped, 2);
});

test('formatSnapshot 展示风险、framePath、shadow 与正文增量', () => {
  const text = formatSnapshot({
    title: 'T', url: 'https://x.test', main: '新增正文', delta: true,
    changed: ['e1'], removed: ['e2'], pageFlags: { captcha: true, login: false },
    inaccessibleFrames: [{ framePath: ['iframe[1]'], src: 'https://other.test' }],
    textDelta: { added: ['新增正文'], removed: ['旧正文'] },
    items: [{ ref: 'e1', role: 'button', name: '继续', href: '', disabled: false, inViewport: true, framePath: ['iframe[0]'], shadow: ['x-host[0]'] }],
    forms: [], truncated: { mainChars: 0, itemsDropped: 0 },
    scroll: { top: 0, height: 1000, viewport: 800 },
  });
  assert.match(text, /风险标志.*captcha/);
  assert.match(text, /framePath=iframe\[0\]/);
  assert.match(text, /shadow=x-host\[0\]/);
  assert.match(text, /新增正文/);
  assert.match(text, /移除正文/);
  assert.match(text, /不可访问 iframe/);
});
