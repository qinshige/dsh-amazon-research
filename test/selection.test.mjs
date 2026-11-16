import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateBatch, evaluateCandidate, normalizeCandidate } from '../host/selection/kpis.js';
import { buildSelectionPlan, amazonDomain } from '../host/selection/channels.js';
import { suggestDifferentiation } from '../host/selection/differentiate.js';
import { inputFingerprint, parseCsv, screenCandidates } from '../host/selection/pipeline.js';
import { decide, evaluateProfileFit } from '../host/selection/profiles.js';
import { buildDecisionBrief } from '../host/selection/brief.js';
import { sensitivity } from '../host/selection/report.js';
import { scoreMarket } from '../host/scoring.js';
import { renderCategoryReport } from '../host/report.js';

const baseRow = {
  ASIN: 'B0TEST0001',
  商品名称: 'Test Vase',
  售价USD: 29.99,
  采购价CNY: 22,
  重量g: 180,
  FBA配送费USD: 3.77,
  广告占比: 10,
  退货率: 5,
  佣金占比: 15,
  类目路径: 'Home & Kitchen > Home Décor > Vases',
  Top100月销: 150000,
  '品牌集中度%': 35,
  前10评价数: 800,
  '新品占比%': 15,
  趋势: '上升',
  季节性: '平稳',
  变体数: 2,
  专利风险: '无',
  易碎: '否',
  供应商数: 2,
  评分: 4.5,
  ABA排名: 150000,
  差评痛点: '底座易滑',
};

test('normalizeCandidate：中英文列名都能读，缺失保持 null', () => {
  const row = normalizeCandidate({ ASIN: 'B0X', 售价USD: '¥19.99', 采购价CNY: '22', 重量g: '180' });
  assert.equal(row.asin, 'B0X');
  assert.equal(row.priceUSD, 19.99);
  assert.equal(row.purchaseCNY, 22);
  assert.equal(row.weightG, 180);
  assert.equal(row.rating, null);
  assert.equal(normalizeCandidate({ 售价USD: '未取到' }).priceUSD, null);
});

test('十维体检：数据齐全的候选进一档', () => {
  const result = evaluateCandidate(baseRow);
  assert.equal(result.tier, '一档');
  assert.equal(result.vetoes.length, 0);
  assert.ok(result.hitRate >= 0.8);
  assert.equal(result.judgedCount >= 6, true);
  assert.ok(result.margin > 0.30);
  assert.equal(result.profit.fbaFeeUSD, 3.77);
});

test('一票否决：品牌集中度 > 70% 直接淘汰', () => {
  const result = evaluateCandidate({ ...baseRow, '品牌集中度%': 80 });
  assert.equal(result.tier, '淘汰');
  assert.ok(result.vetoes.some((v) => v.code === 'CONCENTRATION'));
});

test('一票否决：大类目（< 3 级）淘汰', () => {
  const result = evaluateCandidate({ ...baseRow, 类目路径: 'Home & Kitchen' });
  assert.equal(result.tier, '淘汰');
  assert.ok(result.vetoes.some((v) => v.code === 'CATEGORY_DEPTH'));
});

test('一票否决：变体 > 3 与专利风险', () => {
  const many = evaluateCandidate({ ...baseRow, 变体数: 5 });
  assert.ok(many.vetoes.some((v) => v.code === 'VARIANTS'));
  const patent = evaluateCandidate({ ...baseRow, 专利风险: '疑似侵权' });
  assert.ok(patent.vetoes.some((v) => v.code === 'PATENT'));
  assert.equal(patent.tier, '淘汰');
});

test('小体量：净利率 25%–30% 不能进二档', () => {
  const row = { ...baseRow, 月销: 150, 净利率: 27, 采购价CNY: undefined };
  delete row.采购价CNY;
  delete row.FBA配送费USD;
  const result = evaluateCandidate(row);
  assert.equal(result.smallVolume, true);
  assert.ok(result.margin > 0.25 && result.margin <= 0.30);
  assert.equal(result.tier, '三档');
  assert.match(result.tierReason, /小体量/);
});

test('缺净利率：待复核，不硬给档位', () => {
  const row = { ...baseRow };
  delete row.采购价CNY;
  delete row.FBA配送费USD;
  const result = evaluateCandidate(row);
  assert.equal(result.tier, '待复核');
  assert.ok(result.unknown.includes('净利率'));
});

