/**
 * dsh-amazon-research · host/selection/channels.js
 *
 * 第一部分「选品四大途径」+ 第二部分「九种选品方式」的路线图。
 *
 * 设计原则：这里只产出**可执行的路线与链接**，不伪造榜单数据。
 * 榜单 / 热搜 / 店铺 / 站外平台的具体数字必须来自真实页面或数据源；
 * 抓不到就标注「未取到」，由人补。
 */

/** Amazon 站点 → 域名（只用于拼公开榜单链接）。 */
export const AMAZON_DOMAINS = Object.freeze({
  US: 'amazon.com',
  UK: 'amazon.co.uk',
  DE: 'amazon.de',
  FR: 'amazon.fr',
  IT: 'amazon.it',
  ES: 'amazon.es',
  CA: 'amazon.ca',
  JP: 'amazon.co.jp',
  MX: 'amazon.com.mx',
  AU: 'amazon.com.au',
  IN: 'amazon.in',
  AE: 'amazon.ae',
  BR: 'amazon.com.br',
  SA: 'amazon.sa',
});

export function amazonDomain(marketplace = 'US') {
  return AMAZON_DOMAINS[String(marketplace || 'US').toUpperCase()] || AMAZON_DOMAINS.US;
}

/** nodeIdPath 的末段就是榜单链接要用的 node。 */
export function nodeFromPath(nodeIdPath) {
  const text = String(nodeIdPath || '').trim();
  if (!text) return '';
  const parts = text.split(':').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

/** 站内榜单 / 热搜入口（四个途径里的核心渠道）。 */
export const CHANNELS = Object.freeze([
  {
    id: 'best-sellers',
    part: '站内',
    name: 'Best Sellers 销售榜单',
    purpose: '看细分类目最畅销产品的应用场景与市场表现，判断天花板',
    path: '/gp/bestsellers',
    fields: ['ASIN', '标题', '品牌', '售价', '评分', '评论数', 'BSR', '卖家类型'],
    caution: '一级类目只作场景，必须先下钻到三、四级小类再看榜',
  },
  {
    id: 'new-releases',
    part: '站内',
    name: 'New Releases 新品榜单',
    purpose: '发现近 90 天新趋势与新款式，用来给老品做微创新',
    path: '/gp/new-releases',
    fields: ['ASIN', '标题', '品牌', '上架时间', '售价', '评论数', '排名变化'],
    caution: '不建议直接照抄新品榜；同款链接已多、价格易卷、小心「杀猪盘」与专利 TRO',
  },
  {
    id: 'movers-shakers',
    part: '站内',
    name: 'Movers & Shakers 飙升榜',
    purpose: '追踪 24 小时内排名变化最大、销量快速爬升的产品',
    path: '/gp/movers-and-shakers',
    fields: ['ASIN', '标题', '排名变化幅度', '当前排名', '售价', '评论数'],
    caution: '飙升可能是短期促销/站外引爆，须回查趋势与专利',
  },
  {
    id: 'most-wished-for',
    part: '站内',
    name: 'Most Wished For 心愿榜',
    purpose: '看消费者加心愿单的热门品，预测需求与礼品属性',
    path: '/gp/most-wished-for',
    fields: ['ASIN', '标题', '品牌', '售价', '评分', '评论数'],
    caution: '心愿单 ≠ 成交，需用搜索量与竞品销量复核',
  },
  {
    id: 'gift-ideas',
    part: '站内',
    name: 'Gift Ideas 礼物榜',
    purpose: '节日、生日、纪念日场景选品，适合做节日性产品',
    path: '/gp/gift-ideas',
    fields: ['ASIN', '标题', '适用节日', '售价', '评分', '评论数'],
    caution: '节日品生命周期短，备货与清仓节奏要提前算',
  },
  {
    id: 'todays-deals',
    part: '站内',
    name: "Today's Deals 今日促销",
    purpose: '秒杀与折扣位反映当前动销，可反查价格带与促销力度',
    path: '/deals',
    fields: ['ASIN', '标题', '折扣幅度', '售价', '评分', '评论数'],
    caution: '秒杀可能是服务商代报，不能当成自然畅销证据',
  },
  {
    id: 'search-terms',
    part: '站内',
    name: '热搜词 / ABA 关键词',
    purpose: '看搜索词涨跌幅，判断需求趋势与载体热度',
    path: null,
    fields: ['关键词', '搜索排名', '搜索量', '环比/同比增长', '点击集中度'],
    caution: 'ABA 排名看 10–20 万区间；关键词工具未接通时用卖家精灵网页/后台导出',
  },
]);

/** 站外渠道（第二途径）。 */
export const OFF_AMAZON_CHANNELS = Object.freeze([
  { id: 'marketplaces', name: '其他电商平台', examples: '沃尔玛、美客多、eBay、TikTok Shop、Temu、Etsy、独立站、1688、中国制造网、义乌购', use: '找同款、比价格、看海外需求差异' },
  { id: 'social', name: '社交媒体', examples: 'Instagram、Facebook、YouTube、TikTok', use: '看真实使用场景、开箱视频、痛点评论' },
  { id: 'offline', name: '线下渠道', examples: '产业带、展会、国外商超、工厂', use: '积累工厂资源、拿新品与工艺，多留微信、常问新品' },
]);

/** 软件选品（第三途径）：只做交叉验证，不替代类目分析。 */
export const SOFTWARE_CHANNELS = Object.freeze([
  { id: 'sellersprite', name: '卖家精灵', use: '类目大盘、集中度、价格带、关键词（本插件已接入）' },
  { id: 'sorftime', name: 'Sorftime', use: '类目与竞品补充验证' },
  { id: 'h10', name: 'Helium 10', use: '关键词、竞品跟踪' },
  { id: 'oulu', name: '鸥鹭', use: '选品与广告数据交叉验证' },
]);

/**
 * 九种选品方式。每条给出：适用条件、执行步骤、需要的数据、对应工具。
 * applicable(signals) 返回 { status: '推荐' | '可选' | '不适用', why }。
 */
export const STRATEGIES = Object.freeze([
  {
    id: 'segment',
    name: '细分选品',
    steps: [
      '人口细分：中年男人 / 老人 / 孩子 / 女人 / 宠物 / 户外',
      '类目细分：一级 → 二级 → 三级 → 四级，锁定叶子节点',
      '调研该细分的销量、价格区间、近半年/一年上架新品表现',
    ],
    dataNeeded: ['nodeIdPath', '类目销量', '价格带分布', '新品占比'],
    tool: 'research_category_select（nodeIdPath）',
    applicable: () => ({ status: '推荐', why: '所有选品的起点：先定细分，再看数据' }),
  },
  {
    id: 'competitor-store',
    name: '优秀竞品店铺选品',
    steps: [
      '从类目 Top 品牌/卖家进入店铺',
      '看卖家类型（品牌/贸易/工厂）与其他在售链接',
      '顺藤摸瓜找相关类目，循环挖掘',
    ],
    dataNeeded: ['Top 品牌', '卖家所属地', '店铺链接'],
    tool: 'research_category_select 报告第四节 + 浏览器进入店铺',
    applicable: (signals) => (signals.brandCr3 !== null && signals.brandCr3 < 0.5
      ? { status: '推荐', why: '品牌分散，头部店铺可复制性强' }
      : { status: '可选', why: '集中度高时优先看头部品牌而非长尾店铺' }),
  },
  {
    id: 'cross-market',
    name: '跨站点选品',
    steps: [
      '把中国供应链成熟、美国已验证的品搬到目标站点',
      '核对目的国习俗、专利、配送覆盖',
      '用同 nodeIdPath 在目标站点重跑类目数据',
    ],
    dataNeeded: ['源站点类目', '目标站点类目', '合规差异'],
    tool: 'research_category_select（marketplace 切换）',
    applicable: (signals) => (signals.marketplace && signals.marketplace !== 'US'
      ? { status: '推荐', why: '当前就在非美站点，可直接比对美国站数据' }
      : { status: '可选', why: '美国站跑通后再考虑复制到 CA/AE/SA 等站点' }),
  },
  {
    id: 'related',
    name: '关联产品选品',
    steps: ['看竞品「经常一起购买」模块', '做捆绑/套装组合', '核对组合后的物流与佣金'],
    dataNeeded: ['竞品 ASIN', 'Frequently Bought Together'],
    tool: '浏览器抓详情页 + research_product_select 体检',
    applicable: () => ({ status: '可选', why: '适合已有主推品后做客单提升' }),
  },
  {
    id: 'cross-scene',
    name: '交叉 / 同场景选品',
    steps: ['列出一个场景的全部用品（露营/宠物/浴室）', '按场景做产品组合', '验证组合内每个单品的利润'],
    dataNeeded: ['场景关键词', '组合单品'],
    tool: '浏览器 + research_product_select',
    applicable: () => ({ status: '可选', why: '适合做店铺垂直与关联销售' }),
  },
  {
    id: 'same-product-new-scene',
    name: '相同产品不同场景',
    steps: ['找一个成熟品', '换人群/场景重新包装与主图', '验证新场景关键词搜索量'],
    dataNeeded: ['原品 ASIN', '新场景关键词'],
    tool: '浏览器 + research_product_select',
    applicable: () => ({ status: '可选', why: '差异化成本最低，但要避免同质化跟卖' }),
  },
  {
    id: 'high-price',
    name: '高单价选品',
    steps: ['售价 $50–120、采购 ¥50–150、配送费 ≤ $15–20', '用高客单避开价格战', '确认资金与售后能力'],
    dataNeeded: ['价格带分布', '采购价', 'FBA 费'],
    tool: 'research_category_select + research_unit_cost',
    applicable: (signals) => (signals.avgPrice !== null && signals.avgPrice > 45
      ? { status: '推荐', why: '类目均价已在高价带，适合走利润型' }
      : { status: '可选', why: '类目均价偏低时，高单价需要强差异化支撑' }),
  },
  {
    id: 'new-market',
    name: '新型产品 / 新市场',
    steps: ['新站点：中东、加拿大、爱尔兰等', '换代品：手机电器、汽车/新能源、VR/无人机/3D 打印', '提前布局、关注类目排名爬升'],
    dataNeeded: ['目标站点', '新技术类目'],
    tool: 'research_category_select（marketplace）',
    applicable: (signals) => (['AE', 'SA', 'CA', 'MX', 'BR'].includes(signals.marketplace)
      ? { status: '推荐', why: '当前站点属于新兴/低竞争站点' }
      : { status: '可选', why: '需要额外验证合规与物流覆盖' }),
  },
  {
    id: 'hot-carrier',
    name: '热门载体选品',
    steps: ['用 BS 榜找稳定销量载体', '用新品榜看载体趋势', '用热搜词确认载体热度', '围绕载体覆盖周边'],
    dataNeeded: ['载体关键词', 'BS/新品榜', '搜索趋势'],
    tool: '浏览器榜单 + 关键词工具 + research_product_select',
    applicable: () => ({ status: '可选', why: '前提是载体有足够体量与上升趋势，侵权风险高需先查' }),
  },
]);

/** 十维数据清单（与 kpis.js 的检查项一一对应，供报告引用）。 */
export const DIMENSION_CHECKLIST = Object.freeze([
  { no: 1, name: '市场容量与竞争热度', kpi: 'Top100 月销 10–30 万；品牌集中度 < 50%；前 10 评价 < 1000；利润率 > 30%', source: '卖家精灵类目 + ABA' },
  { no: 2, name: '产品趋势', kpi: '近三年搜索趋势不衰退；ABA 排名 10–20 万', source: 'Google Trends / ABA / 卖家精灵' },
  { no: 3, name: '价格区间', kpi: '避开无利润基本消费带；主攻 $15–45 或高单价带', source: '价格带分布 + 竞品售价' },
  { no: 4, name: '评分数量与星级', kpi: '前 10 评价 < 1000；低评分可作差异化入口', source: '商品详情页 / 评论' },
  { no: 5, name: '新品占有率', kpi: '新品占比 10%–25%；半年–一年新品有销量', source: '上架时间分布' },
  { no: 6, name: '季节性 / 节日性', kpi: '新手优先全年平稳款；节日品单独设备货节奏', source: 'Google Trends / 类目历史' },
  { no: 7, name: '质量、退货与变体', kpi: '退货率 < 5%；差评点可解决；变体 ≤ 3', source: '评论 / 退货率 / 变体' },
  { no: 8, name: '运输便利性', kpi: '非易碎非抛货；物流占售价 10%–15%，> 20% 放弃', source: '件重尺寸 / FBA 费' },
  { no: 9, name: '供应链优势', kpi: '至少 2 家供应商；能配合微创新与账期', source: '1688 / 工厂' },
  { no: 10, name: '侵权、认证与类目审核', kpi: '无专利/商标风险；认证拿得到；非受限类目', source: 'WIPO / 商标局 / 平台规则' },
]);

/** 组装「四途径 → 九策略 → 十维」的执行路线（不取数、不消耗额度）。 */
export function buildSelectionPlan({ marketplace = 'US', category = '', nodeIdPath = '', keyword = '', signals = {} } = {}) {
  const site = String(marketplace || 'US').toUpperCase();
  const domain = amazonDomain(site);
  const node = nodeFromPath(nodeIdPath);
  const ctx = {
    marketplace: site,
    category,
    nodeIdPath,
    keyword,
    brandCr3: typeof signals.brandCr3 === 'number' ? signals.brandCr3 : null,
    avgPrice: typeof signals.avgPrice === 'number' ? signals.avgPrice : null,
  };

  const channels = CHANNELS.map((channel) => ({
    ...channel,
    url: channel.path
      ? 'https://www.' + domain + channel.path + (node && channel.id !== 'todays-deals' ? '/' + node : '')
      : null,
    status: channel.id === 'search-terms' ? '需关键词工具（卖家精灵/ABA）' : '待抓取',
  }));

  const strategies = STRATEGIES.map((strategy) => {
    const verdict = strategy.applicable(ctx);
    return {
      id: strategy.id,
      name: strategy.name,
      status: verdict.status,
      why: verdict.why,
      steps: [...strategy.steps],
      dataNeeded: [...strategy.dataNeeded],
      tool: strategy.tool,
    };
  });

  const nextActions = [
    '1) 从榜单/热搜里取候选 ASIN（或用类目报告 Top 商品），整理成采集表（模板见 assets/selection-table-template.csv）',
    '2) 调 research_product_select（action=screen）做十维持检、一票否决与分档',
    '3) 对一档/二档候选调 research_unit_cost 采 1688 真实采购价，重算净利率',
    '4) 人工核查 WIPO 外观/发明/实用新型与商标，确认认证与类目审核',
    '5) 按差异化清单改包装/组合/主图，小批量测款后再放量',
  ];

  return {
    marketplace: site,
    category,
    nodeIdPath,
    keyword,
    domain,
    channels,
    offAmazon: OFF_AMAZON_CHANNELS.map((item) => ({ ...item })),
    software: SOFTWARE_CHANNELS.map((item) => ({ ...item })),
    strategies,
    dimensions: DIMENSION_CHECKLIST.map((item) => ({ ...item })),
    nextActions,
    note: '榜单链接只是入口，页面数字需真实抓取；抓不到写「未取到」，不要用记忆补。',
  };
}
