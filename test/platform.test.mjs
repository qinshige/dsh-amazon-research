import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as chrome from '../host/web/chrome.js';
import * as cdp from '../host/web/cdp.js';
import * as apple from '../host/web/applescript.js';
import { captureChromeFrame, captureCdpFrame } from '../host/recorder.js';

function stubCdp({ available }) {
  cdp.setCdpFetch(async (url) => {
    if (!available) throw new Error('ECONNREFUSED');
    return {
      ok: true,
      status: 200,
      async text() {
        return url.includes('/json/version') ? JSON.stringify({ Browser: 'Chrome/Test' }) : '[]';
      },
    };
  });
}

async function withEnv(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-platform-'));
  const previousDir = process.env.DSH_AMAZON_DATA_DIR;
  const previousDriver = process.env.DSH_AMAZON_BROWSER_DRIVER;
  const previousPort = process.env.DSH_AMAZON_CDP_PORT;
  process.env.DSH_AMAZON_DATA_DIR = dir;
  delete process.env.DSH_AMAZON_BROWSER_DRIVER;
  delete process.env.DSH_AMAZON_CDP_PORT;
  chrome.resetBrowserCache();
  try {
    await fn(dir);
  } finally {
    apple.setPlatformForTest('');
    if (previousDir === undefined) delete process.env.DSH_AMAZON_DATA_DIR;
    else process.env.DSH_AMAZON_DATA_DIR = previousDir;
    if (previousDriver === undefined) delete process.env.DSH_AMAZON_BROWSER_DRIVER;
    else process.env.DSH_AMAZON_BROWSER_DRIVER = previousDriver;
    if (previousPort === undefined) delete process.env.DSH_AMAZON_CDP_PORT;
    else process.env.DSH_AMAZON_CDP_PORT = previousPort;
    chrome.resetBrowserCache();
    cdp.setCdpFetch(null);
    await rm(dir, { recursive: true, force: true });
  }
}

test('AppleScript 后端只在 macOS 可用，其它平台直接给 APPLESCRIPT_UNSUPPORTED', async () => {
  assert.equal(apple.isAppleScriptSupported('darwin'), true);
  assert.equal(apple.isAppleScriptSupported('win32'), false);
  assert.equal(apple.isAppleScriptSupported('linux'), false);
  apple.setPlatformForTest('win32');
  try {
    await assert.rejects(() => apple.listTabs(), (error) => error?.code === 'APPLESCRIPT_UNSUPPORTED');
  } finally {
    apple.setPlatformForTest('');
  }
});

test('Windows 无调试端口：auto 不静默回落，报 CDP_REQUIRED 并给启动命令', async () => {
  await withEnv(async () => {
    apple.setPlatformForTest('win32');
    stubCdp({ available: false });
    await assert.rejects(() => chrome.resolveBackend({ force: true }), (error) => {
      assert.equal(error?.code, 'CDP_REQUIRED');
      assert.match(error.launchHint, /chrome\.exe/);
      return true;
    });
  });
});

test('Windows 强制 applescript：直接拒绝，不尝试 osascript', async () => {
  await withEnv(async () => {
    apple.setPlatformForTest('win32');
    process.env.DSH_AMAZON_BROWSER_DRIVER = 'applescript';
    chrome.resetBrowserCache();
    await assert.rejects(() => chrome.resolveBackend({ force: true }), (error) => error?.code === 'BROWSER_UNSUPPORTED_ON_PLATFORM');
  });
});

test('Windows 有调试端口：auto 走 CDP，句柄仍带 cdp 前缀', async () => {
  await withEnv(async () => {
    apple.setPlatformForTest('win32');
    stubCdp({ available: true });
    chrome.resetBrowserCache();
    const backend = await chrome.resolveBackend({ force: true });
    assert.equal(backend.backend, 'cdp');
    assert.equal(backend.appleSupported, false);
    assert.match(backend.launchHint, /chrome\.exe/);
  });
});

test('macOS 行为不变：无调试端口仍回落 AppleScript', async () => {
  await withEnv(async () => {
    apple.setPlatformForTest('darwin');
    stubCdp({ available: false });
    chrome.resetBrowserCache();
    const backend = await chrome.resolveBackend({ force: true });
    assert.equal(backend.backend, 'applescript');
    assert.equal(backend.appleSupported, true);
  });
});

test('非 macOS 下手持 apple: 句柄会被明确拒绝', async () => {
  await withEnv(async () => {
    apple.setPlatformForTest('linux');
    await assert.rejects(() => chrome.resolveTabBackend('apple:123'), (error) => error?.code === 'BROWSER_UNSUPPORTED_ON_PLATFORM');
  });
});

test('backend 状态在非 macOS 下不探测 osascript，并给出平台与启动提示', async () => {
  await withEnv(async () => {
    apple.setPlatformForTest('win32');
    stubCdp({ available: false });
    chrome.resetBrowserCache();
    const info = await chrome.browserBackendInfo({ force: true });
    assert.equal(info.platform, 'win32');
    assert.equal(info.applescriptSupported, false);
    assert.equal(info.applescriptAvailable, false);
    assert.match(info.launchHint, /chrome\.exe/);
    assert.equal(info.backendError?.code, 'CDP_REQUIRED');
  });
});

test('实时画面：非 macOS 且无 CDP 时明确报错，不调用 screencapture', async () => {
  await withEnv(async (dir) => {
    apple.setPlatformForTest('win32');
    stubCdp({ available: false });
    chrome.resetBrowserCache();
    const shot = await captureChromeFrame(join(dir, 'frame.jpg'), { maxWidth: 800 });
    assert.equal(shot.ok, false);
    assert.match(shot.reason, /CDP/);
  });
});

test('CDP 实时画面在没有 http(s) 标签页时安全失败', async () => {
  await withEnv(async (dir) => {
    stubCdp({ available: true });
    chrome.resetBrowserCache();
    const shot = await captureCdpFrame(join(dir, 'frame.png'), { maxWidth: 800 });
    assert.equal(shot.ok, false);
    assert.ok(shot.reason.length > 0);
  });
});
