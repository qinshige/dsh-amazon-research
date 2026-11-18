import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as chrome from '../host/web/chrome.js';
import * as cdp from '../host/web/cdp.js';
import { readConfig, writeConfig } from '../host/paths.js';
import { normalizeTarget } from '../host/web/page-capabilities.js';

async function withDataDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-browser-'));
  const previous = process.env.DSH_AMAZON_DATA_DIR;
  process.env.DSH_AMAZON_DATA_DIR = dir;
  chrome.resetBrowserCache();
  try {
    await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.DSH_AMAZON_DATA_DIR;
    else process.env.DSH_AMAZON_DATA_DIR = previous;
    chrome.resetBrowserCache();
    cdp.setCdpFetch(null);
    cdp.setCdpConnect(null);
    delete process.env.DSH_AMAZON_BROWSER_DRIVER;
    delete process.env.DSH_AMAZON_CDP_PORT;
    await rm(dir, { recursive: true, force: true });
  }
}

test('默认 auto：调试端口不可用就回落 AppleScript', async () => {
  await withDataDir(async () => {
    cdp.setCdpFetch(async () => { throw new Error('ECONNREFUSED'); });
    const backend = await chrome.resolveBackend({ force: true });
    assert.equal(backend.driver, 'auto');
    assert.equal(backend.backend, 'applescript');
  });
});

test('强制 cdp 不可达时早失败；可达时固定使用 cdp', async () => {
  await withDataDir(async () => {
    cdp.setCdpFetch(async () => { throw new Error('ECONNREFUSED'); });
    process.env.DSH_AMAZON_BROWSER_DRIVER = 'cdp';
    chrome.resetBrowserCache();
    await assert.rejects(() => chrome.resolveBackend({ force: true }), (error) => error?.code === 'CDP_UNREACHABLE');

    cdp.setCdpFetch(async (url) => ({
      ok: true, status: 200,
      async text() { return url.includes('/json/version') ? JSON.stringify({ Browser: 'Chrome/Test' }) : '[]'; },
    }));
    chrome.resetBrowserCache();
    assert.equal((await chrome.resolveBackend({ force: true })).backend, 'cdp');

    process.env.DSH_AMAZON_BROWSER_DRIVER = 'applescript';
    chrome.resetBrowserCache();
    assert.equal((await chrome.resolveBackend({ force: true })).backend, 'applescript');
    delete process.env.DSH_AMAZON_BROWSER_DRIVER;
    await writeFile(join(process.env.DSH_AMAZON_DATA_DIR, 'config.json'), JSON.stringify({ browser: { driver: 'cdp', cdpPort: 9333 } }));
    chrome.resetBrowserCache();
    const backend = await chrome.resolveBackend({ force: true });
    assert.equal(backend.driver, 'cdp');
    assert.equal(backend.port, 9333);
  });
});

test('CDP 标签句柄带后端前缀，后续可固定驱动', async () => {
  await withDataDir(async () => {
    process.env.DSH_AMAZON_BROWSER_DRIVER = 'cdp';
    cdp.setCdpFetch(async (url) => ({
      ok: true, status: 200,
      async text() {
        if (url.includes('/json/version')) return JSON.stringify({ Browser: 'Chrome/Test' });
        return JSON.stringify([{ id: 'target-1', type: 'page', url: 'https://example.test/', title: 'Fixture' }]);
      },
    }));
    chrome.resetBrowserCache();
    const tabs = await chrome.listTabs();
    assert.equal(tabs[0].id, 'cdp:target-1');
    assert.deepEqual(chrome.decodeTabId(tabs[0].id), { backend: 'cdp', rawId: 'target-1', encoded: true });
    const described = await chrome.describeTab(tabs[0].id);
    assert.equal(described.backend, 'cdp');
    assert.equal(described.id, 'cdp:target-1');
  });
});

test('config.json 的 browser 段可读写且校验非法值', async () => {
  await withDataDir(async (dir) => {
    const defaults = await readConfig(dir);
    assert.deepEqual(defaults.browser, { driver: 'auto', cdpPort: 9222 });
    const saved = await writeConfig(dir, { browser: { driver: 'cdp', cdpPort: 9333 } });
    assert.equal(saved.browser.driver, 'cdp');
    assert.equal(saved.browser.cdpPort, 9333);
    const reloaded = await readConfig(dir);
    assert.equal(reloaded.browser.cdpPort, 9333);
    await assert.rejects(() => writeConfig(dir, { browser: { driver: 'playwright' } }), /browser\.driver/);
    await assert.rejects(() => writeConfig(dir, { browser: { cdpPort: 70000 } }), /cdpPort/);
  });
});

test('normalizeTarget：ref 优先且格式受校验', () => {
  assert.deepEqual(normalizeTarget({ ref: 'e12' }), { ref: 'e12', selector: null, text: null, xpath: null, index: 0, contains: true });
  assert.equal(normalizeTarget({ selector: '#kw' }).selector, '#kw');
  assert.throws(() => normalizeTarget({}), /缺少定位方式/);
  assert.throws(() => normalizeTarget({ ref: 'x1' }), /ref 格式/);
  assert.throws(() => normalizeTarget({ ref: 'f1:e2' }), (error) => error?.code === 'FRAME_REF_READ_ONLY');
});
