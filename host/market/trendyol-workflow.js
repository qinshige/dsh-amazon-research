/** Pure, fail-closed implementation of the user's Trendyol Saudi workflow v1.
 * A check is {status:'passed'|'failed'|'unknown', evidence:'source / finding'}.
 * Human checks assert verified facts, not platform certification or legal advice.
 * No browser, I/O, clocks, inferred scores, FX lookup, or invented scenarios.
 */
import { prepareSaudiCandidate } from '../sourcing/saudi.js';

export const WORKFLOW_MODEL = 'trendyol-saudi-workflow-v1';
export const WORKFLOW_STEPS = ['pool', 'demand', 'route', 'identity', 'compliance', 'logistics', 'sourcing', 'economics', 'returns', 'quality', 'scoring', 'samples', 'test', 'expansion'];
export const SCORE_WEIGHTS = { demand: 30, economics: 30, logistics: 15, quality: 15, supply: 10 };
export const FIXED_FEES = { vatRate: 0.15, commissionRate: 0.10, adRate: 0.08, afterSalesRate: 0.04, freightCNYPerKg: 68, cnyPerSAR: 1.8, forwardSAR: 10, fixedSAR: 5, provisionalReturnSAR: 15 };
const IDENTITY = ['brandAndAuthenticity', 'barcodeAndProductCode', 'attributes', 'packagingLabelsOriginFunction', 'supplierPhotosAndSource', 'resaleAndCatalogPermission', 'ipSearch'];
const COMPLIANCE = ['saberSaso', 'specialCategory', 'electricalBatteryWireless', 'intellectualProperty', 'arabicLabelsOriginImporter'];
const LOGISTICS = ['netWeight', 'grossWeight', 'dimensions', 'billingWeight', 'carton', 'neutralPackaging', 'dropTest'];
const SUPPLIER = ['weightVideo', 'measurementPhoto', 'materialFinish', 'priceTiers', 'neutralPackaging', 'cartonData', 'defectAndRestockPolicy', 'moldOwnership', 'saudiResalePermission', 'exclusiveCustomers', 'imageRights', 'authenticitySource'];
const EXPANSION = ['targetMargin', 'actualReturnsAcceptable', 'noInherentDefect', 'stableBatchQuality', 'buyboxAboveBreakEven', 'cashFlowTurnover'];
const TERMINATION = ['priceBelowBreakEven', 'identityOrBrandComplaint', 'batchDefects', 'returnLossAboveLimit', 'growthStoppedAndAdsWeak'];
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const nonnegative = (x) => finite(x) && x >= 0;
const text = (x) => typeof x === 'string' && x.trim().length > 0;
const checkState = (x) => text(x?.evidence) && ['passed', 'failed'].includes(x?.status) ? x.status : 'unknown';
const blankCheck = () => ({ status: 'unknown', evidence: '' });
const checks = (keys) => Object.fromEntries(keys.map((key) => [key, blankCheck()]));
const saUrl = (url) => { try { const u = new URL(url); return u.protocol === 'https:' && ['trendyol.sa', 'www.trendyol.sa'].includes(u.hostname); } catch { return false; } };
const money = (input) => {
  if (!input || !finite(input.priceSAR) || input.priceSAR <= 0 || !nonnegative(input.purchaseCNY) || !nonnegative(input.billableWeightKg) || !text(input.evidence)) return null;
  const { priceSAR, purchaseCNY, billableWeightKg } = input;
  const purchaseSAR = purchaseCNY / 1.8;
  const freightSAR = billableWeightKg * 68 / 1.8;
  const contributionSAR = priceSAR / 1.15 - priceSAR * (0.10 + 0.08 + 0.04) - (purchaseSAR + freightSAR + 10 + 5);
  return { priceSAR, purchaseCNY, billableWeightKg, purchaseSAR, freightSAR, contributionSAR, contributionMargin: contributionSAR / priceSAR, breakEvenPriceSAR: (purchaseSAR + freightSAR + 15) / (1 / 1.15 - 0.22), evidence: input.evidence };
};

