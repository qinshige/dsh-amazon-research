import { createHash } from 'node:crypto';
import { writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createRun, writeArtifacts } from '../runs.js';
import { buildXlsx } from './xlsx.js';
import { evaluateTrendyolCandidates, WORKFLOW_STEPS } from './trendyol-workflow.js';

const missing = '待确认';
const cell = (v) => v === null || v === undefined || v === '' ? missing : v;
const md = (v) => String(cell(v)).replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ').replace(/</g, '&lt;');
const table = (headers, rows) => ['| ' + headers.map(md).join(' | ') + ' |', '| ' + headers.map(() => '---').join(' | ') + ' |', ...rows.map((r) => '| ' + r.map(md).join(' | ') + ' |')].join('\n');
const labels = { pool: '需求池', demand: '需求门槛', route: 'BB/LD路线分类', identity: '商品身份', compliance: '合规', logistics: '物流', sourcing: '1688寻源核价', economics: '单位经济', returns: '退货损失', quality: '质量可控', scoring: '人工评分', samples: '样品与供应商核验', test: '小批量测试', expansion: '扩货/终止' };

/** Values derive only from an economic result the gate engine actually produced. */
function sensitivity(e) {
  if (!e) return null;
  const upper = (targetMargin) => (e.priceSAR / 1.15 - e.priceSAR * (0.22 + targetMargin) - 15) * 1.8 - e.billableWeightKg * 68;
  return { breakEvenPriceSAR: e.breakEvenPriceSAR, maxPurchaseCNYAtBreakEven: upper(0), maxPurchaseCNYAt10Percent: upper(.10), maxPurchaseCNYAt15Percent: upper(.15) };
}

// Pure display of supplied sourcing metadata; this report performs no supplier verification.
const sourcingDisclosure = '额外国内运费/包装费按每销售单位CNY独立披露，未在固定沙特贡献利润公式中扣除；贡献利润不是扣完额外费用后的完整净利润。未知不补零。';
const evidenceDisplay = (value) => value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length) ? missing : typeof value === 'object' ? JSON.stringify(value) : value;
function sourcingRows(candidate) {
  const s = candidate?.sourcing;
  if (!s) return [['寻源状态', '未提供寻源数据（重跑须补齐，利润关卡暂停）']];
  const offer = s.offer || {}, detail = offer.detail || {}, selection = s.selection || {};
  const costs = selection.additionalCosts || s.additionalCosts || {};
  const rows = [
    ['寻源状态', s.status], ['缺失项', s.missing], ['警告', s.warnings], ['下一步', s.nextActions],
    ['1688链接', offer.url ?? detail.url], ['选定SKU', selection.sku], ['选定规格', selection.spec], ['选定数量', selection.quantity],
    ['选定单价CNY', selection.unitPriceCNY], ['阶梯价格（原始报价，非自动选档）', detail.priceTiers], ['MOQ起批量', detail.moq], ['MOQ原文', detail.moqText],
    ['计费重量kg', selection.billableWeightKg], ['规格证据', selection.specEvidence], ['价格及报价日期证据', selection.priceEvidence],
    ['计费重量证据', selection.weightEvidence], ['详情采集日期（不替代报价日期）', detail.fetchedAt],
    ['匹配类型', selection.matchType], ['路线证据', selection.route], ['搜索页证据（不替代详情报价）', offer.searchEvidence],
  ];
  for (const [key, label] of [['domesticFreightCNY', '额外国内运费'], ['packagingCNY', '额外包装费']]) {
    const cost = costs[key];
    rows.push([`${label}CNY/销售单位（公式未扣）`, cost?.status === 'unknown' ? null : cost?.amount], [`${label}计价口径`, cost?.basis], [`${label}来源`, cost?.source], [`${label}报价日期`, cost?.observedAt], [`${label}证据`, cost?.evidence]);
  }
  rows.push(['费用披露', sourcingDisclosure], ['上游核验标记（非报告核验）', s.verified], ['上游核验范围', s.verificationScope],
    ['证据纪律', '仅展示输入及路径索引；报告未访问1688或读取证据文件，不代表已核验供应商、SKU或费用。'],
    ['原始offer追溯', s.offer], ['原始selection追溯', s.selection]);
  return rows.map(([label, value]) => [label, evidenceDisplay(value)]);
}

