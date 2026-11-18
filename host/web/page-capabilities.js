/**
 * 页面能力层：有界快照、ref 操作、真实 CDP 输入、风险阻断、等待与安全截图。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve, relative, extname, isAbsolute } from 'node:path';
import { resolveDataDir } from '../paths.js';
import {
  runJs, runJson, focusTab, browserBackendInfo, resolveTabBackend, describeTab, waitFor,
} from './chrome.js';
import * as cdp from './cdp.js';
import { snapshotExpression, formatSnapshot } from './snapshot.js';
import { click as clickByJs, type as typeByJs, press as pressByJs, pointSnippet, focusSnippet } from './page-actions.js';

const BLOCKING_FLAGS = ['captcha', 'login', 'rateLimited', 'accessDenied', 'paywall'];

/** 归一化点击/输入目标：ref 优先，其次 selector / text / xpath。 */
export function normalizeTarget(input = {}) {
  const target = {
    ref: typeof input.ref === 'string' && input.ref.trim() ? input.ref.trim() : null,
    selector: typeof input.selector === 'string' && input.selector.trim() ? input.selector.trim() : null,
    text: typeof input.text === 'string' && input.text.trim() ? input.text : null,
    xpath: typeof input.xpath === 'string' && input.xpath.trim() ? input.xpath.trim() : null,
    index: Number.isFinite(Number(input.index)) ? Number(input.index) : 0,
    contains: input.contains !== false,
  };
  if (!target.ref && !target.selector && !target.text && !target.xpath) {
    throw Object.assign(new Error('缺少定位方式：ref（快照编号）或 selector / text / xpath'), { code: 'NO_TARGET' });
  }
  if (target.ref && !/^(?:f\d+:)?e\d+$/.test(target.ref)) {
    throw Object.assign(new Error('ref 格式应为 e12 或 f2:e12（来自 snapshot 的控件编号）'), { code: 'BAD_REF' });
  }
  if (target.ref && /^f\d+:/.test(target.ref)) {
    throw Object.assign(new Error('跨域 frame 的 ref 当前仅供读取；为避免误点，不允许自动交互'), { code: 'FRAME_REF_READ_ONLY' });
  }
  return target;
}

/** 抓一份页面文本快照，并附上可追溯的页面证据元数据。 */
export async function snapshot(tabId, options = {}) {
  const expression = snapshotExpression(options);
  const view = await runJson(tabId, expression, { timeout: 30_000 });
  const backend = await resolveTabBackend(tabId).catch(() => null);
  // 普通 DOM 无法读跨域 frame；CDP 对每个跨域 frame 建只读隔离上下文补采。
  if (backend?.backend === 'cdp') {
    try {
      const frames = await cdp.listFrames(backend.rawId);
      const mainOrigin = (() => { try { return new URL(view?.url || '').origin; } catch { return ''; } })();
      const crossFrames = frames.slice(1).filter((frame) => {
        try { return new URL(frame.url).origin !== mainOrigin; } catch { return false; }
      }).slice(0, 12);
      const extracted = [];
      for (let index = 0; index < crossFrames.length; index += 1) {
        const frame = crossFrames[index];
        try {
          const frameView = await cdp.evaluateInFrame(backend.rawId, frame.id, snapshotExpression({
            delta: options.delta === true,
            maxChars: Math.min(Number(options.maxChars) || 6000, 3000),
            maxItems: Math.min(Number(options.maxItems) || 120, 40),
          }));
          const prefix = 'f' + (index + 1) + ':';
          for (const item of frameView?.items || []) {
            extracted.push({ ...item, ref: prefix + item.ref, framePath: [frame.url, ...(item.framePath || [])], crossOriginFrame: true, interactive: false });
          }
          if (frameView?.main) view.main = [view.main, '[跨域 frame ' + frame.url + ']\n' + frameView.main].filter(Boolean).join('\n');
          if (frameView?.pageFlags) {
            view.pageFlags = view.pageFlags || {};
            for (const key of BLOCKING_FLAGS) if (frameView.pageFlags[key]) view.pageFlags[key] = true;
          }
          view.inaccessibleFrames = (view.inaccessibleFrames || []).filter((entry) => !String(entry?.src || entry?.url || '').includes(frame.url));
        } catch (error) {
          view.inaccessibleFrames = [...(view.inaccessibleFrames || []), { url: frame.url, reason: String(error?.code || 'CDP_FRAME_READ_FAILED') }];
        }
      }
      if (extracted.length) view.items = [...(view.items || []), ...extracted].slice(0, Number(options.maxItems) || 120);
    } catch {
      // 主文档快照仍然有效；frame 读取失败保留原 inaccessibleFrames。
    }
  }
  const tab = await describeTab(tabId).catch(() => null);
  const evidence = {
    sourceUrl: String(view?.url || tab?.url || ''),
    pageTitle: String(view?.title || tab?.title || ''),
    capturedAt: new Date().toISOString(),
    tabId: String(tabId),
    backend: tab?.backend || null,
    extractionMethod: 'dom-snapshot',
    confidence: Array.isArray(view?.inaccessibleFrames) && view.inaccessibleFrames.length ? 'partial' : 'direct',
    pageFlags: view?.pageFlags || {},
  };
  return { view, text: formatSnapshot(view, { delta: options.delta === true }), evidence };
}

