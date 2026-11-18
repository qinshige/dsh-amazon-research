/**
 * dsh-amazon-research · host/recorder.js
 *
 * 实时画面：插件驱动 Chrome 期间，把 Chrome 窗口区域截下来，供面板实时显示。
 *
 * 定位：**只做实时预览，不做视频合成**。
 *   - 不写帧序列、不调 ffmpeg、不产出 mp4 —— 屏幕上看到的就是此刻插件正在读的页面；
 *   - 只保留最新一张 live/frame.jpg（覆盖写），磁盘占用恒定；
 *   - 只截 Chrome 窗口那一块区域（不截整屏），且只在插件运行期间截。
 *
 * 降级：拿不到窗口坐标 / 没给「屏幕录制」权限时返回明确原因，由上层退化为「只有事件流」。
 */
import { execFile } from 'node:child_process';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import * as cdp from './web/cdp.js';
import { resolveBackend, chromeLaunchHint, platformSupport } from './web/chrome.js';
import { currentPlatform } from './web/applescript.js';

function run(cmd, args, { timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, error: error ? String(error.message || error) : null, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** 取 Chrome 前台窗口的屏幕坐标（x, y, w, h）。 */
export async function chromeWindowBounds() {
  const script = 'tell application "Google Chrome" to return bounds of front window';
  const result = await run('osascript', ['-e', script], { timeout: 8000 });
  if (!result.ok) return null;
  const parts = result.stdout.trim().split(',').map((v) => Number(v.trim()));
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return null;
  const [x, y, w, h] = parts;
  if (w < 80 || h < 80) return null;
  return { x, y, w, h };
}

/** 把 Chrome 窗口切到前台（否则区域截图抓到的是别的窗口）。 */
export async function activateChrome() {
  await run('osascript', ['-e', 'tell application "Google Chrome" to activate'], { timeout: 8000 });
}

/**
 * CDP 截图（跨平台）：截可视区域并按目标宽度缩放，写 PNG。
 * macOS 上也可用，且不需要「屏幕录制」权限。
 */
export async function captureCdpFrame(outPath, { maxWidth = 1100, tabId = null } = {}) {
  try {
    let target = tabId;
    if (!target) {
      const tabs = await cdp.listTabs();
      const page = tabs.find((tab) => /^https?:/i.test(String(tab.url || '')));
      if (!page) return { ok: false, reason: '没有可截图的 http(s) 标签页' };
      target = page.id;
    }
    const metrics = await cdp
      .runJson(target, 'JSON.stringify({w:window.innerWidth||1200,h:window.innerHeight||800})', { timeout: 10_000 })
      .catch(() => null);
    const width = Math.max(320, Number(metrics?.w) || 1200);
    const height = Math.max(240, Number(metrics?.h) || 800);
    const scale = Math.max(0.2, Math.min(1, Number(maxWidth) / width));
    const buffer = await cdp.captureScreenshot(target, { clip: { x: 0, y: 0, width, height, scale } });
    if (!buffer?.length) return { ok: false, reason: 'CDP 截图为空' };
    await writeFile(outPath, buffer);
    return { ok: true, path: outPath, method: 'cdp', tabId: target, bytes: buffer.length };
  } catch (error) {
    return { ok: false, reason: 'CDP 截图失败：' + String(error?.message ?? error).slice(0, 160) };
  }
}

/**
 * 截一帧 Chrome 窗口区域并写入 outPath（jpg）。
 * 截完用 sips 压到指定宽度，避免 retina 原始帧过大导致面板刷新卡。
 * @param {string} outPath
 * @param {{maxWidth?:number}} [opts]
 */
export async function captureChromeFrame(outPath, { maxWidth = 1100, tabId = null } = {}) {
  const platform = currentPlatform();
  let backend = null;
  try {
    backend = await resolveBackend({ verify: false });
  } catch {
    backend = null;
  }
  if (backend?.backend === 'cdp') {
    const pngPath = /\.png$/i.test(outPath) ? outPath : outPath.replace(/\.[^./\\]+$/, '') + '.png';
    const shot = await captureCdpFrame(pngPath, { maxWidth, tabId });
    if (shot.ok) return shot;
    if (platform !== 'darwin') return shot;
  }
  if (platform !== 'darwin') {
    return { ok: false, reason: '实时画面在当前平台需要 CDP：' + chromeLaunchHint(platform, backend?.port) };
  }
  const bounds = await chromeWindowBounds();
  if (!bounds) return { ok: false, reason: '拿不到 Chrome 窗口坐标（Chrome 未运行？）' };
  await activateChrome();
  await new Promise((resolve) => setTimeout(resolve, 120));
  const region = [bounds.x, bounds.y, bounds.w, bounds.h].join(',');
  const tmp = outPath + '.raw.jpg';
  const result = await run('screencapture', ['-x', '-t', 'jpg', '-R' + region, tmp], { timeout: 15000 });
  if (!result.ok) {
    return { ok: false, reason: 'screencapture 失败（可能未授予「屏幕录制」权限）：' + (result.stderr || result.error || '').slice(0, 160) };
  }
  try {
    const info = await stat(tmp);
    if (!info.size) return { ok: false, reason: '截图为空' };
  } catch {
    return { ok: false, reason: '截图文件未生成' };
  }
  // 压到目标宽度（失败就用原图）
  const resized = await run('sips', ['-Z', String(maxWidth), tmp, '--out', outPath], { timeout: 15000 });
  if (!resized.ok) {
    const copy = await run('cp', [tmp, outPath], { timeout: 8000 });
    if (!copy.ok) return { ok: false, reason: '截图写入失败' };
  }
  // 原始 retina 帧用完即删，磁盘只留最新一张压缩图
  await run('rm', ['-f', tmp], { timeout: 8000 });
  let bytes = 0;
  try {
    const info = await stat(outPath);
    bytes = info.size;
  } catch {
    /* ignore */
  }
  return { ok: true, path: outPath, bounds, bytes };
}

/**
 * 实时画面订阅器：定时刷新 live/frame.jpg（CDP 下为 live/frame.png）。
 * 只留最新一张，不落帧序列、不产出视频。
 */
export class Recorder {
  constructor({ dir, fps = 2, maxWidth = 1100, onFrame = null } = {}) {
    this.dir = dir;
    this.liveDir = join(dir, 'live');
    this.fps = Math.max(0.5, Math.min(6, Number(fps) || 2));
    this.maxWidth = Math.max(640, Math.min(2400, Number(maxWidth) || 1100));
    this.onFrame = typeof onFrame === 'function' ? onFrame : null;
    this.timer = null;
    this.count = 0;
    this.stopped = false;
    this.enabled = false;
    this.lastError = null;
    this.lastFrameAt = null;
    this.framePath = null;
    this.frameName = null;
    this.method = null;
  }

  async start() {
    await mkdir(this.liveDir, { recursive: true });
    const probe = await captureChromeFrame(join(this.liveDir, 'frame.jpg'), { maxWidth: this.maxWidth });
    if (!probe.ok) {
      this.lastError = probe.reason;
      return { ok: false, reason: probe.reason };
    }
    this.framePath = probe.path || join(this.liveDir, 'frame.jpg');
    this.frameName = 'live/' + basename(this.framePath);
    this.method = probe.method || 'screencapture';
    this.enabled = true;
    this.count = 1;
    this.lastFrameAt = new Date().toISOString();
    if (this.onFrame) this.onFrame({ frame: this.frameName, count: this.count });
    this.timer = setInterval(() => { void this.tick(); }, Math.round(1000 / this.fps));
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return { ok: true, fps: this.fps, maxWidth: this.maxWidth, method: this.method, frame: this.frameName };
  }

  async tick() {
    if (this.stopped || !this.enabled) return;
    this.count += 1;
    const shot = await captureChromeFrame(this.framePath || join(this.liveDir, 'frame.jpg'), { maxWidth: this.maxWidth });
    if (!shot.ok) {
      this.lastError = shot.reason;
      return;
    }
    this.lastFrameAt = new Date().toISOString();
    if (this.onFrame) this.onFrame({ frame: this.frameName || 'live/frame.jpg', count: this.count });
  }

  async stop() {
    if (this.stopped) return { ok: true, frames: this.count };
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.enabled = false;
    return { ok: true, frames: this.count, lastFrameAt: this.lastFrameAt, lastError: this.lastError };
  }
}

export { writeFile };
