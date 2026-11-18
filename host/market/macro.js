/**
 * 沙特四平台宏观研究 + 差异化选品引擎（不依赖卖家精灵）。
 *
 * 输入：agent/用户按采集清单填入的观测数据（GMV/地区/人群/类目前台数据）。
 * 输出：口径校验 → 可比性判定 → 差异化矩阵 → 决策单 → 落盘报告。
 *
 * 三条硬规则：
 *   1. 不补数字。四家平台都不公开沙特 GMV，取不到就写「未取到」。
 *   2. 不跨口径换算。评价数量、累计已售、搜索结果数之间没有换算系数。
 *   3. 不合可比就不算占比。口径/期间/币种不一致时只给并列，不给份额。
 */

import { createHash } from 'node:crypto';
import { createRun, writeArtifacts } from '../runs.js';
import {
  SA_PLATFORMS,
  SA_REGIONS,
  CONSUMER_DIMENSIONS,
  BASIS_LABELS,
  GMV_METRICS,
  GMV_SCOPES,
  getSaPlatform,
  gradeProxy,
  GRADE_RANK,
  platformIds,
} from './platforms.js';
import { collectionPlaybook, differentiationAngles, sourceCatalog } from './sources.js';

const SHARE_DIMS = new Set(['age', 'gender', 'income', 'device', 'payment']);

function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function fmt(value, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? String(Number(value.toFixed(digits))) : '未取到';
}

function fmtShare(value) {
  return typeof value === 'number' && Number.isFinite(value) ? (value * 100).toFixed(1) + '%' : '未取到';
}

function mdTable(headers, rows) {
  const head = '| ' + headers.join(' | ') + ' |';
  const sep = '| ' + headers.map(() => '---').join(' | ') + ' |';
  const body = rows.map((cells) => '| ' + cells.map((cell) => (cell === null || cell === undefined || cell === '' ? '未取到' : String(cell))).join(' | ') + ' |');
  return [head, sep, ...body].join('\n');
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/* ---------------------------------------------------------------- GMV 层 */

function normalizeGmv(list) {
  const out = [];
  const rejects = [];
  for (const [index, raw] of (Array.isArray(list) ? list : []).entries()) {
    if (!raw || typeof raw !== 'object') {
      rejects.push({ index, reason: '不是对象' });
      continue;
    }
    const platform = getSaPlatform(raw.platform);
    if (!platform) {
      rejects.push({ index, reason: '未知平台: ' + String(raw.platform) });
      continue;
    }
    const metric = text(raw.metric) || 'gmv';
    if (!GMV_METRICS.includes(metric)) {
      rejects.push({ index, reason: '未知指标: ' + metric });
      continue;
    }
    const scope = text(raw.scope);
    if (!GMV_SCOPES.includes(scope)) {
      rejects.push({ index, reason: '未知口径 scope: ' + (scope || '(空)') });
      continue;
    }
    const value = num(raw.value);
    if (value === null) {
      rejects.push({ index, reason: 'value 不是数字' });
      continue;
    }
    const basis = text(raw.basis);
    if (!BASIS_LABELS[basis]) {
      rejects.push({ index, reason: '未知可信度 basis: ' + (basis || '(空)') });
      continue;
    }
    out.push({
      platform: platform.id,
      metric,
      value,
      unit: text(raw.unit) || (metric === 'gmv' ? platform.currency : metric === 'gmvGrowth' ? 'ratio' : 'count'),
      period: text(raw.period) || '未取到',
      scope,
      basis,
      source: text(raw.source) || '未取到',
      sourceUrl: text(raw.sourceUrl),
      observedAt: text(raw.observedAt) || '未取到',
      note: text(raw.note),
    });
  }
  return { rows: out, rejects };
}

/** 同一 (metric, period, scope, unit) 分组，才能谈份额。 */
function gmvGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = [row.metric, row.period, row.scope, row.unit].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const out = [];
  for (const [key, items] of groups) {
    const [metric, period, scope, unit] = key.split('|');
    const byPlatform = {};
    for (const item of items) {
      // 同平台同组取最新一条
      const prev = byPlatform[item.platform];
      if (!prev || String(item.observedAt) >= String(prev.observedAt)) byPlatform[item.platform] = item;
    }
    const present = Object.keys(byPlatform);
    const missing = platformIds().filter((id) => !present.includes(id));
    const comparable = missing.length === 0;
    let shares = null;
    let total = null;
    if (comparable && metric !== 'gmvGrowth') {
      const sum = present.reduce((acc, id) => acc + byPlatform[id].value, 0);
      if (sum > 0) {
        total = sum;
        shares = present.map((id) => ({ platform: id, value: byPlatform[id].value, share: byPlatform[id].value / sum }));
      }
    }
    out.push({ metric, period, scope, unit, byPlatform, present, missing, comparable, total, shares });
  }
  return out;
}

