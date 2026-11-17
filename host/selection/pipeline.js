/**
 * dsh-amazon-research · host/selection/pipeline.js
 *
 * 选品体检流水线：候选行（CSV / 数组）→ 十维体检 → 差异化 → 报告与产物落盘。
 * 不联网、不消耗数据服务额度；采购价、榜单数字必须由用户或其它工具提供。
 */
import { createHash } from 'node:crypto';
import { createRun, writeArtifacts } from '../runs.js';
import { buildSelectionPlan } from './channels.js';
import { evaluateBatch } from './kpis.js';
import { suggestDifferentiation } from './differentiate.js';
import { buildDecisionBrief, coachFor, compareChannels } from './brief.js';
import { decide, evaluateProfileFit, getProfile } from './profiles.js';
import { analyzeSegments } from './segments.js';
import { renderDataReport, renderSelectionReport, renderSelectionCsv, sensitivity } from './report.js';
import { getFx } from '../fx.js';

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

/** 稳定序列化（对象键排序），保证同一份输入得到同一个指纹。 */
function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** 输入指纹：sha256(排序后的输入行)，用于复核报告是否对应同一批数据。 */
export function inputFingerprint(rows) {
  return 'sha256:' + createHash('sha256').update(stableStringify(rows)).digest('hex');
}

function slimResult(item) {
  return {
    asin: item.asin,
    name: item.name,
    tier: item.tier,
    tierReason: item.tierReason,
    decision: item.decision ? item.decision.decision : null,
    decisionReason: item.decision ? item.decision.reason : null,
    profileFit: item.profileFit ? item.profileFit.status : null,
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
  fx = 6.7,
  costFx = null,
  settleFx = null,
  outputRoot,
  dataDir = null,
  source = '手动 / 采集表',
  plan = null,
  profile = 'beginner',
  targetMonthlyUnits = null,
  channel = 'amazon-fba',
  reportStyle = 'data',
  liveFx = true,
} = {}) {
  const list = Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object') : [];
  if (list.length === 0) {
    const error = new Error('没有候选数据：请传 rows（数组）或 csv（文本）');
    error.code = 'INVALID_ARGS';
    throw error;
  }
  if (list.length > 500) {
    const error = new Error('一次最多体检 500 个候选，请分批');
    error.code = 'INVALID_ARGS';
    throw error;
  }
  if (!outputRoot) {
    const error = new Error('缺少输出目录 outputRoot');
    error.code = 'INVALID_ARGS';
    throw error;
  }

  // 汇率：默认取实时汇率；取不到回落默认（成本 6.7 / 结算 6.6）。
  const fxCfg = await getFx({
    live: liveFx !== false,
    costFx: costFx === null || costFx === undefined ? undefined : costFx,
    settleFx: settleFx === null || settleFx === undefined ? undefined : settleFx,
  });
  const effectiveCostFx = fxCfg.costFx;
  const effectiveSettleFx = fxCfg.settleFx;

  const prof = getProfile(profile);
  const batch = evaluateBatch(list, { fx: effectiveCostFx, costFx: effectiveCostFx, settleFx: effectiveSettleFx, channel });
  for (const item of batch.results) {
    item.profileFit = evaluateProfileFit(item, prof, channel);
    item.decision = decide(item, item.profileFit, prof);
    item.differentiation = suggestDifferentiation(item);
    if (item.profit) item.sensitivity = sensitivity(item.profit);
    item.brief = buildDecisionBrief({ candidate: item, profile: prof, targetMonthlyUnits, fx });
    item.brief.channels = compareChannels(item, { fx: effectiveCostFx, costFx: effectiveCostFx, settleFx: effectiveSettleFx });
    item.coach = coachFor(item, item.brief);
  }
  batch.segmentAnalysis = analyzeSegments({ rows: list, channel, fx: effectiveCostFx, costFx: effectiveCostFx, settleFx: effectiveSettleFx, profile: prof });
  batch.summary.decisions = {
    做: batch.results.filter((item) => item.decision.decision === '做').length,
    小批量测: batch.results.filter((item) => item.decision.decision === '小批量测').length,
    先补数: batch.results.filter((item) => item.decision.decision === '先补数').length,
    不做: batch.results.filter((item) => item.decision.decision === '不做').length,
  };

  const generatedAt = new Date().toISOString();
  const inputHash = inputFingerprint(list);
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

  const artifactNames = ['manifest.json', 'provenance.json', 'selection-scores.json', 'report.md', 'selection.csv'];
  const renderReport = reportStyle === 'full' ? renderSelectionReport : renderDataReport;
  const reportMd = renderReport({
    title,
    marketplace: site,
    generatedAt,
    batch,
    plan: planData,
    source,
    fx: effectiveCostFx,
    costFx: effectiveCostFx,
    settleFx: effectiveSettleFx,
    fxInfo: fxCfg,
    profile: prof,
    targetMonthlyUnits,
    runId: run.runId,
    inputHash,
    channel,
    artifacts: artifactNames.map((name) => ({ name })),
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
    profile: prof.id,
    channel,
    inputHash,
    costFx: effectiveCostFx,
    settleFx: effectiveSettleFx,
    engine: 'selection-v1',
  };
  const scores = {
    inputHash,
    summary: batch.summary,
    segmentAnalysis: batch.segmentAnalysis,
    results: batch.results.map(slimResult),
  };
  const provenance = {
    runId: run.runId,
    generatedAt,
    engine: 'selection-v1',
    profile: prof.id,
    channel,
    title,
    marketplace: site,
    source,
    fx: effectiveCostFx,
    costFx: effectiveCostFx,
    settleFx: effectiveSettleFx,
    // 汇率来源与取数时间：报告里每个数字都能回到「用哪个汇率算的」
    fxInfo: fxCfg,
    inputHash,
    inputCount: list.length,
    // 原始输入行原样保存：报告里任何数字都可以回到这里核对。
    inputs: list,
    results: batch.results.map((item) => ({
      asin: item.asin,
      tier: item.tier,
      margin: item.margin,
      hitRate: item.hitRate,
      judgedCount: item.judgedCount,
      checks: item.checks,
      vetoes: item.vetoes,
      unknown: item.unknown,
      provenance: item.provenance,
      inputs: item.inputs,
      profit: item.profit,
    })),
  };
  const artifacts = await writeArtifacts(run, {
    'manifest.json': manifest,
    'provenance.json': provenance,
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
    inputHash,
    profile: prof.id,
    channel,
    reportStyle,
    brief: batch.results[0]?.brief || null,
  };
}
