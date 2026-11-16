/**
 * dsh-amazon-research · host/selection/differentiate.js
 *
 * 第四部分「差异化」规则引擎：从十维体检的短板与差评点推导可执行的差异化方向。
 *
 * 原则：每条建议都必须挂上**体检里真实存在的证据**（数值或文字），
 * 没有证据的方向不输出；不承诺「改了就能卖」，只给验证动作。
 */

const AXIS = Object.freeze({ EXTERNAL: '外在', INTERNAL: '内在' });

function pct(value, digits = 0) {
  return value === null || value === undefined ? '—' : (value * 100).toFixed(digits) + '%';
}

/**
 * @param {object} candidate evaluateCandidate 的返回
 * @returns {Array<{axis:string, direction:string, evidence:string, action:string, priority:number}>}
 */
export function suggestDifferentiation(candidate = {}) {
  const list = [];
  const add = (priority, axis, direction, evidence, action) => {
    list.push({ priority, axis, direction, evidence, action });
  };
  const checks = new Map((candidate.checks || []).map((item) => [item.key, item]));
  const get = (key) => checks.get(key);
  const flags = candidate.flags || {};
  const margin = candidate.margin;
  const profit = candidate.profit;

  // 1) 差评点可解决 —— 最直接的差异化入口
  if (flags.hasPain) {
    add(1, AXIS.INTERNAL, '针对差评点做功能/结构改进',
      '已归纳差评：' + (get('reviewPain')?.value || ''),
      '打样时逐条对照差评改结构/材质，主图用对比图讲清改进点');
  }

  // 2) 评分偏低 —— 质量与体验差异化
  const rating = get('rating');
  if (rating && rating.status !== '未知' && candidate.rating !== null && candidate.rating < 4.3) {
    add(2, AXIS.INTERNAL, '质量与说明书优化',
      '评分 ' + candidate.rating.toFixed(1) + '（< 4.3）',
      '抽 20–50 条 3 星及以下评论做词频，优先修高频质量问题与安装说明');
  }

  // 3) 退货率偏高
  const returns = get('returns');
  if (returns && returns.status !== '达标' && returns.status !== '未知') {
    add(2, AXIS.INTERNAL, '防退货设计',
      '退货率 ' + returns.value,
      '加固包装、补尺寸/适配说明，必要时改结构降低误用');
  }

  // 4) 价格/采购压力 —— 组合与包装提客单
  const priceBand = get('priceBand');
  const purchase = get('purchaseRatio');
  const lowPrice = priceBand && priceBand.status === '不达标';
  const highPurchase = purchase && purchase.status !== '达标' && purchase.status !== '未知';
  if (lowPrice || highPurchase) {
    add(3, AXIS.EXTERNAL, '组合装 / 多件装 / 套装提客单',
      (lowPrice ? '售价 ' + priceBand.value + ' 偏低；' : '') + (highPurchase ? '采购占售价 ' + purchase.value + ' 偏高' : ''),
      '做 2–4 件组合、加配件或礼品包装，把客单拉到 $15–45 区间再测算');
  }

  // 5) 物流占比高 —— 轻量化 / 折叠
  const logistics = get('logistics');
  if (logistics && logistics.status !== '达标' && logistics.status !== '未知') {
    add(3, AXIS.INTERNAL, '轻量化 / 折叠 / 拆装降物流',
      '物流占售价 ' + logistics.value + '（目标 10%–15%）',
      '换轻材质、可拆装结构或压缩包装，重算 FBA 与头程');
  }

  // 6) 强季节性 —— 节日套装与礼品化
  if (/强|季节|节日/.test(flags.seasonality || '')) {
    add(4, AXIS.EXTERNAL, '节日套装 / 礼品化包装',
      '季节性：' + flags.seasonality,
      '做节日限定包装与 bundle，按节日倒推备货与清仓节点');
  }

  // 7) 品牌集中度高 —— 换人群/场景切入
  const concentration = get('concentration');
  if (concentration && concentration.status === '警戒') {
    add(4, AXIS.INTERNAL, '人群 / 场景细分切入',
      '品牌集中度 ' + concentration.value + '，正面硬刚不划算',
      '换人群（老人/儿童/宠物/户外）或换场景重新定义卖点与关键词');
  }

  // 8) 新品占比低 —— 材质/外观微创新
  if (flags.newProductPct !== null && flags.newProductPct < 10) {
    add(5, AXIS.INTERNAL, '材质 / 外观微创新',
      '新品占比 ' + flags.newProductPct.toFixed(0) + '%（< 10%，类目偏固化）',
      '在成熟款上换材质、配色或细节结构，避免与头部同质化');
  }

  // 9) 广告占比高 —— 主图/卖点/评论资产
  const ad = get('adRatio');
  if (ad && ad.status !== '达标' && ad.status !== '未知') {
    add(5, AXIS.EXTERNAL, '主图 / 卖点 / 评论资产',
      '广告占售价 ' + ad.value,
      '重做首图与 A+、提炼 3 个差异卖点，先把自然转化拉起来再放广告');
  }

  // 10) 变体空间 —— SKU 组合（新卖家 ≤ 3）
  const variants = get('variants');
  if (variants && variants.status === '达标') {
    add(6, AXIS.EXTERNAL, '颜色 / 尺寸 / SKU 组合（≤ 3 个）',
      '当前变体数 ' + variants.value + '，仍有组合空间',
      '首批发 2–3 个变体测点击，跑出主推色/尺寸后再补');
  }

  // 11) 认证前置 —— 合规也是差异化
  const cert = get('certification');
  if (cert && cert.status === '警戒') {
    add(6, AXIS.INTERNAL, '认证前置与合规设计',
      '认证要求：' + cert.value,
      '先确认证书与测试报告拿得到，再决定是否改材料/结构');
  }

  // 12) 兜底：包装与主图是永远可做的外在差异化
  add(7, AXIS.EXTERNAL, '包装 / 主图 / 说明书基础优化',
    margin === null ? '利润未测算，先补齐成本' : '净利率 ' + pct(margin, 1) + (profit ? '，物流占比 ' + pct(profit.logisticsRatio) : ''),
    '统一视觉与开箱体验，说明书降低误用退货；上架前自查图片素材版权');

  return list.sort((a, b) => a.priority - b.priority);
}

/** 精铺闭环（第四部分第 3 条）：从类目到定品的固定动作。 */
export const PRECISION_LOOP = Object.freeze([
  '细分类目 → 竞品店铺 → 找到相关类目 → 分析',
  '筛同类的不同产品链接：上架 0.5–1 年、评论不多、趋势不错、评分高、售价偏高',
  '用核心关键词搜前台，确认是否已有同款竞品',
  '定目标月销（如 100–300 单），拆竞品差评',
  '按差异化清单改产品/包装/主图，提升利润空间',
  '小批量测款 → 跑通再放量；补货「多补少发」，后期做包装优化',
]);
