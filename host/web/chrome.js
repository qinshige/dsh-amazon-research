/**
 * 浏览器驱动门面。
 *
 * 对采集器提供统一原语，并把标签页句柄命名空间化为 apple:<id> / cdp:<id>。
 * 一旦拿到句柄，后续动作固定使用同一后端，避免 auto 探测变化后把旧标签 id
 * 误交给另一个驱动。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveDataDir } from '../paths.js';
import * as apple from './applescript.js';
import * as cdp from './cdp.js';

const VALID_DRIVERS = new Set(['auto', 'applescript', 'cdp']);
const BACKENDS = { applescript: apple, cdp };
let configCache = { at: 0, value: null };
let backendCache = { at: 0, value: null };
let infoCache = { at: 0, value: null };

function envDriver() {
  const raw = String(process.env.DSH_AMAZON_BROWSER_DRIVER || '').trim().toLowerCase();
  return VALID_DRIVERS.has(raw) ? raw : '';
}

function envPort() {
  const value = Number(process.env.DSH_AMAZON_CDP_PORT);
  return Number.isInteger(value) && value > 0 && value < 65_536 ? value : null;
}

export async function readBrowserConfig() {
  const now = Date.now();
  if (configCache.value && now - configCache.at < 3000) return configCache.value;
  let browser = {};
  try {
    const dataDir = resolveDataDir(process.env.DSH_AMAZON_DATA_DIR);
    const parsed = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8'));
    if (parsed && typeof parsed.browser === 'object' && parsed.browser) browser = parsed.browser;
  } catch {
    browser = {};
  }
  const driver = envDriver() || (VALID_DRIVERS.has(String(browser.driver || '').toLowerCase()) ? String(browser.driver).toLowerCase() : 'auto');
  const configuredPort = Number(browser.cdpPort);
  const port = envPort() || (Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65_536 ? configuredPort : 9222);
  configCache = { at: now, value: { driver, port } };
  return configCache.value;
}

/** 解析当前默认后端。强制 cdp 时端口不可用会立即报错。 */
export async function resolveBackend({ force = false, verify = true } = {}) {
  const now = Date.now();
  if (!force && backendCache.value && now - backendCache.at < 5000) return backendCache.value;
  const config = await readBrowserConfig();
  cdp.configureCdp({ port: config.port });
  let backend = 'applescript';
  if (config.driver === 'cdp') {
    if (verify && !(await cdp.cdpAvailable({ timeoutMs: 1000 }))) {
      throw Object.assign(new Error('无法连接强制配置的 Chrome CDP 端口 127.0.0.1:' + config.port), { code: 'CDP_UNREACHABLE' });
    }
    backend = 'cdp';
  } else if (config.driver === 'auto') {
    backend = (await cdp.cdpAvailable({ timeoutMs: 800 })) ? 'cdp' : 'applescript';
  }
  const value = { backend, driver: config.driver, port: config.port, module: BACKENDS[backend] };
  backendCache = { at: now, value };
  return value;
}

function prefixFor(backend) {
  return backend === 'cdp' ? 'cdp' : 'apple';
}

function backendForPrefix(prefix) {
  return prefix === 'cdp' ? 'cdp' : prefix === 'apple' ? 'applescript' : null;
}

export function encodeTabId(backend, rawId) {
  return prefixFor(backend) + ':' + String(rawId);
}

export function decodeTabId(tabId) {
  const value = String(tabId ?? '');
  const match = /^(apple|cdp):(.*)$/.exec(value);
  if (!match) return { backend: null, rawId: value, encoded: false };
  return { backend: backendForPrefix(match[1]), rawId: match[2], encoded: true };
}

/** 有命名空间的句柄固定后端；旧无前缀句柄仍按当前默认后端兼容。 */
export async function resolveTabBackend(tabId) {
  const decoded = decodeTabId(tabId);
  if (decoded.backend) {
    const config = await readBrowserConfig();
    cdp.configureCdp({ port: config.port });
    return { backend: decoded.backend, module: BACKENDS[decoded.backend], rawId: decoded.rawId, port: config.port };
  }
  const resolved = await resolveBackend();
  return { ...resolved, rawId: decoded.rawId };
}

export async function browserBackendInfo({ force = false } = {}) {
  if (!force && infoCache.value && Date.now() - infoCache.at < 15_000) return infoCache.value;
  const config = await readBrowserConfig();
  cdp.configureCdp({ port: config.port });
  const cdpAvailable = await cdp.cdpAvailable({ timeoutMs: 1000 });
  let appleTabs = null;
  let appleError = null;
  try {
    appleTabs = (await apple.listTabs()).length;
  } catch (error) {
    appleError = String(error?.message ?? error);
  }
  let active = config.driver === 'cdp' ? 'cdp' : 'applescript';
  let backendError = null;
  try {
    active = (await resolveBackend({ force })).backend;
  } catch (error) {
    backendError = { code: String(error?.code || 'BROWSER_BACKEND_FAILED'), message: String(error?.message ?? error) };
  }
  const value = {
    driver: config.driver,
    active,
    cdpPort: config.port,
    cdpAvailable,
    applescriptAvailable: appleTabs !== null,
    applescriptTabs: appleTabs,
    applescriptError: appleError,
    backendError,
    tabIdFormat: 'apple:<id> | cdp:<id>',
    note: cdpAvailable
      ? 'CDP 可用：真实输入事件 + 截图，不需要 Chrome 的 Apple Events JavaScript 开关'
      : 'CDP 未开启：如需真实输入/截图，可用 --remote-debugging-port=' + config.port + ' 启动 Chrome（Chrome 136+ 须配独立 --user-data-dir）；否则沿用 AppleScript',
  };
  infoCache = { at: Date.now(), value };
  return value;
}

export async function runJs(tabId, js, options = {}) {
  const target = await resolveTabBackend(tabId);
  return target.module.runJs(target.rawId, js, options);
}

export async function runJson(tabId, js, options = {}) {
  const target = await resolveTabBackend(tabId);
  return target.module.runJson(target.rawId, js, options);
}

export async function listTabs() {
  const target = await resolveBackend();
  const tabs = await target.module.listTabs();
  return tabs.map((tab) => ({ ...tab, id: encodeTabId(target.backend, tab.id), backend: target.backend }));
}

export async function openTab(url) {
  const target = await resolveBackend();
  const rawId = await target.module.openTab(url);
  return encodeTabId(target.backend, rawId);
}

export async function focusTab(tabId) {
  const target = await resolveTabBackend(tabId);
  return target.module.focusTab(target.rawId);
}

export async function waitFor(tabId, readyJs, options = {}) {
  const target = await resolveTabBackend(tabId);
  return target.module.waitFor(target.rawId, readyJs, options);
}

export async function closeTab(tabId) {
  const target = await resolveTabBackend(tabId);
  return target.module.closeTab(target.rawId);
}

/** 查询句柄对应标签页，不受当前 auto 后端变化影响。 */
export async function describeTab(tabId) {
  const target = await resolveTabBackend(tabId);
  const tabs = await target.module.listTabs();
  const hit = tabs.find((tab) => String(tab.id) === String(target.rawId));
  return hit ? { ...hit, id: encodeTabId(target.backend, hit.id), backend: target.backend } : null;
}

export function resetBrowserCache({ closeConnections = true } = {}) {
  configCache = { at: 0, value: null };
  backendCache = { at: 0, value: null };
  infoCache = { at: 0, value: null };
  if (closeConnections) cdp.closeAll();
}
