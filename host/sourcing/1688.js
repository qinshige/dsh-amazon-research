/**
 * 1688 采价模块（sourcing-1688）。
 *
 * 口径（照抄工作区既有方法论 research/supply/supply_成本与变体.md）：
 *   - 只用页面真实文本，不推断、不用记忆里的价；
 *   - 搜索页卡片价只是「入口 SKU 最低价」，真实拿货价必须进详情页取阶梯价与起批量；
 *   - 抓不到就写「未取到（未进详情页）」，不做估算填充；
 *   - 遇到验证码/登录墙立刻停手报错（NOT_LOGGED_IN / CAPTCHA），不绕过；
 *   - 每次调用记录 fetchedAt 与 source。
 *
 * 对外两个主函数（契约见 CONTRACTS-2.md 第 1 节）：
 *   searchOffers({ keyword, limit, log })  -> { rows, count, keyword, fetchedAt, source }
 *   fetchOfferDetail({ url, log })         -> { offerId, title, url, priceTiers, moq, moqText, ... }
 *
 * 其余导出都是**纯函数**（不联网），供 test/sourcing.test.mjs 离线测试：
 *   parsePriceCNY / parsePriceTiers / formatPriceTiers / parseCardText /
 *   parseAttrPairs / parsePackTable / parseDropshipTable / parseWeightG /
 *   toCsvRow / buildCsv / encodeKeyword
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { openTab, runJs, runJson, waitFor, closeTab } from '../web/chrome.js';

export const SOURCE_SEARCH = '1688:搜索页';
export const SOURCE_DETAIL = '1688:详情页';

/** 统一口径：没抓到的字段一律写这个，不做估算 */
export const NOT_FOUND = '未取到';
export const NOT_DETAIL = '未取到（未进详情页）';

const SEARCH_ENDPOINT = 'https://s.1688.com/selloffer/offer_search.htm?keywords=';
const DETAIL_ENDPOINT = 'https://detail.1688.com/offer/';

/* ------------------------------------------------------------------ *
 * 纯函数区（可离线测试）
 * ------------------------------------------------------------------ */

const UNIT_CHARS = '件|个|套|只|条|片|双|支|箱|包|副|对|张|块|卷|pcs';
/** 起批量 / 阶梯数量片段：'10件起批'、'100-24999件'、'≥25000件'、'5个以上' */
const QTY_RE = /((?:[≥＞>]|大于)\s*)?(\d+(?:\.\d+)?)(?:\s*[-~－—到至]\s*(\d+(?:\.\d+)?))?\s*(件|个|套|只|条|片|双|支|箱|包|副|对|张|块|卷|pcs)(?:\s*(起批|起订|起定|以上))?/i;
const PRICE_RE = /[¥￥]\s*(\d+(?:\.\d+)?)/g;

/** 数字解析：千分位、全角字符 */
export function num(text) {
  if (text === null || text === undefined) return null;
  const m = String(text).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/**
 * 从一段文本里取第一个价格（带 ¥/￥ 优先，其次 '元'，最后裸数字）。
 * 只认页面上真实出现的数字，不做换算。
 */
export function parsePriceCNY(text) {
  if (text === null || text === undefined) return null;
  const s = String(text).replace(/,/g, '');
  if (!s.trim()) return null;
  const withSymbol = s.match(/[¥￥]\s*(\d+(?:\.\d+)?)/);
  if (withSymbol) return Number(withSymbol[1]);
  const withYuan = s.match(/(\d+(?:\.\d+)?)\s*元/);
  if (withYuan) return Number(withYuan[1]);
  const bare = s.trim().match(/^(\d+(?:\.\d+)?)$/);
  return bare ? Number(bare[1]) : null;
}

/** 把 '10件起批' 这类片段拆成 { qty, qtyMax, qtyText } */
export function parseQty(text) {
  if (!text) return null;
  const m = String(text).match(QTY_RE);
  if (!m) return null;
  const qty = num(m[2]);
  if (qty === null) return null;
  return {
    qty: qty,
    qtyMax: m[3] === undefined ? null : num(m[3]),
    qtyText: m[0].replace(/\s+/g, ''),
  };
}

/**
 * 扫描文本里的价格段（带 ¥/￥）。
 *
 * 1688 的价格组件是「价格+数量」粘在一起渲染的（'¥0.7510件起批' = ¥0.75 / 10件起批），
 * 所以不能简单地按小数点切：小数位超过 2 位时，多出来的数字是数量，不是价格。
 * 规则（照页面实际写法）：
 *   - 小数位 ≤ 2 → 整段是价格（'¥0.60≥25000件' 的数量在价格后面另起）；
 *   - 小数位 ≥ 3 且紧接着数量单位 → 前 2 位小数是价格，余下数字是数量。
 *
 * @returns {Array<{price:number, start:number, end:number, qtyDigits:string}>}
 */
export function scanPrices(text) {
  const s = String(text || '');
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch !== '¥' && ch !== '￥') {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < s.length && /\s/.test(s[j])) j += 1;
    const start = j;
    while (j < s.length && /[0-9.]/.test(s[j])) j += 1;
    const run = s.slice(start, j);
    let priceStr = run;
    let qtyDigits = '';
    const dot = run.indexOf('.');
    if (dot >= 0) {
      const dec = run.slice(dot + 1);
      // 数量单位可能隔着区间：'¥0.70100-24999件'
      const after = s.slice(j);
      const unitDirect = /^(件|个|套|只|条|片|双|支|箱|包|副|对|张|块|卷|pcs)/i.test(after);
      const unitAfterRange = /^(?:[-~－—到至]\s*\d+(?:\.\d+)?)?\s*(件|个|套|只|条|片|双|支|箱|包|副|对|张|块|卷|pcs)/i.test(after);
      // 4 位以上小数必然是「价格 2 位 + 数量」，3 位小数只有在紧跟单位时才拆
      const splitQty = dec.length >= 4 || (dec.length === 3 && unitDirect);
      if (splitQty && (unitDirect || unitAfterRange)) {
        priceStr = run.slice(0, dot + 3);
        qtyDigits = dec.slice(2);
      }
    }
    const value = Number(priceStr);
    if (Number.isFinite(value)) out.push({ price: value, start: i, end: j, qtyDigits });
    i = Math.max(j, i + 1);
  }
  return out;
}

