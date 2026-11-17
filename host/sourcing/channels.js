/**
 * dsh-amazon-research · host/sourcing/channels.js
 *
 * 销售渠道成本模型：**同一个品在不同渠道是完全不同的生意**。
 *
 * 为什么必须有这个维度（实测：Work Glove Holders 4 件装）：
 *   - Amazon FBA：小号标准件 FBA 配送费 $3.22，而售价只有 $5.49 → 配送费吃掉 59% 收入，必亏；
 *   - TikTok Shop 美国站：平台佣金 6%、无 FBA 配送费、履约走跨境直发物流 → 同一品可以赚。
 *   插件原先只有 Amazon FBA 一套模型，会对做 TK/独立站/线下渠道的卖家系统性误判低价品。
 *
 * 所有费率都标注来源与口径；不确定的写成「估算值」，必须允许用户用实测值覆盖。
 */

/** 渠道模型。fulfillment 决定履约成本怎么算。 */
export const CHANNEL_MODELS = Object.freeze({
  'amazon-fba': Object.freeze({
    id: 'amazon-fba',
    label: 'Amazon FBA（美国站）',
    platform: 'amazon',
    /** 履约方式：fba = 按重量档位表；fbm = 自发货（无平台配送费）；cross = 跨境直发物流 */
    fulfillment: 'fba',
    referralRate: 0.15,
    adRate: 0.10,
    returnRate: 0.05,
    otherUSD: 0.35,
    /** 跨境/头程：¥/kg */
    firstMilePerKgCNY: 35,
    /** 跨境直发：每件基础 + 每 kg */
    fulfillmentBaseUSD: 0,
    fulfillmentPerKgUSD: 0,
    /** 价格带参考（稳态区间） */
    priceBand: { min: 15, max: 45 },
    notes: [
      '平台佣金 15%（工具/家居 15%，工业科学 12%，服饰 17%，美妆电子 8%）',
      'FBA 配送费按件重档位估算：小号标准 ≤4oz $3.22 起',
      '头程 ¥35/kg（海运 + 贴标 + 操作摊销）',
      '广告 10%、退货损耗 5%、仓储/其它 $0.35',
    ],
  }),
  'amazon-fbm': Object.freeze({
    id: 'amazon-fbm',
    label: 'Amazon 自发货 FBM（美国站）',
    platform: 'amazon',
    fulfillment: 'fbm',
    referralRate: 0.15,
    adRate: 0.12,
    returnRate: 0.05,
    otherUSD: 0.15,
    firstMilePerKgCNY: 35,
    fulfillmentBaseUSD: 0,
    fulfillmentPerKgUSD: 0,
    priceBand: { min: 15, max: 80 },
    notes: [
      '无 FBA 配送费，但买家运费需自行处理或自付包邮',
      '退货要自己处理（含退货物流与二次销售）',
      '适合大件、高客单、或 FBA 费占比过高的低价品',
    ],
  }),
  'tiktok-shop': Object.freeze({
    id: 'tiktok-shop',
    label: 'TikTok Shop 美国站（跨境直发）',
    platform: 'tiktok',
    fulfillment: 'cross',
    /** 平台佣金 6%（TikTok Shop 美国站 2026-10 费率表，多数类目） */
    referralRate: 0.06,
    /** 达人带货佣金 / 广告合并按 12% 估 */
    adRate: 0.12,
    /** TK 冲动消费退货率高于 Amazon，按 8% 估 */
    returnRate: 0.08,
    otherUSD: 0,
    /** 跨境直发：头程并入履约，不再单算 */
    firstMilePerKgCNY: 0,
    /** 每件基础运费 + 每 kg 增量（估算值，按 56g 级小包专线） */
    fulfillmentBaseUSD: 2.2,
    fulfillmentPerKgUSD: 8,
    priceBand: { min: 8, max: 25 },
    notes: [
      '平台佣金 6%（TikTok Shop 美国站 2026-10 费率表，多数类目）',
      '无 FBA 配送费；履约 = 跨境直发物流（默认 $2.20/件 + $8/kg 估算值）',
      '达人带货佣金/广告按 12% 估；冲动消费退货率按 8% 估',
      '无 Amazon 仓储费与长期仓储费',
    ],
  }),
});

export const DEFAULT_CHANNEL = 'amazon-fba';

export function listChannels() {
  return Object.values(CHANNEL_MODELS).map((model) => ({
    id: model.id,
    label: model.label,
    platform: model.platform,
    referralRate: model.referralRate,
    priceBand: model.priceBand,
    notes: [...model.notes],
  }));
}

export function getChannel(id) {
  const key = String(id || '').trim().toLowerCase();
  return Object.hasOwn(CHANNEL_MODELS, key) ? CHANNEL_MODELS[key] : null;
}

export function resolveChannel(id) {
  return getChannel(id) || CHANNEL_MODELS[DEFAULT_CHANNEL];
}