/* -------------------------------------------------------------- 地区层 */

function analyzeRegions(list) {
  const rows = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== 'object') continue;
    const platform = getSaPlatform(raw.platform);
    const share = num(raw.share);
    const region = text(raw.region);
    if (!platform || share === null || !region) continue;
    rows.push({
      platform: platform.id,
      region,
      share: share > 1 ? share / 100 : share,
      basis: BASIS_LABELS[text(raw.basis)] ? text(raw.basis) : 'third-party-estimate',
      source: text(raw.source) || '未取到',
      observedAt: text(raw.observedAt) || '未取到',
    });
  }
  const byPlatform = {};
  for (const platformId of platformIds()) {
    const items = rows.filter((r) => r.platform === platformId);
    if (items.length === 0) {
      byPlatform[platformId] = { available: false, rows: [], sum: null, balanced: null };
      continue;
    }
    const sum = items.reduce((acc, r) => acc + r.share, 0);
    byPlatform[platformId] = { available: true, rows: items, sum, balanced: Math.abs(sum - 1) <= 0.05 };
  }
  const withData = Object.values(byPlatform).filter((item) => item.available).length;
  return { rows, byPlatform, platformsWithData: withData, regions: SA_REGIONS.map((r) => r.id) };
}

/* -------------------------------------------------------------- 人群层 */

function analyzeConsumer(consumer) {
  const matrix = {};
  for (const platformId of platformIds()) {
    const raw = consumer && typeof consumer === 'object' ? consumer[platformId] : null;
    if (!raw || typeof raw !== 'object') {
      matrix[platformId] = { available: false, dims: {}, coverage: 0, filled: 0, missingDims: CONSUMER_DIMENSIONS.map((d) => d.id) };
      continue;
    }
    const dims = {};
    let filled = 0;
    for (const dim of CONSUMER_DIMENSIONS) {
      const value = raw[dim.id];
      if (SHARE_DIMS.has(dim.id)) {
        const bands = (Array.isArray(value) ? value : [])
          .map((item) => ({ band: text(item && item.band), share: num(item && item.share) }))
          .filter((item) => item.band && item.share !== null)
          .map((item) => ({ band: item.band, share: item.share > 1 ? item.share / 100 : item.share }));
        if (bands.length === 0) {
          dims[dim.id] = null;
          continue;
        }
        filled += 1;
        const sorted = [...bands].sort((a, b) => b.share - a.share);
        dims[dim.id] = { bands, top: sorted[0], sum: bands.reduce((acc, b) => acc + b.share, 0) };
      } else {
        const value2 = text(value);
        if (!value2) {
          dims[dim.id] = null;
          continue;
        }
        filled += 1;
        dims[dim.id] = { text: value2 };
      }
    }
    matrix[platformId] = {
      available: filled > 0,
      dims,
      filled,
      coverage: filled / CONSUMER_DIMENSIONS.length,
      missingDims: CONSUMER_DIMENSIONS.filter((d) => !dims[d.id]).map((d) => d.id),
      source: text(raw.source) || '未取到',
      observedAt: text(raw.observedAt) || '未取到',
      sample: text(raw.sample),
    };
  }
  return matrix;
}

/* ------------------------------------------------------------ 差异化层 */