/**
 * 解析一条价格档位文本 → { qty, qtyMax, qtyText, priceCNY, priceMaxCNY }
 *
 * 支持页面上的真实写法（1688 价格组件 textContent 是「价格+数量」粘在一起的）：
 *   '¥0.7510件起批'        -> qty 10, price 0.75
 *   '¥0.70100-24999件'     -> qty 100 (max 24999), price 0.70
 *   '¥0.60≥25000件'        -> qty 25000, price 0.60
 *   '2件起批 ¥4.80'        -> qty 2, price 4.80
 *   '¥0.25 ~ ¥13.50'       -> price 0.25, priceMax 13.50（同一档内的 SKU 价格区间）
 */
export function parseTierLine(line) {
  const raw = String(line || '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const scans = scanPrices(raw);
  if (!scans.length) return null;

  // 重建「去掉价格、保留数量」的文本，供数量解析使用
  let rebuilt = '';
  let cursor = 0;
  for (const sc of scans) {
    rebuilt += raw.slice(cursor, sc.start) + '¥' + sc.qtyDigits;
    cursor = sc.end;
  }
  rebuilt += raw.slice(cursor);

  const q = parseQty(rebuilt);
  const priceCNY = scans[0].price;
  const priceMaxCNY = scans.length > 1 ? scans[1].price : null;
  return {
    qty: q ? q.qty : null,
    qtyMax: q ? q.qtyMax : null,
    qtyText: q ? q.qtyText : null,
    priceCNY: priceCNY,
    priceMaxCNY: priceMaxCNY,
  };
}

/**
 * 解析详情页价格组件（数组或整段文本）→ 阶梯价数组。
 * 形如：[{ qty, qtyMax, qtyText, priceCNY, priceMaxCNY }]
 *
 * 「新人价」是平台补贴价、不是拿货价，单独放到 promos 里，不混进阶梯价。
 */
export function parsePriceTiers(input) {
  const lines = Array.isArray(input)
    ? input.map((s) => String(s || ''))
    : String(input || '').split(/\n+/);
  const tiers = [];
  const promos = [];
  for (const line of lines) {
    const text = String(line || '').replace(/\s+/g, ' ').trim();
    if (!text || !/[0-9]/.test(text)) continue;
    if (/新人价/.test(text)) {
      const scans = scanPrices(text);
      if (scans.length) promos.push('新人价 ¥' + scans[0].price);
      continue;
    }
    const tier = parseTierLine(text);
    if (tier) tiers.push(tier);
  }
  tiers.promos = promos;
  return tiers;
}

/** 阶梯价 → 报告/CSV 用的文本：'2件起批 ¥0.75；≥5000件 ¥0.70' */
export function formatPriceTiers(tiers, promos = []) {
  const list = Array.isArray(tiers) ? tiers : [];
  const parts = [];
  for (const p of promos || []) parts.push(p);
  for (const t of list) {
    if (!t) continue;
    const price = '¥' + t.priceCNY;
    const priceText = t.priceMaxCNY !== null && t.priceMaxCNY !== undefined ? price + '~¥' + t.priceMaxCNY : price;
    if (t.qtyText) parts.push(t.qtyText + ' ' + priceText);
    else if (t.qty !== null && t.qty !== undefined) parts.push('≥' + t.qty + ' ' + priceText);
    else parts.push(priceText);
  }
  return parts.length ? parts.join('；') : NOT_FOUND;
}

/** '1个起批' → { moq: 1, moqText: '1个起批' }；取不到返回 null */
export function parseMoq(text) {
  const s = String(text || '');
  const m = s.match(new RegExp('(\\d+(?:\\.\\d+)?)\\s*(' + UNIT_CHARS + ')\\s*(起批|起订|起定)', 'i'));
  if (!m) return null;
  return { moq: num(m[1]), moqText: m[0].replace(/\s+/g, '') };
}

/** '13 g' / '0.13 kg' / '13' → 克；无单位时按 1688 惯例（kg）换算 */
export function parseWeightG(value, unitHint) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value);
  const n = num(s);
  if (n === null) return null;
  const unit = (unitHint || (s.match(/[a-zA-Z\u4e00-\u9fa5]+/g) || []).find((u) => /kg|千克|公斤|g|克/i.test(u)) || '').toLowerCase();
  if (/kg|千克|公斤/.test(unit)) return Math.round(n * 1000);
  if (/g|克/.test(unit)) return Math.round(n);
  // 详情页「商品属性」里的重量无单位，按 kg 处理（1688 属性表惯例）
  return Math.round(n * 1000);
}