export function buildTrendyolPlan({ category = '' } = {}) {
  return {
    model: WORKFLOW_MODEL, platform: 'trendyol-sa', marketplace: 'SA', currency: 'SAR', category,
    steps: [...WORKFLOW_STEPS], weights: { ...SCORE_WEIGHTS }, fees: { ...FIXED_FEES },
    sourcingTool: { name: 'research_saudi_source', actions: ['plan', 'collect', 'prepare'], instructions: '需求池形成后collect查1688货源辅助同款核验；plan取得selection模板，选定真实SKU/数量/报价及计费重、每销售单位额外费用后prepare。身份/合规/物流通过后才在sourcing关卡放行利润；返回candidate再screen。不下单。旧候选需补寻源证据，历史报告不重写。' },
    rules: ['未知立即暂停，不执行后续步骤；不以缺失值充零', '需求四项至少两项有证据通过', 'BB人工评分；LD独立页面、独立机会池，不共用总分排名', '计费重≤0.40kg是初期优先条件，不是源文规定的一票否决', '退货损失>40 SAR或>售价60%为高风险，暂停复核', '三档情景必须提供真实输入；缺失不自动生成', '售后准备4%已纳入贡献利润，预期退货成本只并列展示，不能重复扣减'],
    thresholds: { demandSignals: 2, preferredWeightKg: 0.40, minimumMargin: 0.10, preferredMargin: 0.15, returnLossSAR: 40, returnLossPriceRatio: 0.60, sampleScore: 70, observeScore: 60, minimumSamples: 2, initialBatch: [20, 30], impressions: 1000, effectiveClicks: [50, 100], orders: [20, 30], snapshotDays: [7, 14] },
    inputTemplate: {
      id: '', name: '', platform: 'trendyol-sa',
      pool: { keyword: '', url: '', priceSAR: null, rating: null, ratingCount: null, reviewCount: null, ranking: '', brand: '', observedAt: '' },
      demand: { signals: Array.from({ length: 4 }, blankCheck), snapshots: [] },
      route: { type: 'BB', evidence: '', unmetNeed: '', supplierUrl: '', newListing: blankCheck(), improvementValue: blankCheck(), launchCost: blankCheck() },
      identity: checks(IDENTITY), compliance: checks(COMPLIANCE), logistics: { ...checks(LOGISTICS), billableWeightKg: null },
      sourcing: { status: 'paused', missing: ['1688同款、所选SKU报价、计费重及额外费用证据'], offer: null, selection: null },
      economics: { priceSAR: null, purchaseCNY: null, billableWeightKg: null, evidence: '', scenarios: { pessimistic: null, neutral: null, optimistic: null } },
      returns: { standardParcel: blankCheck(), returnFreightSAR: null, warehouseSAR: null, packagingLossSAR: null, nonRefundableFeesSAR: null, recoverableValueSAR: null, evidence: '', expectedRate: null },
      quality: checks(['controllable']),
      scores: Object.fromEntries(Object.keys(SCORE_WEIGHTS).map((key) => [key, { points: null, evidence: '' }])),
      samples: { count: null, tests: blankCheck(), supplier: checks(SUPPLIER) },
      test: { catalogApproved: blankCheck(), batchUnits: null, impressions: null, effectiveClicks: null, orders: null, actualReturns: blankCheck(), evidence: '' },
      expansion: { checks: checks(EXPANSION), termination: Object.fromEntries(TERMINATION.map((key) => [key, { triggered: null, evidence: '' }])) },
    },
    fieldDescriptions: { 'route.unmetNeed': 'LD目标用户尚未满足的问题，记录评论或使用场景依据；未知留空并标缺', 'route.supplierUrl': 'LD对应1688/Alibaba候选供应链接，仅供应链核验来源，不证明沙特需求；未知留空并标缺' },
    demandSignalOrder: ['multipleSellersOrSimilarProducts', 'sameStructure100RatingsOrTarget30AndGrowing', 'recentRankingSalesViewsFavoritesOrGrowth', 'reviewsShowUseCaseAndUnmetNeed'],
    outputs: ['最终对标品.md', '淘汰候选.md', '利润测算.xlsx', 'evidence/'],
  };
}

