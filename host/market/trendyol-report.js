import { createHash } from 'node:crypto';
import { writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createRun, writeArtifacts } from '../runs.js';
import { buildXlsx } from './xlsx.js';
import { evaluateTrendyolCandidates, WORKFLOW_STEPS, STRICT_DEMAND_POLICY } from './trendyol-workflow.js';

const missing = '待确认';
const cell = (v) => v === null || v === undefined || v === '' ? missing : v;
const md = (v) => String(cell(v)).replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ').replace(/</g, '&lt;');
const table = (headers, rows) => ['| ' + headers.map(md).join(' | ') + ' |', '| ' + headers.map(() => '---').join(' | ') + ' |', ...rows.map((r) => '| ' + r.map(md).join(' | ') + ' |')].join('\n');
const labels = { pool: '需求池', demand: '需求门槛', route: 'BB/LD路线分类', identity: '商品身份', compliance: '合规', logistics: '物流', sourcing: '1688寻源核价', economics: '单位经济', returns: '退货损失', quality: '质量可控', scoring: '人工评分', samples: '样品与供应商核验', test: '小批量测试', expansion: '扩货/终止' };

/** 报告与工作簿一律输出中文；引擎内部状态码不外泄。 */
const STATUS_CN = {
  paused: '暂停', eliminated: '淘汰', 'expand-eligible': '可扩货', 'stop-replenishment': '停止补货',
  observe: '观察', testing: '小批量测试中', 'passed': '通过', 'failed': '未通过', 'unknown': '待确认',
  ready: '证据齐备', stopped: '已停止', ok: '正常',
};
const ROUTE_CN = { BB: 'BB（同款对标）', LD: 'LD（改良新建页）' };
const SCENARIO_CN = { pessimistic: '悲观情景', neutral: '中性情景', optimistic: '乐观情景' };
const STAGE_STATUS_CN = { passed: '通过', failed: '未通过', unknown: '待确认', paused: '暂停' };
/** 状态 → 一句话中文说明，报告顶部「怎么读」用。 */
const STATUS_HINT = {
  paused: '暂停：证据不足或未通过前序关卡，补齐后才能继续',
  eliminated: '淘汰：命中一票否决，不再继续',
  observe: '观察：信息不足，暂不推荐',
  testing: '小批量测试中：已上架首批，数据未跑够',
  'expand-eligible': '可扩货：全部前置条件通过，可考虑补货',
  'stop-replenishment': '停止补货：命中终止条件',
};
const cn = (value, map) => (value === null || value === undefined || value === '' ? '待确认' : (map[value] ?? String(value)));
const statusCn = (value) => cn(value, STATUS_CN);
const routeCn = (value) => cn(value, ROUTE_CN);
const scenarioCn = (value) => cn(value, SCENARIO_CN);

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
    ['寻源状态', statusCn(s.status)], ['缺失项', s.missing], ['警告', s.warnings], ['下一步', s.nextActions],
    ['1688链接', offer.url ?? detail.url], ['选定SKU', selection.sku], ['选定规格', selection.spec], ['选定数量', selection.quantity],
    ['选定单价CNY', selection.unitPriceCNY], ['阶梯价格（原始报价，非自动选档）', detail.priceTiers], ['MOQ起批量', detail.moq], ['MOQ原文', detail.moqText],
    ['计费重量kg', selection.billableWeightKg], ['规格证据', selection.specEvidence], ['价格及报价日期证据', selection.priceEvidence],
    ['计费重量证据', selection.weightEvidence], ['详情采集日期（不替代报价日期）', detail.fetchedAt],
    ['匹配类型', selection.matchType === 'similar' ? '类似款（需人工确认是否完全同款）' : selection.matchType], ['路线证据', selection.route], ['搜索页证据（不替代详情报价）', offer.searchEvidence],
  ];
  for (const [key, label] of [['domesticFreightCNY', '额外国内运费'], ['packagingCNY', '额外包装费']]) {
    const cost = costs[key];
    rows.push([`${label}CNY/销售单位（公式未扣）`, cost?.status === 'unknown' ? null : cost?.amount], [`${label}计价口径`, cost?.basis], [`${label}来源`, cost?.source], [`${label}报价日期`, cost?.observedAt], [`${label}证据`, cost?.evidence]);
  }
  rows.push(['费用披露', sourcingDisclosure], ['上游核验标记（非报告核验）', s.verified], ['上游核验范围', s.verificationScope],
    ['证据纪律', '仅展示输入及路径索引；报告未访问1688或读取证据文件，不代表已核验供应商、SKU或费用。']);
  return rows.map(([label, value]) => [label, evidenceDisplay(value)]);
}