/** 1688 供应商常见城市 → 省份（用于卡片级 location 推断） */
const CITY_PROVINCE = {
  义乌: '浙江', 东阳: '浙江', 温州: '浙江', 杭州: '浙江', 宁波: '浙江', 台州: '浙江', 永康: '浙江',
  绍兴: '浙江', 嘉兴: '浙江', 金华: '浙江', 湖州: '浙江', 丽水: '浙江', 舟山: '浙江', 慈溪: '浙江',
  广州: '广东', 深圳: '广东', 东莞: '广东', 佛山: '广东', 中山: '广东', 汕头: '广东', 揭阳: '广东',
  泉州: '福建', 厦门: '福建', 福州: '福建', 莆田: '福建',
  南通: '江苏', 常州: '江苏', 无锡: '江苏', 苏州: '江苏', 徐州: '江苏', 南京: '江苏',
  临沂: '山东', 青岛: '山东', 潍坊: '山东', 烟台: '山东', 济南: '山东',
  石家庄: '河北', 保定: '河北', 廊坊: '河北',
  汕头市: '广东', 揭阳市: '广东', 潮州: '广东', 云浮: '广东',
  衡阳: '湖南', 长沙: '湖南', 株洲: '湖南', 邵阳: '湖南',
  玉环: '浙江', 瑞安: '浙江', 平阳: '浙江', 乐清: '浙江', 苍南: '浙江',
  连云港: '江苏', 盐城: '江苏', 扬州: '江苏',
  石家庄市: '河北', 汕头市2: '广东',
};

/** 从公司名推断所在地（仅卡片级、无显式地址时用） */
export function guessLocation(supplier) {
  const s = String(supplier || '');
  if (!s) return null;
  for (const city of Object.keys(CITY_PROVINCE)) {
    if (city.endsWith('市2')) continue;
    if (s.startsWith(city)) return CITY_PROVINCE[city] + ' ' + city;
  }
  return null;
}

/** 页面上的省/市文本（详情页「浙江 金华」这类） */
export function parseLocation(text) {
  const s = String(text || '');
  const m = s.match(/(北京|上海|天津|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|广西|海南|四川|贵州|云南|西藏|陕西|甘肃|青海|宁夏|新疆|内蒙古)[\u4e00-\u9fa5]{0,4}/);
  return m ? m[0].replace(/\s+/g, '') : null;
}

const CARD_BADGE_HINTS = [
  '首单', '新人', '限时', '限量', '新品', '包邮', '退货包运费', '运费', '先采后付', '代发',
  '官方物流', '无理由', '回头率', '验厂', '实力', '源头', '工厂', '严选', '精选', '热销',
  '假一赔十', '闪送', '次日达', '当天发货', '48H', '成交', '复购', '好评', '已售', '跨境',
  '专供', '一件代发', '赠品', '秒杀', '团购', '批发', '预售', '现货', '第',
];

/** 卡片里哪些行是「标签」而不是标题 */
export function isBadgeLine(line) {
  const s = String(line || '').trim();
  if (!s) return true;
  if (s === '｜' || s === '|') return true;
  if (/^[¥￥\d.,\s~%+\-/]+$/.test(s)) return true;
  if (s.length > 24) return false;
  return CARD_BADGE_HINTS.some((h) => s.includes(h));
}

/**
 * 解析搜索页卡片文本 → { title, priceCNY, priceMaxCNY, moqText, monthlySales, supplier, location, badges }
 * 只做「文本 → 字段」的搬运，不推断价格。
 */
export function parseCardText(cardText) {
  const lines = String(cardText || '')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const title = lines.find((l) => !isBadgeLine(l) && l.length >= 4) || lines[0] || '';

  // 价格：¥ 后面可能分行（'¥' / '0' / '.01'），要拼回去
  let priceCNY = null;
  let priceMaxCNY = null;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (!l.includes('¥') && !l.includes('￥')) continue;
    const m = l.match(/[¥￥]\s*(\d+(?:\.\d+)?)/);
    if (m) {
      priceCNY = Number(m[1]);
      break;
    }
    let acc = '';
    let j = i + 1;
    while (j < lines.length && /^[.\d]+$/.test(lines[j]) && acc.length < 12) {
      acc += lines[j];
      j += 1;
    }
    if (acc) {
      priceCNY = Number(acc);
      if (['~', '-', '–', '至'].indexOf(lines[j]) >= 0) {
        let acc2 = '';
        let k = j + 1;
        while (k < lines.length && /^[.\d]+$/.test(lines[k]) && acc2.length < 12) {
          acc2 += lines[k];
          k += 1;
        }
        if (acc2) priceMaxCNY = Number(acc2);
      }
      break;
    }
    break;
  }

  const joined = lines.join(' | ');
  const moqM = joined.match(new RegExp('(\\d+(?:\\.\\d+)?)\\s*(' + UNIT_CHARS + ')\\s*(起批|起订|起定)', 'i'));
  const moqText = moqM ? moqM[0].replace(/\s+/g, '') : null;

  const saleM = joined.match(/(全网销量|全网|月销|月成交|近30天成交|成交|已售|付款|回购)\s*([\d.]+\s*[万wW]?\+?\s*[件个套]?)/);
  const monthlySales = saleM ? (saleM[0].replace(/\s+/g, ' ').trim()) : null;

  let supplier = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const l = lines[i];
    if (l.length >= 4 && l.length <= 40 && /(公司|厂|商行|店|经营部|工作室|门市部|工厂|铺)$/.test(l)) {
      supplier = l;
      break;
    }
  }
  const location = guessLocation(supplier);
  // 标签行要排除价格碎片（'.01' 这种是价格分行渲染出来的，不算标签）
  const badges = lines.filter(
    (l) => isBadgeLine(l) && l.length >= 2 && l.length <= 24 && !/^[¥￥\d.,\s~%+\-/]+$/.test(l),
  );

  return { title, priceCNY, priceMaxCNY, moqText, monthlySales, supplier, location, badges };
}

