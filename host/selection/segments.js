/**
 * dsh-amazon-research · host/selection/segments.js
 *
 * 分位段分析：回答「卖家/品牌集中度高的类目里，第 50–100 名还有没有利润可做」。
 *
 * 为什么需要（老卖家的真实打法）：
 *   Top3 集中度 88% 看着吓人，但那说明**头部很贵**（评论多、评论壁垒高、利润被压）。
 *   真正的机会常在**中长尾**：销量第 20–100 名的链接评论少、售价接近头部、利润反而更高。
 *   所以不能只看类目集中度就否掉整个类目 —— 要按销量分段看每一段的价格/评论/利润。
 *
 * 分段口径：按样本内销量排名切
 *   S1  头部   1–10
 *   S2  腰部   11–30
 *   S3  中长尾 31–50
 *   S4  长尾   51–100
 */
import { landedCost } from '../sourcing/cost-model.js';

export const SEGMENTS = Object.freeze([
  { id: 'S1', label: '头部（1–10）', from: 1, to: 10 },
  { id: 'S2', label: '腰部（11–30）', from: 11, to: 30 },
  { id: 'S3', label: '中长尾（31–50）', from: 31, to: 50 },
  { id: 'S4', label: '长尾（51–100）', from: 51, to: 100 },
]);

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function avg(list, pick) {
  const values = list.map(pick).filter((v) => typeof v === 'number' && Number.isFinite(v));
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function median(list, pick) {
  const values = list.map(pick).filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!values.length) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/**
 * 按销量排名切片并逐段算：价格带、评论数、变体数、净利率、能不能做。
 * @param {{rows:Array<object>, channel?:string, fx?:number, profile?:object}} input
 *   rows 必须是采集表行（已含 售价USD / 评论数 / 采购价CNY / 重量g 等）
 */
export function analyzeSegments({ rows = [], channel = 'amazon-fba', fx = 7.1, profile = null } = {}) {
  const priced = rows
    .map((row, index) => {
      const price = num(row['售价USD'] ?? row.priceUSD);
      const units = num(row['月销'] ?? row.monthlySales);
      return { row, index, price, units, asin: row.ASIN || row.asin || '' };
    })
    .sort((a, b) => {
      const ua = a.units === null ? -1 : a.units;
      const ub = b.units === null ? -1 : b.units;
      if (ua !== ub) return ub - ua;
      return a.index - b.index;
    });

  const segments = [];
  for (const seg of SEGMENTS) {
    const slice = priced.filter((item) => {
      const rank = item.index + 1;
      return rank >= seg.from && rank <= seg.to;
    });
    if (slice.length === 0) {
      segments.push({ ...seg, count: 0, note: '样本不足（需要更多候选）' });
      continue;
    }
    const margins = [];
    const pricedCount = { count: 0 };
    for (const item of slice) {
      const row = item.row;
      const price = num(row['售价USD'] ?? row.priceUSD);
      const purchase = num(row['采购价CNY'] ?? row.purchaseCNY);
      const unitPrice = num(row['单件采购价CNY'] ?? row.unitPriceCNY);
      const packUnits = num(row['每个可售单位件数'] ?? row.packUnits);
      let costCNY = purchase;
      if (costCNY === null && unitPrice !== null && packUnits) costCNY = unitPrice * packUnits;
      if (costCNY === null || !price) continue;
      const calc = landedCost({
        channel,
        priceCNY: costCNY,
        weightG: num(row['重量g'] ?? row.weightG),
        priceUSD: price,
        adRate: num(row['广告占比'] ?? row.adPct) ?? undefined,
        returnRate: num(row['退货率'] ?? row.returnPct) ?? undefined,
        commissionRate: channel.startsWith('amazon') ? (num(row['佣金占比'] ?? row.commissionPct) ?? undefined) : undefined,
        fx,
      });
      if (!calc) continue;
      margins.push(calc.netMargin);
      pricedCount.count += 1;
    }
    const avgMargin = margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : null;
    const medianMargin = median(margins, (v) => v);
    const positive = margins.filter((v) => v > 0).length;
    const good = margins.filter((v) => v >= 0.25).length;
    const avgReviews = avg(slice, (item) => num(item.row['评论数'] ?? item.row.reviews));
    const avgPrice = avg(slice, (item) => item.price);
    const medPrice = median(slice, (item) => item.price);
    const avgVariants = avg(slice, (item) => num(item.row['变体数'] ?? item.row.variants));
    // 能不能做：用画像净利率红线（没有画像时按 25%）
    const redline = profile && typeof profile.marginRedline === 'number' ? profile.marginRedline : 0.25;
    let verdict = '数据不足';
    let why = '';
    if (margins.length === 0) {
      verdict = '缺采购价';
      why = '该段没有可测算利润的候选（缺 1688 实测采购价）';
    } else if (avgMargin >= redline + 0.05) {
      verdict = '可做';
      why = '平均净利率 ' + (avgMargin * 100).toFixed(1) + '% 高于红线 ' + (redline * 100).toFixed(0) + '%，且中位净利率 ' + (medianMargin * 100).toFixed(1) + '%，' + good + '/' + margins.length + ' 个达 25%';
    } else if (avgMargin >= redline) {
      verdict = '可小批量试';
      why = '平均净利率 ' + (avgMargin * 100).toFixed(1) + '% 刚过红线 ' + (redline * 100).toFixed(0) + '%，' + good + '/' + margins.length + ' 个达 25%';
    } else if (avgMargin > 0) {
      verdict = '只能跑体量';
      why = '平均净利率 ' + (avgMargin * 100).toFixed(1) + '%，低于红线；' + positive + '/' + margins.length + ' 个为正，靠走量';
    } else {
      verdict = '暂不做';
      why = '平均净利率 ' + (avgMargin * 100).toFixed(1) + '%，整体亏损';
    }
    segments.push({
      ...seg,
      count: slice.length,
      pricedCount: pricedCount.count,
      avgPrice,
      medianPrice: medPrice,
      avgReviews,
      avgVariants,
      avgMargin,
      medianMargin,
      positiveRatio: margins.length ? positive / margins.length : null,
      goodRatio: margins.length ? good / margins.length : null,
      verdict,
      why,
      asins: slice.map((item) => item.asin).filter(Boolean),
    });
  }
  return {
    segments,
    total: priced.length,
    note: '分段按**样本内销量排名**切；样本来自实际采集的候选，不是类目全量。净利率按各渠道成本模型测算（广告 10% / 退货 5% / 佣金按渠道）。',
  };
}
