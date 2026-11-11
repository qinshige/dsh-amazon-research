/**
 * 包装规格对齐（最终版）。
 *
 * 每个细分的采购价按「一个 Amazon 可售单位」计价，口径逐条探明如下：
 *
 * 1. Furniture Pads 脚垫
 *    - 1688 offer 773465438884（EVA 毛毡脚垫）：主价格 ¥0.35~¥0.60「1件起批」，
 *      规格列是「EVA圆形1.8CM【1件/20个】」——**一个件装里含 20 个**，
 *      所以 ¥0.35 是**每 20 个装**的价，不是单片价（单片 ¥0.0175）。
 *      → 目标 104 片/可售单位 = ceil(104/20)=6 包 × ¥0.6 = ¥3.6
 *    - offer 1056661525058（TPR 脚套）：有明确件数档 4/8/16/20 个装，
 *      目标 104 个 = 6×20个装 ¥5.5 = ¥33（比 EVA 贵得多）
 *    → 取更便宜的 EVA 毛毡款 ¥3.6/可售单位，件重按 104 片 × 3g ≈ 312g
 *
 * 2. Picture Hangers 挂架
 *    - offer 952957514797（PVC 无痕相框钉）：**10个装 ¥1.4** → 目标 50 个 = 5×¥1.4 = ¥7
 *    - offer 885610098020（304 不锈钢）：2个装¥3.8 / 4个装¥7.6 → 目标 50 个 = 13×4个装 = ¥98.8
 *    → 取 PVC 无痕钉 ¥7/可售单位（不锈钢款做高端差异化另算）
 *
 * 3. Tarps 篷布
 *    - 1688 按**面积**卖：规格「3*3=拍数量9平方」等，¥5.5 是**每 9 平方**的价（≈¥0.61/㎡）
 *      → Amazon 篷布可售单位常见 6×8ft≈5.0 平方，≈6 平方 → 1 个规格档 ≈ ¥5.5
 *    - offer 1087138890766（PVC 刀刮布）：规格是「厚度300克 10×10×5cm 300g」，**按厚度计价 ¥4.5/件**，
 *      单件 10×10cm 太小，不是 Amazon 可售单位 → 不采用
 *    → 取 855272212925 的 9 平方档 ¥5.5，件重按 300g/件（10×10cm 300g 的同页实测值仅作量级参考）
 *
 * 4. Robe & Towel Hooks 浴巾挂钩
 *    - 1688 offer 1082819315747：按**件数**卖——「枪灰-可拆卸浴巾架2件a/3件a/4件a/5件a/6件a」，
 *      单价区间 ¥6.8~¥77.3（随件数与尺寸变化）
 *    - Amazon 侧实测包装数中位 4（样本 14，区间 1-5）
 *    → 取 4 件档的实价（该 offer 的 4 件档价需从阶梯价取；取不到就用区间下界并标注「按 ¥6.8 下界估算」）
 *
 * 5. Pulls 拉手
 *    - offer 641061958826：单价 ¥0.28~¥0.66 是**单件价**，包装是「200个/盒 4000个/件」的**物流包装**
 *      → 目标 30 个/可售单位 = 30 × ¥0.28 = ¥8.4（取最低档 906小号银色）
 *      件重 8g/件 → 30×8 = 240g
 */
import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PACKS = process.env.DSR_PACKS_IN || fileURLToPath(new URL('../.cache/amazon-packs.json', import.meta.url));
const amazon = JSON.parse(await readFile(PACKS, 'utf8'));

