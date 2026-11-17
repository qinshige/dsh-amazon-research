import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PAGE_STATE,
  clickSnippet,
  dragScrollSnippet,
  hoverSnippet,
  keySnippet,
  readSnippet,
  scrollSnippet,
  scrollUntilStable,
  typeSnippet,
} from '../host/web/page-actions.js';

/** 每个 snippet 必须能被页面当函数执行（这里只做语法校验）。 */
function assertValidJs(code, label) {
  assert.doesNotThrow(() => new Function(code), label + ' 生成的 JS 语法必须合法');
}

test('页面操作：所有 snippet 生成的 JS 都能通过语法解析', () => {
  const cases = [
    ['click 选择器', clickSnippet({ selector: '#main' })],
    ['click 文本', clickSnippet({ text: '加载更多' })],
    ['click 文本(精确)+index', clickSnippet({ text: '下一页', contains: false, index: 2 })],
    ['click XPath', clickSnippet({ xpath: '//button[@id="x"]' })],
    ['hover', hoverSnippet({ selector: '#menu' })],
    ['type', typeSnippet({ selector: '#kw' }, 'glove clips', { enter: true })],
    ['key', keySnippet('Enter', { selector: '#kw' })],
    ['scroll 元素', scrollSnippet({ selector: '#list', top: 900 })],
    ['scroll 整页', scrollSnippet({ deltaY: 600 })],
    ['drag', dragScrollSnippet({ selector: '#list', toBottom: true })],
    ['read 文本', readSnippet({ selector: '#panel', limit: 20 })],
    ['read 表格', readSnippet({ selector: 'table', rows: true })],
    ['page state', PAGE_STATE],
  ];
  for (const [label, code] of cases) assertValidJs(code, label);
});

test('点击必须派发完整鼠标事件序列（只调 click() 对 React 组件无效）', () => {
  const code = clickSnippet({ selector: '.btn' });
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    assert.ok(code.includes(type), '缺少 ' + type + ' 事件');
  }
  assert.ok(code.includes('scrollIntoView'), '点击前要先滚到可视区');
  assert.ok(code.includes('"NOEL"'), '找不到元素必须返回 NOEL 而不是静默成功');
});

test('按文本找元素：包含/精确、index、只取叶子节点', () => {
  const contains = clickSnippet({ text: '加载更多' });
  assert.ok(contains.includes('加载更多'));
  assert.ok(contains.includes('indexOf'));
  const exact = clickSnippet({ text: '下一页', contains: false, index: 3 });
  assert.ok(exact.includes('=== ') && exact.includes('[3]'));
  assert.ok(contains.includes('e.children.length > 0'), '带子元素的容器要跳过，避免点到大 div');
});

test('输入走原生 value setter + input/change（React 受控组件才认）', () => {
  const code = typeSnippet({ selector: '#asin' }, 'B0TEST123,456', { enter: true });
  assert.ok(code.includes('getOwnPropertyDescriptor'));
  assert.ok(code.includes('"input"') && code.includes('"change"'));
  assert.ok(code.includes('KeyboardEvent') && code.includes('Enter'));
  const noEnter = typeSnippet({ selector: '#asin' }, 'x');
  assert.ok(!noEnter.includes('KeyboardEvent'), '不要求回车时不应派发按键');
});

test('滚动 snippet：能滚元素也能滚整页，并回报前后位置', () => {
  const el = scrollSnippet({ selector: '#grid', top: 1200 });
  assert.ok(el.includes('#grid') && el.includes('scrollTop') && el.includes('"scroll"'));
  const page = scrollSnippet({ deltaY: 400 });
  assert.ok(page.includes('scrollingElement'));
  assert.ok(page.includes('before') && page.includes('after'));
});

test('拖滚动条：先试指针拖拽，没动就退回分步滚动并标注 method', () => {
  const code = dragScrollSnippet({ selector: '#grid', toBottom: true });
  for (const type of ['mousedown', 'mousemove', 'mouseup']) assert.ok(code.includes(type));
  assert.ok(code.includes('"stepped"'), '必须有分步滚动兜底');
  assert.ok(code.includes('method'), '必须回报用的是拖拽还是分步');
  assert.ok(code.includes('maxTop'));
});

test('读取 snippet：文本模式与表格行模式', () => {
  const text = readSnippet({ selector: '#p', limit: 30 });
  assert.ok(text.includes('innerText') && text.includes('30'));
  const rows = readSnippet({ selector: '#p', rows: true });
  assert.ok(rows.includes('querySelectorAll("tr")') && rows.includes('.cells'));
});

test('scrollUntilStable：滚到底且高度不再增长时返回 stable', async () => {
  let top = 0;
  const height = 1000;
  const client = 400;
  const scrollFn = async (_tabId, options) => {
    if (options.top === 0) top = 0;
    else if (typeof options.deltaY === 'number') top = Math.min(height - client, top + options.deltaY);
    return { before: top, after: top, height, client };
  };
  const out = await scrollUntilStable('tab', { step: 300, settleMs: 0, scrollFn, sleepFn: async () => {} });
  assert.equal(out.stable, true);
  assert.equal(out.to, height - client);
  assert.ok(out.steps > 0 && out.trace.length === out.steps);
});

test('scrollUntilStable：始终到不了底时返回 stable=false（不谎报成功）', async () => {
  const scrollFn = async () => ({ before: 0, after: 0, height: 5000, client: 400 });
  const out = await scrollUntilStable('tab', { step: 300, maxSteps: 5, settleMs: 0, scrollFn, sleepFn: async () => {} });
  assert.equal(out.stable, false);
  assert.equal(out.steps, 5);
});
