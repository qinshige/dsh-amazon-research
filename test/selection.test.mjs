import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateBatch, evaluateCandidate, normalizeCandidate } from '../host/selection/kpis.js';
import { buildSelectionPlan, amazonDomain } from '../host/selection/channels.js';
import { suggestDifferentiation } from '../host/selection/differentiate.js';
import { inputFingerprint, parseCsv, screenCandidates } from '../host/selection/pipeline.js';
import { parseDimsCm, parseWeightG, productsToSelectionRows } from '../host/selection/from-products.js';
import { verifyOffer, extractPackCount } from '../host/selection/verify.js';
import { analyzeSegments } from '../host/selection/segments.js';
import { assessDataConfidence, buildEvidenceChain } from '../host/selection/evidence.js';
import { decide, evaluateProfileFit } from '../host/selection/profiles.js';
import { buildDecisionBrief, compareChannels } from '../host/selection/brief.js';
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

test('类目级指标（集中度）只进类目风险，不逐品否决', () => {
  const result = evaluateCandidate({ ...baseRow, '品牌集中度%': 80 });
  // 集中度是**类目**属性：同一个类目里每个 ASIN 都一样，不能逐品淘汰
  assert.equal(result.vetoes.some((v) => v.code === 'CONCENTRATION'), false);
  assert.ok(result.classRisks.some((risk) => risk.includes('品牌集中度')));
  const concentration = result.checks.find((item) => item.key === 'concentration');
  assert.equal(concentration.status, '不达标');
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
  const batch = evaluateBatch([baseRow, { ...baseRow, ASIN: 'B0BAD', 变体数: 9 }]);
  assert.equal(batch.summary.tiers['一档'], 1);
  assert.equal(batch.summary.tiers['淘汰'], 1, '变体 > 3 仍应逐品淘汰');
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
    const out = await screenCandidates({ liveFx: false, freightPerKgCNY: 18,
      rows: [
        { ...baseRow, 链接: 'https://www.amazon.com/dp/B0TEST0001', '1688链接': 'https://detail.1688.com/offer/1.html', '采集时间': '2026-11-16T12:00:00Z', 来源: 'BS 榜' },
        { ...baseRow, ASIN: 'B0BAD', 变体数: 9 },
      ],
      outputRoot: dir,
      title: 'Vases 测试',
      reportStyle: 'full',
    });
    assert.equal(out.count, 2);
    assert.ok(out.runId);
    assert.match(out.inputHash, /^sha256:[0-9a-f]{64}$/);
    const report = await readFile(join(out.dir, 'report.md'), 'utf8');
    assert.match(report, /## 一、决策摘要与结论/);
    assert.match(report, /### 1\.1 决策单/);
    assert.match(report, /安全边际/);
    assert.match(report, /## 附录 A · 补充说明/);
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

test('包装对齐：单件价 × 件数 = 可售单位成本', () => {
  // 实测教训：20 个装手套夹，1688 单件 ¥1.70，当成整包价会把成本低估 20 倍。
  const single = evaluateCandidate({ ...baseRow, 售价USD: 17.99, 采购价CNY: null, 单件采购价CNY: 1.7, 包装对齐: 20, 重量g: 290 });
  const direct = evaluateCandidate({ ...baseRow, 售价USD: 17.99, 采购价CNY: 34, 重量g: 290 });
  assert.ok(single.margin !== null);
  assert.equal(Number(single.margin.toFixed(6)), Number(direct.margin.toFixed(6)), '两条路径应得到同一净利率');
  assert.match(single.marginSource, /× 20 件/);
  const wrong = evaluateCandidate({ ...baseRow, 售价USD: 17.99, 采购价CNY: 1.7, 重量g: 290 });
  assert.ok(wrong.margin > single.margin, '未对齐时净利率会被高估');
});

test('采价校验器：错品拒绝、单件价自动折算、重量交叉验证', () => {
  // 件数抽取
  assert.equal(extractPackCount('20PCS Glove Clips'), 20);
  assert.equal(extractPackCount('Value 2 Pack'), 2);
  assert.equal(extractPackCount('Jetec 6 Pcs'), 6);
  assert.equal(extractPackCount('黑色4个-8字扣'), 4);

  // 错品：含「手套」的扎染材料包必须被拒
  const wrong = verifyOffer({
    amazonTitle: 'ZOEYES 20PCS Glove Clips for Work Glove Holder',
    amazonPackG: 308, amazonPackUnits: 20,
    sourceTitle: '5-10人装扎染材料包,一次性手套（50双）',
    sourcePackPriceCNY: 0.9,
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.confidence, 'low');
  assert.ok(wrong.reasons.some((r) => r.includes('排除词')));

  // 单件价 × 20 = 可售单位成本
  const single = verifyOffer({
    amazonTitle: '20 Pieces Glove Clips for Work, Glove Holder Clip',
    amazonPackG: 290, amazonPackUnits: 20,
    sourceTitle: '手套夹子 劳保多功能扣件挂钩户外工作夹子防丢扣 gloveclip 黑色',
    sourcePackWeightG: 16, sourceUnitPriceCNY: 1.7,
  });
  assert.equal(single.ok, true);
  assert.equal(single.confidence, 'high');
  assert.equal(single.purchaseCNY, 34);

  // 整包价 + 整包重（4 个装）→ 直接用整包价，重量自动折单重
  const pack = verifyOffer({
    amazonTitle: '4 Pcs Black Glove Clips for Work',
    amazonPackG: 56, amazonPackUnits: 4,
    sourceTitle: '跨境4个装多功能塑料防丢手套夹劳保手套夹子挂扣登山扣gloveclip',
    sourcePackCount: 4, sourcePackWeightG: 52, sourcePackPriceCNY: 2.96,
  });
  assert.equal(pack.ok, true);
  assert.equal(pack.purchaseCNY, 2.96);
});

test('分段分析：按销量切段，每段给利润与可做性', () => {
  const rows = [];
  for (let i = 1; i <= 60; i += 1) {
    rows.push({
      ASIN: 'B0' + String(i).padStart(8, '0'),
      '售价USD': i <= 10 ? 30 : (i <= 30 ? 20 : 15),
      '月销': 1000 - i * 10,
      '采购价CNY': i <= 10 ? 12 : 3,
      '重量g': 200,
      '评论数': i <= 10 ? 2000 : 100,
      '变体数': 2,
    });
  }
  const analysis = analyzeSegments({ rows, channel: 'amazon-fba', fx: 7.1 });
  assert.equal(analysis.segments.length, 4);
  const s1 = analysis.segments[0];
  const s3 = analysis.segments[2];
  assert.equal(s1.count, 10);
  assert.ok(s1.avgMargin !== null);
  assert.ok(s1.avgPrice > s3.avgPrice, '头部售价应高于长尾');
  assert.ok(s1.avgReviews > s3.avgReviews, '头部评论数应高于长尾');
  assert.ok(s1.why.length > 0, '每段必须给出可做性依据');
  assert.ok(['可做', '可小批量试', '只能跑体量', '暂不做'].includes(s1.verdict));
});

test('否决依据链：每条否决带数值、阈值、来源、可信度', () => {
  const candidate = evaluateCandidate({ ...baseRow, 变体数: 9 });
  assert.ok(candidate.vetoes.length > 0);
  const veto = candidate.vetoes.find((v) => v.code === 'VARIANTS');
  assert.ok(veto.evidence, '否决必须带依据');
  assert.equal(veto.evidence.value, '9');
  assert.ok(veto.evidence.threshold.includes('3'));
  assert.ok(veto.evidence.source.includes('详情页'));
  assert.ok(veto.evidence.confidence);
  const chain = buildEvidenceChain({ candidate });
  assert.ok(chain.vetoes.length > 0);
  const conf = assessDataConfidence({ checks: candidate.checks, margin: candidate.margin, priceUSD: candidate.priceUSD, provenance: { offerUrl: null } });
  assert.ok(['high', 'medium', 'low'].includes(conf.level));
  assert.ok(conf.gaps.length > 0, '缺采购价必须被记为缺口');
});

test('浏览器字段证据进入否决依据链与 provenance，而不冒充截图', () => {
  const capturedAt = '2026-01-02T03:04:05.000Z';
  const candidate = evaluateCandidate({
    ...baseRow,
    变体数: 9,
    pageContract: { sourceUrl: 'https://example.test/item', capturedAt, screenshotCaptured: false },
    fieldEvidence: {
      variants: { sourceUrl: 'https://example.test/item', capturedAt, confidence: 'direct', screenshotCaptured: false },
    },
  });
  const veto = candidate.vetoes.find((item) => item.code === 'VARIANTS');
  assert.match(veto.evidence.source, /https:\/\/example\.test\/item/);
  assert.equal(candidate.provenance.pageContract.screenshotCaptured, false);
  assert.equal(candidate.provenance.fieldEvidence.variants.screenshotCaptured, false);
  assert.equal(candidate.evidenceChain.pageContract.sourceUrl, 'https://example.test/item');
});

test('实时会话：事件落盘 + 快照可读', async () => {
  const { beginSession, endSession, push, readLiveSnapshot } = await import('../host/live.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'dsr-live-'));
  try {
    const begun = await beginSession({ runId: 'live-test', dir, record: false, source: '单测' });
    assert.equal(begun.ok, true);
    push({ phase: 'open', message: '打开标签页', url: 'https://example.com' });
    const ended = await endSession({ status: 'done', message: '结束' });
    assert.equal(ended.ok, true);
    assert.ok(ended.dir);
    const snapshot = await readLiveSnapshot(dir);
    assert.equal(snapshot.status, 'done');
    assert.ok(snapshot.events.length >= 2);
    assert.equal(snapshot.events[0].phase, 'start');
    assert.ok(snapshot.events.some((item) => item.url === 'https://example.com'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('采集转换：重量/尺寸解析 + 类目聚合 + 新品占比口径', () => {
  assert.equal(parseWeightG('15.2 pounds'), 6895);
  assert.equal(parseWeightG('11.3 ounces'), 320);
  assert.equal(parseWeightG('0.25 kg'), 250);
  assert.equal(parseWeightG('无'), null);
  const dims = parseDimsCm('15 x 10.5 x 10.5 inches');
  assert.equal(dims.l, 38);
  assert.equal(dims.h, 27);
  assert.equal(parseDimsCm('x'), null);

  const market = { concentration: { top3BrandCrn: 0.887 }, newRatio: { l1: 0.1212 }, structure: { returnRatio: 2.51 } };
  const products = [
    { asin: 'B0AAA', title: 'A', brand: 'X', price: 20, rating: 4.5, reviews: 800, monthlySales: 500, monthlyRevenue: 10000, variants: 3, listedDate: '2025-01-01', bsrBig: 1200, fbaFee: 4.1, margin: 55, packWeight: '15.2 pounds', packDims: '15 x 10.5 x 10.5 inches', fulfillment: 'FBA', sellers: 2 },
    { asin: 'B0BBB', title: 'B', brand: 'Y', price: 30, rating: 4.0, reviews: 200, monthlySales: 100, monthlyRevenue: 3000, variants: 1, listedDate: '2026-05-01', bsrBig: 9000, fbaFee: 5.3, margin: 40 },
  ];
  const rows = productsToSelectionRows({ market, products, categoryPath: 'Cat' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].重量g, 6895);
  assert.equal(rows[0].长cm, 38);
  assert.equal(rows[0]['品牌集中度%'], 88.7);
  assert.equal(rows[0]['前10评价数'], 500);
  assert.equal(rows[0]['新品占比%'], 12.1);
  assert.equal(rows[0]['新品占比口径'], 'L1(1个月)');
  assert.ok(Math.abs(rows[0].退货率 - 0.0251) < 1e-9);
  assert.equal(rows[1].重量g, null, '缺重量保持未知，不估算');
});

test('渠道对照：同一品在 FBA 亏、TikTok Shop 能跑', () => {
  const row = { ...baseRow, 售价USD: 5.49, 采购价CNY: 2.96, 重量g: 56 };
  const fba = evaluateCandidate(row, { channel: 'amazon-fba' });
  const tk = evaluateCandidate(row, { channel: 'tiktok-shop' });
  assert.ok(fba.margin < 0, 'Amazon FBA 在 $5.49 应为负');
  assert.ok(tk.margin > 0, 'TikTok Shop 应为正');
  const rows = compareChannels(fba, { fx: 7.1 });
  assert.equal(rows.length, 3);
  const fbaRow = rows.find((item) => item.channel === 'amazon-fba');
  const tkRow = rows.find((item) => item.channel === 'tiktok-shop');
  assert.ok(fbaRow.fulfillmentUSD > 3, 'FBA 履约费应 > $3');
  assert.ok(tkRow.referralRate < fbaRow.referralRate, 'TK 佣金应低于 Amazon');
  assert.ok(tkRow.netMargin > fbaRow.netMargin);
  assert.ok(rows.find((item) => item.channel === 'amazon-fbm').caveat.includes('买家运费'));
});

test('画像价格带随渠道变化：$9.99 在 Amazon 不合格、在 TK 合格', () => {
  const candidate = evaluateCandidate({ ...baseRow, 售价USD: 9.99, 采购价CNY: 2.96, 重量g: 56 });
  const amazonFit = evaluateProfileFit(candidate, 'beginner', 'amazon-fba');
  const tkFit = evaluateProfileFit(candidate, 'beginner', 'tiktok-shop');
  assert.ok(amazonFit.fails.some((item) => item.label.includes('售价')), 'Amazon 新手带下限 $15，$9.99 应不合格');
  assert.ok(!tkFit.fails.some((item) => item.label.includes('售价')), 'TK 带 $8–25，$9.99 应合格');
  assert.equal(tkFit.priceBand.min, 8);
  assert.equal(amazonFit.priceBand.min, 15);
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

test('报告：保守档有附录教练层，进阶没有', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-profile-'));
  try {
    const beginner = await screenCandidates({ liveFx: false, freightPerKgCNY: 18, rows: [baseRow], outputRoot: dir, title: '新手', profile: 'beginner', reportStyle: 'full' });
    const operator = await screenCandidates({ liveFx: false, freightPerKgCNY: 18, rows: [baseRow], outputRoot: dir, title: '进阶', profile: 'operator', reportStyle: 'full' });
    const beginnerMd = await readFile(join(beginner.dir, 'report.md'), 'utf8');
    const operatorMd = await readFile(join(operator.dir, 'report.md'), 'utf8');
    assert.match(beginnerMd, /## 附录 A · 补充说明/);
    assert.doesNotMatch(operatorMd, /## 附录 A · 补充说明/);
    assert.match(operatorMd, /### 1\.1 决策单/);
    assert.equal(beginner.profile, 'beginner');
    assert.equal(operator.profile, 'operator');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('数据版报告（默认）：只有表与数字，不含四途径/教练层/术语/免责声明等叙述', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsr-data-'));
  try {
    const out = await screenCandidates({ liveFx: false, freightPerKgCNY: 18, rows: [baseRow, { ...baseRow, ASIN: 'B0BAD', 变体数: 9 }], outputRoot: dir, title: '数据版' });
    assert.equal(out.reportStyle, 'data');
    const md = await readFile(join(out.dir, 'report.md'), 'utf8');
    // 必须有的数据块
    for (const block of ['## 1 决策单', '## 2 安全边际', '## 4 分档', '## 5 分段利润', '## 8 数据可信度', '## 10 一票否决', '## 11 全部候选', '## 12 净利率计算输入']) {
      assert.ok(md.includes(block), '数据版缺少 ' + block);
    }
    assert.match(md, /B0TEST/);
    // 不该出现的叙述性章节
    for (const prose of ['四途径', '九策略', '教练', '术语', '免责声明', '读法', '附录 A', '今天', '本周']) {
      assert.ok(!md.includes(prose), '数据版不应出现「' + prose + '」');
    }
    // 表格行占比要高：至少 60% 的行是表格行
    const all = md.split('\n').filter((line) => line.trim());
    const tableRows = all.filter((line) => line.trim().startsWith('|'));
    assert.ok(tableRows.length / all.length >= 0.6, '数据版应以表格为主体，实际 ' + tableRows.length + '/' + all.length);
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

test('别名兜底：空 BSR 时取卖家精灵 BSR，空 月销 时取卖家精灵销量', () => {
  const c = normalizeCandidate({
    ASIN: 'B0TEST001',
    商品名称: '测试品',
    '售价USD': 19.99,
    'BSR': '',
    '卖家精灵BSR': 28298,
    '月销': '',
    '卖家精灵销量': 406,
    '卖家精灵FBA费': 4.64,
    '卖家精灵毛利率': 52,
    '卖家精灵变体数': 3,
  });
  assert.equal(c.bsrRank, 28298);
  assert.equal(c.monthlySales, 406);
  assert.equal(c.fbaFeeUSD, 4.64);
  assert.equal(c.variants, 3);
  assert.equal(c.refGrossMargin, 0.52);
});

test('分段分析：没有实测采购价时用卖家精灵毛利率兜底，并给出覆盖度', () => {
  const rows = [];
  for (let i = 0; i < 12; i += 1) {
    rows.push({
      ASIN: 'B0SEG' + String(i).padStart(3, '0'),
      商品名称: '手套夹 ' + i,
      '售价USD': 14 + i,
      'BSR': 1000 + i * 100,
      '评论数': 50 + i,
      '月销': 300 - i * 10,
      '卖家精灵毛利率': 55,
    });
  }
  const out = analyzeSegments({ rows, channel: 'amazon-fba', fx: 7.1, profile: null });
  const head = out.segments[0];
  assert.equal(head.count, 10);
  assert.equal(head.pricedCount, 0);
  assert.ok(head.refGrossAvg !== null);
  assert.equal(Math.round(head.refGrossAvg * 100), 55);
  assert.equal(head.refGrossCount, 10);
  assert.match(head.verdict, /参考毛利率/);
  assert.ok(head.avgUnits > 0);
});