/** 商品属性表（4 列：键1 值1 键2 值2）→ [{ key, value }] */
export function parseAttrPairs(rows) {
  const pairs = [];
  for (const row of rows || []) {
    for (let i = 0; i + 1 < row.length; i += 2) {
      const key = String(row[i] || '').trim();
      const value = String(row[i + 1] || '').trim();
      if (key) pairs.push({ key, value });
    }
  }
  return pairs;
}

/**
 * 包装信息表（商品件重尺）→ { weights:[g], dims:[{l,w,h}], unit }
 * 表头形如：颜色 | 尺寸 | 长(cm) | 宽(cm) | 高(cm) | 体积(cm³) | 重量(g)
 */
export function parsePackTable(rows) {
  const list = rows || [];
  let header = null;
  let headerIdx = -1;
  for (let i = 0; i < list.length; i += 1) {
    const joined = list[i].join('|');
    if (joined.indexOf('重量') >= 0 && (joined.indexOf('长') >= 0 || joined.indexOf('尺') >= 0)) {
      header = list[i];
      headerIdx = i;
      break;
    }
  }
  if (!header) return { ok: false, weights: [], dims: [], rows: [] };
  const colOf = (re) => header.findIndex((h) => re.test(String(h || '')));
  const iWeight = colOf(/^重量|重量/);
  const iLen = colOf(/^长/);
  const iWide = colOf(/^宽/);
  const iHigh = colOf(/^高/);
  // 表头自带单位：'重量(g)' → g；'重量(kg)' → kg
  const weightHeader = iWeight >= 0 ? String(header[iWeight] || '') : '';
  const weightUnit = (weightHeader.match(/\(([^)]*)\)/)?.[1] || '').trim();
  const weights = [];
  const dims = [];
  for (let i = headerIdx + 1; i < list.length; i += 1) {
    const row = list[i];
    if (iWeight >= 0 && row[iWeight] !== undefined) {
      const w = parseWeightG(row[iWeight], weightUnit || String(row[iWeight]).match(/[a-zA-Z]+/)?.[0] || null);
      if (w !== null) weights.push(w);
    }
    if (iLen >= 0 && iWide >= 0 && iHigh >= 0 && row[iLen] && row[iWide] && row[iHigh]) {
      dims.push({
        l: row[iLen],
        w: row[iWide],
        h: row[iHigh],
        text: row[iLen] + '×' + row[iWide] + '×' + row[iHigh] + ' cm',
      });
    }
  }
  return { ok: true, weights, dims, unit: weightUnit || 'g' };
}

/** 商家代发表 → { supported, summary, metrics } */
export function parseDropshipTable(rows) {
  const metrics = {};
  for (const row of rows || []) {
    for (let i = 0; i + 1 < row.length; i += 2) {
      const key = String(row[i] || '').trim();
      const value = String(row[i + 1] || '').trim();
      if (key) metrics[key] = value;
    }
  }
  const supported = Object.keys(metrics).some((k) => /代发|铺货|揽收/.test(k));
  const bits = [];
  if (metrics['商家代发热度']) bits.push('代发热度' + metrics['商家代发热度']);
  if (metrics['铺货分销商数']) bits.push('铺货分销商' + metrics['铺货分销商数']);
  if (metrics['代发品质达标率']) bits.push('代发品质达标率' + metrics['代发品质达标率']);
  if (metrics['48h揽收率']) bits.push('48h揽收率' + metrics['48h揽收率']);
  return { supported, summary: bits.join('，'), metrics };
}

/**
 * 从 SKU 名称里认出包装规格（多件装 / 单件）。
 *
 * 页面真实写法：'2个装'、'【4个装】'、'相框钉10个一包'、'每套4个'、'24大号脚钉【1个】'、'6*6常规相框钉'。
 * 注意 '6*6' 是尺寸不是件数，不能当多件装。
 *
 * @returns {{spec:string, qty:number}}
 */
export function parsePackSpec(skuName) {
  const s = String(skuName || '');
  let m = s.match(/(\d+)\s*(个|只|片|条|双|支|张|件|套|包)\s*(装|一包|入装)/);
  if (m) {
    const qty = num(m[1]);
    return qty && qty > 1 ? { spec: qty + m[2] + (m[3] === '一包' ? '装' : m[3]), qty } : { spec: '单件', qty: 1 };
  }
  m = s.match(/每\s*套\s*(\d+)\s*(个|只|片|件)/);
  if (m) {
    const qty = num(m[1]);
    return qty && qty > 1 ? { spec: qty + m[2] + '/套', qty } : { spec: '单件', qty: 1 };
  }
  m = s.match(/【\s*(\d+)\s*(个|只|片|件|套)\s*】/);
  if (m) {
    const qty = num(m[1]);
    return qty && qty > 1 ? { spec: qty + m[2] + '装', qty } : { spec: '单件', qty: 1 };
  }
  return { spec: '单件', qty: 1 };
}

