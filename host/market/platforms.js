/**
 * 沙特（SA）两平台口径定义：Amazon.sa + Trendyol.sa。
 *
 * 插件只在这两个平台找品（Temu / AliExpress 已按要求移除）。
 *
 * 这份文件只放口径与常量，不放数字结论：
 *   - 平台公布什么、不公布什么（决定 GMV 能不能算）；
 *   - 前台需求代理指标（两平台口径不同，禁止互相换算）；
 *   - 人群画像固定维度（缺就写未取到）；
 *   - 沙特地区枚举。
 *
 * 费用口径分两套，不得混用：
 *   - Trendyol.sa：工作流 v1 固定口径（佣金 10% / 广告 8% / 售后 4%，VAT 15%，尾程 10，固定 5，退回 15，头程 68 RMB/kg，CNY→SAR 1.8）；
 *   - Amazon.sa：本插件不内置费率，必须由用户显式提供，否则费用维度记「未取到」。
 */

export const SA_MARKET = 'SA';
export const SA_CURRENCY = 'SAR';

/** 工作流 v1 的 Trendyol 沙特固定口径（来自用户 SKILL.md，不得静默修改）。 */
export const TRENDYOL_SA_FEE_PROFILE = {
  preset: 'trendyol-sa-v1',
  platform: 'trendyol-sa',
  label: 'Trendyol 沙特工作流 v1 口径',
  vatRate: 0.15,
  commissionRate: 0.10,
  adRate: 0.08,
  afterSalesRate: 0.04,
  forwardLastMileSAR: 10,
  otherFixedSAR: 5,
  returnLastMileSAR: 15,
  freightRMBPerKg: 68,
  cnyToSar: 1.8,
  source: 'Trendyol 沙特选品工作流 v1（用户提供，2026-11-11 修订）',
};

/** Amazon.sa 没有内置费率：必须显式传 feeProfile，否则费用维度未取到。 */
export const AMAZON_SA_FEE_TEMPLATE = {
  preset: 'amazon-sa-custom',
  platform: 'amazon-sa',
  label: 'Amazon.sa 自定义费率（未内置）',
  vatRate: 0.15,
  commissionRate: null,
  adRate: null,
  afterSalesRate: null,
  forwardLastMileSAR: null,
  otherFixedSAR: null,
  returnLastMileSAR: null,
  freightRMBPerKg: 68,
  cnyToSar: 1.8,
  source: '待用户提供 Amazon.sa 实际类目佣金、广告、履约与退货费用',
};

export const SA_PLATFORMS = [
  {
    id: 'amazon-sa',
    label: 'Amazon.sa',
    domain: 'https://www.amazon.sa',
    searchUrl: 'https://www.amazon.sa/s?k={q}',
    currency: SA_CURRENCY,
    model: '本地仓 FBA + 第三方卖家 + 自营',
    officialSaGmv: false,
    disclosure: 'Amazon 财报按北美/国际分部披露，不拆分沙特；沙特 GMV 无官方数字',
    demandProxy: 'ratingCount',
    proxyLabel: '评分数量（累计，含历史）',
    proxyThresholds: { strong: 500, medium: 100 },
    extraSignals: ['Best Seller 标识', 'Amazon Choice 标识', '搜索结果总数（仅可发现度）'],
    profileCaveat: '评分数量是累计社会证明，不等于近期销量；广告位与自然位必须分开记录',
    feeProfile: AMAZON_SA_FEE_TEMPLATE,
    feeNote: 'Amazon.sa 费率未内置；未提供 feeProfile 时单位经济一票否决只能给「待确认」',
  },
  {
    id: 'trendyol-sa',
    label: 'Trendyol.sa',
    domain: 'https://www.trendyol.sa/en',
    searchUrl: 'https://www.trendyol.sa/en/sr?q={q}',
    currency: SA_CURRENCY,
    model: '跨境 + 本地卖家',
    officialSaGmv: false,
    disclosure: 'Trendyol 不公开沙特 GMV；仅有评价数量等前台信号',
    demandProxy: 'ratingCount',
    proxyLabel: '评价数量（含仅评分）',
    proxyThresholds: { strong: 500, medium: 100 },
    extraSignals: ['评分星级', '搜索结果数', '卖家类型'],
    profileCaveat: '评价数量含仅打分不写文字的记录，不能当文字评论数；不得与 Amazon 分数横比',
    feeProfile: TRENDYOL_SA_FEE_PROFILE,
    feeNote: '按工作流 v1 固定口径；取得 Seller Center 实际账单后可覆盖',
  },
];

export function platformIds() {
  return SA_PLATFORMS.map((p) => p.id);
}

export function getSaPlatform(id) {
  const key = String(id || '').trim().toLowerCase();
  return SA_PLATFORMS.find((p) => p.id === key) || null;
}

/** 沙特地区枚举（用于地区消费占比）。 */
export const SA_REGIONS = [
  { id: 'riyadh', label: '利雅得 Riyadh' },
  { id: 'makkah', label: '麦加/吉达 Makkah-Jeddah' },
  { id: 'eastern', label: '东部省 Dammam-Khobar' },
  { id: 'madinah', label: '麦地那 Madinah' },
  { id: 'asir', label: '阿西尔 Asir' },
  { id: 'qassim', label: '卡西姆 Qassim' },
  { id: 'tabuk', label: '塔布克 Tabuk' },
  { id: 'other', label: '其他/未细分' },
];

/** 人群画像维度：固定维度便于跨平台对齐；缺失即未取到。 */
export const CONSUMER_DIMENSIONS = [
  { id: 'age', label: '年龄结构', unit: 'share' },
  { id: 'gender', label: '性别结构', unit: 'share' },
  { id: 'income', label: '收入层次', unit: 'share' },
  { id: 'device', label: '终端偏好（iOS/Android/Web）', unit: 'share' },
  { id: 'payment', label: '支付方式（COD/卡/钱包/BNPL）', unit: 'share' },
  { id: 'habit', label: '购物习惯（比价/囤货/直播/复购）', unit: 'text' },
  { id: 'delivery', label: '时效与履约预期', unit: 'text' },
  { id: 'season', label: '季节性高峰（斋月/开斋节/白色星期五）', unit: 'text' },
  { id: 'language', label: '语言与内容偏好', unit: 'text' },
];

export const GMV_METRICS = ['gmv', 'orders', 'buyers', 'appDownloads', 'traffic', 'gmvGrowth'];

export const GMV_SCOPES = [
  'saudi-total',
  'saudi-cross-border',
  'saudi-domestic',
  'saudi-category',
  'platform-global',
  'mena',
];

export const BASIS_LEVELS = ['official', 'reported', 'third-party-estimate', 'model-estimate'];

export const BASIS_LABELS = {
  official: '平台/财报官方披露',
  reported: '平台公开页面或公开表态',
  'third-party-estimate': '第三方机构估测',
  'model-estimate': '本方模型推算（不得当事实引用）',
};

/** 分级：绝对值 → 强/中/弱/未取到。阈值来自 proxyThresholds，属启发式。 */
export function gradeProxy(platformId, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '未取到';
  const platform = getSaPlatform(platformId);
  if (!platform) return '未取到';
  const { strong, medium } = platform.proxyThresholds;
  if (value >= strong) return '强';
  if (value >= medium) return '中';
  return '弱';
}

export const GRADE_RANK = { 强: 3, 中: 2, 弱: 1, 未取到: 0 };
