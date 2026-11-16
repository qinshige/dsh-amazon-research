/**
 * dsh-amazon-research · host/live.js
 *
 * 实时会话：把「插件正在做什么」实时写出来，面板可轮询查看。
 *
 * 为什么需要：插件驱动 Chrome 时，用户只能看到「插件在跑」，看不到它读的是哪个页面、
 * 抽到了几行、卡在哪一步。实时流把这件事显性化，也让「取数对不对」当场可核。
 *
 * 设计：模块级单会话（一次只有一个浏览器链路在跑），低层模块（chrome.js / 1688.js /
 * 采集器）直接调用 emit()，不需要层层传参。
 */
import { mkdir, writeFile, appendFile, readFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { Recorder } from './recorder.js';

let session = null;

const MAX_EVENTS = 400;

/** 读取某个运行目录的实时快照（面板用）。 */
export async function readLiveSnapshot(dir) {
  try {
    const raw = await readFile(join(dir, 'live', 'snapshot.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 当前会话（面板用；无会话返回 null）。 */
export function currentSession() {
  if (!session) return null;
  return {
    runId: session.runId,
    dir: session.dir,
    startedAt: session.startedAt,
    recording: Boolean(session.recorder && session.recorder.enabled),
    frames: session.recorder ? session.recorder.count : 0,
    events: session.events.length,
  };
}

/**
 * 开始一个实时会话。
 * @param {{runId:string, dir:string, record?:boolean, fps?:number, maxFrames?:number, source?:string}} input
 */
export async function beginSession({ runId, dir, record = false, fps = 1, maxFrames = 900, source = '' } = {}) {
  await endSession();
  const liveDir = join(dir, 'live');
  await mkdir(liveDir, { recursive: true });
  const startedAt = new Date().toISOString();
  session = {
    runId,
    dir,
    liveDir,
    source,
    startedAt,
    events: [],
    writeChain: null,
    recorder: null,
    recordRequested: Boolean(record),
    recordError: null,
    status: 'running',
  };
  if (record) {
    const recorder = new Recorder({ dir, fps, maxFrames });
    const started = await recorder.start();
    session.recorder = started.ok ? recorder : null;
    session.recordError = started.ok ? null : started.reason;
    if (started.ok) {
      push({ phase: 'record', level: 'info', message: '开始录制 Chrome 窗口（' + fps + ' fps）' });
    } else {
      push({ phase: 'record', level: 'warn', message: '屏幕录制不可用，仅保留实时事件流：' + started.reason });
    }
  }
  push({ phase: 'start', level: 'info', message: '开始取数' + (source ? '（' + source + '）' : '') });
  return { ok: true, runId, recording: Boolean(session.recorder), recordError: session.recordError };
}

/** 追加一条事件（时间戳 + 阶段 + 消息 + 可选数据）。 */
export function push(event = {}) {
  if (!session) return null;
  const item = {
    at: new Date().toISOString(),
    phase: String(event.phase || 'step'),
    level: String(event.level || 'info'),
    message: String(event.message ?? ''),
    url: event.url || null,
    tabId: event.tabId || null,
    count: typeof event.count === 'number' ? event.count : null,
    sample: event.sample || null,
  };
  session.events.push(item);
  if (session.events.length > MAX_EVENTS) session.events.shift();
  void persist(session);
  return item;
}

/** 追加一批数据行（只留前几条预览，避免快照无限变大）。 */
export function pushRows(phase, rows, { message = '', url = null, tabId = null } = {}) {
  if (!session) return null;
  const list = Array.isArray(rows) ? rows : [];
  return push({
    phase,
    level: 'info',
    message: message || (list.length + ' 行数据'),
    url,
    tabId,
    count: list.length,
    sample: list.slice(0, 5),
  });
}

async function persist(state) {
  // 串行化落盘：push() 是 fire-and-forget，若与 endSession 的落盘并发，
  // 后者会 truncate 文件，前者再写一遍 → 面板可能读到半截 JSON（实测偶发）。
  const previous = state.writeChain || Promise.resolve();
  state.writeChain = previous.then(() => writeSnapshot(state)).catch(() => {});
  return state.writeChain;
}

async function writeSnapshot(state) {
  try {
    const snapshot = {
      runId: state.runId,
      startedAt: state.startedAt,
      updatedAt: new Date().toISOString(),
      status: state.status,
      recording: Boolean(state.recorder && state.recorder.enabled),
      frames: state.recorder ? state.recorder.count : 0,
      recordError: state.recordError,
      events: state.events.slice(-MAX_EVENTS),
    };
    await writeFile(join(state.liveDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2), 'utf8');
    const last = snapshot.events[snapshot.events.length - 1];
    if (last) await appendFile(join(state.liveDir, 'events.ndjson'), JSON.stringify(last) + '\n', 'utf8');
  } catch {
    /* 落盘失败不影响主流程 */
  }
}

/** 结束会话：停录制、合成视频、写入最终快照。 */
export async function endSession({ status = 'done', message = '' } = {}) {
  if (!session) return { ok: true, recording: false };
  const state = session;
  session = null;
  state.status = status;
  let video = null;
  if (state.recorder) {
    const stopped = await state.recorder.stop();
    video = stopped.video || null;
    pushInto(state, {
      phase: 'record',
      level: 'info',
      message: video
        ? '录制结束：' + stopped.frames + ' 帧 → ' + video
        : '录制结束：' + stopped.frames + ' 帧（未合成视频）',
    });
  }
  if (message) pushInto(state, { phase: status, level: 'info', message });
  await persist(state);
  return { ok: true, recording: Boolean(video), video, frames: state.recorder ? state.recorder.count : 0, dir: state.liveDir, runId: state.runId };
}

/** 把实时会话产物复制进某个运行目录（面板按 runId 找）。 */
export async function attachToRun(runDir, liveDir) {
  const source = liveDir || (session ? session.liveDir : null);
  if (!source || !runDir) return false;
  try {
    await cp(source, join(runDir, 'live'), { recursive: true, force: true });
    // 录屏成片也在会话目录里，一并复制到运行目录，面板按 runId 就能播
    const video = join(source, '..', 'recording.mp4');
    try {
      await cp(video, join(runDir, 'recording.mp4'), { force: true });
    } catch {
      /* 没有视频就跳过 */
    }
    return true;
  } catch {
    return false;
  }
}

function pushInto(state, event) {
  const item = {
    at: new Date().toISOString(),
    phase: String(event.phase || 'step'),
    level: String(event.level || 'info'),
    message: String(event.message ?? ''),
    url: event.url || null,
    tabId: event.tabId || null,
    count: typeof event.count === 'number' ? event.count : null,
    sample: event.sample || null,
  };
  state.events.push(item);
  if (state.events.length > MAX_EVENTS) state.events.shift();
}