function analyzeCategory(raw) {
  const name = text(raw && raw.name) || '未命名类目';
  const useCase = text(raw && raw.useCase);
  const entries = (raw && raw.platforms && typeof raw.platforms === 'object') ? raw.platforms : {};
  const cells = {};
  const prices = [];
  const activity = {};
  for (const platformId of platformIds()) {
    const cell = entries[platformId];
    if (!cell || typeof cell !== 'object') {
      cells[platformId] = { present: false };
      continue;
    }
    const price = num(cell.priceSAR);
    const platformDef = getSaPlatform(platformId);
    const proxyRaw = platformDef && platformDef.demandProxy === 'soldLowerBound'
      ? num(cell.soldLowerBound)
      : num(cell.ratingCount);
    const rating = num(cell.rating);
    const grade = gradeProxy(platformId, proxyRaw);
    if (price !== null) prices.push({ platform: platformId, price });
    activity[platformId] = grade;
    cells[platformId] = {
      present: true,
      priceSAR: price,
      proxyValue: proxyRaw,
      proxyLabel: getSaPlatform(platformId).proxyLabel,
      grade,
      rating,
      spec: text(cell.spec),
      sponsored: cell.sponsored === true,
      url: text(cell.url),
      note: text(cell.note),
    };
  }
  const present = Object.keys(cells).filter((id) => cells[id].present);
  const coverage = present.length;
  const priceComparable = present.length >= 2 && present.every((id) => cells[id].spec !== '') &&
    new Set(present.map((id) => cells[id].spec.toLowerCase())).size === 1;

  let spread = null;
  let cheapest = null;
  let priciest = null;
  if (prices.length >= 2) {
    const sorted = [...prices].sort((a, b) => a.price - b.price);
    cheapest = sorted[0];
    priciest = sorted[sorted.length - 1];
    if (cheapest.price > 0) spread = priciest.price / cheapest.price;
  }

  const ratingCounts = present.map((id) => cells[id].proxyValue).filter((v) => typeof v === 'number' && v > 0);
  const ratingSum = ratingCounts.reduce((acc, v) => acc + v, 0);
  const moat = ratingSum > 0 ? Math.max(...ratingCounts) / ratingSum : null;

  const strong = present.filter((id) => cells[id].grade === '强');
  const weak = present.filter((id) => cells[id].grade === '弱');
  const blank = platformIds().filter((id) => !cells[id].present);

  const gaps = [];
  if (priceComparable && spread !== null && spread >= 1.8) {
    gaps.push({ type: '价差套利', detail: '同规格 ' + cheapest.platform + ' 最低 ' + fmt(cheapest.price) + ' SAR，' + priciest.platform + ' 最高 ' + fmt(priciest.price) + ' SAR，倍数 ' + fmt(spread, 2) });
  }
  if (strong.length >= 2 && (weak.length >= 1 || blank.length >= 1)) {
    gaps.push({ type: '供给薄弱位', detail: (weak.length ? '弱信号平台：' + weak.join('/') : '') + (blank.length ? ' 无样本平台：' + blank.join('/') : '') + '；强信号平台：' + strong.join('/') });
  }
  if (moat !== null && moat >= 0.7) {
    gaps.push({ type: '头部垄断', detail: '最大评价/已售计数占已知总和的 ' + fmtShare(moat) });
  }
  if (priceComparable && spread !== null && spread < 1.3 && strong.length >= 3) {
    gaps.push({ type: '无价差', detail: '跨平台价差仅 ' + fmt(spread, 2) + ' 倍，普通同款没有定价空间' });
  }

  let decision;
  let reason;
  if (coverage < 2) {
    decision = '先补数';
    reason = '仅 ' + coverage + ' 个平台有样本，不足以下结论';
  } else if (moat !== null && moat >= 0.75) {
    decision = '先补数';
    reason = '头部集中度 ' + fmtShare(moat) + '，先确认是否可绕开头部链接';
  } else if (gaps.some((g) => g.type === '价差套利') && coverage >= 3) {
    decision = '小批量测';
    reason = '存在可验证的同规格跨平台价差，且有 3 个平台样本';
  } else if (strong.length >= 2 && (weak.length >= 1 || blank.length >= 1)) {
    decision = '小批量测';
    reason = '多数平台需求已验证，另有平台供给偏薄，可用差异化切入';
  } else if (strong.length <= 1 && !gaps.some((g) => g.type === '价差套利')) {
    decision = '不做';
    reason = '需求代理信号弱且无价差空间，普通同款不值得做';
  } else {
    decision = '先补数';
    reason = '信号不足以判断，需补齐缺失平台样本与规格对齐';
  }

  return {
    name,
    useCase,
    coverage,
    present,
    blank,
    cells,
    prices,
    priceComparable,
    spread,
    cheapest,
    priciest,
    moat,
    activity,
    strong,
    weak,
    gaps,
    decision,
    reason,
  };
}