function evaluate(candidate, index) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const r = { id: c.id ?? String(index + 1), name: c.name ?? '', route: null, status: 'paused', stoppedAt: null, reason: '', stages: [], economics: null, returns: null, score: null, scenarios: null, test: null, warnings: [] };
  const stop = (stage, reason, status = 'paused') => { r.stoppedAt = stage; r.reason = reason; r.status = status; r.stages.push({ stage, status, reason }); return r; };
  // Known stop conditions override every unknown gate and incomplete test observation.
  // Do not compute economics, scenarios, or scores after a documented stop signal.
  const knownStops = TERMINATION.filter((key) => c.expansion?.termination?.[key]?.triggered === true && text(c.expansion.termination[key].evidence));
  if (knownStops.length) return stop('expansion', '命中立即停止补货条件：' + knownStops.join(', '), 'stop-replenishment');
  if (c.route?.type === 'LD') {
    if (!text(c.route.unmetNeed)) r.warnings.push('LD未满足问题 route.unmetNeed 缺失，待确认');
    if (!text(c.route.supplierUrl)) r.warnings.push('LD供应候选链接 route.supplierUrl 缺失，待确认');
  }
  const pass = (stage, note = '') => r.stages.push({ stage, status: 'passed', note });
  const gate = (stage, obj, keys) => {
    const unknown = keys.filter((k) => checkState(obj?.[k]) === 'unknown');
    const failed = keys.filter((k) => checkState(obj?.[k]) === 'failed');
    if (failed.length) return stop(stage, '未通过：' + failed.join(', '), 'eliminated');
    if (unknown.length) return stop(stage, '待确认：' + unknown.join(', '));
    return null;
  };
  if (c.platform !== 'trendyol-sa') return stop('pool', '只接受 Trendyol.sa 候选');
  const p = c.pool;
  if (!p || !saUrl(p.url) || !['keyword', 'ranking', 'brand', 'observedAt'].every((k) => text(p[k])) || !finite(p.priceSAR) || p.priceSAR <= 0 || !finite(p.rating) || p.rating < 0 || p.rating > 5 || !['ratingCount', 'reviewCount'].every((k) => Number.isInteger(p[k]) && p[k] >= 0)) return stop('pool', '需求池字段或沙特商品链接缺失/无效；无榜单也需明确记录');
  pass('pool');
  const signals = c.demand?.signals;
  if (!Array.isArray(signals) || signals.length !== 4) return stop('demand', '需要按计划顺序记录四项需求信号');
  const passed = signals.filter((s) => checkState(s) === 'passed').length;
  const unknown = signals.filter((s) => checkState(s) === 'unknown').length;
  if (passed < 2) return stop('demand', `需求门槛仅${passed}/4通过`, passed + unknown < 2 ? 'eliminated' : 'paused');
  pass('demand', `${passed}/4有证据通过`);
  if (!['BB', 'LD'].includes(c.route?.type) || !text(c.route?.evidence)) return stop('route', '须明确BB同款或LD改良路线及依据');
  r.route = c.route.type;
  if (r.route === 'LD') {
    const fail = gate('route', c.route, ['newListing']); if (fail) return fail;
    r.warnings.push('LD必须新建独立页面，不借用BB评论评分，不参与BB排名');
  }
  pass('route');
  for (const [stage, keys] of [['identity', IDENTITY], ['compliance', COMPLIANCE], ['logistics', LOGISTICS]]) {
    const fail = gate(stage, c[stage], keys); if (fail) return fail;
    if (stage === 'logistics') {
      if (!nonnegative(c.logistics.billableWeightKg)) return stop(stage, '计费重待确认');
      if (c.logistics.billableWeightKg > 0.40) r.warnings.push('超过初期优先计费重0.40kg，非自动淘汰');
    }
    pass(stage);
  }
  // A ready label alone cannot bypass selected-SKU quotation and weight validation.
  if (!c.sourcing || c.sourcing.status !== 'ready') return stop('sourcing', '先使用research_saudi_source核实1688同款、所选SKU报价、计费重和额外费用；未知暂停');
  const prepared = prepareSaudiCandidate({ candidate: c, offer: c.sourcing.offer, selection: c.sourcing.selection });
  if (prepared.status !== 'ready') return stop('sourcing', '1688寻源证据待确认：' + prepared.missing.join(', '));
  if (prepared.candidate.economics.purchaseCNY !== c.economics?.purchaseCNY || prepared.candidate.economics.billableWeightKg !== c.economics?.billableWeightKg) return stop('sourcing', '测算采购价/计费重与所选1688报价不一致，请重新prepare');
  r.warnings.push('国内运费/包装等额外费用在寻源追溯中独立披露，固定贡献利润不是完整净利润。');
  pass('sourcing', '1688所选SKU/数量报价、计费重和额外费用有依据；不代表已独立核实证据真实性');
  const econ = money(c.economics);
  if (!econ) return stop('economics', '真实当前售价、采购价、计费重及来源待确认');
  if (econ.priceSAR !== p.priceSAR || econ.billableWeightKg !== c.logistics.billableWeightKg) return stop('economics', '测算售价/计费重与已核验数据不一致');
  r.economics = econ;
  r.scenarios = Object.fromEntries(['pessimistic', 'neutral', 'optimistic'].map((key) => [key, money(c.economics.scenarios?.[key])]));
  if (Object.values(r.scenarios).some((value) => value === null)) r.warnings.push('三档情景输入不齐，利润测算三档不得宣称完整；缺失场景保持null，不编造价格或成本');
  if (econ.contributionSAR <= 0 || econ.contributionMargin < 0.10) return stop('economics', '贡献利润≤0或贡献利润率低于10%，淘汰/重新谈价', 'eliminated');
  pass('economics', econ.contributionMargin >= 0.15 ? '≥15%优先测试，仍需后续关卡' : '10%至15%有条件测试');
  const ret = c.returns ?? {};
  // Weight alone cannot prove a standard parcel: dimensional weight / desi and exclusions need evidence.
  const standard = econ.billableWeightKg <= 2 && checkState(ret.standardParcel) === 'passed';
  const reverse = nonnegative(ret.returnFreightSAR) && text(ret.evidence) ? ret.returnFreightSAR : standard ? 15 : null;
  const floor = reverse === null ? null : econ.purchaseSAR + econ.freightSAR + 10 + reverse + 5;
  const parts = ['warehouseSAR', 'packagingLossSAR', 'nonRefundableFeesSAR', 'recoverableValueSAR'];
  const complete = reverse !== null && text(ret.evidence) && parts.every((key) => nonnegative(ret[key]));
  // The workflow's provisional floor includes fixed 5; full formula uses actual components instead.
  const full = complete ? econ.purchaseSAR + econ.freightSAR + 10 + reverse + ret.warehouseSAR + ret.packagingLossSAR + ret.nonRefundableFeesSAR - ret.recoverableValueSAR : null;
  if (full !== null && full < 0) return stop('returns', '残值超过损失组成，需复核，不能形成负退货损失');
  r.returns = { returnFreightSAR: reverse, returnFreightProvisional: !(nonnegative(ret.returnFreightSAR) && text(ret.evidence)), minimumKnownLossSAR: floor, completeLossSAR: full, complete, expectedReturnCostSAR: complete && nonnegative(ret.expectedRate) && ret.expectedRate <= 1 ? ret.expectedRate * full : null, missing: parts.filter((key) => !nonnegative(ret[key])), afterSalesReserveAlreadyIncluded: true };
  if (!complete) return stop('returns', '逆向/仓库/损耗/不可退费用/残值待确认；仅显示最低已知损失，不得视为完整损失');
  if (full > 40 || full > econ.priceSAR * 0.60) return stop('returns', '单次退货损失超过40 SAR或售价60%，高风险暂停复核');
  pass('returns');
  const qualityFail = gate('quality', c.quality, ['controllable']); if (qualityFail) return qualityFail;
  pass('quality');
  if (r.route === 'BB') {
    const valid = Object.entries(SCORE_WEIGHTS).every(([key, max]) => finite(c.scores?.[key]?.points) && c.scores[key].points >= 0 && c.scores[key].points <= max && text(c.scores[key].evidence));
    if (!valid) return stop('scoring', '需要有依据的人工维度分30/30/15/15/10；不自动映射或补分');
    r.score = { total: Object.keys(SCORE_WEIGHTS).reduce((sum, key) => sum + c.scores[key].points, 0), max: 100, dimensions: Object.fromEntries(Object.entries(SCORE_WEIGHTS).map(([key, max]) => [key, { points: c.scores[key].points, max, evidence: c.scores[key].evidence }])) };
    if (r.score.total < 60) return stop('scoring', '低于60分', 'eliminated');
    if (r.score.total < 70) return stop('scoring', '60至69分进入观察', 'observe');
  } else {
    const fail = gate('scoring', c.route, ['improvementValue', 'launchCost']); if (fail) return fail;
  }
  pass('scoring', r.route === 'LD' ? 'LD仅单独评估，不给BB总分' : '人工证据评分通过');
  if (!Number.isInteger(c.samples?.count) || c.samples.count < 2) return stop('samples', '至少2至3个样品核验，不接受单一样品');
  const sampleFail = gate('samples', c.samples, ['tests']) || gate('samples', c.samples.supplier, SUPPLIER); if (sampleFail) return sampleFail;
  pass('samples');
  const t = c.test;
  const testFail = gate('test', t, ['catalogApproved']); if (testFail) return testFail;
  if (!text(t.evidence) || !Number.isInteger(t.batchUnits) || t.batchUnits < 20 || t.batchUnits > 30) return stop('test', '初期建议20至30件，批量或依据缺失/超出建议需人工确认');
  r.test = { impressionsReady: nonnegative(t.impressions) && t.impressions >= 1000, clicksReady: nonnegative(t.effectiveClicks) && t.effectiveClicks >= 50, returnsReady: nonnegative(t.orders) && t.orders >= 20, actualReturnReview: checkState(t.actualReturns), guidance: '约1000展示/50至100有效点击/20至30单为内部初步分析门槛，不是平台标准，也不自动授权扩货' };
  if (!r.test.impressionsReady || !r.test.clicksReady || !r.test.returnsReady || r.test.actualReturnReview !== 'passed') return stop('test', '测试数据或真实退货费用记录尚不足，继续小批量测试', 'testing');
  pass('test');
  const termination = c.expansion?.termination;
  if (TERMINATION.some((key) => termination?.[key]?.triggered === true && text(termination[key].evidence))) return stop('expansion', '命中立即停止补货条件', 'stop-replenishment');
  if (!TERMINATION.every((key) => termination?.[key]?.triggered === false && text(termination[key].evidence))) return stop('expansion', '终止条件核查不完整');
  const expansionFail = gate('expansion', c.expansion?.checks, EXPANSION); if (expansionFail) return expansionFail;
  pass('expansion'); r.status = 'expand-eligible'; r.reason = '扩货条件均有依据通过；本结果不执行采购'; return r;
}

export function evaluateTrendyolCandidates({ candidates = [], observedAt = null } = {}) {
  if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array');
  const results = candidates.map(evaluate);
  return { model: WORKFLOW_MODEL, platform: 'trendyol-sa', currency: 'SAR', observedAt, candidates: results,
    bbRanking: results.filter((r) => r.route === 'BB' && r.score && !['eliminated', 'stop-replenishment'].includes(r.status)).map((r) => ({ id: r.id, score: r.score.total, status: r.status })).sort((a, b) => b.score - a.score),
    ldCandidates: results.filter((r) => r.route === 'LD'), eliminated: results.filter((r) => r.status === 'eliminated'), paused: results.filter((r) => r.status === 'paused'),
  };
}
