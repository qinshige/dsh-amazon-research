import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DISCOVERY_MODEL, DEMAND_POLICY, AMAZON_SA_ORIGIN, amazonSaUrl, trendyolSaUrl,
  parseSarPrice, parseRating, parseCount, parseRank,
  validateObservation, validateObservations, toObservations, mergeObservations,
  waitingPoolMarkdown, buildDiscoveryPlan, discoveryEntryPoints,
} from '../host/market/sa-discovery.js';
import { buildTrendyolPlan, evaluateTrendyolCandidates, STRICT_DEMAND_POLICY } from '../host/market/trendyol-workflow.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDiscoveryUrls, normalizeCard, assertGuard } from '../host/web/amazon-sa.js';
import { createSaudiDiscoveryTool } from '../host/market/sa-discovery-tool.js';

const observation = (overrides = {}) => ({
  id: 'obs-1',
  sourcePlatform: 'trendyol-sa',
  sourceUrl: 'https://www.trendyol.sa/en/p-1',
  observedAt: '2026-11-18',
  signalType: 'rating-count',
  value: 120,
  unit: 'count',
  scope: { keyword: 'cup holder', category: null, listingId: 'p-1', listingUrl: null, position: 1, timeWindow: '2026-11-18', note: '' },
  candidateRelation: 'same-product',
  comparability: 'existence-check',
  capture: { method: 'browser-dom-structured', locator: 'search card', evidenceRef: null },
  ...overrides,
});

test('计划声明：Trendyol.sa 主销、Amazon.sa 只做找品，门槛至少1项来自Trendyol', () => {
  const plan = buildDiscoveryPlan({ keyword: 'cup holder' });
  assert.equal(plan.model, DISCOVERY_MODEL);
  assert.equal(plan.salesPlatform, 'trendyol-sa');
  assert.deepEqual(plan.demandSources, ['trendyol-sa', 'amazon-sa']);
  assert.equal(plan.demandPolicy.minimumPassed, 2);
  assert.equal(plan.demandPolicy.minimumTrendyolPassed, 1);
  assert.equal(plan.demandPolicy.aggregation, 'forbidden');
  assert.ok(plan.entries.every((entry) => entry.url.startsWith(AMAZON_SA_ORIGIN)));
  assert.ok(plan.rules.some((rule) => rule.includes('至少 1 项必须来自 Trendyol.sa')));
  assert.ok(plan.rules.some((rule) => rule.includes('待匹配池')));
  assert.deepEqual(DEMAND_POLICY.aggregation, 'forbidden');
});

test('榜单入口只允许 amazon.sa 同源，且不提供非沙特平台', () => {
  const entries = discoveryEntryPoints({ keyword: 'cup holder' });
  assert.ok(entries.length >= 4);
  for (const entry of entries) assert.ok(entry.url.startsWith(AMAZON_SA_ORIGIN), entry.id);
  assert.equal(discoveryEntryPoints({ categoryUrl: 'https://www.amazon.com/x' }).some((entry) => entry.url === 'https://www.amazon.com/x'), false);
});

test('来源域名严格校验：拒绝 http、子域伪造、端口与凭证', () => {
  assert.equal(amazonSaUrl('https://www.amazon.sa/dp/B0TEST1234'), true);
  assert.equal(amazonSaUrl('https://amazon.sa/dp/B0TEST1234'), false);
  assert.equal(amazonSaUrl('https://www.amazon.sa.evil.test/dp/B0TEST1234'), false);
  assert.equal(amazonSaUrl('http://www.amazon.sa/dp/B0TEST1234'), false);
  assert.equal(amazonSaUrl('https://www.amazon.sa:8443/dp/B0TEST1234'), false);
  assert.equal(amazonSaUrl('https://user:pass@www.amazon.sa/dp/B0TEST1234'), false);
  assert.equal(trendyolSaUrl('https://www.trendyol.sa/en/p-1'), true);
  assert.equal(trendyolSaUrl('https://www.trendyol.com/p-1'), false);
});

test('价格/评分/数量解析：带货币标记才认，解析不到就 null 而不是估算', () => {
  assert.equal(parseSarPrice('SAR 39.99'), 39.99);
  assert.equal(parseSarPrice('1,299.00 SAR'), 1299);
  assert.equal(parseSarPrice('ر.س.‏ 12,50'), 12.5);
  assert.equal(parseSarPrice('$19.99'), null);
  assert.equal(parseSarPrice(''), null);
  assert.equal(parseRating('4.3 out of 5 stars'), 4.3);
  assert.equal(parseRating('4,7 من أصل 5 نجوم'), 4.7);
  assert.equal(parseRating(''), null);
  assert.equal(parseCount('1,234'), 1234);
  assert.equal(parseCount('2.1K'), 2100);
  assert.equal(parseRank('#12 in Home & Kitchen'), 12);
  assert.equal(parseRank('没有排名'), null);
});