/* ------------------------------------------------------------- 方案输出 */

export function buildMacroPlan({ market = 'SA', category = '', platform = '' } = {}) {
  const platforms = platform ? [getSaPlatform(platform)].filter(Boolean) : SA_PLATFORMS;
  return {
    market,
    category: category || '',
    model: 'saudi-cross-platform-macro-v1',
    dataDependency: '不依赖卖家精灵；只用公开页面、公开披露与前台可观测信号',
    platforms: platforms.map((p) => ({
      id: p.id,
      label: p.label,
      domain: p.domain,
      searchUrl: p.searchUrl.replace('{q}', encodeURIComponent(category || '')),
      model: p.model,
      officialSaGmv: p.officialSaGmv,
      disclosure: p.disclosure,
      demandProxy: p.demandProxy,
      proxyLabel: p.proxyLabel,
      proxyThresholds: p.proxyThresholds,
      profileCaveat: p.profileCaveat,
    })),
    sources: sourceCatalog(),
    playbook: collectionPlaybook(),
    differentiationAngles: differentiationAngles(),
    inputTemplate: {
      market,
      gmv: [{ platform: 'amazon-sa', metric: 'gmv', value: null, unit: 'SAR', period: '2024', scope: 'saudi-total', basis: 'third-party-estimate', source: '', sourceUrl: '', observedAt: '' }],
      regions: [{ platform: 'amazon-sa', region: 'riyadh', share: null, basis: 'third-party-estimate', source: '', observedAt: '' }],
      consumer: {
        'amazon-sa': {
          age: [{ band: '18-24', share: null }],
          gender: [{ band: 'male', share: null }],
          payment: [{ band: 'COD', share: null }],
          habit: '',
          delivery: '',
          season: '',
          source: '',
          observedAt: '',
        },
      },
      categories: [{
        name: category || '类目名',
        useCase: '同一用途描述（用于规格对齐）',
        platforms: {
          'amazon-sa': { priceSAR: null, ratingCount: null, rating: null, spec: '同一规格串', sponsored: false, url: '' },
          temu: { priceSAR: null, soldLowerBound: null, spec: '同一规格串', url: '' },
          aliexpress: { priceSAR: null, soldLowerBound: null, spec: '同一规格串', url: '' },
          'trendyol-sa': { priceSAR: null, ratingCount: null, rating: null, spec: '同一规格串', url: '' },
        },
      }],
    },
  };
}

export function analyzeMacro({ market = 'SA', gmv = [], regions = [], consumer = {}, categories = [], title = '', source = '' } = {}) {
  const normalized = normalizeGmv(gmv);
  const groups = gmvGroups(normalized.rows);
  const regionResult = analyzeRegions(regions);
  const consumerMatrix = analyzeConsumer(consumer);
  const categoryResults = (Array.isArray(categories) ? categories : []).map((item) => analyzeCategory(item));

  const platformGmv = {};
  for (const platformId of platformIds()) {
    const rows = normalized.rows.filter((r) => r.platform === platformId);
    platformGmv[platformId] = {
      rows,
      hasSaudiGmv: rows.some((r) => r.metric === 'gmv' && (r.scope === 'saudi-total' || r.scope === 'saudi-cross-border' || r.scope === 'saudi-domestic')),
      hasAny: rows.length > 0,
    };
  }
  const saudiGmvPlatforms = platformIds().filter((id) => platformGmv[id].hasSaudiGmv);

  const decisions = {};
  for (const item of categoryResults) decisions[item.name] = { decision: item.decision, reason: item.reason };

  const dataGaps = [];
  const totalPlatforms = platformIds().length;
  if (saudiGmvPlatforms.length < totalPlatforms) {
    dataGaps.push('沙特口径 GMV：' + (totalPlatforms - saudiGmvPlatforms.length) + '/' + totalPlatforms + ' 个平台未取到（两平台均不公开沙特 GMV，属结构性缺口）');
  }
  if (regionResult.platformsWithData === 0) dataGaps.push('地区消费占比：无平台级地区分布，只能给全市场参考');
  const consumerCovered = platformIds().filter((id) => consumerMatrix[id].available);
  if (consumerCovered.length < totalPlatforms) dataGaps.push('人群画像：' + (totalPlatforms - consumerCovered.length) + '/' + totalPlatforms + ' 个平台无画像数据');
  for (const item of categoryResults) {
    if (item.blank.length) dataGaps.push('类目「' + item.name + '」缺平台样本：' + item.blank.join('/'));
    if (!item.priceComparable && item.present.length >= 2) dataGaps.push('类目「' + item.name + '」规格未对齐，价差只作参考');
  }

  return {
    market,
    title: title || '沙特四平台宏观研究与差异化选品',
    model: 'saudi-cross-platform-macro-v1',
    generatedAt: new Date().toISOString(),
    source: source || '手动/浏览器前台采集',
    gmv: {
      rows: normalized.rows,
      rejects: normalized.rejects,
      groups,
      platformGmv,
      saudiGmvPlatforms,
      saudiGmvCoverage: saudiGmvPlatforms.length,
    },
    regions: regionResult,
    consumer: consumerMatrix,
    consumerCoverage: consumerCovered.length,
    categories: categoryResults,
    decisions,
    dataGaps,
    inputHash: fingerprint({ market, gmv, regions, consumer, categories }),
  };
}