test('批量汇总：分档统计与共性短板', () => {
  const batch = evaluateBatch([baseRow, { ...baseRow, ASIN: 'B0BAD', '品牌集中度%': 90 }]);
  assert.equal(batch.summary.tiers['一档'], 1);
  assert.equal(batch.summary.tiers['淘汰'], 1);
  assert.ok(batch.summary.commonGaps.length > 0);
});

test('差异化建议必须带证据，且区分外在/内在', () => {
  const result = evaluateCandidate(baseRow);
  const list = suggestDifferentiation(result);
  assert.ok(list.length > 0);
  for (const item of list) {
    assert.ok(item.axis === '外在' || item.axis === '内在');
    assert.ok(item.evidence.length > 0);
    assert.ok(item.action.length > 0);
  }
  assert.ok(list.some((item) => item.direction.includes('差评')));
});

test('四途径路线：7 个站内入口 + 9 个策略 + 站点域名', () => {
  const plan = buildSelectionPlan({ marketplace: 'UK', category: 'vases', nodeIdPath: '1:2:333' });
  assert.equal(plan.channels.length, 7);
  assert.equal(plan.strategies.length, 9);
  assert.equal(plan.domain, 'amazon.co.uk');
  assert.ok(plan.channels[0].url.includes('/bestsellers/333'));
  const deals = plan.channels.find((channel) => channel.id === 'todays-deals');
  assert.equal(deals.url, 'https://www.amazon.co.uk/deals');
  assert.ok(plan.channels.every((channel) => channel.purpose && channel.fields.length > 0));
  assert.equal(plan.dimensions.length, 10);
  assert.equal(amazonDomain('US'), 'amazon.com');
});

test('九策略：品牌分散时推荐竞品店铺，高均价时推荐高单价', () => {
  const plan = buildSelectionPlan({ marketplace: 'US', signals: { brandCr3: 0.3, avgPrice: 75 } });
  const store = plan.strategies.find((item) => item.id === 'competitor-store');
  const high = plan.strategies.find((item) => item.id === 'high-price');
  assert.equal(store.status, '推荐');
  assert.equal(high.status, '推荐');
});