test('观测校验：来源、日期、信号类型、采集方式缺一不可', () => {
  assert.deepEqual(validateObservation(observation()), []);
  assert.match(validateObservation(observation({ sourceUrl: 'https://www.amazon.com/dp/B0TEST1234' })).join(), /sourceUrl/);
  assert.match(validateObservation(observation({ sourcePlatform: 'amazon-sa' })).join(), /sourceUrl/);
  assert.match(validateObservation(observation({ observedAt: '2026/11/18' })).join(), /observedAt/);
  assert.match(validateObservation(observation({ signalType: 'sales-volume' })).join(), /signalType/);
  assert.match(validateObservation(observation({ comparability: 'guess' })).join(), /comparability/);
  assert.match(validateObservation(observation({ capture: {} })).join(), /capture\.method/);
  assert.equal(validateObservations([observation(), observation()]).ok, false);
  assert.equal(validateObservations([observation()]).ok, true);
  assert.equal(validateObservations('nope').ok, false);
});

test('采集行转观测：一条卡片拆成多条信号，非 amazon.sa 链接直接丢弃', () => {
  const rows = toObservations({ asin: 'B0TEST1234', url: 'https://www.amazon.sa/dp/B0TEST1234', ratingText: '4.4 out of 5 stars', reviewText: '1,024', rankText: null }, { sourceUrl: 'https://www.amazon.sa/s?k=cup+holder', capturedAt: '2026-11-18T10:00:00.000Z', keyword: 'cup holder', position: 2 });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((item) => item.signalType), ['rating', 'rating-count']);
  assert.equal(rows[1].value, 1024);
  assert.equal(rows[0].sourcePlatform, 'amazon-sa');
  assert.equal(rows[0].scope.listingUrl, 'https://www.amazon.sa/dp/B0TEST1234');
  assert.equal(rows[0].observedAt, '2026-11-18');
  assert.deepEqual(toObservations({ asin: 'B0X', url: 'https://www.amazon.com/dp/B0X' }, { sourceUrl: 'https://www.amazon.com/s?k=x' }), []);
});

test('合并观测按 id 去重，被拒项有明细而不是静默丢弃', () => {
  const merged = mergeObservations({ collected: [observation()], manual: [observation(), observation({ id: 'obs-2', sourcePlatform: 'amazon-sa', sourceUrl: 'https://www.amazon.sa/dp/B0TEST1234' })] });
  assert.equal(merged.observations.length, 2);
  assert.equal(merged.ok, false);
  assert.equal(merged.rejected.length, 1);
  assert.match(merged.rejected[0].errors.join(), /重复/);
});

test('待匹配池明确标注不进候选池，空结果写明本轮无', () => {
  const empty = waitingPoolMarkdown({ observations: [] });
  assert.match(empty, /本轮无/);
  assert.match(empty, /不进候选池/);
  const amazonRow = observation({
    id: 'a1', sourcePlatform: 'amazon-sa', sourceUrl: 'https://www.amazon.sa/dp/B0TEST1234',
    signalType: 'rating-count', value: 88,
    scope: { listingId: 'B0TEST1234', listingUrl: 'https://www.amazon.sa/dp/B0TEST1234' },
  });
  const rows = waitingPoolMarkdown({ observations: [amazonRow], keyword: 'cup holder' });
  assert.match(rows, /B0TEST1234/);
  assert.match(rows, /88/);
  assert.match(rows, /等待 Trendyol.sa 同款匹配/);
});

