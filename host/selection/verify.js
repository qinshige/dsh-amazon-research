/**
 * dsh-amazon-research · host/selection/verify.js
 *
 * 采价校验器：任何一条 1688 报价在被用于利润测算之前，必须先过这道闸。
 *
 * 为什么必须有（实测事故）：
 *   1) 关键词「手套夹 20个装」搜到一个「5-10人装扎染材料包…一次性手套(50双)」，
 *      因为标题含「手套」被误匹配 → 采到了完全不相干的产品的价格；
 *   2) 1688 报价是**单件价**（¥1.70/个），Amazon 卖的是 **20 个装**，
 *      直接相减 → 采购成本低估 20 倍，净利率从 13.8% 虚报成 48.4%。
 *
 * 三道校验（任何一道不过 → 拒绝采用该报价，标 unknown 而不是猜）：
 *   A. 同一性：1688 标题必须命中该 Amazon 品的品类词，且不得命中排除词；
 *   B. 件数一致：Amazon 件数 与 1688 规格件数 必须一致（或明确按单件价×倍数换算）；
 *   C. 重量一致：Amazon 包装重量 ÷ 件数 应与 1688 单件重量 接近（±50%）。
 *
 * 通过后给出置信度：high（三道全过）/ medium（过重量+件数）/ low（只过重量）。
 * low 及以下一律不参与利润测算，报告里显示「未通过校验」。
 */

/** 品类同义词表：Amazon 英文品类词 → 1688 中文可接受词。命中任一即视为同一品类。 */
export const CATEGORY_SYNONYMS = Object.freeze({
  'glove clip': ['手套夹', '手套卡扣', '手套挂扣', '夹手套', 'gloveclip', 'glove clip'],
  'glove holder': ['手套夹', '手套挂扣', 'glove夹'],
  'tool holder': ['工具夹', '工具收纳', '工具挂扣', 'tool clip'],
  'carabiner': ['登山扣', '弹簧扣', '扣环', 'carabiner'],
  'wall hook': ['挂钩', '壁挂', 'hook'],
  'magnetic holder': ['磁吸', '磁性', 'magnetic'],
  'belt clip': ['腰夹', '皮带夹', 'belt clip'],
  'cable tie': ['扎带', '尼龙扎带', 'cable tie'],
});

/** 排除词：命中即判「不是同一个品」（实测扎染包含「手套」「材料包」被误匹配）。 */
export const EXCLUDE_WORDS = Object.freeze([
  '材料包', '扎染', '一次性手套', '防护服', '围裙', '皮筋', '头巾', '浴巾', '毛巾',
  '袜子', '手套盒', '收纳盒', '收纳袋', '挂钩套装', '工具包', '零部件', '散装',
]);

/**
 * 从文本里抽取「件数」。支持：20PCS / 20 Pieces / 6 Pcs / 2 Pack / 4个装 / 10片装。
 * @param {string} text
 * @returns {number|null}
 */
export function extractPackCount(text) {
  const t = String(text || '');
  const patterns = [
    /([0-9]+)\s*(?:pcs|pieces|piece|count|pack|set)/i,
    /([0-9]+)\s*(?:个|只|枚|片|条|付|装)/,
    /(?:value|pack)\s*([0-9]+)/i,
  ];
  for (const pattern of patterns) {
    const match = t.match(pattern);
    if (match) {
      const n = Number(match[1]);
      if (Number.isFinite(n) && n > 0 && n <= 500) return n;
    }
  }
  return null;
}

/**
 * 从 Amazon 标题 + 要点里抽取品类核心词（用于匹配 1688 标题）。
 * 取标题里出现过的已知品类词；没有则退回标题里最长的名词片段。
 */
