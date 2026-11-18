/**
 * dsh-amazon-research · host/web/page-actions.js
 *
 * 通用「像人一样操作页面」能力层：点击、滚动、拖滚动条、输入、按键、悬停、
 * 等待元素、读表格 / 读可见文本。
 *
 * 为什么必须有这一层：
 *   - 卖家精灵扩展面板、卖家精灵网页版、Amazon 搜索页、1688 详情页、Trendyol，
 *     数据都不是一次性渲染完的：虚拟滚动只渲染视口行、付费列懒加载、按钮要点「加载更多」、
 *     筛选要选下拉、翻页要点击。只会「开页面 + 读一次 DOM」的采集器，永远只能拿到首屏。
 *   - 这些站点全都有反自动化（验证码 / 频控 / 人机校验），所以本层**只做页面内 DOM 交互**，
 *     不注入伪造 UA、不绕过验证、不模拟指纹；遇到验证码应停下交人工。
 *
 * 实现口径：
 *   - 全部通过 `execute javascript`（chrome.js 的 runJs / runJson）在页面上下文执行；
 *   - 点击派发**完整事件序列**（pointerdown → mousedown → pointerup → mouseup → click），
 *     只调 el.click() 对 React / Vue 组件常常无效（它们监听 pointerdown 或 mousedown）；
 *   - 输入走**原生 value setter + input/change 事件**，否则 React 受控组件读不到值；
 *   - 滚动优先真实 `scrollTop` 赋值 + `scroll` 事件（虚拟列表公认做法）；
 *     需要拖滚动条时再走 `dragScroll`，它会先试指针拖拽，失败自动退回分步滚动并如实标注。
 */

import { runJs, runJson, waitFor } from './chrome.js';