/** 快速检查验证码、登录、限流、拒绝访问和付费墙。 */
export async function pageRisk(tabId) {
  const expression = `(function(){
    var text=''; try{text=((document.body&&document.body.innerText)||'').slice(0,50000).toLowerCase();}catch(e){}
    var url=String(location.href||'').toLowerCase();
    return JSON.stringify({
      captcha:/captcha|verify you are human|人机验证|滑动验证|安全验证|验证码/.test(text),
      login:/\\/(login|signin)(?:[/?#]|$)/.test(url)||!!document.querySelector('form input[type="password"],form[action*="login" i],form[action*="signin" i]'),
      rateLimited:/too many requests|rate limit|请求过于频繁|访问频繁|稍后再试/.test(text),
      accessDenied:/access denied|forbidden|拒绝访问|无权访问/.test(text),
      paywall:/subscribe to continue|upgrade to view|付费后查看|开通会员|购买套餐/.test(text)
    });
  })()`;
  return runJson(tabId, expression, { timeout: 10_000 });
}

export async function assertPageSafe(tabId) {
  const flags = await pageRisk(tabId).catch(() => ({}));
  const active = BLOCKING_FLAGS.filter((key) => flags?.[key] === true);
  if (active.length) {
    throw Object.assign(new Error('页面存在需要人工处理的状态：' + active.join(', ') + '；插件已停止自动操作'), {
      code: 'PAGE_BLOCKED', pageFlags: flags,
    });
  }
  return flags;
}

function fallbackReason(error) {
  return { code: String(error?.code || 'CDP_ACTION_FAILED'), message: String(error?.message ?? error).slice(0, 500) };
}

async function settle(tabId, options = {}) {
  const timeout = Math.max(1, Math.min(300, Number(options.timeout) || 30));
  const result = { requested: false, settled: null };
  if (options.waitForSelector) {
    result.requested = true;
    result.selectorFound = await waitFor(tabId, '!!document.querySelector(' + JSON.stringify(String(options.waitForSelector)) + ')', { timeout });
  }
  if (options.waitForUrl) {
    result.requested = true;
    result.urlMatched = await waitFor(tabId, 'String(location.href).indexOf(' + JSON.stringify(String(options.waitForUrl)) + ') >= 0', { timeout });
  }
  if (options.waitUntil === 'dom-settled') {
    result.requested = true;
    const stable = `(function(){
      if(document.readyState==='loading') return false;
      if(!window.__dshDomSettle){
        window.__dshDomSettle={at:Date.now()};
        try{window.__dshDomSettle.observer=new MutationObserver(function(){window.__dshDomSettle.at=Date.now();});window.__dshDomSettle.observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});}catch(e){}
        return false;
      }
      return Date.now()-window.__dshDomSettle.at>=600;
    })()`;
    result.settled = await waitFor(tabId, stable, { timeout });
  }
  return result.requested ? result : null;
}

/** 点击：CDP 失败时显式标记降级；requireNative=true 时不降级。 */
export async function click(tabId, input, options = {}) {
  const target = normalizeTarget(input);
  await assertPageSafe(tabId);
  const backend = await resolveTabBackend(tabId);
  let degraded = null;
  if (backend.backend === 'cdp') {
    try {
      const point = await runJson(tabId, pointSnippet(target), { timeout: 20_000 });
      if (!point?.ok || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        throw Object.assign(new Error('无法取得目标元素点击坐标'), { code: point?.reason || 'NO_POINT' });
      }
      await cdp.clickAt(backend.rawId, point.x, point.y);
      const waited = await settle(tabId, options);
      return { ok: true, method: 'cdp', ref: target.ref || null, x: Math.round(point.x), y: Math.round(point.y), wait: waited };
    } catch (error) {
      if (options.requireNative === true) throw error;
      degraded = fallbackReason(error);
    }
  } else if (options.requireNative === true) {
    throw Object.assign(new Error('当前标签页使用 AppleScript/JS 后端，无法满足 requireNative'), { code: 'NATIVE_INPUT_REQUIRED' });
  }
  const result = await clickByJs(tabId, target);
  const waited = await settle(tabId, options);
  return { ...result, method: 'js', degradedFrom: degraded ? 'cdp' : null, fallbackReason: degraded, wait: waited };
}

