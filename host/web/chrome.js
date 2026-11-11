/**
 * Chrome 标签页驱动（macOS AppleScript）。
 *
 * 用途：当数据源只提供「网页登录态」而非开放 API 时，用本模块在用户已登录的 Chrome 里
 * 打开目标页面、执行 JS 抽取 DOM，再把结果读回 Node。
 *
 * 约束：
 *   - 只读公开/已授权页面，不绕过登录、验证码或付费墙；
 *   - 每个动作都有超时；取不到就报错，不静默返回空；
 *   - 依赖 macOS 的 Google Chrome + osascript；其它平台直接抛错（provider 自行降级）。
 */
import { spawn } from 'node:child_process';

const APPLESCRIPT = `on run argv
  set verb to item 1 of argv
  if verb is "tabs" then
    set out to ""
    tell application "Google Chrome"
      repeat with w in windows
        repeat with t in tabs of w
          set out to out & (id of t) & "\t" & (title of t) & "\t" & (URL of t) & linefeed
        end repeat
      end repeat
    end tell
    return out
  else if verb is "new" then
    set theURL to item 2 of argv
    tell application "Google Chrome"
      set t to make new tab at end of tabs of front window with properties {URL:theURL}
      return (id of t) as string
    end tell
  else if verb is "go" then
    set theURL to item 2 of argv
    set tid to item 3 of argv
    tell application "Google Chrome"
      set t to my tabRef(tid)
      set URL of t to theURL
      return "ok"
    end tell
  else if verb is "js" then
    set tid to item 2 of argv
    set jsText to item 3 of argv
    with timeout of 90 seconds
      tell application "Google Chrome"
        set t to my tabRef(tid)
        return execute t javascript jsText
      end tell
    end timeout
  end if
end run

on tabRef(tid)
  tell application "Google Chrome"
    repeat with w in windows
      repeat with t in tabs of w
        if ((id of t) as string) is tid then return t
      end repeat
    end repeat
  end tell
  error "tab not found"
end tabRef`;

/** AppleScript 源码（走 stdin 执行） */
function ensureScript() {
  return APPLESCRIPT;
}

/**
 * 执行 AppleScript，返回 stdout。
 * 调用方式与 chrome_tab.py 一致：脚本内容走 stdin，参数跟在 '-' 之后（osascript - <verb> <args>）。
 */
function osa(verbArgs, timeout = 120_000) {
  const script = ensureScript();
  return new Promise((resolve, reject) => {
    const child = spawn('osascript', ['-', ...verbArgs], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Object.assign(new Error('Chrome 控制超时（' + timeout + 'ms）'), { code: 'CHROME_TIMEOUT' }));
    }, timeout);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(Object.assign(new Error('无法启动 osascript: ' + error.message), { code: 'CHROME_FAILED' }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        Object.assign(new Error('Chrome 控制失败（osascript ' + code + '）: ' + (stderr.trim() || '无错误输出').slice(0, 300)), {
          code: 'CHROME_FAILED',
        }),
      );
    });
    child.stdin.end(script);
  });
}

/** 列出标签页 */
export async function listTabs() {
  const out = await osa(['tabs']);
  const rows = [];
  for (const line of out.split('\n')) {
    const parts = line.split('\t');
    if (parts.length >= 3) rows.push({ id: parts[0], title: parts[1], url: parts[2] });
  }
  return rows;
}

/** 打开新标签页，返回 tab id */
export async function openTab(url) {
  const id = (await osa(['new', url])).trim();
  if (!id) throw new Error('无法打开标签页: ' + url);
  return id;
}

/** 在已有标签页执行 JS，返回原始字符串 */
export async function runJs(tabId, js, { timeout = 120_000 } = {}) {
  return osa(['js', tabId, js], timeout);
}

/**
 * 在标签页执行 JS 并解析 JSON。
 * strict=false 时，非 JSON 文本按原样返回（用于 "OK" / "NO_INPUT" 这类状态标记）。
 */
export async function runJson(tabId, js, { timeout = 120_000, strict = true } = {}) {
  const raw = await runJs(tabId, js, { timeout });
  const text = String(raw || '').trim();
  if (!text) throw new Error('页面返回空内容（可能未登录或页面未加载）');
  try {
    return JSON.parse(text);
  } catch {
    if (!strict) return text;
    throw new Error('页面返回非 JSON: ' + text.slice(0, 200));
  }
}

/** 等待页面出现某个 DOM 标志 */
export async function waitFor(tabId, readyJs, { timeout = 45, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const raw = await runJs(tabId, readyJs, { timeout: 40 });
      const value = String(raw || '').trim();
      if (value && value !== 'false' && value !== 'null' && value !== 'undefined' && value !== '__NOT_FOUND__') return true;
    } catch {
      /* 页面未就绪，继续等 */
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/** 关闭标签页（尽力而为） */
export async function closeTab(tabId) {
  try {
    await osa(['go', 'about:blank', tabId], 30_000);
  } catch {
    /* 忽略 */
  }
}