/** 原始 JSON 追溯单独成节：保留可追溯性，但不让机器字段混在给人看的主表里。 */
function rawTraceRows(candidate) {
  const s = candidate?.sourcing;
  if (!s) return [];
  return [
    ['原始货源数据（机器格式，原样保留供复核）', evidenceDisplay(s.offer)],
    ['原始选定记录（机器格式，原样保留供复核）', evidenceDisplay(s.selection)],
  ];
}

function workbookSheets(result, candidates) {
  const profit = [['候选ID', '路线', '状态', '售价SAR', '采购CNY', '计费重kg', '贡献利润SAR', '贡献利润率', '数据来源']];
  const scenarios = [['候选ID', '真实输入情景', '售价SAR', '采购CNY', '计费重kg', '贡献利润SAR', '贡献利润率', '依据']];
  const returns = [['候选ID', '退回运费SAR', '是否预估', '最低已知损失SAR', '完整损失SAR', '预期退货成本SAR', '完整性', '缺失项']];
  const sensitivities = [['候选ID', '盈亏平衡售价SAR', '盈亏平衡采购上限CNY', '10%利润率采购上限CNY', '15%利润率采购上限CNY']];
  for (const r of result.candidates) {
    const e = r.economics;
    profit.push([r.id, routeCn(r.route), statusCn(r.status), e?.priceSAR, e?.purchaseCNY, e?.billableWeightKg, e?.contributionSAR, e?.contributionMargin, e?.evidence].map(cell));
    for (const key of ['pessimistic', 'neutral', 'optimistic']) {
      const s = r.scenarios?.[key];
      scenarios.push([r.id, scenarioCn(key), s?.priceSAR, s?.purchaseCNY, s?.billableWeightKg, s?.contributionSAR, s?.contributionMargin, s?.evidence].map(cell));
    }
    const t = r.returns;
    returns.push([r.id, t?.returnFreightSAR, t?.returnFreightProvisional ? '是（预估）' : '否', t?.minimumKnownLossSAR, t?.completeLossSAR, t?.expectedReturnCostSAR, t ? (t.complete ? '完整' : '不完整：不可推荐') : '未到此关卡', t?.missing?.join(', ') || (t ? '见证据' : null)].map(cell));
    const s = sensitivity(e);
    sensitivities.push([r.id, s?.breakEvenPriceSAR, s?.maxPurchaseCNYAtBreakEven, s?.maxPurchaseCNYAt10Percent, s?.maxPurchaseCNYAt15Percent].map(cell));
  }
  const notes = [['项目', '口径'], ['贡献利润', '售价/1.15 - 售价*(0.10+0.08+0.04) - ((采购CNY+计费重kg*68)/1.8+10+5)'], ['利润率', '贡献利润/含税售价；工作流内部假设，非平台统一费率'], ['敏感性', '代数边界，不模拟乐观/悲观情景；采购上限为负代表无非负采购价可达标'], ['退货', '最低已知损失不是完整损失；未知不补零'], ['售后准备', '贡献利润已扣4%；预期退货成本仅单列，不重复扣减'], ['三档', '只使用明确提供且有依据的输入；缺失保持待确认'], ['结果', '暂停/观察/测试不等于推荐或扩货批准'], ['计算', '数值为引擎及代数结果快照，非Excel公式，不随手动修改输入自动重算'], ['状态说明', '暂停=证据不足或未通过前序关卡；淘汰=命中一票否决；观察=信息不足；可扩货=全部前置条件通过']];
  return [{ name: '利润测算', rows: profit }, { name: '三档情景', rows: scenarios }, { name: '退货损失', rows: returns }, { name: '敏感性', rows: sensitivities }, { name: '口径说明', rows: notes }, { name: '1688寻源追溯', rows: [['候选ID', '字段', '输入值（非报告核验）'], ...result.candidates.flatMap((r, i) => sourcingRows(candidates[i]).map(([label, value]) => [r.id, label, value]))] }].map((s) => ({ ...s, widths: s.rows[0].map(() => 24) }));
}

