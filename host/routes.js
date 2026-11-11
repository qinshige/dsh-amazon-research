import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { readConfig, writeConfig, resolveOutputRoot, outputRootCandidates, isHostInternalPath } from './paths.js';
import { listRuns, listRunsMulti, listRunsFromIndex, findRun } from './runs.js';

const API_PREFIX = '/amazon-research/api';
const MAX_JSON_BYTES = 64 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const FILE_WHITELIST = /^(report\.md|dashboard\.html|scores\.json|market\.json|manifest\.json|tables\/[\p{L}\p{N}._-]+\.csv)$/u;
/** 数据源状态探测超时（毫秒）——必须显著小于前端 8 秒超时。 */
const PROVIDER_PROBE_TIMEOUT_MS = 2500;

function isLoopback(request) {
  const address = request?.socket?.remoteAddress ?? '';
  return LOOPBACK.has(address);
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body, 'utf8')),
  });
  response.end(body);
}

function fail(response, status, code, message, hint) {
  sendJson(response, status, { ok: false, error: { code, message, ...(hint ? { hint } : {}) } });
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const done = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };
    request.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_JSON_BYTES) {
        done(() => {
          request.removeAllListeners('data');
          request.resume();
          reject(Object.assign(new Error('请求体过大'), { status: 413, code: 'too_large' }));
        });
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      done(() => {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(Object.assign(new Error('JSON 解析失败'), { status: 400, code: 'bad_json' }));
        }
      });
    });
    request.on('error', (error) => done(() => reject(error)));
  });
}