/** 把任意值安全塞进页面 JS 字面量。 */
function lit(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function numLit(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : String(fallback);
}

/** 找元素的最小公共前置代码（ref / 选择器 / 文本 / XPath 四选一）。 */
function resolveExpr({ selector, text, xpath, ref, index = 0, contains = true }) {
  const idx = numLit(index, 0);
  if (ref) {
    const safe = String(ref).replace(/[^A-Za-z0-9:_-]/g, '');
    return 'var __reg = window.__dshRefRegistry; var el = __reg && typeof __reg.resolve === "function" ? __reg.resolve(' + lit(safe) + ') : null;';
  }
  if (selector) {
    return 'var __els = document.querySelectorAll(' + lit(selector) + '); var el = __els[' + idx + '] || null;';
  }
  if (xpath) {
    return 'var __x = document.evaluate(' + lit(xpath) + ', document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);' +
      ' var __els = []; for (var __i = 0; __i < __x.snapshotLength; __i++) __els.push(__x.snapshotItem(__i));' +
      ' var el = __els[' + idx + '] || null;';
  }
  const target = String(text ?? '');
  const cond = contains
    ? 't.indexOf(' + lit(target) + ') >= 0'
    : 't === ' + lit(target);
  return 'var __all = document.querySelectorAll("a,button,span,div,li,td,th,label,input,select,option");' +
    ' var __els = [].slice.call(__all).filter(function(e){' +
    ' if (e.children.length > 0 && e.tagName !== "SELECT") return false;' +
    ' var t = (e.innerText || e.textContent || e.value || "").trim().replace(/\\s+/g, " ");' +
    ' return ' + cond + '; });' +
    ' var el = __els[' + idx + '] || null;';
}

/**
 * 页面内：派发完整鼠标事件序列点击元素（对 React / Vue 组件同样有效）。
 * @returns {string} JSON
 */
export function clickSnippet(target) {
  return [
    '(function(){',
    '  ' + resolveExpr(target),
    '  if (!el) return JSON.stringify({ok:false, reason:"NOEL"});',
    '  var __hit = el;',
    '  var __cl = el.closest ? el.closest("a,button,[role=\\"button\\"],label,input[type=\\"submit\\"],input[type=\\"checkbox\\"]") : null;',
    '  if (__cl) el = __cl;',
    '  try { el.scrollIntoView({block:"center", inline:"center"}); } catch(e) {}',
    '  var r = el.getBoundingClientRect();',
    '  var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);',
    '  var base = {bubbles:true, cancelable:true, composed:true, view:window, clientX:x, clientY:y, button:0, buttons:1};',
    '  var P = window.PointerEvent || null;',
    '  if (P) el.dispatchEvent(new P("pointerdown", base));',
    '  el.dispatchEvent(new MouseEvent("mousedown", base));',
    '  if (P) el.dispatchEvent(new P("pointerup", Object.assign({}, base, {buttons:0})));',
    '  el.dispatchEvent(new MouseEvent("mouseup", Object.assign({}, base, {buttons:0})));',
    '  try {',
    '    if (typeof el.click === "function") el.click();',
    '    else el.dispatchEvent(new MouseEvent("click", Object.assign({}, base, {buttons:0})));',
    '  } catch(e) { return JSON.stringify({ok:false, reason:"CLICK_FAILED", message:String(e && e.message || e)}); }',
    '  return JSON.stringify({ok:true, tag:el.tagName, text:(el.innerText||"").trim().slice(0,40), x:x, y:y});',
    '})()'
  ].join('\n');
}

/** 页面内：把元素滚到视口中央并返回其中心坐标（CDP 真实点击用）。 */
export function pointSnippet(target) {
  return [
    '(function(){',
    '  ' + resolveExpr(target),
    '  if (!el) return JSON.stringify({ok:false, reason:"NOEL"});',
    '  var __cl = el.closest ? el.closest("a,button,[role=\\"button\\"],label,input[type=\\"submit\\"],input[type=\\"checkbox\\"]") : null;',
    '  if (__cl) el = __cl;',
    '  try { el.scrollIntoView({block:"center", inline:"center"}); } catch(e) {}',
    '  var r = el.getBoundingClientRect();',
    '  return JSON.stringify({ok:true, x:r.left + r.width / 2, y:r.top + r.height / 2, width:r.width, height:r.height});',
    '})()'
  ].join('\n');
}

/** 页面内：聚焦输入框并清空（CDP 真实键入前用）。 */
export function focusSnippet(target, { clear = true } = {}) {
  return [
    '(function(){',
    '  ' + resolveExpr(target),
    '  if (!el) return JSON.stringify({ok:false, reason:"NOEL"});',
    '  if (typeof el.focus === "function") el.focus();',
    '  if (' + (clear ? 'true' : 'false') + ' && typeof el.select === "function") { try { el.select(); } catch(e) {} }',
    '  return JSON.stringify({ok:true, tag:el.tagName});',
    '})()'
  ].join('\n');
}

/** 页面内：悬停（触发下拉菜单 / tooltip）。 */
export function hoverSnippet(target) {
  return [
    '(function(){',
    '  ' + resolveExpr(target),
    '  if (!el) return JSON.stringify({ok:false, reason:"NOEL"});',
    '  var r = el.getBoundingClientRect();',
    '  var o = {bubbles:true, cancelable:true, view:window, clientX:Math.round(r.left+r.width/2), clientY:Math.round(r.top+r.height/2)};',
    '  el.dispatchEvent(new MouseEvent("mouseover", o));',
    '  el.dispatchEvent(new MouseEvent("mouseenter", o));',
    '  el.dispatchEvent(new MouseEvent("mousemove", o));',
    '  return JSON.stringify({ok:true, tag:el.tagName});',
    '})()'
  ].join('\n');
}

/** 页面内：向输入框写值（React 受控组件可识别），可选回车提交。 */
export function typeSnippet(target, text, { enter = false, clear = true } = {}) {
  return [
    '(function(){',
    '  ' + resolveExpr(target),
    '  if (!el) return JSON.stringify({ok:false, reason:"NOEL"});',
    '  el.focus();',
    '  var proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;',
    '  var desc = Object.getOwnPropertyDescriptor(proto, "value");',
    '  var nextValue = ' + (clear ? lit(text) : '(String(el.value || "") + ' + lit(text) + ')') + ';',
    '  if (desc && desc.set) desc.set.call(el, nextValue); else el.value = nextValue;',
    '  el.dispatchEvent(new Event("input", {bubbles:true}));',
    '  el.dispatchEvent(new Event("change", {bubbles:true}));',
    ...(enter ? [
    '  ["keydown","keypress","keyup"].forEach(function(name){',
    '    el.dispatchEvent(new KeyboardEvent(name, {key:"Enter", code:"Enter", keyCode:13, which:13, bubbles:true, cancelable:true}));',
    '  });',
    '  var form = el.closest("form");',
    '  if (form && typeof form.requestSubmit === "function") { try { form.requestSubmit(); } catch(e) {} }',
    '  var scope = form || el.parentElement || document;',
    '  var btn = scope ? scope.querySelector("button,[type=\\"submit\\"]") : null;',
    '  if (btn && typeof btn.click === "function") { try { btn.click(); } catch(e) {} }',
    ] : []),
    '  return JSON.stringify({ok:true, value:String(el.value).slice(0,60)});',
    '})()'
  ].join('\n');
}

/** 页面内：按键（Enter / Escape / ArrowDown …）。 */
export function keySnippet(key, target = {}) {
  return [
    '(function(){',
    '  ' + (target && (target.selector || target.text || target.xpath || target.ref) ? resolveExpr(target) : 'var el = document.activeElement || document.body;'),
    '  if (!el) el = document.body;',
    '  var code = ' + lit(key) + ';',
    '  ["keydown","keypress","keyup"].forEach(function(name){',
    '    el.dispatchEvent(new KeyboardEvent(name, {key:code, code:code, bubbles:true, cancelable:true}));',
    '  });',
    '  return JSON.stringify({ok:true, key:code, tag:el.tagName});',
    '})()'
  ].join('\n');
}

/** 页面内：设定某元素的滚动位置（容器或窗口）。 */
export function scrollSnippet({ selector = null, top = null, left = null, deltaY = null } = {}) {
  return [
    '(function(){',
    selector
      ? '  var el = document.querySelector(' + lit(selector) + '); if (!el) return JSON.stringify({ok:false, reason:"NOEL"});'
      : '  var el = document.querySelector("[data-dsh-scroll-root]") || null;',
    '  var tgt = el;',
    '  if (!tgt) { var d = document.scrollingElement || document.documentElement; tgt = d; }',
    '  var before = tgt.scrollTop;',
    '  if (' + (deltaY === null || deltaY === undefined ? 'false' : 'true') + ') tgt.scrollTop = before + (' + numLit(deltaY ?? 0, 0) + ');',
    '  if (' + (top === null || top === undefined ? 'false' : 'true') + ') tgt.scrollTop = ' + numLit(top ?? 0, 0) + ';',
    '  if (' + (left === null || left === undefined ? 'false' : 'true') + ') tgt.scrollLeft = ' + numLit(left ?? 0, 0) + ';',
    '  tgt.dispatchEvent(new Event("scroll", {bubbles:true}));',
    '  return JSON.stringify({ok:true, before:before, after:tgt.scrollTop, height:tgt.scrollHeight, client:tgt.clientHeight});',
    '})()'
  ].join('\n');
}

/**
 * 页面内：拖滚动条。
 * 先派发指针拖拽序列（页面自定义滚动条 / canvas 表格需要），
 * 再比对 scrollTop；若没动，则分步设定 scrollTop 并派发 scroll 事件（虚拟列表的标准做法）。
 */
export function dragScrollSnippet({ selector = null, toBottom = true, deltaY = 600 } = {}) {
  return [
    '(function(){',
    selector
      ? '  var el = document.querySelector(' + lit(selector) + '); if (!el) return JSON.stringify({ok:false, reason:"NOEL"});'
      : '  var el = document.scrollingElement || document.documentElement;',
    '  var host = el;',
    '  var before = host.scrollTop;',
    '  var maxTop = Math.max(0, host.scrollHeight - host.clientHeight);',
    '  var want = ' + (toBottom ? 'maxTop' : 'Math.min(maxTop, before + ' + numLit(deltaY, 600) + ')') + ';',
    '  var r = host.getBoundingClientRect();',
    '  var sx = Math.round(r.right - 6), sy0 = Math.round(r.top + 24), sy1 = Math.round(r.top + Math.max(40, r.height * 0.8));',
    '  var mk = function(type, y, buttons){ return new MouseEvent(type, {bubbles:true, cancelable:true, view:window, clientX:sx, clientY:y, button:0, buttons:buttons}); };',
    '  try {',
    '    host.dispatchEvent(mk("mousedown", sy0, 1));',
    '    host.dispatchEvent(mk("mousemove", sy1, 1));',
    '    host.dispatchEvent(mk("mouseup", sy1, 0));',
    '  } catch(e) {}',
    '  var viaDrag = host.scrollTop;',
    '  var method = "drag";',
    '  if (Math.abs(viaDrag - before) < 2) {',
    '    method = "stepped";',
    '    var steps = 24; var from = before;',
    '    for (var i = 1; i <= steps; i++) { host.scrollTop = from + (want - from) * i / steps; host.dispatchEvent(new Event("scroll", {bubbles:true})); }',
    '  }',
    '  return JSON.stringify({ok:true, method:method, before:before, after:host.scrollTop, maxTop:maxTop, moved:Math.round(host.scrollTop - before)});',
    '})()'
  ].join('\n');
}

/** 页面内：读可见文本 / 表格。 */
export function readSnippet({ selector = null, limit = 500, rows = false } = {}) {
  return [
    '(function(){',
    selector
      ? '  var el = document.querySelector(' + lit(selector) + '); if (!el) return JSON.stringify({ok:false, reason:"NOEL"});'
      : '  var el = document.body;',
    rows
      ? '  var out = [].slice.call(el.querySelectorAll("tr")).slice(0, ' + numLit(limit, 500) + ').map(function(tr){ return [].slice.call(tr.cells).map(function(td){ return (td.innerText||"").trim().replace(/\\s+/g," "); }); });'
      : '  var out = (el.innerText || "").trim().split("\\n").map(function(s){ return s.trim(); }).filter(Boolean).slice(0, ' + numLit(limit, 500) + ');',
    '  return JSON.stringify({ok:true, count:out.length, data:out});',
    '})()'
  ].join('\n');
}

/** 页面内：页面概况（URL / 标题 / 高度 / 可见元素数），用于确认「真的到位了」。 */
export const PAGE_STATE = [
  '(function(){',
  '  var d = document.scrollingElement || document.documentElement;',
  '  return JSON.stringify({',
  '    url: location.href,',
  '    title: document.title,',
  '    readyState: document.readyState,',
  '    scrollTop: d.scrollTop,',
  '    scrollHeight: d.scrollHeight,',
  '    clientHeight: d.clientHeight,',
  '    links: document.querySelectorAll("a").length,',
  '    buttons: document.querySelectorAll("button").length,',
  '    tables: document.querySelectorAll("table").length,',
  '    rows: document.querySelectorAll("tr").length',
  '  });',
  '})()'
].join('\n');

// ───────────────────────── 高层动作（Node 侧） ─────────────────────────

function noEl(result, action) {
  const error = new Error(action + '：页面上没找到目标元素（选择器/文本不匹配，或页面还没加载完）');
  error.code = 'NOEL';
  error.detail = result;
  return error;
}

/** 点击：按选择器 / 文本 / XPath。 */
export async function click(tabId, target) {
  const r = await runJson(tabId, clickSnippet(target), { timeout: 30000 });
  if (!r || r.ok !== true) throw noEl(r, '点击');
  return r;
}

/** 悬停：用于展开下拉菜单 / tooltip。 */
export async function hover(tabId, target) {
  const r = await runJson(tabId, hoverSnippet(target), { timeout: 30000 });
  if (!r || r.ok !== true) throw noEl(r, '悬停');
  return r;
}

/** 输入文本（可选回车）。 */
export async function type(tabId, target, text, options = {}) {
  const r = await runJson(tabId, typeSnippet(target, text, options), { timeout: 30000 });
  if (!r || r.ok !== true) throw noEl(r, '输入');
  return r;
}

/** 按键。 */
export async function press(tabId, key, target = null) {
  return runJson(tabId, keySnippet(key, target || {}), { timeout: 30000 });
}

/** 滚动（元素或整页）。 */
export async function scroll(tabId, options = {}) {
  return runJson(tabId, scrollSnippet(options), { timeout: 30000 });
}

/** 拖滚动条（失败自动分步滚动，并在返回值里说明用的哪种）。 */
export async function dragScroll(tabId, options = {}) {
  return runJson(tabId, dragScrollSnippet(options), { timeout: 60000 });
}

/** 读可见文本（或表格行）。 */
export async function read(tabId, options = {}) {
  return runJson(tabId, readSnippet(options), { timeout: 60000 });
}

/** 读页面概况。 */
export async function pageState(tabId) {
  return runJson(tabId, PAGE_STATE, { timeout: 30000 });
}

/** 等某个选择器出现；返回 true/false。 */
export async function waitForSelector(tabId, selector, { timeout = 30 } = {}) {
  const probe = 'String(document.querySelector(' + lit(selector) + ') !== null)';
  return waitFor(tabId, probe, { timeout });
}

/**
 * 反复滚动直到内容不再增长（无限列表 / 虚拟滚动全量读取）。
 *
 * @returns {{steps:number, from:number, to:number, height:number, stable:boolean, trace:Array}}
 */
export async function scrollUntilStable(tabId, {
  selector = null,
  step = 600,
  maxSteps = 60,
  settleMs = 320,
  onStep = null,
  scrollFn = scroll,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const trace = [];
  let lastHeight = -1;
  let stableRounds = 0;
  let steps = 0;
  const first = await scrollFn(tabId, { selector, top: 0 });
  const from = first.before ?? 0;
  while (steps < maxSteps) {
    const r = await scrollFn(tabId, { selector, deltaY: step });
    steps += 1;
    trace.push({ step: steps, top: r.after, height: r.height });
    if (onStep) {
      try {
        onStep({ step: steps, top: r.after, height: r.height });
      } catch {
        /* 回调异常不影响采集 */
      }
    }
    if (r.after + r.client >= r.height - 2) {
      // 已经到底：再等一屏，若高度不变则确认到底
      await sleepFn(settleMs);
      const again = await scrollFn(tabId, { selector, deltaY: 0 });
      if (again.height === lastHeight) {
        stableRounds += 1;
        if (stableRounds >= 2) return { steps, from, to: again.after, height: again.height, stable: true, trace };
      } else {
        stableRounds = 0;
        lastHeight = again.height;
      }
      continue;
    }
    lastHeight = r.height;
    await sleepFn(settleMs);
  }
  const end = await scrollFn(tabId, { selector, deltaY: 0 });
  return { steps, from, to: end.after, height: end.height, stable: false, trace };
}