/* --------------------------------------------------------------- 报告 */

export function renderMacroReport(result) {
  const platformLabel = (id) => (getSaPlatform(id) || { label: id }).label;
  const all = platformIds();
  const lines = [];

  lines.push('# ' + result.title);
  lines.push('');
  lines.push('> 市场：沙特阿拉伯（SA）｜币种：SAR｜模型：' + result.model + '｜生成时间：' + result.generatedAt);
  lines.push('> 数据来源：' + result.source + '｜不依赖卖家精灵');
  lines.push('> 口径纪律：四家平台均不公开沙特口径 GMV；取不到写「未取到」，不做跨口径换算，不补经验值。');
  lines.push('');

  // 1. 决策单
  lines.push('## 1. 差异化选品决策单');
  lines.push('');
  if (result.categories.length === 0) {
    lines.push('未提供类目样本，无法给出选品决策。先按采集模板填空后重跑 analyze。');
  } else {
    lines.push(mdTable(
      ['类目', '用途', '有样本平台', '空白平台', '价格倍数', '头部集中度', '决策', '依据'],
      result.categories.map((item) => [
        item.name,
        item.useCase || '未取到',
        item.coverage + '/' + totalPlatforms,
        item.blank.length ? item.blank.map(platformLabel).join('、') : '无',
        item.priceComparable ? fmt(item.spread, 2) + '×' : '规格未对齐',
        item.moat === null ? '未取到' : fmtShare(item.moat),
        '**' + item.decision + '**',
        item.reason,
      ]),
    ));
  }
  lines.push('');

  // 2. GMV
  lines.push('## 2. 平台体量与近两年 GMV：可得性优先');
  lines.push('');
  const totalPlatforms = SA_PLATFORMS.length;
  const coverageLine = result.gmv.saudiGmvCoverage === 0
    ? '**结论：两个平台均未取到沙特口径 GMV。** 这不是采集失败，而是结构性缺口——Amazon 与 Trendyol 的母公司都只披露区域或集团合并数字，不拆分沙特。'
    : '**沙特口径 GMV 覆盖 ' + result.gmv.saudiGmvCoverage + '/' + totalPlatforms + ' 个平台。** 未覆盖平台的份额不可推算。';
  lines.push(coverageLine);
  lines.push('');
  lines.push(mdTable(
    ['平台', '经营模式', '是否公开沙特 GMV', '披露口径说明', '需求代理指标'],
    SA_PLATFORMS.map((p) => [p.label, p.model, p.officialSaGmv ? '公开' : '未公开', p.disclosure, p.proxyLabel]),
  ));
  lines.push('');
  if (result.gmv.rows.length > 0) {
    lines.push('### 已录入的规模观测');
    lines.push('');
    lines.push(mdTable(
      ['平台', '指标', '数值', '单位', '期间', '口径', '可信度', '来源'],
      result.gmv.rows.map((r) => [platformLabel(r.platform), r.metric, fmt(r.value), r.unit, r.period, r.scope, BASIS_LABELS[r.basis] || r.basis, r.source]),
    ));
    lines.push('');
    const comparable = result.gmv.groups.filter((g) => g.comparable && g.shares);
    if (comparable.length > 0) {
      lines.push('### 可计算份额的口径组');
      lines.push('');
      for (const group of comparable) {
        lines.push('口径：' + group.metric + ' / ' + group.period + ' / ' + group.scope + ' / ' + group.unit + '（四平台齐全）');
        lines.push('');
        lines.push(mdTable(['平台', '数值', '份额'], group.shares.map((s) => [platformLabel(s.platform), fmt(s.value), fmtShare(s.share)])));
        lines.push('');
      }
    } else {
      lines.push('**没有任何一组口径是四平台齐全的**，因此不计算平台份额——只用并列展示，避免用不完整样本编造占比。');
      lines.push('');
    }
    const incomplete = result.gmv.groups.filter((g) => !g.comparable);
    if (incomplete.length > 0) {
      lines.push('口径不完整的分组（只并列、不算份额）：' + incomplete.map((g) => g.metric + '/' + g.period + '/' + g.scope + '（缺 ' + g.missing.map(platformLabel).join('、') + '）').join('；'));
      lines.push('');
    }
  } else {
    lines.push('未录入任何规模观测。下一步：按采集清单填入财报区域数字、第三方估测或前台代理指标，再重跑 analyze。');
    lines.push('');
  }
  if (result.gmv.rejects.length > 0) {
    lines.push('被拒绝的观测（字段不合规，已排除在计算外）：');
    for (const item of result.gmv.rejects) lines.push('- 第 ' + (item.index + 1) + ' 条：' + item.reason);
    lines.push('');
  }

  // 3. 地区
  lines.push('## 3. 地区消费占比');
  lines.push('');
  if (result.regions.platformsWithData === 0) {
    lines.push('**未取到任何平台级地区分布。** 没有平台级数据时，只能引用沙特全市场的人口/零售分布作为「分母参考」，不能声称某平台在利雅得占多少。');
  } else {
    const rows = [];
    for (const platformId of all) {
      const entry = result.regions.byPlatform[platformId];
      if (!entry.available) {
        rows.push([platformLabel(platformId), '未取到', '未取到', '未取到', '未取到']);
        continue;
      }
      for (const item of entry.rows) {
        rows.push([platformLabel(platformId), item.region, fmtShare(item.share), BASIS_LABELS[item.basis] || item.basis, item.source]);
      }
      rows.push([platformLabel(platformId), '合计', fmtShare(entry.sum), entry.balanced ? '合计≈100%' : '合计偏离 100%，需复核口径', '']);
    }
    lines.push(mdTable(['平台', '地区', '占比', '可信度', '来源'], rows));
  }
  lines.push('');

  // 4. 人群
  lines.push('## 4. 人群画像与消费习惯');
  lines.push('');
  const consumerRows = [];
  for (const platformId of all) {
    const entry = result.consumer[platformId];
    if (!entry.available) {
      consumerRows.push([platformLabel(platformId), '未取到', '未取到', '未取到', '未取到', '未取到', '0/' + CONSUMER_DIMENSIONS.length]);
      continue;
    }
    const topOf = (dim) => (entry.dims[dim] && entry.dims[dim].top ? entry.dims[dim].top.band + ' ' + fmtShare(entry.dims[dim].top.share) : '未取到');
    const textOf = (dim) => (entry.dims[dim] && entry.dims[dim].text ? entry.dims[dim].text : '未取到');
    consumerRows.push([
      platformLabel(platformId),
      topOf('age'),
      topOf('gender'),
      topOf('payment'),
      textOf('habit'),
      entry.observedAt,
      entry.filled + '/' + CONSUMER_DIMENSIONS.length,
    ]);
  }
  lines.push(mdTable(['平台', '主力年龄带', '性别结构', '主力支付方式', '购物习惯', '数据时间', '维度覆盖'], consumerRows));
  lines.push('');
  lines.push('各维度明细（只列已取到）：');
  lines.push('');
  for (const platformId of all) {
    const entry = result.consumer[platformId];
    if (!entry.available) continue;
    const parts = [];
    for (const dim of CONSUMER_DIMENSIONS) {
      const value = entry.dims[dim.id];
      if (!value) continue;
      if (value.bands) parts.push(dim.label + '：' + value.bands.map((b) => b.band + ' ' + fmtShare(b.share)).join(' / '));
      else parts.push(dim.label + '：' + value.text);
    }
    lines.push('- **' + platformLabel(platformId) + '**（来源：' + entry.source + (entry.sample ? '；样本：' + entry.sample : '') + '）' + parts.join('；'));
  }
  lines.push('');
  if (result.consumerCoverage < SA_PLATFORMS.length) {
    lines.push('注意：人群画像覆盖 ' + result.consumerCoverage + '/' + SA_PLATFORMS.length + ' 个平台。**未取到画像的平台不可套用其他平台的人群结构**，平台间人群差异本身就是要验证的假设。');
    lines.push('');
  }

  // 5. 差异化矩阵
  lines.push('## 5. 类目差异化矩阵');
  lines.push('');
  if (result.categories.length === 0) {
    lines.push('未提供类目样本。');
  } else {
    for (const item of result.categories) {
      lines.push('### ' + item.name + (item.useCase ? '（' + item.useCase + '）' : ''));
      lines.push('');
      lines.push(mdTable(
        ['平台', '前台价 SAR', '需求代理值', '分级', '星级', '规格', '广告位', '样本状态'],
        all.map((platformId) => {
          const cell = item.cells[platformId];
          if (!cell || !cell.present) return [platformLabel(platformId), '无样本', '无样本', '未取到', '未取到', '未取到', '未取到', '空白'];
          return [
            platformLabel(platformId),
            fmt(cell.priceSAR),
            fmt(cell.proxyValue, 0),
            cell.grade,
            fmt(cell.rating, 1),
            cell.spec || '未对齐',
            cell.sponsored ? '是' : '否',
            '已采',
          ];
        }),
      ));
      lines.push('');
      lines.push('- 决策：**' + item.decision + '** —— ' + item.reason);
      if (item.gaps.length) {
        lines.push('- 可攻击点：');
        for (const gap of item.gaps) lines.push('  - [' + gap.type + '] ' + gap.detail);
      } else {
        lines.push('- 可攻击点：未发现显著差异（价差、供给缺位、集中度均不突出）');
      }
      lines.push('');
    }
  }

  // 6. 平台攻击面
  lines.push('## 6. 各平台可攻击面（不含结论，只列可验证方向）');
  lines.push('');
  const angles = differentiationAngles();
  for (const platformId of all) {
    const platform = getSaPlatform(platformId);
    lines.push('- **' + platform.label + '**：' + angles[platformId].join('；'));
  }
  lines.push('');

  // 7. 缺口
  lines.push('## 7. 数据缺口与下一步');
  lines.push('');
  if (result.dataGaps.length === 0) {
    lines.push('无显著缺口。');
  } else {
    for (const gap of result.dataGaps) lines.push('- ' + gap);
  }
  lines.push('');
  lines.push('补齐顺序建议：① 先补类目空白平台的同规格样本；② 再补人群画像（决定选品定位）；③ 最后补 GMV/地区（决定投入规模，但不影响单品是否可做）。');
  lines.push('');

  // 8. 方法
  lines.push('## 8. 方法与边界');
  lines.push('');
  lines.push('- 差异化判断基于可观测的价格、需求代理分级、头部集中度与平台空白位，属启发式规则，不是平台官方口径。');
  lines.push('- 各平台需求代理不同：Amazon/Trendyol 用评分数量，Temu/AliExpress 用页面累计已售下限；三者之间没有换算系数。');
  lines.push('- 规格未对齐的样本不参与价差倍数计算，只作存在性证据。');
  lines.push('- 选品决策未包含采购成本、头程、佣金、退货与合规，因此「小批量测」不等于可盈利，仍需接 research_unit_cost 做全成本测算。');
  lines.push('- 刻意不使用卖家精灵；全部数字来自公开页面、公开披露或人工录入。');
  lines.push('');
  lines.push('## 9. 产物');
  lines.push('');
  lines.push('- report.md（本文件）');
  lines.push('- macro.json（结构化结果：分组、份额、分级、决策）');
  lines.push('- provenance.json（原始输入 + SHA-256 指纹 + 拒绝项）');
  lines.push('- tables/platform_gmv.csv / tables/consumer_profile.csv / tables/differentiation.csv');

  return lines.join('\n') + '\n';
}