/** 输入：CDP 可用时真实键入，目标会先聚焦；降级总是显式返回原因。 */
export async function type(tabId, input, value, { enter = false, clear = true, requireNative = false, ...waitOptions } = {}) {
  const target = normalizeTarget(input);
  await assertPageSafe(tabId);
  const backend = await resolveTabBackend(tabId);
  let degraded = null;
  if (backend.backend === 'cdp') {
    try {
      const focused = await runJson(tabId, focusSnippet(target, { clear }), { timeout: 20_000 });
      if (!focused?.ok) throw Object.assign(new Error('目标元素无法聚焦'), { code: focused?.reason || 'FOCUS_FAILED' });
      await cdp.insertText(backend.rawId, String(value ?? ''));
      if (enter) await cdp.pressKey(backend.rawId, 'Enter');
      const waited = await settle(tabId, waitOptions);
      return { ok: true, method: 'cdp', ref: target.ref || null, length: String(value ?? '').length, wait: waited };
    } catch (error) {
      if (requireNative) throw error;
      degraded = fallbackReason(error);
    }
  } else if (requireNative) {
    throw Object.assign(new Error('当前标签页使用 AppleScript/JS 后端，无法满足 requireNative'), { code: 'NATIVE_INPUT_REQUIRED' });
  }
  const result = await typeByJs(tabId, target, String(value ?? ''), { enter, clear });
  const waited = await settle(tabId, waitOptions);
  return { ...result, method: 'js', degradedFrom: degraded ? 'cdp' : null, fallbackReason: degraded, wait: waited };
}

/** 按键：提供目标时先聚焦，避免把按键发到旧的 activeElement。 */
export async function press(tabId, key, target = null, options = {}) {
  await assertPageSafe(tabId);
  const normalized = target ? normalizeTarget(target) : null;
  const backend = await resolveTabBackend(tabId);
  let degraded = null;
  if (backend.backend === 'cdp') {
    try {
      if (normalized) {
        const focused = await runJson(tabId, focusSnippet(normalized, { clear: false }), { timeout: 20_000 });
        if (!focused?.ok) throw Object.assign(new Error('目标元素无法聚焦'), { code: focused?.reason || 'FOCUS_FAILED' });
      }
      const result = await cdp.pressKey(backend.rawId, key);
      return { ok: true, method: 'cdp', ...result, wait: await settle(tabId, options) };
    } catch (error) {
      if (options.requireNative === true) throw error;
      degraded = fallbackReason(error);
    }
  } else if (options.requireNative === true) {
    throw Object.assign(new Error('当前标签页使用 AppleScript/JS 后端，无法满足 requireNative'), { code: 'NATIVE_INPUT_REQUIRED' });
  }
  const result = await pressByJs(tabId, key, normalized || {});
  return { ...result, method: 'js', degradedFrom: degraded ? 'cdp' : null, fallbackReason: degraded, wait: await settle(tabId, options) };
}

/** 滚动整页（CDP 下用真实滚轮，失败时显式降级）。 */
export async function scrollPage(tabId, deltaY, options = {}) {
  await assertPageSafe(tabId);
  const backend = await resolveTabBackend(tabId);
  let degraded = null;
  if (backend.backend === 'cdp') {
    try {
      const state = await runJson(tabId, 'JSON.stringify({x:(window.innerWidth||800)/2,y:(window.innerHeight||600)/2})', { timeout: 10_000 });
      await cdp.wheelAt(backend.rawId, state.x, state.y, deltaY);
      return { ok: true, method: 'cdp', deltaY };
    } catch (error) {
      if (options.requireNative === true) throw error;
      degraded = fallbackReason(error);
    }
  } else if (options.requireNative === true) {
    throw Object.assign(new Error('当前标签页使用 AppleScript/JS 后端，无法满足 requireNative'), { code: 'NATIVE_INPUT_REQUIRED' });
  }
  const result = await runJs(tabId, 'window.scrollBy(0,' + Number(deltaY || 0) + '); String(window.scrollY)');
  return { ok: true, method: 'js', scrollY: Number(result), degradedFrom: degraded ? 'cdp' : null, fallbackReason: degraded };
}

