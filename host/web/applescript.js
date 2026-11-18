/**
 * Chrome 标签页驱动（macOS AppleScript 后端）。
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
import { push as livePush } from '../live.js';

/** 平台可注入，仅用于在非 macOS 环境验证门禁逻辑（测试/诊断）。 */
let platformOverride = '';

/** 覆盖平台判断（传空串恢复 process.platform）。 */
export function setPlatformForTest(value) {
  platformOverride = typeof value === 'string' ? value : '';
}

/** 当前生效平台。 */
export function currentPlatform() {
  return platformOverride || process.platform;
}

/** AppleScript 后端只在 macOS 可用；Windows/Linux 必须走 CDP。 */
export function isAppleScriptSupported(platform = currentPlatform()) {
  return platform === 'darwin';
}

const APPLESCRIPT = `on run argv
  set verb to item 1 of argv
  if verb is "tabs" then
    set out to ""
    tell application "Google Chrome"
      repeat with w in windows
        repeat with t in tabs of w
          set out to out & (id of t) & "\t" & (URL of t) & linefeed
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
  else if verb is "close" then
    set tid to item 2 of argv
    tell application "Google Chrome"
      repeat with w in windows
        repeat with i from (count of tabs of w) to 1 by -1
          if ((id of (item i of tabs of w)) as string) is tid then
            close (item i of tabs of w)
            return "closed"
          end if
        end repeat
      end repeat
    end tell
    return "notfound"
  else if verb is "go" then
    set theURL to item 2 of argv
    set tid to item 3 of argv
    tell application "Google Chrome"
      set t to my tabRef(tid)
      set URL of t to theURL
      return "ok"
    end tell
  else if verb is "focus" then
    set tid to item 2 of argv
    tell application "Google Chrome"
      repeat with w in windows
        repeat with i from 1 to (count of tabs of w)
          if ((id of (item i of tabs of w)) as string) is tid then
            set active tab index of w to i
            set index of w to 1
            return "focused"
          end if
        end repeat
      end repeat
    end tell
    return "notfound"
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
  if (!isAppleScriptSupported()) {
    return Promise.reject(Object.assign(
      new Error('AppleScript 后端仅支持 macOS；当前平台 ' + currentPlatform() + ' 需用 CDP（Chrome 加 --remote-debugging-port 启动）'),
      { code: 'APPLESCRIPT_UNSUPPORTED', platform: currentPlatform() },
    ));
  }
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

/**
 * 列出标签页（**不取标题**）。
 *
 * 为什么不要标题：取 title 要额外 0.6 秒（70 个标签页时 1.98s → 1.34s），
 * 而项目里没有任何地方用 tab.title（页面标题另走 document.title / snippet 取）。
 * 探针要在 2.5s 内返回，否则面板会误报「连接失败」。
 */
export async function listTabs() {
  const out = await osa(['tabs']);
  const rows = [];
  for (const line of out.split('\n')) {
    const parts = line.split('\t');
    if (parts.length >= 2) rows.push({ id: parts[0], url: parts[1], title: '' });
  }
  return rows;
}

/** 打开新标签页，返回 tab id */
export async function openTab(url) {
  const id = (await osa(['new', url])).trim();
  if (!id) throw new Error('无法打开标签页: ' + url);
  livePush({ phase: 'open', level: 'info', message: '打开标签页', url, tabId: id });
  return id;
}

/**
 * 激活标签页（置为前台标签页）。
 *
 * 为什么需要：浏览器扩展只在**前台标签页**跑完整逻辑；后台标签页被 Chrome 节流，
 * 卖家精灵扩展的关键词分析表就不会渲染（实测：新开后台标签页等 60s 表格不出现，
 * 同一页面在前台则正常渲染）。
 */
export async function focusTab(tabId) {
  const out = await osa(['focus', tabId], 30_000);
  livePush({ phase: 'focus', level: 'info', message: '切换到前台标签页（扩展需要前台才渲染）', tabId });
  return String(out || '').trim();
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

/** 等待页面出现某个 DOM 标志。timeout 单位为秒；runJs 的 timeout 单位为毫秒。 */
export async function waitFor(tabId, readyJs, { timeout = 45, intervalMs = 2000, check = runJs, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const deadline = now() + timeout * 1000;
  while (now() < deadline) {
    try {
      const raw = await check(tabId, readyJs, { timeout: Math.max(1, Math.min(40_000, deadline - now())) });
      const value = String(raw || '').trim();
      if (value && value !== 'false' && value !== 'null' && value !== 'undefined' && value !== '__NOT_FOUND__') return true;
    } catch {
      /* 页面未就绪，继续等 */
    }
    await sleep(Math.max(0, Math.min(intervalMs, deadline - now())));
  }
  return false;
}

/**
 * 真正关闭标签页。
 *
 * 为什么要改：旧实现只是 `location.href = "about:blank"` —— 标签页**并没有被关掉**，
 * 只是变成空白页留在窗口里。批量抓 100+ 个详情页就会在 Chrome 里堆出上百个标签页
 * （实测：抓 90 个详情页后 Chrome 有 189 个标签页，页面被自己的空白页淹没）。
 */
export async function closeTab(tabId) {
  try {
    await osa(['close', tabId], 30_000);
  } catch {
    /* 关不掉就退回清空内容，避免留白页 */
    try {
      await osa(['go', 'about:blank', tabId], 20_000);
    } catch {
      /* 忽略 */
    }
  }
}
