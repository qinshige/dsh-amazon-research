import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SAFE_NAME = /[^\p{L}\p{N}._-]+/gu;

/** 生成运行 id：YYYYMMDD_<slug>_<site>（中文保留，空格/符号归一为下划线） */
export function makeRunId({ date = new Date(), label = 'run', site = 'US' } = {}) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const slug = String(label || 'run').trim().replace(SAFE_NAME, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'run';
  return y + m + d + '_' + slug + '_' + String(site || 'US').toUpperCase();
}

/** 运行登记表路径 */
function runIndexPath(registryDir) {
  return join(resolve(registryDir), 'run-index.json');
}

/** 读取运行登记表（不存在/损坏时返回空数组） */
export async function readRunIndex(registryDir) {
  if (!registryDir) return [];
  try {
    const parsed = JSON.parse(await readFile(runIndexPath(registryDir), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.dir === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 写入一条运行登记。
 *
 * 为什么需要：宿主进程的 cwd 不一定是用户工作区，产物可能被写到
 * config.outputRoot / dataDir/runs / 工作区 等不同位置。只靠「扫固定根目录」
 * 会出现报告已生成、面板却 0 条的情况。登记表记录每次运行的绝对目录，
 * 面板按登记表回读，与产物落点解耦。
 */
export async function registerRun(registryDir, entry) {
  if (!registryDir || !entry || !entry.dir) return;
  await mkdir(resolve(registryDir), { recursive: true });
  const list = await readRunIndex(registryDir);
  const next = list.filter((e) => e.dir !== entry.dir);
  next.push({
    runId: entry.runId ?? null,
    dir: entry.dir,
    kind: entry.kind ?? 'unknown',
    title: entry.title ?? '',
    site: entry.site ?? '',
    createdAt: entry.createdAt ?? new Date().toISOString(),
  });
  // 只保留最近 200 条，避免无限增长
  next.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const trimmed = next.slice(0, 200);
  const tmp = runIndexPath(registryDir) + '.tmp';
  await writeFile(tmp, JSON.stringify(trimmed, null, 2) + '\n', 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, runIndexPath(registryDir));
}

/**
 * 回填运行登记表：扫候选根目录，把已有的运行补登记。
 * 用于插件启动时自愈（历史产物可能散落在多个位置）。
 */
export async function backfillRunIndex(registryDir, rootDirs) {
  if (!registryDir) return 0;
  const roots = Array.isArray(rootDirs) ? rootDirs.filter((dir) => typeof dir === 'string' && dir.trim()) : [];
  const existing = new Set((await readRunIndex(registryDir)).map((entry) => entry.dir));
  let added = 0;
  for (const root of roots) {
    let dirs = [];
    try {
      dirs = await readdir(resolve(root), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of dirs) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = join(resolve(root), entry.name);
      if (existing.has(dir)) continue;
      try {
        const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
        await registerRun(registryDir, {
          runId: manifest.runId || entry.name,
          dir,
          kind: manifest.kind,
          title: manifest.title,
          site: manifest.site,
          createdAt: manifest.createdAt,
        });
        existing.add(dir);
        added += 1;
      } catch {
        /* 无 manifest 的目录跳过 */
      }
    }
  }
  return added;
}

/** 从登记表列运行（按 createdAt 倒序） */
export async function listRunsFromIndex(registryDir, { limit = 30 } = {}) {
  const entries = await readRunIndex(registryDir);
  const runs = [];
  for (const entry of entries) {
    try {
      const manifest = JSON.parse(await readFile(join(entry.dir, 'manifest.json'), 'utf8'));
      let scores = null;
      try {
        scores = JSON.parse(await readFile(join(entry.dir, 'scores.json'), 'utf8'));
      } catch {
        /* 可选 */
      }
      runs.push({
        runId: manifest.runId || entry.runId || entry.dir.split('/').pop(),
        dir: entry.dir,
        title: manifest.title || entry.title || '',
        kind: manifest.kind || entry.kind || 'unknown',
        site: manifest.site || entry.site || '',
        marketplace: manifest.marketplace || manifest.site || entry.site || '',
        provider: manifest.provider || '',
        createdAt: manifest.createdAt || entry.createdAt || '',
        total: scores && typeof scores.total === 'number' ? scores.total : manifest.total ?? null,
        max: scores && typeof scores.max === 'number' ? scores.max : manifest.max ?? null,
        normalized: scores && typeof scores.normalized === 'number' ? scores.normalized : manifest.normalized ?? null,
        grade: (scores && scores.grade) || manifest.grade || '',
        outputRoot: entry.dir.slice(0, entry.dir.lastIndexOf('/')),
        fromIndex: true,
      });
    } catch {
      /* 目录已删除或 manifest 损坏：跳过 */
    }
  }
  runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return runs.slice(0, limit);
}

/** 创建运行目录（重名自动加 -2/-3） */
export async function createRun({ rootDir, kind, title, site, label, registryDir = null }) {
  const root = resolve(rootDir);
  const runId = makeRunId({ label: label || title || kind, site });
  let dir = join(root, runId);
  let attempt = 2;
  for (;;) {
    try {
      await mkdir(dir, { recursive: false });
      break;
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        dir = join(root, runId + '-' + attempt);
        attempt += 1;
        if (attempt > 50) throw new Error('无法创建运行目录: ' + dir);
        continue;
      }
      await mkdir(root, { recursive: true });
      await mkdir(dir, { recursive: true });
      break;
    }
  }
  const created = { runId: dir.split('/').pop(), dir, rootDir: root, kind, title, site };
  if (registryDir) {
    await registerRun(registryDir, created).catch(() => {
      /* 登记失败不影响主流程：面板仍有扫目录兜底 */
    });
  }
  return created;
}

/** 写入产物（文件名 → 内容），返回产物清单 */
export async function writeArtifacts(run, files) {
  const artifacts = [];
  for (const [name, content] of Object.entries(files || {})) {
    if (content === undefined || content === null) continue;
    const target = join(run.dir, name);
    const parent = target.slice(0, target.lastIndexOf('/'));
    if (parent && parent !== run.dir) await mkdir(parent, { recursive: true });
    await writeFile(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n', 'utf8');
    const info = await stat(target);
    artifacts.push({ name, path: target, bytes: info.size });
  }
  return artifacts;
}

/**
 * 跨多个根目录列出运行（按 createdAt 倒序，runId 去重）。
 *
 * 为什么需要：实际输出目录可能因「运行环境 cwd 不同」而分散在多处
 * （工作区/选品研究、config.outputRoot、dataDir/runs）。只读单一根目录时，
 * 报告明明生成了、面板却显示 0 条（实测踩过）。
 */
export async function listRunsMulti(rootDirs, { limit = 30 } = {}) {
  const roots = Array.isArray(rootDirs) ? rootDirs.filter((dir) => typeof dir === 'string' && dir.trim()) : [];
  const seen = new Map();
  for (const root of roots) {
    const runs = await listRuns(root, { limit: 200 });
    for (const run of runs) {
      const key = run.runId + '@' + run.dir;
      if (seen.has(key)) continue;
      seen.set(key, { ...run, outputRoot: root });
    }
  }
  const all = [...seen.values()];
  all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return all.slice(0, limit);
}

/** 在多个根目录中查找同名 runId（先找到先返回） */
export async function findRun(rootDirs, runId, { limit = 200, registryDir = null } = {}) {
  const roots = Array.isArray(rootDirs) ? rootDirs.filter((dir) => typeof dir === 'string' && dir.trim()) : [];
  if (registryDir) {
    const entries = await readRunIndex(registryDir);
    const hit = entries.find((entry) => entry.runId === runId || entry.dir.split('/').pop() === runId);
    if (hit) {
      try {
        return await readRun(hit.dir.slice(0, hit.dir.lastIndexOf('/')), hit.dir.split('/').pop());
      } catch {
        /* 登记表条目失效：继续按目录扫 */
      }
    }
  }
  for (const root of roots) {
    const runs = await listRuns(root, { limit });
    const hit = runs.find((run) => run.runId === runId);
    if (hit) return await readRun(root, runId);
  }
  const err = new Error('找不到运行: ' + runId);
  err.code = 'RUN_NOT_FOUND';
  throw err;
}

/** 列出运行（读每个目录的 manifest.json，按 createdAt 倒序） */
export async function listRuns(rootDir, { limit = 30 } = {}) {
  const root = resolve(rootDir);
  let dirs = [];
  try {
    dirs = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs = [];
  for (const entry of dirs) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = join(root, entry.name);
    try {
      const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
      let scores = null;
      try {
        scores = JSON.parse(await readFile(join(dir, 'scores.json'), 'utf8'));
      } catch {
        /* 可选 */
      }
      runs.push({
        runId: manifest.runId || entry.name,
        dir,
        title: manifest.title || entry.name,
        kind: manifest.kind || 'unknown',
        site: manifest.site || '',
        marketplace: manifest.marketplace || manifest.site || '',
        provider: manifest.provider || '',
        createdAt: manifest.createdAt || '',
        total: scores && typeof scores.total === 'number' ? scores.total : manifest.total ?? null,
        max: scores && typeof scores.max === 'number' ? scores.max : manifest.max ?? null,
        normalized: scores && typeof scores.normalized === 'number' ? scores.normalized : manifest.normalized ?? null,
        grade: (scores && scores.grade) || manifest.grade || '',
      });
    } catch {
      /* 无 manifest 的目录跳过 */
    }
  }
  runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return runs.slice(0, limit);
}

/** 读取一次运行的完整内容（报告与产物清单） */
export async function readRun(rootDir, runId) {
  const root = resolve(rootDir);
  const dir = join(root, String(runId || '').replace(/[\/]/g, ''));
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  } catch {
    const err = new Error('找不到运行: ' + runId);
    err.code = 'RUN_NOT_FOUND';
    throw err;
  }
  const safeRead = async (name) => {
    try {
      return await readFile(join(dir, name), 'utf8');
    } catch {
      return null;
    }
  };
  const reportMd = (await safeRead('report.md')) || '';
  const scoresRaw = await safeRead('scores.json');
  let scores = null;
  try {
    scores = scoresRaw ? JSON.parse(scoresRaw) : null;
  } catch {
    scores = null;
  }
  const artifacts = [];
  const walk = async (sub) => {
    const abs = join(dir, sub);
    let entries = [];
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = sub ? sub + '/' + entry.name : entry.name;
      if (entry.isDirectory()) await walk(rel);
      else {
        const info = await stat(join(dir, rel));
        artifacts.push({ name: rel, path: join(dir, rel), bytes: info.size });
      }
    }
  };
  await walk('');
  return { runId: manifest.runId || runId, dir, manifest, scores, reportMd, artifacts };
}