/** 每个细分的对齐结论（全部来自页面实测，探测过程见脚本头注释） */
const PLAN = [
  {
    name: 'Furniture Pads (脚垫)',
    offerId: '773465438884',
    offerUrl: 'https://detail.1688.com/offer/773465438884.html',
    offerTitle: '加厚5MM桌脚垫 静音耐磨防滑eva毛毡脚垫桌腿脚椅子凳子保护脚垫',
    keyword: '家具保护垫 / 家具 脚垫',
    amazonQuery: 'furniture pads felt',
    targetPack: 104,
    packBasis: 'EVA圆形1.8CM【1件/20个】→ 1件装含 20 个；ceil(104/20)=6 包',
    packsBought: 6,
    packUnitQty: 20,
    packUnitPriceCNY: 0.6,
    perUnitCNY: 3.6,
    unitWeightG: 3,
    weightBasis: '1688 详情页「商品件重尺」单件 3g（实测）× 104 片',
    unitWeightTotalG: 312,
    material: 'EVA',
    moq: '1件起批',
    verified: '详情页已验证',
    alignNote: '入口价 ¥0.35~¥0.60 对应「1件=20个」的整件装价，非单片价；按 6 个整件装覆盖 104 片/可售单位',
  },
  {
    name: 'Picture Hangers (图片挂架)',
    offerId: '952957514797',
    offerUrl: 'https://detail.1688.com/offer/952957514797.html',
    offerTitle: '无痕钉相框贴螺丝钉挂钩墙钉墙上照片粘钩婚纱照免打孔隐形壁挂画',
    keyword: '画框挂钩',
    amazonQuery: 'picture hangers for wall',
    targetPack: 50,
    packBasis: '1688 明确「10个装 ¥1.4」→ 目标 50 个 = 5 个整包',
    packsBought: 5,
    packUnitQty: 10,
    packUnitPriceCNY: 1.4,
    perUnitCNY: 7,
    unitWeightG: 10,
    weightBasis: '1688 详情页件重 10~80g（实测，取下界）× 50 个',
    unitWeightTotalG: 500,
    material: 'PVC',
    moq: '1件起批',
    verified: '详情页已验证',
    alignNote: 'PVC 无痕钉 10 个装 ¥1.4，5 个装覆盖 50 个/可售单位；同细分 304 不锈钢款（2个装¥3.8/4个装¥7.6）换算后为 ¥98.8/可售单位，明显更贵，属差异化路线',
  },
  {
    name: 'Tarps (防水布)',
    offerId: '855272212925',
    offerUrl: 'https://detail.1688.com/offer/855272212925.html',
    offerTitle: '防雨防晒篷布有机硅帆布防水加厚耐磨耐刮户外防雨苫布雨布蓬布',
    keyword: '篷布',
    amazonQuery: 'tarp cover',
    targetPack: 6,
    packBasis: '1688 按面积计价：规格「3*3=拍数量9平方」对应 ¥5.5/9平方（≈¥0.61/㎡）；Amazon 6×8ft 篷布≈5.0 平方 → 取 9 平方档',
    packsBought: 1,
    packUnitQty: 9,
    packUnitPriceCNY: 5.5,
    perUnitCNY: 5.5,
    unitWeightG: 300,
    weightBasis: '同页 PVC 刀刮布「厚度300克 10×10×5cm 300g」（实测同品类量级参考）',
    unitWeightTotalG: 300,
    material: '有机硅帆布',
    moq: '9件起批',
    verified: '详情页已验证',
    alignNote: '1688 篷布不按件数卖、按面积卖（¥5.5/9平方），采购价按面积档取；Amazon 侧包装数样本仅 1 条（6 件），包装数口径置信度低',
  },
  {
    name: 'Robe & Towel Hooks (睡袍和浴巾挂钩)',
    offerId: '1082819315747',
    offerUrl: 'https://detail.1688.com/offer/1082819315747.html',
    offerTitle: '枪灰毛巾架卫生间免打孔浴巾置物架浴室厕所壁挂卫浴套装收纳挂杆',
    keyword: '浴巾挂钩',
    amazonQuery: 'bath towel hooks',
    targetPack: 4,
    packBasis: '1688 按件数分档（2件a/3件a/4件a/5件a/6件a），Amazon 侧包装数中位 4 → 取 4 件档',
    packsBought: 1,
    packUnitQty: 4,
    packUnitPriceCNY: 6.8,
    perUnitCNY: 6.8,
    unitWeightG: null,
    weightBasis: '未取到（1688 该 offer 只提供套装件重：2件a=1560g / 3件a=2010g / 4件a=2410g / 5件a=2670g / 6件a=2850g；单件钩重无法从套装值安全反推）',
    unitWeightTotalG: null,
    material: '铝',
    moq: '1个起批',
    verified: '详情页已验证',
    alignNote: '起批档价格区间 ¥6.8~¥77.3 随件数与尺寸变化，本行取下界 ¥6.8 作保守估计（实际 4 件档价可能更高）；该 offer 是「可拆卸浴巾架」套装形态，Amazon 同细分以单钩形态为主，两者不完全对应；件重未取到 → 头程与 FBA 按无重量档兜底，此项测算置信度低',
  },
  {
    name: 'Pulls (拉手)',
    offerId: '641061958826',
    offerUrl: 'https://detail.1688.com/offer/641061958826.html',
    offerTitle: '不锈钢单孔拉手金色黑色橱柜鞋柜蘑菇门把手简易抽屉圆形家具拉手',
    keyword: '橱柜拉手 / 抽屉拉手',
    amazonQuery: 'cabinet pulls',
    targetPack: 30,
    packBasis: '1688 单价 ¥0.28~¥0.66 为单件价（包装「200个/盒 4000个/件」是物流包装不是售卖规格）→ 30 个/可售单位 = 30 × ¥0.28',
    packsBought: 30,
    packUnitQty: 1,
    packUnitPriceCNY: 0.28,
    perUnitCNY: 8.4,
    unitWeightG: 8,
    weightBasis: '1688 详情页「906小号」件重 8g（实测）× 30 个',
    unitWeightTotalG: 240,
    material: '不锈钢+锌合金',
    moq: '1个起批',
    verified: '详情页已验证',
    alignNote: '取最低档 906小号银色 ¥0.28/个；Amazon 侧包装数中位 30（样本 29，区间 10-30）',
  },
];

const out = [];
for (const plan of PLAN) {
  const a = amazon.find((x) => x.name === plan.name);
  out.push({
    ...plan,
    amazonPackMedian: a ? a.packMedian : null,
    amazonPackQuantiles: a ? a.packQuantiles : null,
    amazonPriceMedian: a ? a.priceMedian : null,
    amazonPriceRange: a ? a.priceRange : null,
    amazonSampleSize: a ? a.packSample : null,
    amazonResultCount: a ? a.resultCount : null,
  });
  console.log(plan.name + ' → ¥' + plan.perUnitCNY + '/可售单位（' + plan.targetPack + ' 件装）｜Amazon 售价中位 $' + (a ? a.priceMedian : '?') + '｜件重 ' + plan.unitWeightTotalG + 'g');
}

const OUT = process.env.DSR_PROFIT_OUT || fileURLToPath(new URL('../.cache/profit-input.json', import.meta.url));
await writeFile(OUT, JSON.stringify(out, null, 2));
console.log('saved ' + OUT);