/**
 * 入口价对应哪个 SKU（详情页里「同一链接的最低档价」就是入口 SKU 的价）
 */
export function pickEntrySku(skuList, entryPriceCNY) {
  const list = Array.isArray(skuList) ? skuList : [];
  if (!list.length) return null;
  if (entryPriceCNY !== null && entryPriceCNY !== undefined) {
    const hit = list.find((s) => Math.abs(Number(s.priceCNY) - Number(entryPriceCNY)) < 0.005);
    if (hit) return hit;
  }
  return list.reduce((a, b) => (Number(a.priceCNY) <= Number(b.priceCNY) ? a : b));
}

/**
 * 多件装档汇总：'2个装 ¥3.8；4个装 ¥7.6'
 * （下游要拿单件价去对 Amazon 多件装均价，这是对齐用的关键信息）
 */
export function summarizePackTiers(skuList) {
  const groups = new Map();
  for (const s of Array.isArray(skuList) ? skuList : []) {
    const pack = parsePackSpec(s.sku);
    if (!pack.qty || pack.qty <= 1) continue;
    if (!groups.has(pack.spec)) groups.set(pack.spec, []);
    const prices = groups.get(pack.spec);
    const v = Number(s.priceCNY);
    if (prices.indexOf(v) < 0) prices.push(v);
  }
  const out = [];
  for (const [spec, prices] of groups) {
    out.push(spec + prices.map((v) => '¥' + v).join('/'));
  }
  return out.join(' / ');
}

/**
 * 单件价（1个装那一档）——下游拿它对 Amazon 的多件装均价时，要先除以件数
 */
export function singlePiecePriceCNY(skuList) {
  const list = Array.isArray(skuList) ? skuList : [];
  const single = list.find((s) => {
    const pack = parsePackSpec(s.sku);
    return pack.qty === 1;
  });
  return single ? Number(single.priceCNY) : null;
}

/**
 * 按尺寸/面积计价的规格档（篷布这类：'3*3=拍数量9平方' ¥5.5）
 */
export function summarizeSizeTiers(skuList) {
  const seen = new Set();
  const out = [];
  for (const s of Array.isArray(skuList) ? skuList : []) {
    const name = String(s.sku || '');
    if (!/平方|平米|米|尺寸|厚度|克/.test(name)) continue;
    if (parsePackSpec(name).qty > 1) continue;
    const key = name + '@' + s.priceCNY;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name + '¥' + s.priceCNY);
  }
  return out.join(' / ');
}

/**
 * 商品属性里的 SKU 变体（规格 / 颜色 / 尺寸 / 款式 …）→ [{ property, values }]
 * 值是页面原文，逗号分隔。
 */
export function parseSkuVariants(attrs) {
  const KEY_RE = /^(规格|颜色|尺寸|款式|型号|规格型号|颜色分类|尺码|规格尺寸|包装数量)$/;
  const out = [];
  for (const a of attrs || []) {
    const key = String(a.key || '').trim();
    const value = String(a.value || '').trim();
    if (!KEY_RE.test(key) || !value) continue;
    const values = value
      .split(/[,，]/)
      .map((v) => v.trim())
      .filter(Boolean);
    if (!values.length) continue;
    out.push({ property: key, values: values });
  }
  return out;
}

/**
 * SKU 价格对：详情页「规格按套起批」区块形如
 *   '18半明垫【配16mm螺丝】 ¥0.05 库存1604215个 22半明垫【配16mm螺丝】 ¥0.06 …'
 * → [{ sku: '18半明垫【配16mm螺丝】', priceCNY: 0.05 }]
 */
