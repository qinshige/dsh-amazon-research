/**
 * dsh-amazon-research · host/selection/pipeline.js
 *
 * 选品体检流水线：候选行（CSV / 数组）→ 十维体检 → 差异化 → 报告与产物落盘。
 * 不联网、不消耗数据服务额度；采购价、榜单数字必须由用户或其它工具提供。
 */
import { createRun, writeArtifacts } from '../runs.js';
import { buildSelectionPlan } from './channels.js';
import { evaluateBatch } from './kpis.js';
import { suggestDifferentiation } from './differentiate.js';
import { renderSelectionReport, renderSelectionCsv, sensitivity } from './report.js';

/** 最小 RFC4180 CSV 解析（支持引号、逗号、换行、BOM）。 */
export function parseCsv(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const clean = rows.filter((item) => item.some((value) => String(value).trim() !== ''));
  if (clean.length === 0) return [];
  const headers = clean[0].map((value) => String(value).trim());
  return clean.slice(1).map((values) => {
    const record = {};
    headers.forEach((header, index) => {
      if (header) record[header] = values[index] === undefined ? '' : values[index];
    });
    return record;
  });
}

function slimResult(item) {
  return {
    asin: item.asin,
    name: item.name,
    tier: item.tier,
    tierReason: item.tierReason,
    priceUSD: item.priceUSD,
    margin: item.margin,
    hitRate: item.hitRate,
    judgedCount: item.judgedCount,
    vetoes: item.vetoes,
    unknown: item.unknown,
    checks: item.checks,
    differentiation: item.differentiation,
  };
}

/**
 * 体检一批候选品并落盘。
 * @param {{rows:Array<object>, title?:string, marketplace?:string, fx?:number, outputRoot:string, dataDir?:string, source?:string, plan?:object}} params
 */
export async function screenCandidates({
  rows,
  title = '选品体检',
  marketplace = 'US',
  fx = 7.1,
  outputRoot,
  dataDir = null,
  source = '手动 / 采集表',
  plan = null,
} = {}) {
  const list = Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : [];
  if (list.length === 0) {
    const error = new Error('没有候选数据：请传 rows（数组）或 csv（文本）');
    error.code = 'INVALID_ARGS';
    throw error;
  }
  if (list.length > 200) {
    const error = new Error('一次最多体检 200 个候选，请分批');
    error.code = 'INVALID_ARGS';
    throw error;
  }
  if (!outputRoot) {
    const error = new Error('缺少输出目录 outputRoot');
    error.code = 'INVALID_ARGS';
    throw error;
  }

  const batch = evaluateBatch(list, { fx });
  for (const item of batch.results) {
    item.differentiation = suggestDifferentiation(item);
    if (item.profit) item.sensitivity = sensitivity(item.profit);
  }

  const generatedAt = new Date().toISOString();
  const site = String(marketplace || 'US').toUpperCase();
  const planData = plan || buildSelectionPlan({ marketplace: site });
  const run = await createRun({
    rootDir: outputRoot,
    kind: 'selection',
    title,
    site,
    label: title,
    registryDir: dataDir,
  });

  const reportMd = renderSelectionReport({
    title,
    marketplace: site,
    generatedAt,
    batch,
    plan: planData,
    source,
    fx,
  });
  const manifest = {
    runId: run.runId,
    kind: 'selection',
    title,
    site,
    marketplace: site,
    platform: 'amazon',
    provider: source,
    createdAt: generatedAt,
    generatedAt,
    count: batch.results.length,
    tiers: batch.summary.tiers,
    avgMargin: batch.summary.avgMargin,
    nodeIdPath: planData?.nodeIdPath || '',
    category: planData?.category || '',
  };
  const scores = {
    summary: batch.summary,
    results: batch.results.map(slimResult),
  };
  const artifacts = await writeArtifacts(run, {
    'manifest.json': manifest,
    // 不写 scores.json：面板会把「五维评分」当成类目评分渲染，选品批次没有总分。
    'selection-scores.json': scores,
    'report.md': reportMd,
    'selection.csv': renderSelectionCsv(batch),
  });

  return {
    ok: true,
    runId: run.runId,
    dir: run.dir,
    outputRoot,
    count: batch.results.length,
    summary: batch.summary,
    top: batch.results.slice(0, 5).map((item) => ({
      asin: item.asin,
      name: item.name,
      tier: item.tier,
      priceUSD: item.priceUSD,
      margin: item.margin,
      hitRate: item.hitRate,
      vetoes: item.vetoes.map((v) => v.label),
    })),
    artifacts,
    generatedAt,
  };
}
