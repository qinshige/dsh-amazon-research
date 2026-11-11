import { homedir } from 'node:os';
import { join, resolve, isAbsolute, sep } from 'node:path';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';

/** 解析插件数据目录：config.dataDir > $DSH_HOME/amazon-research > ~/.dsh/amazon-research */
export function resolveDataDir(configured) {
  const explicit = typeof configured === 'string' ? configured.trim() : '';
  if (explicit) return resolve(explicit);
  const home = (process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh');
  return join(home, 'amazon-research');
}

/**
 * 判断一个路径是否落在「宿主 profile / 应用包」内部。
 *
 * 为什么必须排除：宿主进程的 cwd 常常就是 profile 目录（或应用包内），
 * 早期版本会把「cwd/选品研究」当成输出目录并写进 config.json，
 * 结果报告写到 profile 下、用户在面板里永远看不到（实测踩过）。
 */
export function isHostInternalPath(input) {
  const text = typeof input === 'string' ? input : '';
  if (!text) return false;
  const p = text.split(sep).join('/');
  if (/\/\.dsh(\/|$)/u.test(p)) return true;
  if (p.includes('app.asar')) return true;
  if (p.includes('DeepSeek Harness.app')) return true;
  return false;
}

/** 读取 dataDir/config.json（不存在时返回默认值） */
export async function readConfig(dataDir) {
  const defaults = { marketplace: 'US', defaultLimit: 50, outputRoot: '', provider: 'sellersprite', unitCost: null, cacheTtlHours: 24 };
  try {
    const raw = await readFile(join(dataDir, 'config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const merged = { ...defaults, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    // 自愈：历史上被写进 config 的宿主内部路径（profile 目录）一律视为无效，
    // 否则面板会一直指向一个空目录。
    if (merged.outputRoot && isHostInternalPath(merged.outputRoot)) merged.outputRoot = '';
    return merged;
  } catch {
    return defaults;
  }
}

/** 合并写回 config.json（原子性足够：先写临时文件再 rename） */
export async function writeConfig(dataDir, patch) {
  const current = await readConfig(dataDir);
  const next = { ...current, ...(patch || {}) };
  await mkdir(dataDir, { recursive: true });
  const tmp = join(dataDir, '.config.json.tmp');
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  await chmod(tmp, 0o600);
  const { rename } = await import('node:fs/promises');
  await rename(tmp, join(dataDir, 'config.json'));
  return next;
}

/** 候选输出根目录（按优先级）：显式 outDir > config.outputRoot > 宿主 cwd/选品研究 > dataDir/runs */
export function outputRootCandidates(config, explicit) {
  const out = [];
  const push = (value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return;
    const abs = resolve(text);
    if (isHostInternalPath(abs)) return;
    if (!out.includes(abs)) out.push(abs);
  };
  push(explicit);
  push(config?.outputRoot);
  try {
    const cwd = process.cwd();
    if (cwd && cwd !== '/' && isAbsolute(cwd) && !isHostInternalPath(cwd)) push(join(cwd, '选品研究'));
  } catch {
    /* cwd 不可读：跳过 */
  }
  const dataRuns = join(resolveDataDir(config?.dataDir), 'runs');
  if (!out.includes(dataRuns)) out.push(dataRuns);
  return out;
}

/**
 * 解析报告输出根目录（写入用）：取候选列表第一个。
 * 优先级：工具调用显式 outDir > config.outputRoot > 宿主 cwd/选品研究 > dataDir/runs
 */
export function resolveOutputRoot(config, explicit) {
  const candidates = outputRootCandidates(config, explicit);
  return candidates[0];
}