export function parseSkuList(skuText) {
  const s = String(skuText || '').replace(/\s+/g, ' ').trim();
  if (!s || s.indexOf('¥') < 0 && s.indexOf('￥') < 0) return [];
  const chunks = s.split(/库存\s*[\d.]+\s*[个件套包]/).map((c) => c.trim()).filter(Boolean);
  const out = [];
  for (const chunk of chunks) {
    const m = chunk.match(/^(.*?)\s*[¥￥]\s*(\d+(?:\.\d+)?)\s*$/);
    if (!m) continue;
    let name = m[1].trim();
    name = name.replace(/^.*(?:按套起批|按件起批|规格)[，,]\s*/, '').replace(/^每套\s*\d+\s*[个件]\s*/, '');
    if (!name) continue;
    out.push({ sku: name, priceCNY: Number(m[2]) });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * CSV 映射（列名与既有 research/supply/supply_货源表.csv 对齐）
 * ------------------------------------------------------------------ */

export const CSV_COLUMNS = [
  '品类',
  '搜索关键词',
  'offerID',
  '标题',
  '链接',
  '起批量',
  '单价CNY',
  '多件装档',
  '阶梯价',
  '包装规格',
  '材质',
  '件重g',
  '供应商',
  '是否支持一件代发',
  '数据验证状态',
  '备注',
];

const CSV_VALUE = {
  verified: '详情页已验证',
  card: '搜索页卡片级',
};

/** 单条记录 → CSV 行（数组，顺序同 CSV_COLUMNS） */
export function toCsvRow(record) {
  const r = record || {};
  const detail = r.detail || null;
  const isDetail = !!detail;
  // 卡片级的价格只是入口 SKU 最低价，不能当拿货价 → 单价列留空，备注里写明
  const priceCNY = isDetail ? detail.entryPriceCNY : null;
  const tiersText = isDetail ? detail.priceTiersText : NOT_DETAIL;
  const packSpec = isDetail ? detail.packSpec || '单件' : NOT_DETAIL;
  const packTiers = isDetail ? detail.packTiersText || '' : '';
  const moqText = isDetail ? detail.moqText : r.moqText || NOT_FOUND;
  const material = isDetail ? detail.material || NOT_FOUND : NOT_DETAIL;
  const weight = isDetail ? detail.weightText || NOT_FOUND : NOT_DETAIL;
  const supplier = isDetail ? detail.supplier || NOT_FOUND : r.supplier || NOT_DETAIL;
  const dropship = isDetail ? detail.onePieceDropshipText : NOT_DETAIL;
  const notes = (r.notes || []).filter(Boolean).join('；');
  return [
    r.category || '',
    r.keyword || '',
    r.offerId || '',
    (detail && detail.title) || r.title || '',
    r.url || '',
    moqText,
    priceCNY === null || priceCNY === undefined ? NOT_FOUND : String(priceCNY),
    packTiers || '',
    tiersText,
    packSpec,
    material,
    weight,
    supplier,
    dropship,
    isDetail ? CSV_VALUE.verified : CSV_VALUE.card,
    notes,
  ];
}

/** CSV 单元格转义：含 , " 换行时加引号 */
export function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** 多条记录 → CSV 文本（带表头） */
export function buildCsv(records) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const rec of records || []) lines.push(toCsvRow(rec).map(csvCell).join(','));
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * Chrome 驱动区
 * ------------------------------------------------------------------ */

const snippetCache = new Map();

async function snippet(name) {
  if (snippetCache.has(name)) return snippetCache.get(name);
  const path = fileURLToPath(new URL('./snippets/' + name, import.meta.url));
  const code = await readFile(path, 'utf8');
  snippetCache.set(name, code);
  return code;
}

async function runSnippet(tabId, name) {
  const code = await snippet(name);
  const raw = await runJson(tabId, code, { strict: false, timeout: 90_000 });
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error('片段返回非 JSON: ' + raw.slice(0, 200));
    }
  }
  return raw;
}

/**
 * 关键词 → 1688 搜索页 URL。
 * 1688 的 query 参数按 GBK 解码，UTF-8 关键词必须显式带 charset=utf8，否则页面标题乱码。
 */
export function buildSearchUrl(keyword) {
  return SEARCH_ENDPOINT + encodeURIComponent(String(keyword || '')) + '&charset=utf8';
}

/** 关键词的 GBK 百分号编码（备用路径） */
export function encodeKeyword(keyword) {
  return encodeURIComponent(String(keyword || ''));
}

/** 真关标签页（chrome.js 的 closeTab 只是跳到 about:blank，这里再补一次真关） */
function closeTabHard(tabId) {
  const script = `on run argv
  set tid to item 1 of argv
  tell application "Google Chrome"
    repeat with w in windows
      set ts to tabs of w
      repeat with t in ts
        if ((id of t) as string) is tid then
          if (count of ts) is 1 then
            make new tab at end of tabs of w with properties {URL:"about:blank"}
          end if
          close t
          return "closed"
        end if
      end repeat
    end repeat
  end tell
  return "not found"
end run`;
  return new Promise((resolve) => {
    const child = spawn('osascript', ['-', tabId], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(out.trim() === 'closed'));
    child.stdin.end(script);
  });
}

/** 释放标签页：先 chrome.js 的 closeTab（跳空白页），再真关 */
async function releaseTab(tabId) {
  try {
    await closeTab(tabId);
  } catch {
    /* ignore */
  }
  await closeTabHard(tabId);
}

/** 登录墙 / 验证码守卫：命中即抛错，不绕过 */
async function assertNoWall(tabId, where) {
  const guard = await runSnippet(tabId, 'page-guard.js');
  if (!guard || guard.status === 'OK') return;
  const err = new Error(where + '：' + (guard.reason || guard.status) + '（已停止抓取）');
  err.code = guard.status === 'CAPTCHA' ? 'CAPTCHA' : guard.status === 'BLOCKED' ? 'RATE_LIMITED' : 'NOT_LOGGED_IN';
  err.url = guard.url;
  throw err;
}

/**
 * 搜索 1688 供应货源，返回**搜索页卡片级**数据。
 *
 * @param {{keyword:string, limit?:number, log?:Function}} opts
 * @returns {Promise<{rows:Array, count:number, keyword:string, fetchedAt:string, source:string}>}
 */