/** 导航到指定 http(s) URL，并可等待 URL/选择器/DOM 稳定。 */
export async function navigate(tabId, url, options = {}) {
  const text = String(url || '').trim();
  if (!/^https?:\/\//i.test(text)) throw Object.assign(new Error('只允许 http(s) URL：' + text.slice(0, 120)), { code: 'BAD_URL' });
  await assertPageSafe(tabId);
  const backend = await resolveTabBackend(tabId);
  let degraded = null;
  if (backend.backend === 'cdp') {
    try {
      const result = await cdp.navigate(backend.rawId, text);
      return { ok: true, method: 'cdp', ...result, wait: await settle(tabId, options) };
    } catch (error) {
      if (options.requireNative === true) throw error;
      degraded = fallbackReason(error);
    }
  } else if (options.requireNative === true) {
    throw Object.assign(new Error('当前标签页使用 AppleScript/JS 后端，无法满足 requireNative'), { code: 'NATIVE_INPUT_REQUIRED' });
  }
  await runJs(tabId, 'location.href = ' + JSON.stringify(text) + '; "OK"', { timeout: 30_000 });
  return { ok: true, method: 'js', url: text, degradedFrom: degraded ? 'cdp' : null, fallbackReason: degraded, wait: await settle(tabId, options) };
}

export async function history(tabId, action, options = {}) {
  const scripts = { back: 'history.back(); "OK"', forward: 'history.forward(); "OK"', reload: 'location.reload(); "OK"' };
  if (!scripts[action]) throw Object.assign(new Error('未知 history 动作: ' + action), { code: 'BAD_ACTION' });
  await assertPageSafe(tabId);
  await runJs(tabId, scripts[action], { timeout: 30_000 });
  return { ok: true, action, wait: await settle(tabId, options) };
}

/** 截图只能写入插件数据目录 screenshots/，且拒绝覆盖已有文件。 */
export async function screenshot(tabId, { fullPage = false, savePath = null } = {}) {
  const backend = await resolveTabBackend(tabId);
  if (backend.backend !== 'cdp') {
    const { chromeLaunchHint } = await import('./chrome.js');
    throw Object.assign(new Error('截图需要 CDP：' + chromeLaunchHint(process.platform, backend.port)), { code: 'SCREENSHOT_NEEDS_CDP' });
  }
  const screenshotRoot = resolve(resolveDataDir(process.env.DSH_AMAZON_DATA_DIR), 'screenshots');
  const requested = typeof savePath === 'string' && savePath.trim() ? savePath.trim() : '';
  const target = requested
    ? resolve(isAbsolute(requested) ? requested : join(screenshotRoot, requested))
    : join(screenshotRoot, 'page-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png');
  const rel = relative(screenshotRoot, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || extname(target).toLowerCase() !== '.png') {
    throw Object.assign(new Error('截图只能保存到插件数据目录 screenshots/ 下的 .png 文件'), { code: 'BAD_SCREENSHOT_PATH' });
  }
  // 先验证目标路径，再向浏览器请求像素，避免无效/越界路径仍触发截图。
  const buffer = await cdp.captureScreenshot(backend.rawId, { fullPage });
  await mkdir(dirname(target), { recursive: true });
  try { await writeFile(target, buffer, { flag: 'wx' }); }
  catch (error) {
    if (error?.code === 'EEXIST') throw Object.assign(new Error('截图文件已存在，拒绝覆盖：' + target), { code: 'SCREENSHOT_EXISTS' });
    throw error;
  }
  return { ok: true, path: target, bytes: buffer.length, fullPage: fullPage === true };
}

/** 跟随句柄对应标签页，不受 auto 后端重新探测影响。 */
export async function follow(tabId) {
  const hit = await describeTab(tabId);
  if (!hit) throw Object.assign(new Error('找不到该标签页：' + tabId + '（可能已关闭）'), { code: 'NO_TAB' });
  await focusTab(tabId).catch(() => null);
  return { ok: true, tab: { id: hit.id, url: hit.url, title: hit.title || '', backend: hit.backend } };
}

export async function backendStatus(options = {}) { return browserBackendInfo(options); }
export { formatSnapshot, snapshotExpression };