test('CSV 解析：引号、逗号、BOM', () => {
  const rows = parseCsv('\uFEFFASIN,商品名称,售价USD\nB0A,"Pad, Large",19.99\nB0B,"He said ""hi""",9.99\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].商品名称, 'Pad, Large');
  assert.equal(rows[1].商品名称, 'He said "hi"');
});

test('敏感性：三个场景都给出净利率', () => {
  const result = evaluateCandidate(baseRow);
  const sense = sensitivity(result.profit);
  assert.ok(sense);
  assert.ok(sense.purchaseUp < result.margin);
  assert.ok(sense.adUp < result.margin);
  assert.ok(sense.priceDown < result.margin);
});

test('输入指纹：键顺序不同但内容相同 → 同一指纹', () => {
  const a = inputFingerprint([{ ASIN: 'B0A', 售价USD: 20 }]);
  const b = inputFingerprint([{ 售价USD: 20, ASIN: 'B0A' }]);
  assert.equal(a, b);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(a, inputFingerprint([{ ASIN: 'B0A', 售价USD: 21 }]));
});

test('体检落盘：report.md 含四途径、十维、否决、差异化与追溯', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-selection-'));
  try {
    const out = await screenCandidates({
      rows: [
        { ...baseRow, 链接: 'https://www.amazon.com/dp/B0TEST0001', '1688链接': 'https://detail.1688.com/offer/1.html', '采集时间': '2026-11-16T12:00:00Z', 来源: 'BS 榜' },
        { ...baseRow, ASIN: 'B0BAD', '品牌集中度%': 85 },
      ],
      outputRoot: dir,
      title: 'Vases 测试',
    });
    assert.equal(out.count, 2);
    assert.ok(out.runId);
    assert.match(out.inputHash, /^sha256:[0-9a-f]{64}$/);
    const report = await readFile(join(out.dir, 'report.md'), 'utf8');
    assert.match(report, /## 一、决策摘要与结论/);
    assert.match(report, /### 1\.1 决策单/);
    assert.match(report, /安全边际/);
    assert.match(report, /### 1\.2 新手教练/);
    assert.match(report, /## 二、四途径执行路线/);
    assert.match(report, /## 三、十维体检明细/);
    assert.match(report, /## 四、一票否决清单/);
    assert.match(report, /## 五、差异化方向/);
    assert.match(report, /## 六、利润与敏感性/);
    assert.match(report, /## 七、合规与风控清单/);
    assert.match(report, /8\.1 追溯信息/);
    assert.match(report, /8\.2 逐品来源/);
    assert.match(report, /8\.3 指标取数列/);
    assert.match(report, /8\.4 净利率计算输入/);
    assert.match(report, /输入指纹/);
    assert.match(report, /https:\/\/www\.amazon\.com\/dp\/B0TEST0001/);
    const csv = await readFile(join(out.dir, 'selection.csv'), 'utf8');
    assert.match(csv, /一档/);
    assert.match(csv, /淘汰/);
    assert.match(csv, /amazon\.com\/dp\/B0TEST0001/);
    const manifest = JSON.parse(await readFile(join(out.dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.kind, 'selection');
    assert.equal(manifest.inputHash, out.inputHash);
    const provenance = JSON.parse(await readFile(join(out.dir, 'provenance.json'), 'utf8'));
    assert.equal(provenance.inputHash, out.inputHash);
    assert.equal(provenance.inputs.length, 2);
    assert.equal(provenance.inputs[0]['1688链接'], 'https://detail.1688.com/offer/1.html');
    assert.ok(provenance.results[0].checks.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('高集中度时不能再写「头部未完全垄断」', () => {
  const candidate = evaluateCandidate({ ...baseRow, '品牌集中度%': 86 });
  candidate.profileFit = evaluateProfileFit(candidate, 'beginner');
  candidate.decision = decide(candidate, candidate.profileFit, 'beginner');
  const brief = buildDecisionBrief({ candidate, profile: 'beginner', fx: 7.1 });
  assert.ok(brief.attackSurface.some((item) => item.includes('高度垄断')));
  assert.ok(!brief.attackSurface.some((item) => item.includes('头部未完全垄断')));
});

test('安全边际不可达时不输出负数阈值', () => {
  const candidate = evaluateCandidate({ ...baseRow, 售价USD: 5.49, 采购价CNY: 2.96, 重量g: 56, 退货率: 2.51 });
  candidate.profileFit = evaluateProfileFit(candidate, 'beginner');
  candidate.decision = decide(candidate, candidate.profileFit, 'beginner');
  const brief = buildDecisionBrief({ candidate, profile: 'beginner', fx: 7.1 });
  assert.equal(brief.safety.feasible, false);
  assert.ok(brief.safety.maxPurchaseCNY < 0);
  assert.ok(brief.changeMyMind.some((item) => item.includes('达不到目标净利率')));
  assert.ok(brief.actions.every((item) => !/≤ ¥-/.test(item)));
});

test('未检索的专利/认证不能被判成达标', () => {
  const pending = evaluateCandidate({ ...baseRow, 专利风险: '未检索（类目内有专利款，需 FTO）', 认证: '待确认' });
  const patent = pending.checks.find((item) => item.key === 'patent');
  const cert = pending.checks.find((item) => item.key === 'certification');
  assert.equal(patent.status, '未知');
  assert.equal(cert.status, '未知');
  assert.equal(pending.vetoes.length, 0);

  const risky = evaluateCandidate({ ...baseRow, 专利风险: '疑似落入 US 外观专利' });
  assert.ok(risky.vetoes.some((item) => item.code === 'PATENT'));
});

test('卖家画像：同一个品对新手不适合、对进阶可测', () => {
  const row = {
    ...baseRow,
    售价USD: 42,
    采购价CNY: 30,
    重量g: 1800,
    FBA配送费USD: 5.3,
    广告占比: 8,
    退货率: 4,
    季节性: '强季节',
    变体数: 3,
  };
  const candidate = evaluateCandidate(row);
  const beginnerFit = evaluateProfileFit(candidate, 'beginner');
  const operatorFit = evaluateProfileFit(candidate, 'operator');
  assert.equal(beginnerFit.status, '不适合');
  assert.ok(beginnerFit.fails.some((item) => item.label.includes('重量')));
  assert.notEqual(operatorFit.status, '不适合');

  candidate.profileFit = beginnerFit;
  candidate.decision = decide(candidate, beginnerFit, 'beginner');
  assert.equal(candidate.decision.decision, '不做');

  candidate.profileFit = operatorFit;
  candidate.decision = decide(candidate, operatorFit, 'operator');
  assert.ok(['做', '小批量测'].includes(candidate.decision.decision));
});

test('决策单：安全边际与首批资金可复算', () => {
  const candidate = evaluateCandidate({ ...baseRow, 售价USD: 42, 采购价CNY: 30, 重量g: 1800, FBA配送费USD: 5.3, 广告占比: 8, 退货率: 4 });
  candidate.profileFit = evaluateProfileFit(candidate, 'operator');
  candidate.decision = decide(candidate, candidate.profileFit, 'operator');
  const brief = buildDecisionBrief({ candidate, profile: 'operator', fx: 7.1 });
  assert.equal(brief.decision, candidate.decision.decision);
  assert.ok(brief.safety.maxPurchaseCNY > candidate.inputs.purchaseCNY, '采购上限应高于当前采购价');
  assert.ok(brief.safety.minPriceUSD < candidate.priceUSD, '售价下限应低于当前售价');
  assert.ok(brief.safety.maxAdRate > 0);
  assert.equal(brief.batch.available, true);
  assert.ok(brief.batch.capitalCNY > 0);
  assert.ok(brief.actions.length >= 3);
  assert.ok(brief.changeMyMind.length > 0);
});

test('报告：新手有教练层，进阶没有', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-profile-'));
  try {
    const beginner = await screenCandidates({ rows: [baseRow], outputRoot: dir, title: '新手', profile: 'beginner' });
    const operator = await screenCandidates({ rows: [baseRow], outputRoot: dir, title: '进阶', profile: 'operator' });
    const beginnerMd = await readFile(join(beginner.dir, 'report.md'), 'utf8');
    const operatorMd = await readFile(join(operator.dir, 'report.md'), 'utf8');
    assert.match(beginnerMd, /### 1\.2 新手教练/);
    assert.doesNotMatch(operatorMd, /### 1\.2 新手教练/);
    assert.match(operatorMd, /### 1\.1 决策单/);
    assert.equal(beginner.profile, 'beginner');
    assert.equal(operator.profile, 'operator');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('类目报告第九章：四途径入口、九策略、十维与差异化', () => {
  const market = {
    provider: 'sellersprite',
    marketplace: 'US',
    label: 'Cell Phones',
    nodeIdPath: '11091801:11974521:8882489011',
    totals: { products: 8885, units: 120000, revenue: 9000000 },
    avgs: { price: 75, units: 1200, revenue: 90000, rating: 4.2, ratings: 850 },
    concentration: { top3BrandCrn: 0.62, top3ProductCrn: 0.35 },
    structure: { fbaProportion: 95, fbmProportion: 5, amazonSelfProportion: 8, returnRatio: 6 },
    newRatio: { l6: 0.1 },
    distributions: {
      ratingsCount: [{ label: '0-100', products: 500, units: 50000, unitsRatio: 0.42 }],
      brand: [{ brand: 'Apple', products: 120, units: 42000, revenue: 38000000, unitsRatio: 0.35 }],
      price: [{ label: '0-150', products: 300, units: 40000, revenue: 3000000, unitsRatio: 0.3333 }],
    },
    products: [{ asin: 'B0AAA', price: 30, monthlySales: 500 }],
    fetchedAt: '2026-11-10T00:00:00Z',
    warnings: [],
  };
  const score = scoreMarket(market);
  const report = renderCategoryReport({ market, score, site: 'US', generatedAt: '2026-11-10T00:00:00Z' });
  assert.match(report, /## 九、选品落地/);
  assert.match(report, /9\.1 四途径入口/);
  assert.match(report, /9\.2 九策略适配/);
  assert.match(report, /9\.3 类目级十维体检/);
  assert.match(report, /9\.4 差异化方向/);
  assert.match(report, /9\.5 落地动作/);
  assert.match(report, /Best Sellers/);
  assert.match(report, /research_product_select/);
});
