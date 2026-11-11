import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * 面板响应时长守卫。
 *
 * 背景（实测踩过）：面板 overview 会顺带探测各数据源状态。
 * 网页登录态 provider 的 health() 原本要去开 Chrome 抓卖家精灵「选市场」页，
 * 单次 8~10 秒 → 面板请求超过前端 8 秒超时 → 前端报「运行记录加载失败」，
 * 后端明明 200 且数据完整。
 *
 * 这里用静态断言守住两个不变量：
 *   1. provider 状态探测必须带超时兜底；
 *   2. 网页链路的 health() 不得触发数据页抓取（只允许列标签页）。
 */

const root = fileURLToPath(new URL('../', import.meta.url));

async function read(rel) {
  return readFile(root + rel, 'utf8');
}

test('routes.js：provider 状态探测有超时保护', async () => {
  const src = await read('host/routes.js');
  assert.match(src, /PROVIDER_PROBE_TIMEOUT_MS/, '必须定义探测超时常量');
  assert.match(src, /withTimeout\(/, 'provider 状态收集必须走 withTimeout 包装');
  // 超时值必须显著小于前端 8 秒
  const m = /const PROVIDER_PROBE_TIMEOUT_MS = (\d+)/.exec(src);
  assert.ok(m, '必须能读到超时值');
  assert.ok(Number(m[1]) < 5000, '探测超时应 < 5000ms（前端总超时 8s）');
});

test('providers.js：网页 provider 的 status 有超时兜底', async () => {
  const src = await read('host/providers.js');
  assert.match(src, /Promise\.race\(/, 'web provider status 必须有超时兜底');
  assert.match(src, /网页登录态探测超时/, '必须给出超时错误文案');
});

test('网页 provider 的 health() 不抓数据页（只列标签页）', async () => {
  const src = await read('host/providers/sellersprite-web.js');
  // health 不得调用任何数据抓取函数
  const healthBody = /async health\([\s\S]*?\n  }/.exec(src);
  assert.ok(healthBody, '必须能定位 health 方法体');
  const body = healthBody[0];
  assert.doesNotMatch(body, /fetchMarketList/, 'health() 不得调用 fetchMarketList（会开浏览器抓数据页）');
  assert.doesNotMatch(body, /fetchNodeReport/, 'health() 不得调用 fetchNodeReport');
  assert.doesNotMatch(body, /fetchTopProducts/, 'health() 不得调用 fetchTopProducts');
  // 但要允许列标签页
  assert.match(src, /listTabs/, '轻量探测应通过 listTabs 判断登录态');
  // 且要有缓存，避免每次面板刷新都跑浏览器自动化
  assert.match(src, /HEALTH_TTL_MS/, '健康检查必须有 TTL 缓存');
});

test('前端超时预算与后端探测预算匹配', async () => {
  const client = await read('client.js');
  const m = /const TIMEOUT_MS = (\d+)/.exec(client);
  assert.ok(m, '必须能读到前端超时值');
  const clientTimeout = Number(m[1]);
  assert.ok(clientTimeout <= 8000, '前端超时不应超过 8s');

  const routes = await read('host/routes.js');
  const p = /const PROVIDER_PROBE_TIMEOUT_MS = (\d+)/.exec(routes);
  assert.ok(p, '必须能读到探测超时值');
  assert.ok(Number(p[1]) < clientTimeout, '后端探测超时应小于前端总超时');
});