function evidenceIndex(candidates) {
  return candidates.flatMap((c, index) => (Array.isArray(c?.evidence) ? c.evidence : []).flatMap((item) => {
    const path = typeof item === 'string' ? item : item?.path;
    if (typeof path !== 'string' || !path.trim()) return [];
    return [{ candidateId: c.id ?? String(index + 1), path, description: typeof item === 'object' ? item.description ?? '' : '', sourceUrl: typeof item === 'object' ? item.sourceUrl ?? '' : '', verified: false, note: '用户提供路径索引；未读取、复制或验证文件，非新采集截图' }];
  }));
}

const platformLabel = { 'trendyol-sa': 'Trendyol.sa', 'amazon-sa': 'Amazon.sa' };
const signalLabel = {
  'rating-count': '评分数', 'review-count': '文字评论数', rating: '星级', rank: '榜单位次',
  badge: '平台徽章', 'search-result-count': '搜索结果数', 'recent-growth': '近期增长',
  'seller-count': '卖家数量', 'unmet-need': '未满足需求',
};
const relationLabel = { 'same-product': '同款', 'same-purpose-same-spec': '同用途同规格', similar: '类似款', unknown: '未确认' };
const comparabilityLabel = { 'source-only': '仅来源参考', 'existence-check': '可用于存在性比对', 'not-comparable': '不可比' };

/** 需求观测按平台并列展示；不做聚合、不换算销量。 */
function demandRows(candidate, evaluated) {
  const observations = Array.isArray(candidate?.demand?.observations) ? candidate.demand.observations : [];
  if (!observations.length) return null;
  const passedIds = new Set((evaluated?.signals || []).filter((item) => item.status === 'passed').flatMap((item) => item.observationIds));
  return observations.map((item) => [
    item.id,
    platformLabel[item.sourcePlatform] || item.sourcePlatform,
    signalLabel[item.signalType] || item.signalType,
    item.value,
    item.unit,
    item.observedAt,
    relationLabel[item.candidateRelation] || item.candidateRelation || '未确认',
    comparabilityLabel[item.comparability] || item.comparability,
    passedIds.has(item.id) ? '计入需求门槛' : '未计入',
    item.sourceUrl,
  ]);
}

/** Persist a strict workflow run. evidence[] is optional user-provided path metadata.
 * Never reads evidence files, fetches pages, or generates substitute evidence.
 */