test('采集 URL 构造与页面守卫：榜单用 pg、搜索用 page，风控一律停止', () => {
  assert.deepEqual(buildDiscoveryUrls({ mode: 'search', keyword: 'cup holder', pages: 2 }), [
    'https://www.amazon.sa/s?k=cup+holder',
    'https://www.amazon.sa/s?k=cup+holder&page=2',
  ]);
  assert.equal(buildDiscoveryUrls({ mode: 'bestsellers', categoryUrl: 'https://www.amazon.sa/gp/bestsellers/home', pages: 2 })[1], 'https://www.amazon.sa/gp/bestsellers/home?pg=2');
  assert.throws(() => buildDiscoveryUrls({ mode: 'bestsellers', categoryUrl: 'https://www.amazon.com/gp/bestsellers' }), /amazon\.sa/);
  assert.throws(() => buildDiscoveryUrls({ mode: 'search', keyword: '' }), /keyword/);
  assert.throws(() => assertGuard({ origin: AMAZON_SA_ORIGIN, captcha: true }), (error) => error.code === 'CAPTCHA');
  assert.throws(() => assertGuard({ origin: AMAZON_SA_ORIGIN, rateLimited: true }), (error) => error.code === 'RATE_LIMITED');
  assert.throws(() => assertGuard({ origin: AMAZON_SA_ORIGIN, signIn: true }), (error) => error.code === 'NOT_LOGGED_IN');
  assert.throws(() => assertGuard({ origin: 'https://www.amazon.com', currencySAR: true }), (error) => error.code === 'ORIGIN_MISMATCH');
  assert.throws(() => assertGuard({ origin: AMAZON_SA_ORIGIN, currencyUSD: true, currencySAR: false, textLength: 900 }), (error) => error.code === 'CURRENCY_MISMATCH');
  assert.throws(() => assertGuard({ origin: AMAZON_SA_ORIGIN, empty: true }), (error) => error.code === 'EMPTY_PAGE');
  assert.equal(assertGuard({ origin: AMAZON_SA_ORIGIN, currencySAR: true }).origin, AMAZON_SA_ORIGIN);
});

test('卡片规范化：价格缺失记 null，非 amazon.sa 链接丢弃', () => {
  const card = normalizeCard({ kind: 'search', asin: 'B0TEST1234', title: 'Cup Holder', url: 'https://www.amazon.sa/dp/B0TEST1234', priceText: 'SAR 39.99', ratingText: '4.4 out of 5 stars', reviewText: '1,024', position: 3 }, { pageUrl: 'https://www.amazon.sa/s?k=x' });
  assert.equal(card.priceSAR, 39.99);
  assert.equal(card.rating, 4.4);
  assert.equal(card.reviewCount, 1024);
  assert.equal(normalizeCard({ url: 'https://www.amazon.com/dp/B0TEST1234' }, { pageUrl: 'https://www.amazon.sa/s?k=x' }), null);
  assert.equal(normalizeCard({ asin: 'B0TEST1234', url: 'https://www.amazon.sa/dp/B0TEST1234', priceText: '暂无报价' }, { pageUrl: 'https://www.amazon.sa/s?k=x' }).priceSAR, null);
});

// —— 需求门槛：分平台观测 ——

function candidate(overrides = {}) {
  const c = buildTrendyolPlan().inputTemplate;
  c.id = 'sa-1'; c.name = '沙特候选';
  c.pool = { keyword: 'cup holder', url: 'https://www.trendyol.sa/en/p-1', priceSAR: 100, rating: 4, ratingCount: 120, reviewCount: 20, ranking: '未上榜，已核对', brand: 'Generic', observedAt: '2026-11-18' };
  c.demand.signals = [{ evidence: '人工核验' }, { evidence: '人工核验' }, { evidence: '人工核验' }, { evidence: '人工核验' }];
  c.route.evidence = '实物同款比对';
  return Object.assign(c, overrides);
}

const strict = (c) => evaluateTrendyolCandidates({ candidates: [c], demandPolicy: STRICT_DEMAND_POLICY }).candidates[0];

test('严格模式：没有分平台观测不得进入需求门槛', () => {
  const r = strict(candidate());
  assert.equal(r.stoppedAt, 'demand');
  assert.match(r.reason, /分平台需求观测/);
  assert.equal(r.economics, null);
});

test('Amazon.sa 观测不能替代 Trendyol.sa：两项都来自 Amazon 时暂停', () => {
  const c = candidate();
  c.demand.observations = [
    observation({ id: 'a1', sourcePlatform: 'amazon-sa', sourceUrl: 'https://www.amazon.sa/dp/B0TEST1234' }),
    observation({ id: 'a2', sourcePlatform: 'amazon-sa', sourceUrl: 'https://www.amazon.sa/dp/B0TEST5678' }),
  ];
  c.demand.signals = [{ evidence: 'Amazon 观测', observationIds: ['a1'] }, { evidence: 'Amazon 观测', observationIds: ['a2'] }, { evidence: '' }, { evidence: '' }];
  const r = strict(c);
  assert.equal(r.stoppedAt, 'demand');
  assert.equal(r.demand.passed, 2);
  assert.equal(r.demand.trendyolPassed, 0);
  assert.match(r.reason, /Trendyol\.sa/);
});