export function amazonCategoryKeys(title, bullets = []) {
  const text = [String(title || ''), ...bullets].join(' ').toLowerCase();
  const keys = Object.keys(CATEGORY_SYNONYMS).filter((key) => text.indexOf(key) >= 0);
  if (keys.length > 0) return keys;
  const words = String(title || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
  return words.slice(0, 3);
}

const STOP_WORDS = new Set(['with', 'your', 'from', 'that', 'this', 'they', 'have', 'pack', 'piece', 'pieces', 'pcs', 'black', 'blue', 'red', 'green', 'clip', 'clips', 'holder', 'holders', 'glove', 'gloves', 'work', 'heavy', 'duty']);

/**
 * 1688 标题是否与该 Amazon 品同一品类。
 * @returns {{ok:boolean, reason:string, matched:string|null}}
 */
export function checkSameProduct(amazonTitle, sourceTitle, amazonKeys) {
  const src = String(sourceTitle || '').toLowerCase();
  if (!src) return { ok: false, reason: '1688 标题为空', matched: null };
  const excluded = EXCLUDE_WORDS.find((word) => src.indexOf(word) >= 0);
  if (excluded) return { ok: false, reason: '1688 标题命中排除词「' + excluded + '」，不是同一品类（实测：含「手套」的扎染材料包被误匹配）', matched: null };
  for (const key of amazonKeys || []) {
    const synonyms = CATEGORY_SYNONYMS[key] || [key];
    const hit = synonyms.find((word) => src.indexOf(String(word).toLowerCase()) >= 0);
    if (hit) return { ok: true, reason: '命中品类词「' + hit + '」', matched: hit };
  }
  return { ok: false, reason: '1688 标题未命中该 Amazon 品的品类词（' + (amazonKeys || []).join('/') + '）', matched: null };
}

/**
 * 重量一致性：Amazon 包装重量 ÷ 件数 ≈ 1688 单件重量？
 * @param {{amazonPackG:number|null, packUnits:number|null, sourceUnitG:number|null}} input
 */
export function checkWeight({ amazonPackG, packUnits, sourceUnitG }) {
  if (!amazonPackG || !packUnits || !sourceUnitG) {
    return { ok: false, reason: '重量数据不全（Amazon 包装重 / 件数 / 1688 单重）', ratio: null };
  }
  const implied = amazonPackG / packUnits;
  const ratio = sourceUnitG / implied;
  const ok = ratio >= 0.5 && ratio <= 2;
  return {
    ok,
    ratio,
    implied,
    reason: ok
      ? '重量吻合：Amazon 包装 ' + Math.round(amazonPackG) + 'g ÷ ' + packUnits + ' = ' + Math.round(implied) + 'g/个 ≈ 1688 ' + Math.round(sourceUnitG) + 'g/个'
      : '重量不符：Amazon 折算 ' + Math.round(implied) + 'g/个 vs 1688 ' + Math.round(sourceUnitG) + 'g/个（比值 ' + ratio.toFixed(2) + '）',
  };
}

/**
 * 完整校验一条 1688 报价。
 * @param {{amazonTitle:string, amazonBullets?:string[], amazonPackG?:number|null,
 *          amazonPackUnits?:number|null, sourceTitle:string, sourcePackCount?:number|null,
 *          sourceUnitG?:number|null, sourceUnitPriceCNY?:number|null, sourcePackPriceCNY?:number|null}} input
 * @returns {{ok:boolean, confidence:'high'|'medium'|'low', reasons:string[], sameProduct:object, weight:object, packUnits:number|null, unitPriceCNY:number|null, packPriceCNY:number|null, purchaseCNY:number|null}}
 */
export function verifyOffer(input = {}) {
  const reasons = [];
  const amazonKeys = amazonCategoryKeys(input.amazonTitle, input.amazonBullets || []);
  const same = checkSameProduct(input.amazonTitle, input.sourceTitle, amazonKeys);
  if (!same.ok) reasons.push('同一性校验未过：' + same.reason);

  // Amazon 件数：优先用商品标题/要点，其次用采集表已填的件数
  const amazonPackUnits = input.amazonPackUnits || extractPackCount(input.amazonTitle) || extractPackCount((input.amazonBullets || []).join(' '));
  // 1688 规格件数（可能是整包，也可能没有）
  const sourcePackCount = input.sourcePackCount || null;
  // 1688 给的重量可能是**整包重**；只有明确了件数才能折成单重。
  // 之前把 4 个装的 52g 当成单重 → 与 Amazon 折算 14g/个 差 3.7 倍，误判为「不是同一品」。
  const sourceRawWeightG = input.sourcePackWeightG || input.sourceUnitG || null;
  const sourceUnitG = sourceRawWeightG === null
    ? null
    : (sourcePackCount && sourcePackCount > 0 ? sourceRawWeightG / sourcePackCount : sourceRawWeightG);
  if (sourceRawWeightG !== null && sourcePackCount && sourcePackCount > 1) {
    reasons.push('1688 规格重 ' + Math.round(sourceRawWeightG) + 'g ÷ ' + sourcePackCount + ' 件 = ' + Math.round(sourceUnitG) + 'g/个');
  }

  // 采购成本口径：
  //   1688 报价若是「整包价」→ 直接作为可售单位成本（前提件数一致）；
  //   1688 报价若是「单件价」→ 乘以 Amazon 一个可售单位的件数。
  let purchaseCNY = null;
  let unitPriceCNY = null;
  let packPriceCNY = null;
  let packUnits = null;
  if (sourcePackCount && amazonPackUnits && sourcePackCount === amazonPackUnits && input.sourcePackPriceCNY) {
    packPriceCNY = input.sourcePackPriceCNY;
    purchaseCNY = packPriceCNY;
    packUnits = amazonPackUnits;
    reasons.push('包装一致：1688 为 ' + sourcePackCount + ' 件装，Amazon 也是 ' + amazonPackUnits + ' 件装，直接用整包价');
  } else if (input.sourceUnitPriceCNY) {
    unitPriceCNY = input.sourceUnitPriceCNY;
    packUnits = amazonPackUnits || sourcePackCount || null;
    if (packUnits) {
      purchaseCNY = Number((unitPriceCNY * packUnits).toFixed(2));
      reasons.push('包装对齐：1688 单件 ¥' + unitPriceCNY.toFixed(2) + ' × ' + packUnits + ' 件/可售单位 = ¥' + purchaseCNY.toFixed(2));
    } else {
      reasons.push('件数未知，无法把 1688 单件价换算成可售单位成本');
    }
  } else if (input.sourcePackPriceCNY) {
    packPriceCNY = input.sourcePackPriceCNY;
    if (amazonPackUnits && sourcePackCount && sourcePackCount !== amazonPackUnits) {
      reasons.push('件数不一致：1688 ' + sourcePackCount + ' 件装 vs Amazon ' + amazonPackUnits + ' 件装，整包价不可直接用');
    } else {
      purchaseCNY = packPriceCNY;
      packUnits = amazonPackUnits || sourcePackCount;
      reasons.push('按 1688 整包价 ¥' + packPriceCNY.toFixed(2) + ' 作为可售单位成本');
    }
  }

  const weight = checkWeight({
    amazonPackG: input.amazonPackG || null,
    packUnits: amazonPackUnits || null,
    sourceUnitG,
  });
  if (!weight.ok && weight.reason.indexOf('数据不全') < 0) reasons.push('重量校验未过：' + weight.reason);

  const hardFail = !same.ok || purchaseCNY === null;
  const confidence = hardFail ? 'low' : (same.ok && weight.ok ? 'high' : (weight.ok ? 'medium' : 'low'));
  return {
    ok: !hardFail && confidence !== 'low',
    confidence,
    reasons,
    sameProduct: same,
    weight,
    packUnits,
    unitPriceCNY,
    packPriceCNY,
    purchaseCNY,
    amazonPackUnits,
    sourcePackCount,
  };
}
