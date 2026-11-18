/**
 * dsh-amazon-research · host/selection/evidence.js
 *
 * 否决依据链：每个否决项必须说清「依据是什么数值 / 阈值是多少 / 数据从哪来 / 可信度多高」。
 *
 * 为什么需要：用户明确要求「不要一上来就否决，你否决的依据是什么我不清楚」。
 * 旧版只给「淘汰 + 否决项名称」，看起来像拍脑袋。
 * 现在每个否决都带 evidence（数值 + 阈值 + 来源 + 置信度），报告里逐条列出。
 */

/** 置信度分级：数据来源越硬、交叉验证越多，置信度越高。 */
export const CONFIDENCE = Object.freeze({
  high: { label: '高', note: '页面实测值，且有第二来源交叉验证' },
  medium: { label: '中', note: '页面实测值，无交叉验证' },
  low: { label: '低', note: '推导值或估算值' },
  unknown: { label: '未知', note: '数据未取到' },
});

/**
 * 给一个否决项补上依据。
 * @param {{code:string,label:string,detail:string}} veto
 * @param {{value?:number|string|null, threshold?:string, source?:string, confidence?:string, unit?:string}} evidence
 */
export function withEvidence(veto, evidence = {}) {
  return {
    ...veto,
    evidence: {
      value: evidence.value === undefined ? null : evidence.value,
      unit: evidence.unit || '',
      threshold: evidence.threshold || '',
      source: evidence.source || '',
      confidence: evidence.confidence || 'unknown',
      confidenceNote: (CONFIDENCE[evidence.confidence] || CONFIDENCE.unknown).note,
    },
  };
}

/**
 * 由体检结果生成完整的依据链：否决项 + 类目级风险 + 数据可信度。
 * @param {{candidate:object, checks?:Array<object>}} input
 */
export function buildEvidenceChain({ candidate }) {
  const checks = new Map((candidate.checks || []).map((item) => [item.key, item]));
  const fieldEvidence = candidate.fieldEvidence && typeof candidate.fieldEvidence === 'object' ? candidate.fieldEvidence : {};
  const chain = [];

  for (const veto of candidate.vetoes || []) {
    const map = {
      VARIANTS: { key: 'variants', fields: ['variants', 'variantCount'], threshold: '≤ 3 个变体', source: 'Amazon 详情页变体数', confidence: 'high' },
      PATENT: { key: 'patent', fields: ['patent'], threshold: '无专利/商标风险', source: '人工检索结论（需附检索号）', confidence: 'medium' },
      CATEGORY_DEPTH: { key: 'categoryDepth', fields: ['categoryPath', 'breadcrumbs'], threshold: '≥ 3 级细分类目', source: 'Amazon 详情页面包屑', confidence: 'high' },
      FRAGILE: { key: 'fragile', fields: ['fragile', 'material'], threshold: '非易碎/抛货', source: '人工判断 + 包装信息', confidence: 'low' },
      OVERSIZE: { key: 'oversize', fields: ['weightG', 'weight', 'dimensions'], threshold: '≤ 2000g', source: 'Amazon 详情页包装重量', confidence: 'high' },
      MARGIN: { key: 'netMargin', fields: ['purchaseCNY', 'price', 'priceUSD'], threshold: '> 15%', source: '1688 实测采购价 + 全成本模型', confidence: 'medium' },
      RETURNS: { key: 'returns', fields: ['returnPct', 'returns'], threshold: '≤ 10%', source: '类目/竞品退货率', confidence: 'medium' },
    }[veto.code];
    const check = map ? checks.get(map.key) : null;
    const browser = map?.fields?.map((field) => fieldEvidence[field]).find(Boolean) || null;
    const browserSource = browser?.sourceUrl
      ? (map.source + '；页面证据 ' + browser.sourceUrl + (browser.capturedAt ? ' @ ' + browser.capturedAt : ''))
      : null;
    chain.push(withEvidence(veto, {
      value: check ? check.value : null,
      threshold: map ? map.threshold : '',
      source: browserSource || (map ? map.source : '见对应检查项'),
      confidence: check && check.status === '未知' ? 'unknown' : (browser?.confidence === 'direct' ? 'high' : (map ? map.confidence : 'low')),
    }));
  }

  const classRisks = (candidate.classRisks || []).map((text) => ({
    code: 'CLASS_CONTEXT',
    label: '类目级风险（不淘汰单品）',
    detail: text,
    evidence: {
      value: null,
      threshold: '',
      source: '卖家精灵类目报告（品牌集中度 / 评价壁垒）',
      confidence: 'medium',
      confidenceNote: CONFIDENCE.medium.note,
    },
  }));

  return {
    vetoes: chain,
    classRisks,
    dataConfidence: candidate.dataConfidence || 'unknown',
    pageContract: candidate.pageContract || null,
    fieldEvidence,
  };
}

/** 数据可信度总评：看关键字段有没有取到、有没有交叉验证。 */
export function assessDataConfidence(candidate) {
  const checks = candidate.checks || [];
  const unknown = checks.filter((item) => item.status === '未知').map((item) => item.label);
  const hasMargin = candidate.margin !== null && candidate.margin !== undefined;
  const hasPrice = candidate.priceUSD !== null && candidate.priceUSD !== undefined;
  const hasPurchase = candidate.provenance && candidate.provenance.offerUrl !== null && candidate.provenance.offerUrl !== undefined;
  const gaps = [];
  if (!hasPrice) gaps.push('售价未取到');
  if (!hasPurchase) gaps.push('采购价未取到（缺 1688 实测或未通过校验）');
  if (!hasMargin) gaps.push('净利率无法测算');
  const level = gaps.length === 0 ? 'high' : (gaps.length === 1 ? 'medium' : 'low');
  return {
    level,
    gaps,
    unknownChecks: unknown,
    note: gaps.length === 0
      ? '价格、采购价、净利率齐备，结论可直接采信'
      : '缺：' + gaps.join('、') + ' —— 结论只能当参考',
  };
}