test('Trendyol 1 项 + Amazon 1 项：需求门槛通过并记录分平台计数', () => {
  const c = candidate();
  c.demand.observations = [
    observation({ id: 't1' }),
    observation({ id: 'a1', sourcePlatform: 'amazon-sa', sourceUrl: 'https://www.amazon.sa/dp/B0TEST1234', signalType: 'rank', value: 12, unit: 'position' }),
  ];
  c.demand.signals = [{ evidence: 'Trendyol 评分数', observationIds: ['t1'] }, { evidence: 'Amazon 榜单位次', observationIds: ['a1'] }, { evidence: '' }, { evidence: '' }];
  const r = strict(c);
  assert.notEqual(r.stoppedAt, 'demand');
  assert.equal(r.demand.verified, true);
  assert.equal(r.demand.passed, 2);
  assert.equal(r.demand.trendyolPassed, 1);
  assert.equal(r.stoppedAt, 'identity');
});

test('同一观测被重复引用、或观测不可比时，需求关直接暂停', () => {
  const dup = candidate();
  dup.demand.observations = [observation({ id: 't1' })];
  dup.demand.signals = [{ evidence: 'A', observationIds: ['t1'] }, { evidence: 'B', observationIds: ['t1'] }, { evidence: '' }, { evidence: '' }];
  const r1 = strict(dup);
  assert.equal(r1.stoppedAt, 'demand');
  assert.match(r1.reason, /重复引用/);

  const incomparable = candidate();
  incomparable.demand.observations = [observation({ id: 't1', comparability: 'not-comparable' }), observation({ id: 't2' })];
  incomparable.demand.signals = [{ evidence: 'A', observationIds: ['t1'] }, { evidence: 'B', observationIds: ['t2'] }, { evidence: '' }, { evidence: '' }];
  const r2 = strict(incomparable);
  assert.equal(r2.stoppedAt, 'demand');
  assert.match(r2.reason, /不可比观测/);
});

test('旧候选（只有 signals、无观测）在非严格模式下行为不变，但报告会标注未核验', () => {
  const c = candidate();
  c.demand.signals = [{ status: 'passed', evidence: '历史证据' }, { status: 'passed', evidence: '历史证据' }, { status: 'failed', evidence: '无' }, { status: 'failed', evidence: '无' }];
  const r = evaluateTrendyolCandidates({ candidates: [c] }).candidates[0];
  assert.equal(r.demand.verified, false);
  assert.ok(r.warnings.some((warning) => warning.includes('无法核验')));
  assert.notEqual(r.stoppedAt, 'demand');
});

test('找品工具 collect 全流程：采集行转观测、落盘待匹配池、不产生候选', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sa-discovery-run-'));
  try {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ platform: 'trendyol', marketplace: 'SA', provider: 'trendyol-web', outputRoot: join(dir, 'runs') }));
    const stub = async () => ({
      ok: true,
      rows: [
        { kind: 'search', asin: 'B0TEST1234', title: 'Cup Holder', url: 'https://www.amazon.sa/dp/B0TEST1234', pageUrl: 'https://www.amazon.sa/s?k=cup+holder', position: 1, priceText: 'SAR 39.99', priceSAR: 39.99, ratingText: '4.4 out of 5 stars', reviewText: '1,024', rankText: null, sponsored: false },
        { kind: 'search', asin: 'B0TEST5678', title: 'Cup Holder XL', url: 'https://www.amazon.sa/dp/B0TEST5678', pageUrl: 'https://www.amazon.sa/s?k=cup+holder', position: 2, priceText: null, priceSAR: null, ratingText: '4.1 out of 5 stars', reviewText: '88', rankText: null, sponsored: true },
      ],
      sourceUrls: ['https://www.amazon.sa/s?k=cup+holder'],
      pagesFetched: 1,
      diagnostics: [],
      fetchedAt: '2026-11-18T09:00:00.000Z',
    });
    const tool = createSaudiDiscoveryTool({ dataDir: dir, collect: stub });
    const result = await tool.execute({ action: 'collect', platform: 'amazon-sa', marketplace: 'SA', mode: 'search', keyword: 'cup holder', pages: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.pagesFetched, 1);
    assert.equal(result.observations.length, 4);
    assert.ok(result.observations.every((item) => item.sourcePlatform === 'amazon-sa'));
    assert.ok(result.observations.every((item) => item.sourceUrl === 'https://www.amazon.sa/s?k=cup+holder'));
    assert.equal(result.candidates, undefined);
    const pool = await readFile(result.waitingPoolPath, 'utf8');
    assert.match(pool, /B0TEST1234/);
    assert.match(pool, /不进候选池/);
    const source = JSON.parse(await readFile(result.sourcePath, 'utf8'));
    assert.equal(source.salesPlatform, 'trendyol-sa');
    assert.equal(source.demandPolicy.minimumTrendyolPassed, 1);
    const manifest = JSON.parse(await readFile(join(result.dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.kind, 'saudi-discovery');
    assert.deepEqual(manifest.demandSources, ['trendyol-sa', 'amazon-sa']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
