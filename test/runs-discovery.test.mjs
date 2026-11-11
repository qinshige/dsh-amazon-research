import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listRunsMulti,
  listRunsFromIndex,
  registerRun,
  createRun,
  findRun,
  backfillRunIndex,
} from '../host/runs.js';
import { isHostInternalPath, outputRootCandidates } from '../host/paths.js';

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-runs-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedRun(root, runId, score = 62) {
  const dir = join(root, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ runId, title: runId, kind: 'category', site: 'US', createdAt: '2026-11-11T01:00:00.000Z' }));
  await writeFile(join(dir, 'scores.json'), JSON.stringify({ total: score, max: 92, normalized: 67.4, grade: '良好' }));
  return dir;
}

test('isHostInternalPath：拦截 profile 与应用包，放行工作区', () => {
  assert.equal(isHostInternalPath('/Users/qsg/.dsh/profiles/desktop/选品研究'), true);
  assert.equal(isHostInternalPath('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/x'), true);
  assert.equal(isHostInternalPath('/Users/qsg/Desktop/SH-TK/跨境电商/选品研究'), false);
  assert.equal(isHostInternalPath(''), false);
});

test('outputRootCandidates：过滤宿主内部路径并保序去重', () => {
  const roots = outputRootCandidates({
    outputRoot: '/Users/qsg/.dsh/profiles/desktop/选品研究',
    dataDir: '/tmp/dsr-data',
  }, '/tmp/explicit-out');
  assert.equal(roots[0], '/tmp/explicit-out');
  assert.ok(roots.every((p) => !p.includes('.dsh/profiles')), '不得包含 profile 目录');
});

test('listRunsMulti：跨多个根目录聚合且去重', async () => {
  await withDir(async (dir) => {
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await seedRun(a, '20261111_Hardware_US', 62);
    await seedRun(b, '20261110_Pulls_US', 70);
    const runs = await listRunsMulti([a, b], { limit: 10 });
    assert.equal(runs.length, 2);
    // 同一目录传两次不应重复
    const dedup = await listRunsMulti([a, a], { limit: 10 });
    assert.equal(dedup.length, 1);
  });
});

test('运行登记表：createRun 登记后即使不在候选根目录也能被面板发现', async () => {
  await withDir(async (dir) => {
    const registryDir = join(dir, 'registry');
    const outputRoot = join(dir, 'workspace', '选品研究');
    await mkdir(outputRoot, { recursive: true });
    const run = await createRun({ rootDir: outputRoot, kind: 'category', title: 'Hardware', site: 'US', label: 'Hardware', registryDir });
    await writeFile(join(run.dir, 'manifest.json'), JSON.stringify({ runId: run.runId, title: 'Hardware', kind: 'category', site: 'US', createdAt: '2026-11-11T02:00:00.000Z' }));
    await writeFile(join(run.dir, 'scores.json'), JSON.stringify({ total: 62, max: 92, normalized: 67.4, grade: '良好' }));

    // 登记表能列出来
    const indexed = await listRunsFromIndex(registryDir, { limit: 10 });
    assert.equal(indexed.length, 1);
    assert.equal(indexed[0].runId, run.runId);
    assert.equal(indexed[0].fromIndex, true);

    // 即使把候选根目录设成完全不相关的地方，findRun 靠登记表也能找到
    const found = await findRun([join(dir, 'nowhere')], run.runId, { registryDir });
    assert.equal(found.runId, run.runId);
    assert.ok(found.reportMd !== undefined);
  });
});

test('backfillRunIndex：扫根目录把历史运行补登记，且不重复', async () => {
  await withDir(async (dir) => {
    const registryDir = join(dir, 'registry');
    const root = join(dir, '选品研究');
    await mkdir(root, { recursive: true });
    await seedRun(root, '20261111_Hardware_US', 62);
    await seedRun(root, '20261110_Tarps_US', 75);

    const added = await backfillRunIndex(registryDir, [root]);
    assert.equal(added, 2);
    const listed = await listRunsFromIndex(registryDir, { limit: 10 });
    assert.equal(listed.length, 2);

    // 再跑一次不应重复登记
    const again = await backfillRunIndex(registryDir, [root]);
    assert.equal(again, 0);
    assert.equal((await listRunsFromIndex(registryDir, { limit: 10 })).length, 2);
  });
});

test('listRunsFromIndex：目录被删后自动跳过，不抛错', async () => {
  await withDir(async (dir) => {
    const registryDir = join(dir, 'registry');
    await mkdir(registryDir, { recursive: true });
    await registerRun(registryDir, { runId: 'gone', dir: join(dir, 'gone'), createdAt: '2026-11-11T00:00:00.000Z' });
    const runs = await listRunsFromIndex(registryDir, { limit: 10 });
    assert.equal(runs.length, 0);
  });
});