function contentTypeFor(name) {
  const ext = extname(name).toLowerCase();
  if (ext === '.md') return 'text/markdown; charset=utf-8';
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.csv') return 'text/csv; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

/**
 * 注册面板使用的 HTTP API。返回 dispose 函数（由调用方放进 ctx.effect）。
 * @returns {(() => void) | null}
 */
export function registerRoutes(ctx, deps) {
  const server = ctx.get?.('webServer');
  if (!server || typeof server.register !== 'function') return null;
  const { dataDir, secrets, providers, version } = deps;

  const dispatch = async (request, response) => {
    try {
      if (!isLoopback(request)) {
        fail(response, 403, 'forbidden', '选品研究接口只接受本机访问');
        return;
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      let path = url.pathname;
      if (!path.startsWith(API_PREFIX)) {
        fail(response, 404, 'not_found', '未知接口');
        return;
      }
      path = path.slice(API_PREFIX.length) || '/';
      if (path.length > 1) path = path.replace(/\/+$/, '');
      const method = (request.method ?? 'GET').toUpperCase();
      const config = await readConfig(dataDir);
      const outputRoot = resolveOutputRoot(config);
      // 实际产物可能分散在多个候选根目录（工作区/配置/数据目录）；
      // 面板必须聚合全部候选根，否则会出现「报告已生成、面板 0 条」。
      const roots = outputRootCandidates(config);

      if (path === '/health' && method === 'GET') {
        sendJson(response, 200, { ok: true, version, uptime: process.uptime() });
        return;
      }

      if (path === '/overview' && method === 'GET') {
        // 双通道：① 扫候选根目录 ② 读运行登记表（产物可能落在二者之外的目录）。
        // 合并去重后再按时间倒序，确保「报告已生成」时面板一定有记录。
        const scanned = await listRunsMulti(roots, { limit: 100 });
        const indexed = await listRunsFromIndex(dataDir, { limit: 100 });
        const merged = new Map();
        for (const run of [...scanned, ...indexed]) {
          const key = run.runId + '@' + run.dir;
          if (!merged.has(key)) merged.set(key, run);
        }
        const runs = [...merged.values()]
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
          .slice(0, 30);
        // 数据源状态探测必须有超时保护：任何一个慢探针（比如需要驱动浏览器的网页链路）
        // 都不该拖垮整个面板请求（前端只等 8 秒）。
        const withTimeout = (promise, ms, fallback) =>
          Promise.race([
            promise.catch((error) => ({ ok: false, lastError: String(error?.message ?? error) })),
            new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
          ]);
        const providersInfo = await Promise.all(
          providers.list().map(async (p) => {
            if (p.id === 'sellersprite-web') {
              const status = await withTimeout(
                providers.status(p.id),
                PROVIDER_PROBE_TIMEOUT_MS,
                { ok: false, lastError: '数据源状态探测超时' },
              );
              return {
                id: p.id,
                label: p.label,
                configured: true,
                ok: Boolean(status.ok),
                note: status.note || null,
                lastError: status.lastError || null,
                capabilities: p.capabilities,
              };
            }
            const described = await secrets.describe(p.id).catch(() => ({ configured: false }));
            return { id: p.id, label: p.label, configured: Boolean(described.configured), ok: Boolean(described.configured), capabilities: p.capabilities };
          }),
        );
        sendJson(response, 200, {
          ok: true,
          version,
          defaultMarketplace: config.marketplace,
          outputRoot,
          outputRoots: roots,
          config: { marketplace: config.marketplace, defaultLimit: config.defaultLimit, outputRoot: config.outputRoot || '', provider: config.provider },
          providers: providersInfo,
          runs,
        });
        return;
      }

      const runMatch = /^\/runs\/([^/]+)(\/file)?$/.exec(path);
      if (runMatch && method === 'GET') {
        const runId = decodeURIComponent(runMatch[1]);
        let run;
        try {
          run = await findRun(roots, runId, { registryDir: dataDir });
        } catch (error) {
          fail(response, 404, 'run_not_found', '找不到运行: ' + runId);
          return;
        }
        if (runMatch[2]) {
          const name = url.searchParams.get('name') || 'report.md';
          if (!FILE_WHITELIST.test(name)) {
            fail(response, 400, 'bad_file', '不允许读取该文件', '可读：report.md / dashboard.html / scores.json / market.json / manifest.json / tables/*.csv');
            return;
          }
          try {
            const content = await readFile(join(run.dir, name));
            response.writeHead(200, { 'content-type': contentTypeFor(name), 'cache-control': 'no-store' });
            response.end(content);
          } catch {
            fail(response, 404, 'file_not_found', '文件不存在: ' + name);
          }
          return;
        }
        const reportMd = run.reportMd.length > 200000 ? run.reportMd.slice(0, 200000) : run.reportMd;
        sendJson(response, 200, { ok: true, runId: run.runId, dir: run.dir, manifest: run.manifest, scores: run.scores, reportMd, artifacts: run.artifacts });
        return;
      }

      if (path === '/settings' && method === 'POST') {
        const body = await readJsonBody(request);
        const patch = {};
        if (typeof body.marketplace === 'string' && body.marketplace.trim()) patch.marketplace = body.marketplace.trim().toUpperCase();
        if (body.defaultLimit !== undefined) {
          const n = Math.min(100, Math.max(10, Math.round(Number(body.defaultLimit) || 50)));
          patch.defaultLimit = n;
        }
        if (typeof body.outputRoot === 'string') {
          const value = body.outputRoot.trim();
          if (value && isHostInternalPath(value)) {
            fail(response, 400, 'invalid_output_root', '输出目录不能设在宿主 profile 或应用包内部（该目录不属于你的工作区，报告会被写到你找不到的地方）', '请填工作区内的绝对路径，例如 /Users/you/work/选品研究');
            return;
          }
          patch.outputRoot = value;
        }
        const next = await writeConfig(dataDir, patch);
        sendJson(response, 200, { ok: true, config: { marketplace: next.marketplace, defaultLimit: next.defaultLimit, outputRoot: next.outputRoot || '' } });
        return;
      }

      if (path === '/credentials' && method === 'POST') {
        const body = await readJsonBody(request);
        const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
        const key = typeof body.key === 'string' ? body.key : '';
        if (!provider || !key.trim()) {
          fail(response, 400, 'invalid_args', 'provider 与 key 必填');
          return;
        }
        await secrets.set(provider, key);
        sendJson(response, 200, { ok: true, provider, configured: true });
        return;
      }

      if (path === '/credentials' && method === 'DELETE') {
        const body = await readJsonBody(request);
        const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
        if (!provider) {
          fail(response, 400, 'invalid_args', 'provider 必填');
          return;
        }
        await secrets.clear(provider);
        sendJson(response, 200, { ok: true, provider, configured: false });
        return;
      }

      fail(response, 404, 'not_found', '未知接口: ' + method + ' ' + path);
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500;
      fail(response, status, typeof error?.code === 'string' ? error.code : 'internal', String(error?.message ?? error));
    }
  };

  return server.register({ kind: 'prefix', path: API_PREFIX, handler: dispatch });
}