function workbookSheets(result, candidates) {
  const profit = [['候选ID', '路线', '状态', '售价SAR', '采购CNY', '计费重kg', '贡献利润SAR', '贡献利润率', '数据来源']];
  const scenarios = [['候选ID', '真实输入情景', '售价SAR', '采购CNY', '计费重kg', '贡献利润SAR', '贡献利润率', '依据']];
  const returns = [['候选ID', '退回运费SAR', '是否预估', '最低已知损失SAR', '完整损失SAR', '预期退货成本SAR', '完整性', '缺失项']];
  const sensitivities = [['候选ID', '盈亏平衡售价SAR', '盈亏平衡采购上限CNY', '10%利润率采购上限CNY', '15%利润率采购上限CNY']];
  for (const r of result.candidates) {
    const e = r.economics;
    profit.push([r.id, r.route, r.status, e?.priceSAR, e?.purchaseCNY, e?.billableWeightKg, e?.contributionSAR, e?.contributionMargin, e?.evidence].map(cell));
    for (const key of ['pessimistic', 'neutral', 'optimistic']) {
      const s = r.scenarios?.[key];
      scenarios.push([r.id, key, s?.priceSAR, s?.purchaseCNY, s?.billableWeightKg, s?.contributionSAR, s?.contributionMargin, s?.evidence].map(cell));
    }
    const t = r.returns;
    returns.push([r.id, t?.returnFreightSAR, t?.returnFreightProvisional, t?.minimumKnownLossSAR, t?.completeLossSAR, t?.expectedReturnCostSAR, t ? (t.complete ? '完整' : '不完整：不可推荐') : '未到此关卡', t?.missing?.join(', ') || (t ? '见证据' : null)].map(cell));
    const s = sensitivity(e);
    sensitivities.push([r.id, s?.breakEvenPriceSAR, s?.maxPurchaseCNYAtBreakEven, s?.maxPurchaseCNYAt10Percent, s?.maxPurchaseCNYAt15Percent].map(cell));
  }
  const notes = [['项目', '口径'], ['贡献利润', '售价/1.15 - 售价*(0.10+0.08+0.04) - ((采购CNY+计费重kg*68)/1.8+10+5)'], ['利润率', '贡献利润/含税售价；工作流内部假设，非平台统一费率'], ['敏感性', '代数边界，不模拟乐观/悲观情景；采购上限为负代表无非负采购价可达标'], ['退货', '最低已知损失不是完整损失；未知不补零'], ['售后准备', '贡献利润已扣4%；预期退货成本仅单列，不重复扣减'], ['三档', '只使用明确提供且有依据的输入；缺失保持待确认'], ['结果', '暂停/观察/测试不等于推荐或扩货批准'], ['计算', '数值为引擎及代数结果快照，非Excel公式，不随手动修改输入自动重算']];
  return [{ name: '利润测算', rows: profit }, { name: '三档情景', rows: scenarios }, { name: '退货损失', rows: returns }, { name: '敏感性', rows: sensitivities }, { name: '口径说明', rows: notes }, { name: '1688寻源追溯', rows: [['候选ID', '字段', '输入值（非报告核验）'], ...result.candidates.flatMap((r, i) => sourcingRows(candidates[i]).map(([label, value]) => [r.id, label, value]))] }].map((s) => ({ ...s, widths: s.rows[0].map(() => 24) }));
}

function evidenceIndex(candidates) {
  return candidates.flatMap((c, index) => (Array.isArray(c?.evidence) ? c.evidence : []).flatMap((item) => {
    const path = typeof item === 'string' ? item : item?.path;
    if (typeof path !== 'string' || !path.trim()) return [];
    return [{ candidateId: c.id ?? String(index + 1), path, description: typeof item === 'object' ? item.description ?? '' : '', sourceUrl: typeof item === 'object' ? item.sourceUrl ?? '' : '', verified: false, note: '用户提供路径索引；未读取、复制或验证文件，非新采集截图' }];
  }));
}

/** Persist a strict workflow run. evidence[] is optional user-provided path metadata.
 * Never reads evidence files, fetches pages, or generates substitute evidence.
 */
