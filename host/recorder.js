/**
 * dsh-amazon-research · host/recorder.js
 *
 * 屏幕录制器：把插件驱动 Chrome 的过程录下来，让用户能实时看到「插件正在读哪个页面」。
 *
 * 实现要点（macOS）：
 *   - Chrome 窗口屏幕坐标：AppleScript 取 `bounds of front window`；
 *   - 区域截图：`screencapture -x -R<x,y,w,h>`（只截 Chrome 窗口那一块，不截整屏）；
 *   - 合成视频：ffmpeg 把帧序列编码成 mp4（用 -movflags +faststart 便于面板边下边看）。
 *
 * 隐私与安全：
 *   - **默认关闭**，必须显式开启（工具参数 record=true）；
 *   - 只截 Chrome 窗口区域，且只在插件驱动 Chrome 期间截；
 *   - 截不到（没给「屏幕录制」权限 / Chrome 不在前台）时降级为「只有事件流」，不报错中断取数。
 */
import { spawn, execFile } from 'node:child_process';
import { mkdir, writeFile, copyFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

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
 * 截一帧 Chrome 窗口区域。
 * @param {string} outPath
 * @returns {Promise<{ok:boolean, path?:string, reason?:string}>}
 */
export async function captureChromeFrame(outPath) {
  const bounds = await chromeWindowBounds();
  if (!bounds) return { ok: false, reason: '拿不到 Chrome 窗口坐标（Chrome 未运行？）' };
  await activateChrome();
  // 给窗口一点时间置顶，避免抓到切换过程中的旧画面
  await new Promise((resolve) => setTimeout(resolve, 120));
  const region = [bounds.x, bounds.y, bounds.w, bounds.h].join(',');
  const result = await run('screencapture', ['-x', '-t', 'jpg', '-R' + region, outPath], { timeout: 15000 });
  if (!result.ok) {
    return { ok: false, reason: 'screencapture 失败（可能未授予「屏幕录制」权限）：' + (result.stderr || result.error || '').slice(0, 160) };
  }
  try {
    const info = await stat(outPath);
    if (!info.size) return { ok: false, reason: '截图为空' };
  } catch {
    return { ok: false, reason: '截图文件未生成' };
  }
  return { ok: true, path: outPath, bounds };
}

/**
 * 录制器：定时抓帧 → frames/ 目录；同时维护 live/frame.jpg 供面板轮询。
 */
export class Recorder {
  constructor({ dir, fps = 1, maxFrames = 900, onFrame = null } = {}) {
    this.dir = dir;
    this.framesDir = join(dir, 'frames');
    this.liveDir = join(dir, 'live');
    this.fps = Math.max(0.5, Math.min(4, Number(fps) || 1));
    this.maxFrames = Math.max(10, Math.min(3600, Number(maxFrames) || 900));
    this.onFrame = typeof onFrame === 'function' ? onFrame : null;
    this.timer = null;
    this.count = 0;
    this.stopped = false;
    this.lastError = null;
    this.enabled = false;
  }

  async start() {
    await mkdir(this.framesDir, { recursive: true });
    await mkdir(this.liveDir, { recursive: true });
    const interval = Math.round(1000 / this.fps);
    // 先截一帧，确认权限可用再进入循环
    const probe = await captureChromeFrame(join(this.framesDir, 'f_0001.jpg'));
    if (!probe.ok) {
      this.lastError = probe.reason;
      return { ok: false, reason: probe.reason };
    }
    this.enabled = true;
    this.count = 1;
    await this.publish(probe.path);
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return { ok: true, fps: this.fps, maxFrames: this.maxFrames };
  }

  async tick() {
    if (this.stopped || !this.enabled) return;
    if (this.count >= this.maxFrames) {
      await this.stop();
      return;
    }
    this.count += 1;
    const name = 'f_' + String(this.count).padStart(5, '0') + '.jpg';
    const shot = await captureChromeFrame(join(this.framesDir, name));
    if (!shot.ok) {
      this.lastError = shot.reason;
      return;
    }
    await this.publish(shot.path);
  }

  /** 复制最新帧到 live/frame.jpg，供面板轮询。 */
  async publish(framePath) {
    try {
      await copyFile(framePath, join(this.liveDir, 'frame.jpg'));
    } catch {
      /* 复制失败不影响录制 */
    }
    if (this.onFrame) {
      try { this.onFrame({ frame: 'live/frame.jpg', count: this.count }); } catch { /* ignore */ }
    }
  }

  async stop() {
    if (this.stopped) return { ok: true, frames: this.count, video: null };
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.enabled = false;
    const video = await this.assembleVideo();
    return { ok: true, frames: this.count, video };
  }

  /** 用 ffmpeg 把帧序列合成 mp4；没有 ffmpeg 或失败时返回 null（不影响主流程）。 */
  async assembleVideo() {
    let frames = [];
    try {
      frames = (await readdir(this.framesDir)).filter((f) => f.endsWith('.jpg')).sort();
    } catch {
      frames = [];
    }
    if (frames.length < 3) return null;
    const out = join(this.dir, 'recording.mp4');
    const args = [
      '-y', '-framerate', String(this.fps),
      '-i', join(this.framesDir, 'f_%05d.jpg'),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      out,
    ];
    const result = await run('ffmpeg', args, { timeout: 120000 });
    if (!result.ok) return null;
    try {
      const info = await stat(out);
      if (!info.size) return null;
    } catch {
      return null;
    }
    return 'recording.mp4';
  }
}

/** 清理帧目录（只保留视频，节省磁盘）。 */
export async function cleanupFrames(dir) {
  try {
    await rm(join(dir, 'frames'), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export { spawn, writeFile };