export async function runTrendyolWorkflow({ candidates = [], outputRoot, registryDir = null, title = 'Trendyol.sa 严格选品工作流', source = '用户提供候选与核验证据', demandPolicy = null } = {}) {
  if (typeof outputRoot !== 'string' || !outputRoot.trim()) throw new TypeError('outputRoot is required');
  const policy = demandPolicy && typeof demandPolicy === 'object' ? demandPolicy : STRICT_DEMAND_POLICY;
  // Hash and retain JSON inputs exactly as evaluated. Reject non-JSON values instead of losing them.
  const input = { candidates, title, source };
  const inputJson = JSON.stringify(input, (_key, value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Inputs must contain finite JSON numbers');
    if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new TypeError('Inputs must be JSON values');
    return value;
  });
  const snapshot = JSON.parse(inputJson);
  const generatedAt = new Date().toISOString();
  const result = evaluateTrendyolCandidates({ candidates: snapshot.candidates, observedAt: generatedAt, demandPolicy: policy });
  const inputHash = createHash('sha256').update(inputJson).digest('hex');
  const evidence = evidenceIndex(snapshot.candidates);
  const summary = { total: result.candidates.length, paused: result.paused.length, eliminated: result.eliminated.length, ld: result.ldCandidates.length, expandEligible: result.candidates.filter((r) => r.status === 'expand-eligible').length };
  const demandVerified = result.candidates.every((r) => r.demand?.verified === true);
  // 停止关卡分布：让读者一眼看出 85 行卡在哪一关
  const stopCounts = new Map();
  for (const r of result.candidates) {
    const key = r.stoppedAt ?? '全部通过';
    stopCounts.set(key, (stopCounts.get(key) ?? 0) + 1);
  }
  // 停止原因里的内部检查项名换成中文
  const CHECK_CN = {
    brandAndAuthenticity: '品牌真实性', barcodeAndProductCode: '条码与产品编码',
    attributes: '商品属性一致性', packagingLabelsOriginFunction: '包装标签与产地',
    supplierPhotosAndSource: '供应商实拍与货源来源', resaleAndCatalogPermission: '转售与上架许可',
    ipSearch: '知识产权检索', saberSaso: 'SABER/SASO 认证', specialCategory: '特殊类目',
    electricalBatteryWireless: '电池与无线', intellectualProperty: '知识产权',
    arabicLabelsOriginImporter: '阿语标签与进口商', netWeight: '净重', grossWeight: '毛重',
    dimensions: '包装尺寸', billingWeight: '计费重', carton: '装箱与外箱',
    neutralPackaging: '中性包装', dropTest: '跌落测试', controllable: '质量可控',
    newListing: '新建独立页面', improvementValue: '改良价值', launchCost: '开发成本',
    weightVideo: '称重视频', measurementPhoto: '测量照片', materialFinish: '材质与表面',
    priceTiers: '阶梯报价', cartonData: '装箱数据', defectAndRestockPolicy: '瑕疵与补货政策',
    moldOwnership: '模具归属', saudiResalePermission: '沙特转售许可',
    exclusiveCustomers: '独家客户', imageRights: '图片商用许可', authenticitySource: '品牌真实性来源',
    standardParcel: '标准件判定', tests: '样品测试', catalogApproved: '目录审核通过',
    actualReturns: '真实退货复盘', targetMargin: '目标利润率', actualReturnsAcceptable: '实际退货可接受',
    noInherentDefect: '无固有缺陷', stableBatchQuality: '批次质量稳定',
    buyboxAboveBreakEven: 'Buybox 高于盈亏平衡', cashFlowTurnover: '现金流周转',
  };
  const cnReason = (text) => {
    let out = String(text ?? '');
    for (const [key, label] of Object.entries(CHECK_CN)) out = out.split(key).join(label);
    return out;
  };
  const stopRows = [...stopCounts.entries()].sort((a, b) => b[1] - a[1]).map(([stage, count]) => [
    labels[stage] ?? (stage === '全部通过' ? '全部关卡通过' : stage),
    count,
    count === result.candidates.length ? '100%' : Math.round((count / result.candidates.length) * 100) + '%',
    stage === '全部通过' ? '可以进入样品与扩货' : cnReason(result.candidates.find((r) => r.stoppedAt === stage)?.reason ?? ''),
  ]);
  const sections = [
    `# ${md(title)}`,
    `生成时间：${generatedAt}；数据来源：${md(source)}。销售平台：Trendyol.sa / SA / SAR；找品来源：Amazon.sa（仅需求交叉验证，不产生候选）。`,
    '## 怎么读这份报告',
    table(['列名', '含义'], [
      ['候选ID', '你自己表里的编号，用它回到原表对照'],
      ['路线', 'BB = 与现有商品完全同款、共享原链接评分；LD = 改良后新建独立页面，不借用原商品评分'],
      ['状态', '暂停 / 淘汰 / 观察 / 小批量测试中 / 可扩货'],
      ['停止位置', '卡在哪一道关卡（需求池 → 需求门槛 → 路线 → 身份 → 合规 → 物流 → 寻源 → 利润 → 退货 → 质量 → 评分 → 样品 → 测试 → 扩货）'],
      ['理由', '为什么停在这里、缺什么证据'],
      ['金额单位', 'SAR = 沙特里亚尔；CNY = 人民币；kg = 公斤'],
    ]),
    table(['状态', '意思'], Object.entries(STATUS_HINT).map(([key, text]) => [STATUS_CN[key], text])),
    '## 一、总览',
    table(['指标', '数量', '说明'], [
      ['候选总数', result.candidates.length, '本轮送入工作流的全部候选'],
      ['可扩货', summary.expandEligible, '全部前置条件都通过，可以考虑补货'],
      ['暂停', summary.paused, '证据不足或未通过前序关卡，补齐后继续'],
      ['淘汰', summary.eliminated, '命中一票否决，不再继续'],
      ['独立改良页（LD）', summary.ld, '单独机会池，不参与同款排名'],
    ]),
    '### 卡在哪一关（按数量从多到少）',
    table(['停止关卡', '候选数', '占比', '说明'], stopRows),
    '## 结论纪律',
    '本报告严格按工作流逐关记录。暂停、观察、小批量测试中的候选均不作推荐；不得跳过缺失证据。评分为有依据的人工维度分，不是实验92分模型。',
    `需求证据来源核验：${demandVerified ? '全部候选均提供了分平台观测（至少1项需求证据来自 Trendyol.sa 由引擎校验）' : '未提供分平台需求观测的候选，无法核验「至少1项来自Trendyol.sa」，不得当作通过'}。`,
    '## 二、候选总表',
    table(['候选ID', '名称', '路线', '状态', '停止位置', '理由'], result.candidates.map((r) => [r.id, r.name, routeCn(r.route), statusCn(r.status), labels[r.stoppedAt] ?? (r.stoppedAt ? r.stoppedAt : '全部通过'), cnReason(r.reason)])),
  ];
  result.candidates.forEach((r, i) => {
    const inputCandidate = snapshot.candidates[i];
    sections.push(`## 候选 ${md(r.id)}：${md(r.name)}`, `当前状态：${statusCn(r.status)}｜路线：${routeCn(r.route)}｜停止位置：${labels[r.stoppedAt] ?? (r.stoppedAt ?? '全部关卡通过')}`, `数据快照日期：${md(inputCandidate?.pool?.observedAt)}；来源链接：${md(inputCandidate?.pool?.url)}`, table(['执行序号', '阶段', '状态', '依据/停止原因'], WORKFLOW_STEPS.map((key, index) => {
      const s = r.stages.find((v) => v.stage === key);
      return [index + 1, labels[key], s?.status ? (STAGE_STATUS_CN[s.status] ?? s.status) : '未执行', cnReason(s?.reason || s?.note || (s ? '通过，详见原始核验证据' : '前序关卡未通过，不得跳步'))];
    })));
    const rows = demandRows(inputCandidate, r.demand);
    if (rows) {
      sections.push('### 需求观测（分平台并列，不聚合）', table(['观测ID', '来源平台', '信号', '值', '单位', '观测日期', '与候选关系', '可比性', '是否计入门槛', '来源链接'], rows), `需求门槛：${r.demand?.passed ?? 0}/4 通过，其中 Trendyol.sa ${r.demand?.trendyolPassed ?? 0} 项。两平台数值只并列，不相加、不平均、不换算销量。`);
    } else sections.push('需求观测：未提供分平台观测，需求来源无法逐条追溯。');
    if (inputCandidate?.sourcing) {
      sections.push('### 1688寻源追溯与额外费用披露', sourcingDisclosure, table(['字段', '输入值（非报告核验）'], sourcingRows(inputCandidate)));
      const rawRows = rawTraceRows(inputCandidate);
      if (rawRows.length) sections.push('<details><summary>展开原始数据（机器格式，供复核）</summary>', table(['字段', '原始值'], rawRows), '</details>');
    }
    if (r.economics) sections.push('### 已到达单位经济关卡', table(['贡献利润SAR', '贡献利润率', '盈亏平衡售价SAR'], [[r.economics.contributionSAR, r.economics.contributionMargin, r.economics.breakEvenPriceSAR]]));
    else sections.push('单位经济：未到此关卡，不计算利润。');
    sections.push(`人工BB总分：${r.score ? r.score.total + '/100' : '未评分（暂停或LD独立路线）'}。`, ...(r.warnings || []).map((w) => '- ' + md(w)));
  });
  sections.push('## 改良产品／轻差异化候选清单（LD 独立页面，不参与同款排名）');
  if (!result.ldCandidates.length) sections.push('本轮无');
  else sections.push(table(['候选ID', '对标商品及当前数据', '未满足问题', '1688候选', '改良点', '新建页面原因', '初步利润SAR', '下一步'], result.candidates.flatMap((r, index) => {
    if (r.route !== 'LD') return [];
    const c = snapshot.candidates[index];
    return [[r.id, `${c.pool.url}；${c.pool.priceSAR} SAR；${c.pool.observedAt}`, c.route.unmetNeed, c.route.supplierUrl, c.route.improvementValue?.evidence, c.route.newListing?.evidence, r.economics?.contributionSAR, r.reason]];
  })));
  sections.push('## 产物与证据', '最终对标品.md / 淘汰候选.md / 利润测算.xlsx / evidence/index.json / provenance.json。', 'evidence只索引用户提供路径，不伪造图片。三档情景缺失为待确认；不得用当前主测算冒充已提供的中性情景。', `原始输入SHA-256：${inputHash}`);
  const report = sections.join('\n\n') + '\n';
  const rejected = '# 淘汰候选\n\n' + (result.eliminated.length
    ? '命中一票否决、不再继续的候选。\n\n' + table(['候选ID', '名称', '否决关卡', '原因'], result.eliminated.map((r) => [r.id, r.name, labels[r.stoppedAt] ?? r.stoppedAt, r.reason]))
    : '本轮无已判定淘汰候选。暂停候选仍需补证，不能当作通过。') + '\n';
  const run = await createRun({ rootDir: outputRoot, registryDir, kind: 'trendyol-workflow', title, site: 'SA', label: title });
  const artifacts = await writeArtifacts(run, { 'report.md': report, '最终对标品.md': report, '淘汰候选.md': rejected, 'evaluation.json': result, 'provenance.json': { model: result.model, generatedAt, inputHash, hashAlgorithm: 'sha256', hashSerialization: 'JSON.stringify(input)', input: snapshot, source }, 'evidence/index.json': evidence, 'evidence/README.md': '# 实际证据路径索引\n\n' + (evidence.length ? table(['候选ID', '用户提供路径', '说明', '核验状态'], evidence.map((e) => [e.candidateId, e.path, e.description, e.note])) : '本轮未提供证据文件路径；未生成或伪造截图。') + '\n' });
  // writeArtifacts serializes objects as JSON and cannot write a binary Buffer.
  const workbookPath = join(run.dir, '利润测算.xlsx');
  await writeFile(workbookPath, buildXlsx(workbookSheets(result, snapshot.candidates)));
  artifacts.push({ name: '利润测算.xlsx', path: workbookPath, bytes: (await stat(workbookPath)).size });
  const manifest = { runId: run.runId, kind: 'trendyol-workflow', title, site: 'SA', marketplace: 'SA', platform: 'trendyol', provider: 'trendyol-web', salesPlatform: 'trendyol-sa', demandSources: ['trendyol-sa', 'amazon-sa'], demandPolicy: policy, model: result.model, createdAt: generatedAt, source, inputHash, summary, artifacts };
  artifacts.push(...await writeArtifacts(run, { 'manifest.json': manifest }));
  return { ok: true, runId: run.runId, dir: run.dir, reportPath: join(run.dir, 'report.md'), workbookPath, inputHash, summary, artifacts };
}
