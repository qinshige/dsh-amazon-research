import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import * as chrome from '../host/web/chrome.js';
import * as cdp from '../host/web/cdp.js';
import * as caps from '../host/web/page-capabilities.js';

const enabled = process.env.DSH_BROWSER_INTEGRATION === '1';
const candidates = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);

async function executable() {
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* next */ }
  }
  return null;
}

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function closeServer(server) { return new Promise((resolve) => server.close(resolve)); }
function origin(server) { return `http://127.0.0.1:${server.address().port}`; }
async function waitForFile(path, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { return await readFile(path, 'utf8'); } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error('等待文件超时：' + path);
}

test('真实 Chrome/CDP：快照、ref 单次点击、输入、跨域 frame 与安全截图', { skip: !enabled }, async (t) => {
  const bin = await executable();
  if (!bin) return t.skip('未找到 Chrome/Chromium');
  const temp = await mkdtemp(join(tmpdir(), 'dsr-real-browser-'));
  const profile = join(temp, 'profile');
  const dataDir = join(temp, 'data');
  let child;
  let mainServer;
  let frameServer;
  const previous = {
    data: process.env.DSH_AMAZON_DATA_DIR,
    driver: process.env.DSH_AMAZON_BROWSER_DRIVER,
    port: process.env.DSH_AMAZON_CDP_PORT,
  };
  try {
    frameServer = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Foreign</title><main>跨域框架正文</main><button id="foreign">Foreign</button>');
    });
    mainServer = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (req.url === '/same') return res.end('<!doctype html><main>同源框架正文</main><button>Same</button>');
      res.end(`<!doctype html><meta charset="utf-8"><title>DSH Fixture</title>
        <main id="content">主文档正文</main>
        <input id="normal" aria-label="普通输入"><input id="secret" type="password" value="NeverLeak123" aria-label="NeverLeak123">
        <button id="once" onclick="window.clickCount=(window.clickCount||0)+1;this.textContent='clicked '+window.clickCount">Click once</button>
        <div id="shadow"></div><iframe src="/same"></iframe><iframe src="${origin(frameServer)}/foreign"></iframe>
        <script>const root=document.querySelector('#shadow').attachShadow({mode:'open'});root.innerHTML='<button>Shadow Action</button><p>影子正文</p>';</script>`);
    });
    const pageUrl = origin(mainServer) + '/';
    child = spawn(bin, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=0', '--user-data-dir=' + profile, pageUrl,
    ], { stdio: 'ignore' });
    const active = await waitForFile(join(profile, 'DevToolsActivePort'));
    const port = Number(active.split(/\r?\n/)[0]);
    assert.ok(Number.isInteger(port) && port > 0);
    process.env.DSH_AMAZON_DATA_DIR = dataDir;
    process.env.DSH_AMAZON_BROWSER_DRIVER = 'cdp';
    process.env.DSH_AMAZON_CDP_PORT = String(port);
    chrome.resetBrowserCache();

    let tabs = [];
    // DevToolsActivePort 可能先于 HTTP 端点就绪写出，这里容忍刚开始的 ECONNREFUSED。
    for (let i = 0; i < 60; i += 1) {
      try {
        tabs = await chrome.listTabs();
        if (tabs.some((tab) => tab.url === pageUrl)) break;
      } catch (error) {
        if (i === 59) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const tab = tabs.find((item) => item.url === pageUrl);
    assert.ok(tab, '应能在 CDP 里找到 fixture 页面，实际：' + tabs.map((item) => item.url).join(' | '));
    assert.ok(tab.id.startsWith('cdp:'));
    await chrome.waitFor(tab.id, 'document.readyState === "complete"', { timeout: 10, intervalMs: 100 });

    const snap = await caps.snapshot(tab.id, { maxChars: 20_000, maxItems: 100 });
    assert.match(snap.text, /主文档正文/);
    assert.match(snap.text, /同源框架正文/);
    assert.match(snap.text, /影子正文|Shadow Action/);
    assert.match(snap.text, /跨域框架正文/);
    assert.doesNotMatch(JSON.stringify(snap.view), /NeverLeak123/);
    assert.equal(snap.evidence.backend, 'cdp');

    const button = snap.view.items.find((item) => item.name === 'Click once');
    assert.ok(button?.ref);
    const clicked = await caps.click(tab.id, { ref: button.ref }, { requireNative: true, waitUntil: 'dom-settled', timeout: 5 });
    assert.equal(clicked.method, 'cdp');
    assert.equal(await chrome.runJs(tab.id, 'String(window.clickCount||0)'), '1');

    const typed = await caps.type(tab.id, { selector: '#normal' }, 'native text', { requireNative: true });
    assert.equal(typed.method, 'cdp');
    assert.equal(await chrome.runJs(tab.id, 'document.querySelector("#normal").value'), 'native text');

    const shot = await caps.screenshot(tab.id, { savePath: 'fixture.png' });
    assert.ok((await stat(shot.path)).size > 0);
    await assert.rejects(() => caps.screenshot(tab.id, { savePath: 'fixture.png' }), (error) => error?.code === 'SCREENSHOT_EXISTS');
    await assert.rejects(() => caps.screenshot(tab.id, { savePath: '../escape.png' }), (error) => error?.code === 'BAD_SCREENSHOT_PATH');

    await chrome.runJs(tab.id, 'document.body.innerHTML="<main>Captcha - verify you are human</main><button id=blocked>Blocked</button>"');
    await assert.rejects(() => caps.click(tab.id, { selector: '#blocked' }), (error) => error?.code === 'PAGE_BLOCKED');
  } finally {
    chrome.resetBrowserCache();
    cdp.closeAll();
    if (child) { child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)).catch(() => {}); }
    if (mainServer) await closeServer(mainServer);
    if (frameServer) await closeServer(frameServer);
    if (previous.data === undefined) delete process.env.DSH_AMAZON_DATA_DIR; else process.env.DSH_AMAZON_DATA_DIR = previous.data;
    if (previous.driver === undefined) delete process.env.DSH_AMAZON_BROWSER_DRIVER; else process.env.DSH_AMAZON_BROWSER_DRIVER = previous.driver;
    if (previous.port === undefined) delete process.env.DSH_AMAZON_CDP_PORT; else process.env.DSH_AMAZON_CDP_PORT = previous.port;
    await rm(temp, { recursive: true, force: true });
  }
});
