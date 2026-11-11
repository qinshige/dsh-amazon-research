import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTools } from '../host/tools.js';

async function withDataDir(fn) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsr-test-'));
  try {
    return await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

function fakeProviders() {
  return {
    list: () => [
      { id: 'sellersprite', label: '卖家精灵', capabilities: ['market'] },
      { id: 'sorftime', label: 'Sorftime', capabilities: ['category'] },
    ],
    status: async (id) => ({ id, label: id, configured: id === 'sellersprite', ok: id === 'sellersprite', capabilities: [] }),
    call: async () => ({ ok: true }),
  };
}

function fakeSecrets() {
  return {
    describe: async (id) => ({ configured: id === 'sellersprite' }),
    get: async () => null,
    set: async () => ({ ok: true }),
    clear: async () => ({ ok: true }),
  };
}

test('research_provider_status 返回数据源与配置', async () => {
  await withDataDir(async (dataDir) => {
    const tools = createTools({ ctx: {}, dataDir, secrets: fakeSecrets(), providers: fakeProviders(), version: '0.1.0' });
    const status = tools.find((t) => t.name === 'research_provider_status');
    assert.ok(status);
    const result = await status.execute({ provider: 'all' });
    assert.equal(result.ok, true);
    assert.equal(result.providers.length, 2);
    assert.equal(result.providers[0].configured, true);
    assert.ok(result.config.outputRoot);
  });
});

test('research_runs 列出并读取运行目录', async () => {
  await withDataDir(async (dataDir) => {
    const root = join(dataDir, 'runs');
    const runDir = join(root, '20261110_test_US');
    await mkdir(join(runDir, 'tables'), { recursive: true });
    await writeFile(join(runDir, 'manifest.json'), JSON.stringify({ runId: '20261110_test_US', title: '测试类目', kind: 'category', site: 'US', createdAt: '2026-11-10T10:00:00.000Z' }));
    await writeFile(join(runDir, 'scores.json'), JSON.stringify({ total: 63, max: 92, normalized: 68.5, grade: '良好', dimensions: [] }));
    await writeFile(join(runDir, 'report.md'), '# 测试报告\n\n结论先行。');
    await writeFile(join(runDir, 'tables', 'brands.csv'), 'brand,units\nA,1\n');
    const tools = createTools({ ctx: {}, dataDir, secrets: fakeSecrets(), providers: fakeProviders(), version: '0.1.0' });
    const runs = tools.find((t) => t.name === 'research_runs');

    const listed = await runs.execute({ action: 'list', outDir: root });
    assert.equal(listed.ok, true);
    assert.equal(listed.runs.length, 1);
    assert.equal(listed.runs[0].total, 63);

    const detail = await runs.execute({ action: 'get', runId: '20261110_test_US', outDir: root });
    assert.equal(detail.ok, true);
    assert.match(detail.reportMd, /结论先行/);
    assert.ok(detail.artifacts.some((a) => a.name === 'tables/brands.csv'));
  });
});
