/**
 * 有界、脱敏的 DOM 文本快照。
 *
 * ref 只保存在 window.__dshRefRegistry 中，不修改页面 DOM。快照递归读取
 * open shadow root 与同源 iframe；跨域 frame 只报告其位置，不尝试绕过限制。
 */

const INTERACTIVE_SELECTOR = [
  'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
  '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
  '[role="tab"]', '[role="menuitem"]', '[role="switch"]', '[contenteditable="true"]', '[onclick]',
].join(',');

const FIELD_SELECTOR = 'input:not([type="hidden"]),select,textarea';

/**
 * @param {{delta?:boolean,maxChars?:number,maxItems?:number}} [options]
 * @returns {string}
 */
export function snapshotExpression({ delta = false, maxChars = 6000, maxItems = 120 } = {}) {
  const config = {
    delta: delta === true,
    maxChars: Number.isFinite(Number(maxChars)) ? Math.max(500, Math.min(200_000, Number(maxChars))) : 6000,
    maxItems: Number.isFinite(Number(maxItems)) ? Math.max(1, Math.min(1000, Number(maxItems))) : 120,
  };
  return `(function(){
  var CFG = ${JSON.stringify(config)};
  var doc = document;
  var win = window;
  var prev = win.__dshLastSnapshot || null;

  function normText(value){ return String(value == null ? '' : value).replace(/\\s+/g, ' ').trim(); }
  function attr(el, name){ try { return el && el.getAttribute ? el.getAttribute(name) : null; } catch (e) { return null; } }
  function bounded(value, max){ return String(value == null ? '' : value).slice(0, max); }

  /* Registry is deliberately outside the DOM so refs never leak into markup. */
  var registry = win.__dshRefRegistry;
  if (!registry || !registry.elementToRef || !registry.refToElement) {
    registry = { elementToRef: new WeakMap(), refToElement: new Map(), seq: Number(win.__dshRefSeq || 0) || 0 };
    registry.resolve = function(ref) {
      var held = this.refToElement.get(String(ref));
      if (!held) return null;
      try { return typeof held.deref === 'function' ? (held.deref() || null) : held; } catch (e) { return null; }
    };
    win.__dshRefRegistry = registry;
  }
  if (typeof registry.resolve !== 'function') {
    registry.resolve = function(ref) { var held = this.refToElement.get(String(ref)); return held && typeof held.deref === 'function' ? (held.deref() || null) : (held || null); };
  }
  function refFor(el){
    var existing = registry.elementToRef.get(el);
    if (existing) return existing;
    registry.seq = (Number(registry.seq) || 0) + 1;
    var next = 'e' + registry.seq;
    registry.elementToRef.set(el, next);
    try { registry.refToElement.set(next, typeof WeakRef === 'function' ? new WeakRef(el) : el); } catch (e) { registry.refToElement.set(next, el); }
    return next;
  }

  function visible(el, contextWin){
    try {
      var cs = contextWin && contextWin.getComputedStyle ? contextWin.getComputedStyle(el) : (win.getComputedStyle ? win.getComputedStyle(el) : null);
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
    } catch (e) {}
    try { var rect = el.getBoundingClientRect(); return !!rect && rect.width > 0 && rect.height > 0; } catch (e) { return false; }
  }
  function roleOf(el){
    var role = attr(el, 'role');
    if (role) return role;
    var tag = String(el.tagName || '').toUpperCase();
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'textarea';
    if (tag === 'SUMMARY') return 'summary';
    if (tag === 'INPUT') {
      var type = String(el.type || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button') return 'button';
      return 'input';
    }
    if (el.isContentEditable === true) return 'contenteditable';
    return tag.toLowerCase();
  }
  function sensitiveHaystack(el){
    return [el && el.type, attr(el, 'name'), attr(el, 'id'), attr(el, 'autocomplete'), attr(el, 'placeholder'),
      attr(el, 'aria-label'), attr(el, 'title'), attr(el, 'data-testid')].join(' ').toLowerCase();
  }
  function isSensitive(el){
    var hay = sensitiveHaystack(el);
    return String(el && el.type || '').toLowerCase() === 'password' ||
      /(password|passwd|passcode|pwd|secret|otp|totp|one[-_ ]?time[-_ ]?code|pin|cvv|cvc|card|credit[-_ ]?card|token|auth[-_ ]?code)/i.test(hay) ||
      /cc-(number|csc|exp|exp-month|exp-year)/i.test(hay);
  }
  function accessibleName(el, sensitive){
    if (sensitive) return '••••';
    var candidates = [attr(el, 'aria-label'), attr(el, 'title'), attr(el, 'alt'), attr(el, 'placeholder')];
    for (var i = 0; i < candidates.length; i++) if (candidates[i]) return bounded(normText(candidates[i]), 120);
    var text = normText(el.innerText || el.textContent || '');
    if (text) return bounded(text, 120);
    if (String(el.tagName || '').toUpperCase() === 'INPUT' && el.value) return bounded(el.value, 120);
    return '';
  }
  function fingerprint(item){ return JSON.stringify([item.role,item.name,item.value,item.checked,item.disabled,item.href,item.framePath,item.shadow]); }
  function frameLabel(frame, index){ return 'iframe[' + index + ']'; }
  function shadowLabel(host, index){
    var id = attr(host, 'id');
    return String(host.tagName || 'host').toLowerCase() + (id ? '#' + bounded(id, 50) : '[' + index + ']');
  }
  function splitBlocks(value){
    var raw = String(value == null ? '' : value).split(/(?:\\r?\\n){1,}|(?<=[.!?。！？])\\s+/);
    var out = [];
    for (var i = 0; i < raw.length; i++) { var text = normText(raw[i]); if (text) out.push(bounded(text, 1000)); }
    return out;
  }

  /* 有些页面把 CSS/JS 当纯文本塞进正文；这类块不是页面内容，直接丢弃。
     判据：密集的分号 + 多条「属性: 值;」声明，而不是看字符比例（字体名全是字母）。 */
  function looksLikeCode(text){
    var t = String(text || '').trim();
    if (t.length < 40) return false;
    var semicolons = (t.match(/;/g) || []).length;
    if (semicolons < 5) return false;
    var declarations = t.match(/[;{]\\s*[-a-zA-Z][-a-zA-Z0-9]*\\s*:\\s*[^;{}]{1,200}[;}]/g) || [];
    if (declarations.length >= 4) return true;
    return /\{/.test(t) && declarations.length >= 2;
  }

  var allItems = [];
  var allForms = [];
  var seen = {};
  var textBlocks = [];
  var inaccessibleFrames = [];
  var traversedRoots = [];

  /* 兜底取可见文本：跳过脚本/样式等不可见节点，避免把 CSS 当正文。
     只在 innerText 不可用或为空时使用，且不改动页面 DOM。 */
  function visibleTextFallback(root, contextWin){
    var out = [];
    var total = 0;
    var skip = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CANVAS: 1, HEAD: 1, TITLE: 1 };
    function hidden(el, parentStyle){
      try {
        var cs = parentStyle || (contextWin && contextWin.getComputedStyle ? contextWin.getComputedStyle(el) : (win.getComputedStyle ? win.getComputedStyle(el) : null));
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0')) return true;
      } catch (e) {}
      return false;
    }
    function visit(node, depth){
      if (!node || total >= 200000 || depth > 60) return;
      if (node.nodeType === 3) {
        var text = String(node.nodeValue || '');
        if (text.trim()) { out.push(text); total += text.length; }
        return;
      }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      var tag = String(node.tagName || '').toUpperCase();
      if (skip[tag]) return;
      if (node.nodeType === 1 && hidden(node)) return;
      var kids = node.childNodes || [];
      for (var i = 0; i < kids.length; i++) visit(kids[i], depth + 1);
    }
    try { visit(root, 0); } catch (e) {}
    return out.join('\\n');
  }

  function addRootText(root, contextWin){
    var value = '';
    try {
      var node = root && root.body ? root.body : root;
      var direct = node && node.innerText ? node.innerText : '';
      value = direct && direct.trim() ? direct : visibleTextFallback(node, contextWin);
    } catch (e) { value = ''; }
    var blocks = splitBlocks(value);
    for (var i = 0; i < blocks.length && textBlocks.length < 1000; i++) {
      if (looksLikeCode(blocks[i])) continue;
      textBlocks.push(blocks[i]);
    }
  }

  function walkRoot(root, framePath, shadowPath, contextWin){
    if (!root || traversedRoots.indexOf(root) >= 0) return;
    traversedRoots.push(root);
    addRootText(root, contextWin);
    var controls = [];
    try { controls = root.querySelectorAll(${JSON.stringify(INTERACTIVE_SELECTOR)}) || []; } catch (e) { controls = []; }
    for (var i = 0; i < controls.length; i++) {
      var el = controls[i];
      if (!el || !visible(el, contextWin)) continue;
      var ref = refFor(el);
      if (seen[ref]) continue;
      seen[ref] = true;
      var role = roleOf(el);
      var sensitive = isSensitive(el);
      var item = {
        ref: ref, role: role, name: accessibleName(el, sensitive),
        href: role === 'link' ? bounded(attr(el, 'href') || '', 300) : '',
        disabled: el.disabled === true || attr(el, 'aria-disabled') === 'true',
        checked: typeof el.checked === 'boolean' ? el.checked : null,
        inViewport: (function(){ try { var r = el.getBoundingClientRect(); return r.top < ((contextWin && contextWin.innerHeight) || win.innerHeight || 0) && r.bottom > 0; } catch (e) { return false; } })(),
        value: '', sensitive: sensitive, framePath: framePath.slice(), shadow: shadowPath.slice()
      };
      if (/^(input|textarea|select|contenteditable)$/.test(role)) {
        item.value = sensitive ? '••••' : bounded(el.value == null ? '' : el.value, 80);
        allForms.push({ ref: ref, role: role, name: item.name, value: item.value, masked: sensitive, required: el.required === true, framePath: item.framePath, shadow: item.shadow });
      }
      allItems.push(item);
    }

    var nodes = [];
    try { nodes = root.querySelectorAll('*') || []; } catch (e) { nodes = []; }
    var frameIndex = 0;
    var shadowIndex = 0;
    for (var n = 0; n < nodes.length; n++) {
      var node = nodes[n];
      try {
        if (node && node.shadowRoot && String(node.shadowRoot.mode || 'open') === 'open') {
          walkRoot(node.shadowRoot, framePath, shadowPath.concat([shadowLabel(node, shadowIndex++)]), contextWin);
        }
      } catch (e) {}
      if (String(node && node.tagName || '').toUpperCase() === 'IFRAME') {
        var childPath = framePath.concat([frameLabel(node, frameIndex++)]);
        try {
          var childDoc = node.contentDocument;
          var childWin = node.contentWindow;
          if (!childDoc || !childDoc.documentElement) throw new Error('unavailable');
          /* Accessing location/document can throw for cross-origin frames. */
          void childDoc.title;
          walkRoot(childDoc, childPath, shadowPath, childWin || contextWin);
        } catch (e) {
          inaccessibleFrames.push({ framePath: childPath, src: bounded(attr(node, 'src') || '', 300), reason: 'cross-origin-or-unavailable' });
        }
      }
    }
  }
  walkRoot(doc, [], [], win);

  var selected = allItems.filter(function(x){ return x.inViewport; }).concat(allItems.filter(function(x){ return !x.inViewport; }));
  var dropped = Math.max(0, selected.length - CFG.maxItems);
  var items = selected.slice(0, CFG.maxItems);
  var kept = {};
  for (var k = 0; k < items.length; k++) kept[items[k].ref] = true;
  var forms = allForms.filter(function(field){ return kept[field.ref]; });

  var fullMain = textBlocks.join('\\n');
  var mainCut = Math.max(0, fullMain.length - CFG.maxChars);
  var main = bounded(fullMain, CFG.maxChars);
  var currentBlocks = splitBlocks(main);
  var oldBlocks = prev && Array.isArray(prev.textBlocks) ? prev.textBlocks : [];
  var oldCount = {}, newCount = {}, added = [], removedText = [];
  for (var ob = 0; ob < oldBlocks.length; ob++) oldCount[oldBlocks[ob]] = (oldCount[oldBlocks[ob]] || 0) + 1;
  for (var nb = 0; nb < currentBlocks.length; nb++) newCount[currentBlocks[nb]] = (newCount[currentBlocks[nb]] || 0) + 1;
  var usedOld = {};
  for (var ai = 0; ai < currentBlocks.length; ai++) { var av = currentBlocks[ai]; usedOld[av] = (usedOld[av] || 0) + 1; if (usedOld[av] > (oldCount[av] || 0)) added.push(av); }
  var usedNew = {};
  for (var ri = 0; ri < oldBlocks.length; ri++) { var rv = oldBlocks[ri]; usedNew[rv] = (usedNew[rv] || 0) + 1; if (usedNew[rv] > (newCount[rv] || 0)) removedText.push(rv); }
  function boundDelta(list){ var out=[], used=0; for(var i=0;i<list.length;i++){ var left=CFG.maxChars-used; if(left<=0) break; var value=bounded(list[i],left); out.push(value); used+=value.length; } return out; }
  added = boundDelta(added); removedText = boundDelta(removedText);

  var changed = [], removed = [];
  if (prev && prev.items) {
    for (var r = 0; r < items.length; r++) { var current = items[r]; if (!prev.items[current.ref] || prev.items[current.ref] !== fingerprint(current)) changed.push(current.ref); }
    for (var oldRef in prev.items) if (Object.prototype.hasOwnProperty.call(prev.items, oldRef) && !seen[oldRef]) removed.push(oldRef);
  }
  var currentMap = {};
  for (var m = 0; m < items.length; m++) currentMap[items[m].ref] = fingerprint(items[m]);
  win.__dshLastSnapshot = { items: currentMap, textBlocks: currentBlocks, at: Date.now() };
  win.__dshRefSeq = registry.seq;

  if (CFG.delta) {
    var changedSet = {}; for (var c = 0; c < changed.length; c++) changedSet[changed[c]] = true;
    items = items.filter(function(item){ return changedSet[item.ref]; });
    forms = forms.filter(function(field){ return changedSet[field.ref]; });
    main = bounded(added.join('\\n'), CFG.maxChars);
  }

  var flagText = (String(location.href || '') + ' ' + String(doc.title || '') + ' ' + fullMain).toLowerCase().slice(0, 100000);
  var pageFlags = {
    captcha: /captcha|recaptcha|hcaptcha|verify you are human|security check|验证码|人机验证/.test(flagText),
    login: /sign[ -]?in|log[ -]?in|登录|登陆|账号登录/.test(flagText),
    rateLimited: /too many requests|rate limit|retry later|请求过于频繁|访问频繁|限流/.test(flagText),
    accessDenied: /access denied|forbidden|not authorized|permission denied|拒绝访问|无权访问/.test(flagText),
    paywall: /subscribe to continue|subscription required|premium only|付费墙|订阅后|开通会员|购买后查看/.test(flagText)
  };

  return JSON.stringify({
    url: bounded(location.href || '', 2000), title: bounded(doc.title || '', 500), ready: bounded(doc.readyState || '', 50),
    delta: CFG.delta, main: main, textDelta: { added: added, removed: removedText },
    items: items, forms: forms, changed: changed, removed: removed,
    pageFlags: pageFlags, inaccessibleFrames: inaccessibleFrames.slice(0, 100),
    truncated: { mainChars: mainCut, itemsDropped: dropped, inaccessibleFramesDropped: Math.max(0, inaccessibleFrames.length - 100) },
    scroll: (function(){ try { return { top: Math.round(win.scrollY || 0), height: Math.round((doc.documentElement && doc.documentElement.scrollHeight) || 0), viewport: Math.round(win.innerHeight || 0) }; } catch (e) { return null; } })()
  });
})()`;
}