export async function runTrendyolWorkflow({ candidates = [], outputRoot, registryDir = null, title = 'Trendyol.sa 严格选品工作流', source = '用户提供候选与核验证据' } = {}) {
  if (typeof outputRoot !== 'string' || !outputRoot.trim()) throw new TypeError('outputRoot is required');
  // Hash and retain JSON inputs exactly as evaluated. Reject non-JSON values instead of losing them.
  const input = { candidates, title, source };
  const inputJson = JSON.stringify(input, (_key, value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Inputs must contain finite JSON numbers');
    if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new TypeError('Inputs must be JSON values');
    return value;
  });
  const snapshot = JSON.parse(inputJson);
  const generatedAt = new Date().toISOString();
  const result = evaluateTrendyolCandidates({ candidates: snapshot.candidates, observedAt: generatedAt });
  const inputHash = createHash('sha256').update(inputJson).digest('hex');
  const evidence = evidenceIndex(snapshot.candidates);
  const summary = { total: result.candidates.length, paused: result.paused.length, eliminated: result.eliminated.length, ld: result.ldCandidates.length, expandEligible: result.candidates.filter((r) => r.status === 'expand-eligible').length };
  const sections = [`# ${md(title)}`, `生成时间：${generatedAt}；数据来源：${md(source)}。平台仅 Trendyol.sa / SA / SAR。`, '## 结论纪律', '本报告严格按工作流逐关记录。暂停、观察、小批量测试中的候选均不作推荐；不得跳过缺失证据。评分为有依据的人工维度分，不是实验92分模型。', table(['候选ID', '名称', '路线', '状态', '停止位置', '理由'], result.candidates.map((r) => [r.id, r.name, r.route, r.status, r.stoppedAt, r.reason]))];
  result.candidates.forEach((r, i) => {
    const inputCandidate = snapshot.candidates[i];
    sections.push(`## 候选 ${md(r.id)}：${md(r.name)}`, `数据快照日期：${md(inputCandidate?.pool?.observedAt)}；来源链接：${md(inputCandidate?.pool?.url)}`, table(['执行序号', '阶段', '状态', '依据/停止原因'], WORKFLOW_STEPS.map((key, index) => {
      const s = r.stages.find((v) => v.stage === key);
      return [index + 1, labels[key], s?.status ?? '未执行', s?.reason || s?.note || (s ? '通过，详见原始核验证据' : '前序关卡未通过，不得跳步')];
    })));
    if (inputCandidate?.sourcing) sections.push('### 1688寻源追溯与额外费用披露', sourcingDisclosure, table(['字段', '输入值（非报告核验）'], sourcingRows(inputCandidate)));
    if (r.economics) sections.push('### 已到达单位经济关卡', table(['贡献利润SAR', '贡献利润率', '盈亏平衡售价SAR'], [[r.economics.contributionSAR, r.economics.contributionMargin, r.economics.breakEvenPriceSAR]]));
    else sections.push('单位经济：未到此关卡，不计算利润。');
    sections.push(`人工BB总分：${r.score ? r.score.total + '/100' : '未评分（暂停或LD独立路线）'}。`, ...(r.warnings || []).map((w) => '- ' + md(w)));
  });
  sections.push('## 改良产品／轻差异化候选清单');
  if (!result.ldCandidates.length) sections.push('本轮无');
  else sections.push(table(['候选ID', '对标商品及当前数据', '未满足问题', '1688候选', '改良点', '新建页面原因', '初步利润SAR', '下一步'], result.candidates.flatMap((r, index) => {
    if (r.route !== 'LD') return [];
    const c = snapshot.candidates[index];
    return [[r.id, `${c.pool.url}；${c.pool.priceSAR} SAR；${c.pool.observedAt}`, c.route.unmetNeed, c.route.supplierUrl, c.route.improvementValue?.evidence, c.route.newListing?.evidence, r.economics?.contributionSAR, r.reason]];
  })));
  sections.push('## 产物与证据', '最终对标品.md / 淘汰候选.md / 利润测算.xlsx / evidence/index.json / provenance.json。', 'evidence只索引用户提供路径，不伪造图片。三档情景缺失为待确认；不得用当前主测算冒充已提供的中性情景。', `原始输入SHA-256：${inputHash}`);
  const report = sections.join('\n\n') + '\n';
  const rejected = '# 淘汰候选\n\n' + (result.eliminated.length ? table(['候选ID', '名称', '否决关卡', '原因'], result.eliminated.map((r) => [r.id, r.name, r.stoppedAt, r.reason])) : '本轮无已判定淘汰候选。暂停候选仍需补证，不能当作通过。') + '\n';
  const run = await createRun({ rootDir: outputRoot, registryDir, kind: 'trendyol-workflow', title, site: 'SA', label: title });
  const artifacts = await writeArtifacts(run, { 'report.md': report, '最终对标品.md': report, '淘汰候选.md': rejected, 'evaluation.json': result, 'provenance.json': { model: result.model, generatedAt, inputHash, hashAlgorithm: 'sha256', hashSerialization: 'JSON.stringify(input)', input: snapshot, source }, 'evidence/index.json': evidence, 'evidence/README.md': '# 实际证据路径索引\n\n' + (evidence.length ? table(['候选ID', '用户提供路径', '说明', '核验状态'], evidence.map((e) => [e.candidateId, e.path, e.description, e.note])) : '本轮未提供证据文件路径；未生成或伪造截图。') + '\n' });
  // writeArtifacts serializes objects as JSON and cannot write a binary Buffer.
  const workbookPath = join(run.dir, '利润测算.xlsx');
  await writeFile(workbookPath, buildXlsx(workbookSheets(result, snapshot.candidates)));
  artifacts.push({ name: '利润测算.xlsx', path: workbookPath, bytes: (await stat(workbookPath)).size });
  const manifest = { runId: run.runId, kind: 'trendyol-workflow', title, site: 'SA', marketplace: 'SA', platform: 'trendyol', provider: 'trendyol-web', model: result.model, createdAt: generatedAt, source, inputHash, summary, artifacts };
  artifacts.push(...await writeArtifacts(run, { 'manifest.json': manifest }));
  return { ok: true, runId: run.runId, dir: run.dir, reportPath: join(run.dir, 'report.md'), workbookPath, inputHash, summary, artifacts };
}
