/**
 * 沙特两平台（Amazon.sa + Trendyol.sa）的数据来源清单与采集动作。
 *
 * 关键事实（也是本模块存在的理由）：
 *   Amazon.sa 与 Trendyol.sa 都不公开沙特口径 GMV。所以规模这一层只有三类东西：
 *     1) 母公司财报的区域/集团合并数字（不是沙特单市场）；
 *     2) 第三方机构对沙特电商或某平台的估测（必须带机构名、口径、年份）；
 *     3) 前台可观测代理指标（评价数、评分增长、榜单、搜索页结果数）。
 *   本模块不把 1) 2) 3) 互相换算成平台 GMV，也不补经验值。
 */

export const MACRO_SOURCES = [
  {
    id: 'platform-filing',
    label: '平台财报 / 投资者关系页',
    covers: ['gmv', 'revenue', 'orders', 'buyers'],
    scope: 'platform-global 或区域合并（通常不是沙特单市场）',
    basis: 'official',
    how: 'Amazon 10-K/10-Q 国际分部；Trendyol 母公司（DMK）披露',
    caveat: '只到区域/合并层级；不能写成沙特 GMV。用于判断量级与增速方向。',
  },
  {
    id: 'saudi-official',
    label: '沙特官方统计（GASTAT / SAMA / 商务部）',
    covers: ['saudi-total e-commerce', 'payment mix', 'population', 'income'],
    scope: 'saudi-total',
    basis: 'official',
    how: 'GASTAT 电商与零售统计、SAMA 支付统计、人口与家庭支出口径',
    caveat: '给的是全市场与支付结构，不拆平台；只能作为地区/人群的分母参考。',
  },
  {
    id: 'third-party',
    label: '第三方电商/流量机构估测',
    covers: ['gmv', 'traffic', 'appDownloads', 'buyers'],
    scope: 'saudi 或 mena',
    basis: 'third-party-estimate',
    how: 'Similarweb / Sensor Tower / data.ai 类流量下载；区域电商研究机构报告',
    caveat: '估测方法与误差不公开；必须写机构名与口径年份，不得与官方数字混排成同一列。',
  },
  {
    id: 'storefront-proxy',
    label: '平台前台可观测信号',
    covers: ['ratingCount', 'rating', '搜索结果数', 'bestseller 标识', '评论增长'],
    scope: '关键词搜索样本',
    basis: 'reported',
    how: 'Chrome 已登录页面 + research_page（read/scrollAll）；Trendyol 可用 research_category_select(platform=trendyol)',
    caveat: '样本非全类目；两平台口径不同，禁止互相换算成销量或 GMV。',
  },
  {
    id: 'consumer-panel',
    label: '消费者行为调研 / 应用商店评论 / 社媒舆情',
    covers: ['age', 'gender', 'income', 'device', 'payment', 'habit'],
    scope: 'saudi 或 mena',
    basis: 'third-party-estimate',
    how: '区域消费者调研、App Store/Google Play 沙特区评论分布、平台招商资料受众描述',
    caveat: '多为抽样或平台自述；样本量与年份必须记录。',
  },
];

/** 每个分析层级要采什么、在哪采、采不到怎么办。 */
export const COLLECTION_STEPS = [
  {
    layer: 'L1 平台体量与增速（近两年）',
    fields: ['gmv', 'orders', 'buyers', 'gmvGrowth'],
    action: '先查两家财报与第三方估测；只有拿到沙特口径才填 saudi-total，只拿到区域就填 mena 或 platform-global。',
    missing: '两家都不披露沙特 GMV 时，GMV 一栏写「未取到」，改用前台代理指标做相对比较——不要编数字。',
  },
  {
    layer: 'L2 地区消费占比',
    fields: ['region share per platform'],
    action: '优先用平台招商资料或第三方地区分布；拿不到就只用沙特官方人口与零售分布做分母，并标明不是平台口径。',
    missing: '没有平台级地区数据时，只能给全市场参考，不能声称某平台在利雅得占多少。',
  },
  {
    layer: 'L3 人群画像',
    fields: ['age', 'gender', 'income', 'device', 'payment', 'habit', 'delivery', 'season', 'language'],
    action: '每个维度单独记录来源与年份；平台自述与第三方调研分开标注。',
    missing: '单维度缺失写「未取到」，不要把 Amazon 的人群结构套到 Trendyol。',
  },
  {
    layer: 'L4 类目差异化',
    fields: ['price per platform', 'demand proxy per platform', 'specs', 'seller type'],
    action: '同一用途、同一规格对齐后再比价；记录前台价、评价数/评分增长、卖家类型、是否 sponsored。',
    missing: '规格没对齐的样本不进价差计算，只作存在性证据。',
  },
];

/** 各平台可攻击面：不预设结论，只列可验证方向。 */
export const DIFFERENTIATION_ANGLES = {
  'amazon-sa': [
    '本地仓时效与退货体验（Prime 次日达）',
    '阿语 listing、阿语安装说明与本地售后',
    '套装/多件装抬高客单，避开单件低价竞争',
    'B2B/工程批量（酒店、装修承包商）',
  ],
  'trendyol-sa': [
    '土系供应链款式与审美，与本地装修风格接近',
    '评价数已高的成熟品类不做普通同款',
    '本地卖家发货时效是主要竞争点',
    '中低价位、快反上新；[LD] 改良款新建独立页面',
  ],
};

export function sourceCatalog() {
  return MACRO_SOURCES.map((item) => ({ ...item }));
}

export function collectionPlaybook() {
  return COLLECTION_STEPS.map((item) => ({ ...item, fields: [...item.fields] }));
}

export function differentiationAngles() {
  const out = {};
  for (const [key, list] of Object.entries(DIFFERENTIATION_ANGLES)) out[key] = [...list];
  return out;
}