/** Render a compact, bounded snapshot for the model. */
export function formatSnapshot(view, { delta = false } = {}) {
  if (!view || typeof view !== 'object') return '（无快照数据）';
  const lines = [];
  lines.push('【页面】' + truncate(view.title || '（无标题）', 500));
  lines.push('URL: ' + truncate(view.url || '', 2000));
  if (view.scroll) lines.push('滚动: top=' + view.scroll.top + ' / height=' + view.scroll.height + ' / viewport=' + view.scroll.viewport);
  const flags = view.pageFlags && typeof view.pageFlags === 'object'
    ? Object.keys(view.pageFlags).filter((key) => view.pageFlags[key]) : [];
  if (flags.length) lines.push('【风险标志】' + flags.join(', '));
  const inaccessible = Array.isArray(view.inaccessibleFrames) ? view.inaccessibleFrames : [];
  if (inaccessible.length) {
    lines.push('【不可访问 iframe】' + inaccessible.length + ' 个');
    for (const frame of inaccessible.slice(0, 20)) lines.push('  ' + formatPath(frame.framePath) + (frame.src ? ' → ' + truncate(frame.src, 200) : ''));
  }
  const items = Array.isArray(view.items) ? view.items : [];
  const removed = Array.isArray(view.removed) ? view.removed : [];
  const changed = Array.isArray(view.changed) ? view.changed : [];
  const forms = Array.isArray(view.forms) ? view.forms : [];
  const isDelta = delta || view.delta === true;
  if (isDelta) lines.push('【增量】变化 ' + changed.length + ' 个，消失 ' + removed.length + ' 个');
  else lines.push('【控件】' + items.length + ' 个' + (forms.length ? '，其中表单字段 ' + forms.length + ' 个' : ''));
  if (items.length) {
    lines.push('控件清单（用 ref 点击/输入）:');
    for (const item of items) {
      let line = '  [' + item.ref + '] ' + item.role + ' "' + truncate(item.name, 80) + '"';
      if (Array.isArray(item.framePath) && item.framePath.length) line += ' framePath=' + formatPath(item.framePath);
      if (Array.isArray(item.shadow) && item.shadow.length) line += ' shadow=' + item.shadow.join(' > ');
      if (item.href) line += ' → ' + truncate(item.href, 300);
      if (item.value) line += ' = "' + truncate(item.value, 80) + '"';
      if (item.checked === true) line += ' [已勾选]';
      if (item.disabled) line += ' (disabled)';
      if (item.inViewport === false) line += ' (视口外)';
      lines.push(line);
    }
  } else if (!isDelta) lines.push('控件清单: （无可见交互控件）');
  if (removed.length) lines.push('消失的 ref: ' + removed.join(', '));
  if (isDelta) {
    const td = view.textDelta && typeof view.textDelta === 'object' ? view.textDelta : {};
    const added = Array.isArray(td.added) ? td.added : [];
    const removedText = Array.isArray(td.removed) ? td.removed : [];
    lines.push('正文增量: +' + added.length + ' / -' + removedText.length);
    if (added.length) lines.push('新增正文:\n' + truncate(added.join('\n'), 6000));
    if (removedText.length) lines.push('移除正文:\n' + truncate(removedText.join('\n'), 6000));
  } else {
    lines.push('正文:');
    lines.push(view.main ? truncate(view.main, 6000) : '（无可见正文）');
  }
  if (view.truncated && view.truncated.mainChars > 0) lines.push('（正文已截断 ' + view.truncated.mainChars + ' 字符）');
  if (view.truncated && view.truncated.itemsDropped > 0) lines.push('（控件超出上限，省略 ' + view.truncated.itemsDropped + ' 个）');
  return lines.join('\n');
}

function formatPath(path) {
  return Array.isArray(path) && path.length ? path.join(' > ') : 'top';
}
function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? value.slice(0, max) + '…' : value;
}

export { INTERACTIVE_SELECTOR, FIELD_SELECTOR };