export async function searchOffers({ keyword, limit = 20, log = () => {} } = {}) {
  if (!keyword) throw new Error('缺少 keyword');
  const url = buildSearchUrl(keyword);
  log('打开 1688 搜索页：' + keyword + ' → ' + url);
  const tabId = await openTab(url);
  try {
    // 等「有卡片」或「出现登录墙/验证码」二者之一，先出现哪个算哪个
    await waitFor(
      tabId,
      'document.querySelectorAll(\'a[href*="detail.1688.com/offer/"]\').length > 0 || /punish|x5sec|tmd_____/.test(location.href)',
      { timeout: 45 },
    );
    // 搜索页是虚拟滚动，向下滚几屏让更多卡片渲染出来（滚动太快容易被判成机器人，节奏放慢）
    for (let i = 0; i < 2; i += 1) {
      await runJs(tabId, 'window.scrollTo(0, document.body.scrollHeight); "OK"', { timeout: 30_000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));
    }
    await runJs(tabId, 'window.scrollTo(0, 0); "OK"', { timeout: 30_000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));

    // 滚动过程中可能已经被跳到滑块验证页，所以抓取前再守一次
    await assertNoWall(tabId, '1688 搜索页');
    const data = await runSnippet(tabId, 'search-cards.js');
    const items = Array.isArray(data && data.items) ? data.items : [];
    if (!items.length) {
      // 0 条卡片多半是被拦截了（验证码页 body 只有一百多字），复查一次守卫再决定
      await assertNoWall(tabId, '1688 搜索页（未抓到卡片）');
    }
    log('搜索页卡片 ' + items.length + ' 条（' + keyword + '）');

    const rows = [];
    for (const item of items) {
      const parsed = parseCardText(item.cardText);
      rows.push({
        offerId: item.offerId,
        title: parsed.title || item.titleAttr || '',
        url: item.url,
        priceCNY: parsed.priceCNY,
        priceMaxCNY: parsed.priceMaxCNY,
        moqText: parsed.moqText,
        supplier: parsed.supplier,
        location: parsed.location,
        monthlySales: parsed.monthlySales,
        badges: parsed.badges,
      });
      if (rows.length >= limit) break;
    }
    return {
      rows: rows,
      count: rows.length,
      keyword: keyword,
      fetchedAt: new Date().toISOString(),
      source: SOURCE_SEARCH,
    };
  } finally {
    await releaseTab(tabId);
  }
}

/**
 * 进入 offer 详情页逐项验证。
 *
 * @param {{url:string, log?:Function}} opts
 * @returns {Promise<Object>} 详情页字段（阶梯价/起批量/材质/件重/供应商/一件代发…）
 */