function csvEscape(value) {
  const raw = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(raw) ? '"' + raw.replace(/"/g, '""') + '"' : raw;
}

function toCsv(headers, rows) {
  return [headers.map(csvEscape).join(','), ...rows.map((row) => row.map(csvEscape).join(','))].join('\n') + '\n';
}

export function macroCsvArtifacts(result) {
  const platformLabel = (id) => (getSaPlatform(id) || { label: id }).label;
  const gmv = toCsv(
    ['platform', 'metric', 'value', 'unit', 'period', 'scope', 'basis', 'source', 'observed_at', 'note'],
    result.gmv.rows.map((r) => [r.platform, r.metric, r.value, r.unit, r.period, r.scope, r.basis, r.source, r.observedAt, r.note]),
  );
  const consumerRows = [];
  for (const platformId of platformIds()) {
    const entry = result.consumer[platformId];
    if (!entry.available) {
      consumerRows.push([platformId, 'ALL', '未取到', '', 0, 0, entry.source, entry.observedAt]);
      continue;
    }
    for (const dim of CONSUMER_DIMENSIONS) {
      const value = entry.dims[dim.id];
      if (!value) {
        consumerRows.push([platformId, dim.id, '未取到', '', 0, entry.coverage, entry.source, entry.observedAt]);
        continue;
      }
      if (value.bands) {
        for (const band of value.bands) {
          consumerRows.push([platformId, dim.id, band.band, '', band.share, entry.coverage, entry.source, entry.observedAt]);
        }
      } else {
        consumerRows.push([platformId, dim.id, value.text, '', 0, entry.coverage, entry.source, entry.observedAt]);
      }
    }
  }
  const consumer = toCsv(
    ['platform', 'dimension', 'band_or_text', 'unit', 'share', 'coverage', 'source', 'observed_at'],
    consumerRows,
  );
  const diffRows = [];
  for (const item of result.categories) {
    for (const platformId of platformIds()) {
      const cell = item.cells[platformId];
      if (!cell || !cell.present) {
        diffRows.push([item.name, item.useCase, platformId, '', '', '未取到', '', '', '', '无样本', item.decision, item.reason]);
        continue;
      }
      diffRows.push([
        item.name, item.useCase, platformId, cell.priceSAR ?? '', cell.proxyValue ?? '', cell.grade,
        cell.rating ?? '', cell.spec, cell.sponsored ? 'yes' : 'no', '已采',
        item.decision, item.reason,
      ]);
    }
  }
  const differentiation = toCsv(
    ['category', 'use_case', 'platform', 'price_sar', 'proxy_value', 'grade', 'rating', 'spec', 'sponsored', 'sample_state', 'decision', 'reason'],
    diffRows,
  );
  return { gmv, consumer, differentiation, platformLabel };
}

export async function runMacroAnalysis({ market = 'SA', gmv, regions, consumer, categories, title, source, outputRoot, dataDir = null, registryDir = null }) {
  const result = analyzeMacro({ market, gmv, regions, consumer, categories, title, source });
  const run = await createRun({
    rootDir: outputRoot,
    kind: 'macro',
    title: result.title,
    site: 'SA',
    label: title || 'Saudi_macro',
    registryDir,
  });
  const csv = macroCsvArtifacts(result);
  const reportMd = renderMacroReport(result);
  const artifacts = await writeArtifacts(run, {
    'report.md': reportMd,
    'macro.json': result,
    'provenance.json': {
      model: result.model,
      inputHash: result.inputHash,
      capturedAt: result.generatedAt,
      source: result.source,
      market,
      platformCatalog: SA_PLATFORMS,
      rejects: result.gmv.rejects,
      dataGaps: result.dataGaps,
    },
    'tables/platform_gmv.csv': csv.gmv,
    'tables/consumer_profile.csv': csv.consumer,
    'tables/differentiation.csv': csv.differentiation,
  });
  return {
    runId: run.runId,
    dir: run.dir,
    reportPath: run.dir + '/report.md',
    summary: {
      categories: result.categories.map((item) => ({ name: item.name, decision: item.decision, coverage: item.coverage, spread: item.spread, moat: item.moat })),
      saudiGmvCoverage: result.gmv.saudiGmvCoverage,
      consumerCoverage: result.consumerCoverage,
      regionCoverage: result.regions.platformsWithData,
      dataGaps: result.dataGaps,
    },
    artifacts,
  };
}