export async function fetchOfferDetail({ url, log = () => {} } = {}) {
  if (!url) throw new Error('缺少 url');
  const offerId = (String(url).match(/offer\/(\d+)\.html/) || [])[1] || null;
  if (!offerId) throw new Error('无法从 url 解析 offerId：' + url);
  const cleanUrl = DETAIL_ENDPOINT + offerId + '.html';
  log('打开 1688 详情页：' + cleanUrl);
  const tabId = await openTab(cleanUrl);
  try {
    await waitFor(
      tabId,
      'document.querySelector("h1") !== null || /punish|x5sec|tmd_____/.test(location.href)',
      { timeout: 45 },
    );
    await new Promise((r) => setTimeout(r, 2500));
    await assertNoWall(tabId, '1688 详情页');

    const data = await runSnippet(tabId, 'detail-page.js');
    const bodyText = String(data.bodyText || '');
    const lines = bodyText.split(/\n+/).map((s) => s.trim()).filter(Boolean);

    // 标题：1688 详情页的 h1 常常是公司名，商品标题取页面 title（去掉 ' - 阿里巴巴' 后缀）
    const docTitle = String(data.docTitle || '').trim();
    const titleFromDoc = docTitle.replace(/\s*[-–—|]\s*阿里巴巴(\.com)?\s*$/, '').trim();
    const titleCandidates = (data.titleCandidates || []).filter(
      (t) => t && t.length >= 8 && t.length <= 300 && !/(公司|厂|商行|经营部|门市部)$/.test(t),
    );
    const title = titleCandidates.sort((a, b) => b.length - a.length)[0] || titleFromDoc || (data.h1 || '').trim();

    // 价格：主价格区结构化片段 + 各档位组件
    const priceInfoText = (data.priceInfoParts || []).join('');
    const tiers = parsePriceTiers(data.priceComponents || []);
    const promos = tiers.promos || [];
    const rangeMatch = priceInfoText.match(/([\d.]+)(?:\s*[-~]\s*[¥￥]?\s*([\d.]+))?/);
    const priceRange = rangeMatch
      ? { min: Number(rangeMatch[1]), max: rangeMatch[2] === undefined ? null : Number(rangeMatch[2]) }
      : null;

    // 起批量：优先取带「起批」的档位，其次正文里的 'N件起批'
    let moq = null;
    let moqText = null;
    for (const t of tiers) {
      if (t.qtyText && /起批|起订|起定/.test(t.qtyText)) {
        moq = t.qty;
        moqText = t.qtyText;
        break;
      }
    }
    if (!moqText) {
      const m = parseMoq(bodyText);
      if (m) {
        moq = m.moq;
        moqText = m.moqText;
      }
    }

    // 表格分工：商品属性 / 包装信息 / 商家代发
    const tables = Array.isArray(data.tables) ? data.tables : [];
    let attrRows = [];
    let packRows = [];
    let dropshipRows = [];
    for (const t of tables) {
      const rows = t.rows || [];
      const joined = rows.map((r) => r.join('|')).join('\n');
      if (/商家代发热度|代发品质达标率|铺货分销商/.test(joined)) {
        dropshipRows = rows;
      } else if (/重量/.test(joined) && /长|尺/.test(joined)) {
        packRows = rows;
      } else if (!attrRows.length) {
        attrRows = rows;
      }
    }
    const attrs = parseAttrPairs(attrRows);
    const pack = parsePackTable(packRows);
    const dropship = parseDropshipTable(dropshipRows);

    const attrValue = (keys) => {
      for (const k of keys) {
        const hit = attrs.find((a) => a.key === k || a.key.indexOf(k) >= 0);
        if (hit && hit.value) return hit.value;
      }
      return null;
    };
    const material = attrValue(['材质', '主要材质', '材料', '材质成分']);

    // 件重：优先「包装信息 → 商品件重尺」（页面直接给克），其次商品属性里的重量
    let weightG = null;
    let weightText = NOT_FOUND;
    let weightSource = '';
    if (pack.ok && pack.weights.length) {
      const min = Math.min(...pack.weights);
      const max = Math.max(...pack.weights);
      weightG = min;
      weightText = min === max ? String(min) : min + '~' + max;
      weightSource = '商品件重尺';
    } else {
      const rawWeight = attrValue(['重量', '件重', '商品重量', '净重']);
      if (rawWeight) {
        const g = parseWeightG(rawWeight);
        if (g !== null) {
          weightG = g;
          weightText = String(g);
          weightSource = '商品属性（原文 ' + rawWeight + '，按 kg 换算）';
        }
      }
    }

    // 包装尺寸
    let packDimsCm = null;
    if (pack.dims.length) {
      const first = pack.dims[0].text;
      const last = pack.dims[pack.dims.length - 1].text;
      packDimsCm = first === last ? first : first + '~' + last;
    }

    // 供应商 / 所在地
    let supplier = null;
    for (const l of lines.slice(0, 40)) {
      // 供应商名常带后缀：'…制品厂(个体工商户)'
      if (l.length >= 4 && l.length <= 45 && /(公司|厂|商行|经营部|工作室|门市部|工厂)([(（][^)）]{0,10}[)）])?$/.test(l) && !/卖家|买家/.test(l)) {
        supplier = l;
        break;
      }
    }
    const location = guessLocation(supplier) || parseLocation(bodyText.slice(0, 4000));

    // 销量
    const saleM = bodyText.match(/(全网销量|月销|月成交|近30天成交|已售)\s*([\d.]+\s*[万wW]?\+?\s*[件个套]?)/);
    const monthlySales = saleM ? saleM[0].replace(/\s+/g, ' ').trim() : null;

    // 一件代发：商家代发表优先，其次主商品操作区按钮
    let onePieceDropship = dropship.supported;
    let onePieceDropshipText = dropship.supported
      ? '是（' + (dropship.summary || '详情页有代发数据表') + '）'
      : '否';
    if (!dropship.supported) {
      const mainArea = bodyText.slice(0, bodyText.indexOf('同款推荐') >= 0 ? bodyText.indexOf('同款推荐') : bodyText.length);
      if (/代发下单|一键下单|密文代发|跨境铺货|铺货分销/.test(mainArea)) {
        onePieceDropship = true;
        onePieceDropshipText = '是（详情页有代发入口，无代发数据表）';
      }
    }

    // SKU 变体：属性表里的规格/颜色/尺寸 + SKU 价格对（都是页面原文）
    const skuProps = parseSkuVariants(attrs);
    const skuList = parseSkuList(String(data.skuText || ''));
    const skuVariantsText = skuProps.length
      ? skuProps.map((prop) => prop.property + '：' + prop.values.slice(0, 12).join('/') + (prop.values.length > 12 ? ' 等' + prop.values.length + '项' : '')).join('；')
      : NOT_FOUND;

    // 阶梯价文本（同一档内是 SKU 价格区间）
    const priceTiersText = formatPriceTiers(tiers, promos);
    const entryPriceCNY = tiers.length
      ? tiers[0].priceCNY
      : priceRange
        ? priceRange.min
        : null;
    const entryPriceMaxCNY = tiers.length
      ? tiers[0].priceMaxCNY
      : priceRange
        ? priceRange.max
        : null;

    // 包装规格：入口价到底对应「单件」还是「N 个装」
    const entrySku = pickEntrySku(skuList, entryPriceCNY);
    const packSpecInfo = entrySku ? parsePackSpec(entrySku.sku) : { spec: '单件', qty: 1 };
    const packTiersText = summarizePackTiers(skuList);

    const notes = [];
    if (weightSource.indexOf('商品属性') === 0) notes.push('件重来自商品属性表（' + weightSource + '）');
    if (priceRange && priceRange.max !== null && priceRange.min !== priceRange.max) {
      notes.push('同一链接起批档内最低价=入口SKU价，最高 ¥' + priceRange.max + '（更大规格SKU，实际拿货价取决于所选SKU）');
    }
    if (promos.length) notes.push('页面另标注' + promos.join('/'));

    return {
      offerId: offerId,
      title: title,
      url: cleanUrl,
      priceTiers: tiers.map((t) => ({ qty: t.qty, priceCNY: t.priceCNY, qtyText: t.qtyText, priceMaxCNY: t.priceMaxCNY })),
      priceTiersText: priceTiersText,
      priceRangeCNY: priceRange,
      entryPriceCNY: entryPriceCNY,
      entryPriceMaxCNY: entryPriceMaxCNY,
      packSpec: packSpecInfo.spec,
      packSpecQty: packSpecInfo.qty,
      entrySku: entrySku ? entrySku.sku : null,
      packTiersText: packTiersText,
      promos: promos,
      moq: moq,
      moqText: moqText || NOT_FOUND,
      material: material,
      skuVariants: skuProps,
      skuVariantsText: skuVariantsText,
      skuList: skuList,
      weightG: weightG,
      weightText: weightText,
      packDimsCm: packDimsCm,
      supplier: supplier,
      location: location,
      onePieceDropship: onePieceDropship,
      onePieceDropshipText: onePieceDropshipText,
      monthlySales: monthlySales,
      flags: data.flags || [],
      fetchedAt: new Date().toISOString(),
      source: SOURCE_DETAIL,
    };
  } finally {
    await releaseTab(tabId);
  }
}
