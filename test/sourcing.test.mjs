/**
 * 1688 采价模块的离线单元测试。
 *
 * 只测纯函数（价格解析 / 阶梯价提取 / CSV 列映射），不联网、不碰 Chrome。
 * 运行：node --test test/*.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CSV_COLUMNS,
  NOT_DETAIL,
  NOT_FOUND,
  buildCsv,
  csvCell,
  formatPriceTiers,
  guessLocation,
  isBadgeLine,
  parseAttrPairs,
  parseCardText,
  parseDropshipTable,
  parseLocation,
  parseMoq,
  parsePackSpec,
  summarizeSizeTiers,
  singlePiecePriceCNY,
  parsePackTable,
  parsePriceCNY,
  parsePriceTiers,
  parseQty,
  parseSkuList,
  parseSkuVariants,
  parseTierLine,
  pickEntrySku,
  summarizePackTiers,
  parseWeightG,
  scanPrices,
  toCsvRow,
} from '../host/sourcing/1688.js';

/* ----------------------------- 价格解析 ----------------------------- */

test('parsePriceCNY：认 ¥/￥/元/裸数字，其余返回 null', () => {
  assert.equal(parsePriceCNY('¥0.25'), 0.25);
  assert.equal(parsePriceCNY('￥ 13.50'), 13.5);
  assert.equal(parsePriceCNY('¥1,234.50'), 1234.5);
  assert.equal(parsePriceCNY('3.8元'), 3.8);
  assert.equal(parsePriceCNY('7.25'), 7.25);
  assert.equal(parsePriceCNY('首单减1元'), 1);
  assert.equal(parsePriceCNY('没有价格'), null);
  assert.equal(parsePriceCNY(''), null);
  assert.equal(parsePriceCNY(null), null);
});

test('scanPrices：价格与粘在后面的数量要分开', () => {
  // '¥0.7510件起批' = ¥0.75 / 10件起批，不是 ¥0.7510
  const s1 = scanPrices('¥0.7510件起批');
  assert.equal(s1.length, 1);
  assert.equal(s1[0].price, 0.75);
  assert.equal(s1[0].qtyDigits, '10');

  // '¥2.881个起批' = ¥2.88 / 1个起批
  const s2 = scanPrices('¥2.881个起批');
  assert.equal(s2[0].price, 2.88);
  assert.equal(s2[0].qtyDigits, '1');

  // 区间价：两段价格
  const s3 = scanPrices('¥0.25 ~ ¥13.50');
  assert.deepEqual(s3.map((x) => x.price), [0.25, 13.5]);

  // 3 位小数且后面跟区间分隔符 → 整段是价格
  assert.equal(scanPrices('¥25.001~49件')[0].price, 25.001);
});

test('parseTierLine：阶梯价文本 → qty + 价格', () => {
  const t1 = parseTierLine('¥0.7510件起批');
  assert.equal(t1.qty, 10);
  assert.equal(t1.priceCNY, 0.75);
  assert.equal(t1.qtyText, '10件起批');

  const t2 = parseTierLine('¥0.70100-24999件');
  assert.equal(t2.qty, 100);
  assert.equal(t2.qtyMax, 24999);
  assert.equal(t2.priceCNY, 0.7);

  const t3 = parseTierLine('¥0.60≥25000件');
  assert.equal(t3.qty, 25000);
  assert.equal(t3.priceCNY, 0.6);

  const t4 = parseTierLine('2件起批 ¥4.80');
  assert.equal(t4.qty, 2);
  assert.equal(t4.priceCNY, 4.8);

  // 同一档内的 SKU 价格区间
  const t5 = parseTierLine('¥0.05 ~ ¥2.881个起批60天老客价');
  assert.equal(t5.qty, 1);
  assert.equal(t5.priceCNY, 0.05);
  assert.equal(t5.priceMaxCNY, 2.88);

  assert.equal(parseTierLine('没有价格'), null);
});

test('parsePriceTiers：详情页价格组件 → 阶梯价数组（新人价单独归类）', () => {
  const components = [
    '新人价¥0.6510件预估到手单价',
    '¥0.7510件起批',
    '¥0.70100-24999件',
    '¥0.60≥25000件',
  ];
  const tiers = parsePriceTiers(components);
  assert.equal(tiers.length, 3);
  assert.deepEqual(tiers.map((t) => t.qty), [10, 100, 25000]);
  assert.deepEqual(tiers.map((t) => t.priceCNY), [0.75, 0.7, 0.6]);
  assert.deepEqual(tiers.promos, ['新人价 ¥0.65']);
});

test('formatPriceTiers：阶梯价 → 报告文本', () => {
  const tiers = parsePriceTiers(['¥0.7510件起批', '¥0.70100-24999件', '¥0.60≥25000件']);
  assert.equal(formatPriceTiers(tiers), '10件起批 ¥0.75；100-24999件 ¥0.7；≥25000件 ¥0.6');
  assert.equal(formatPriceTiers([], ['新人价 ¥0.65']), '新人价 ¥0.65');
  assert.equal(formatPriceTiers([]), NOT_FOUND);
});

test('parseQty / parseMoq：起批量与数量片段', () => {
  assert.deepEqual(parseQty('10件起批'), { qty: 10, qtyMax: null, qtyText: '10件起批' });
  assert.equal(parseQty('≥25000件').qty, 25000);
  assert.equal(parseQty('100-24999件').qtyMax, 24999);
  assert.equal(parseQty('没有数量'), null);

  assert.deepEqual(parseMoq('起批量 2件起批'), { moq: 2, moqText: '2件起批' });
  assert.equal(parseMoq('没有起批'), null);
});

test('parseWeightG：单位换算（g 原样 / kg 换算 / 无单位按 kg）', () => {
  assert.equal(parseWeightG('13', 'g'), 13);
  assert.equal(parseWeightG('0.13', 'kg'), 130);
  assert.equal(parseWeightG('13 g'), 13);
  assert.equal(parseWeightG('0.5 kg'), 500);
  assert.equal(parseWeightG('0.13'), 130);
  assert.equal(parseWeightG('未取到'), null);
  assert.equal(parseWeightG(null), null);
});

/* ----------------------------- 卡片 / 详情页文本 ----------------------------- */

test('parseCardText：搜索页卡片文本 → 标题/价格/供应商/销量', () => {
  const cardText = [
    '家具地脚钉桌椅子脚钉防滑塑料尼龙加厚地脚钉防滑防潮脚垫脚钉',
    '首单减1元',
    '｜',
    '商机组货：隐形五金配件大全',
    '¥',
    '0',
    '.01',
    '运费3.8元',
    '全网10万+件',
    '退货包运费',
    '先采后付',
    '回头率 50%',
    '广州市瀛雅家具五金有限公司',
  ].join('\n');
  const parsed = parseCardText(cardText);
  assert.equal(parsed.title, '家具地脚钉桌椅子脚钉防滑塑料尼龙加厚地脚钉防滑防潮脚垫脚钉');
  assert.equal(parsed.priceCNY, 0.01);
  assert.equal(parsed.supplier, '广州市瀛雅家具五金有限公司');
  assert.equal(parsed.location, '广东 广州');
  assert.equal(parsed.monthlySales, '全网10万+件');
  assert.ok(parsed.badges.indexOf('退货包运费') >= 0);
  // 价格碎片不算标签
  assert.equal(parsed.badges.indexOf('.01'), -1);
});

test('isBadgeLine：标签行 vs 标题行', () => {
  assert.equal(isBadgeLine('首单减1元'), true);
  assert.equal(isBadgeLine('｜'), true);
  assert.equal(isBadgeLine('0.01'), true);
  assert.equal(isBadgeLine('加厚桌椅脚套耐磨降噪家具桌子凳子腿保护套'), false);
});

test('parseAttrPairs：商品属性表 → 键值对', () => {
  const rows = [
    ['产品类别', '桌椅脚套/桌脚垫', '材质', 'TPR'],
    ['功能', '耐磨', '品牌', '其他'],
  ];
  const attrs = parseAttrPairs(rows);
  assert.equal(attrs.length, 4);
  assert.deepEqual(attrs[0], { key: '产品类别', value: '桌椅脚套/桌脚垫' });
  assert.equal(attrs.find((a) => a.key === '材质').value, 'TPR');
});

test('parsePackTable：包装信息表 → 件重(g) 与尺寸(cm)', () => {
  const rows = [
    ['颜色', '尺寸', '长(cm)', '宽(cm)', '高(cm)', '体积(cm³)', '重量(g)'],
    ['透明款特小号圆形', '4个装', '5', '5', '2.50', '62.500', '20'],
    ['透明款特小号圆形', '8个装', '5', '5', '5', '125', '40'],
    ['透明款特小号圆形', '1个装', '2.50', '2.50', '2.50', '15.625', '5'],
  ];
  const pack = parsePackTable(rows);
  assert.equal(pack.ok, true);
  assert.deepEqual(pack.weights, [20, 40, 5]);
  assert.equal(pack.dims.length, 3);
  assert.equal(pack.dims[0].text, '5×5×2.50 cm');
  // 没有包装表 → ok=false，不许编
  assert.equal(parsePackTable([['材质', 'TPR']]).ok, false);
});

test('parseDropshipTable：商家代发表 → 是否支持一件代发', () => {
  const rows = [
    ['商家代发热度', '1641', '近30天代发数量', '100以内'],
    ['48h揽收率', '100.00%', '下游铺货数', '100以内'],
    ['铺货分销商数', '40000+', '代发品质达标率', '100.00%'],
  ];
  const dropship = parseDropshipTable(rows);
  assert.equal(dropship.supported, true);
  assert.match(dropship.summary, /代发热度1641/);
  assert.match(dropship.summary, /代发品质达标率100.00%/);
  assert.equal(parseDropshipTable([['材质', 'TPR']]).supported, false);
});

test('parseSkuVariants / parseSkuList：SKU 变体与 SKU 价格', () => {
  const attrs = parseAttrPairs([
    ['颜色', '透明色', '是否跨境出口专供货源', '是'],
    ['规格', '18半明垫【配16mm螺丝】,22半明垫【配16mm螺丝】', '货号', 'HXL-ZJD'],
  ]);
  const variants = parseSkuVariants(attrs);
  assert.equal(variants.length, 2);
  const spec = variants.find((v) => v.property === '规格');
  assert.equal(spec.values.length, 2);
  assert.equal(spec.values[0], '18半明垫【配16mm螺丝】');
  // 非 SKU 属性不进变体
  assert.equal(variants.find((v) => v.property === '货号'), undefined);

  const list = parseSkuList(
    '规格按套起批，每套4个 18半明垫【配16mm螺丝】 ¥0.05 库存1604215个 22半明垫【配16mm螺丝】 ¥0.06 库存1122304个',
  );
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { sku: '18半明垫【配16mm螺丝】', priceCNY: 0.05 });
  assert.deepEqual(list[1], { sku: '22半明垫【配16mm螺丝】', priceCNY: 0.06 });
  assert.equal(parseSkuList('没有价格').length, 0);
});

test('guessLocation / parseLocation：所在地', () => {
  assert.equal(guessLocation('广州市瀛雅家具五金有限公司'), '广东 广州');
  assert.equal(guessLocation('义乌市纳拾旮日用品有限公司'), '浙江 义乌');
  assert.equal(guessLocation('不知名公司'), null);
  assert.equal(parseLocation('浙江金华'), '浙江金华');
  assert.equal(parseLocation('没有地址'), null);
});

test('parsePackSpec / pickEntrySku / summarizePackTiers：包装规格与多件装档', () => {
  assert.deepEqual(parsePackSpec('4个装'), { spec: '4个装', qty: 4 });
  assert.deepEqual(parsePackSpec('【2个装】可重复使用'), { spec: '2个装', qty: 2 });
  assert.deepEqual(parsePackSpec('相框钉10个一包'), { spec: '10个装', qty: 10 });
  assert.deepEqual(parsePackSpec('规格按套起批，每套4个'), { spec: '4个/套', qty: 4 });
  // 单件与「尺寸不是件数」
  assert.deepEqual(parsePackSpec('24大号脚钉【1个】'), { spec: '单件', qty: 1 });
  assert.deepEqual(parsePackSpec('6*6常规相框钉'), { spec: '单件', qty: 1 });
  assert.deepEqual(parsePackSpec('6*6透明螺丝钉【螺杆长6mm】'), { spec: '单件', qty: 1 });
  assert.deepEqual(parsePackSpec(''), { spec: '单件', qty: 1 });

  const skuList = [
    { sku: '【1个装】可重复使用-掉落包退', priceCNY: 1.9 },
    { sku: '【2个装】可重复使用-掉落包退', priceCNY: 3.8 },
    { sku: '【4个装】可重复使用-掉落包退', priceCNY: 7.6 },
  ];
  assert.equal(pickEntrySku(skuList, 1.9).sku, '【1个装】可重复使用-掉落包退');
  assert.equal(pickEntrySku(skuList, 99).priceCNY, 1.9);
  assert.equal(pickEntrySku([], 1), null);
  assert.equal(summarizePackTiers(skuList), '2个装¥3.8 / 4个装¥7.6');
  assert.equal(summarizePackTiers([]), '');
  assert.equal(singlePiecePriceCNY(skuList), 1.9);
  assert.equal(singlePiecePriceCNY([]), null);
  // 按面积/尺寸计价的规格档（篷布这类）
  assert.equal(
    summarizeSizeTiers([{ sku: '3*3=拍数量9平方', priceCNY: 5.5 }, { sku: '4*5=拍数量20平方', priceCNY: 5.5 }]),
    '3*3=拍数量9平方¥5.5 / 4*5=拍数量20平方¥5.5',
  );
});

/* ----------------------------- CSV 列映射 ----------------------------- */

test('CSV_COLUMNS：与既有货源表列名对齐', () => {
  assert.deepEqual(CSV_COLUMNS, [
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
  ]);
});

test('toCsvRow：详情页已验证的一行', () => {
  const row = toCsvRow({
    category: 'Furniture Pads 家具脚垫',
    keyword: '家具 脚垫',
    offerId: '971157205648',
    url: 'https://detail.1688.com/offer/971157205648.html',
    notes: ['测试备注'],
    detail: {
      title: '家具桌椅脚垫硅胶增高垫',
      entryPriceCNY: 0.05,
      priceTiersText: '1个起批 ¥0.05~¥2.88',
      packSpec: '单件',
      packTiersText: '4个装¥1 / 8个装¥2.2',
      moqText: '1个起批',
      material: '硅胶',
      weightText: '4~80',
      supplier: '广州市悍泰五金有限公司',
      onePieceDropshipText: '是（代发热度1641）',
    },
  });
  assert.equal(row.length, CSV_COLUMNS.length);
  assert.equal(row[0], 'Furniture Pads 家具脚垫');
  assert.equal(row[1], '家具 脚垫');
  assert.equal(row[2], '971157205648');
  assert.equal(row[5], '1个起批');
  assert.equal(row[6], '0.05');
  assert.equal(row[7], '4个装¥1 / 8个装¥2.2');
  assert.equal(row[8], '1个起批 ¥0.05~¥2.88');
  assert.equal(row[9], '单件');
  assert.equal(row[10], '硅胶');
  assert.equal(row[11], '4~80');
  assert.equal(row[12], '广州市悍泰五金有限公司');
  assert.equal(row[13], '是（代发热度1641）');
  assert.equal(row[14], '详情页已验证');
  assert.equal(row[15], '测试备注');
});

test('toCsvRow：只有搜索页卡片级时，未验证字段一律标「未取到（未进详情页）」', () => {
  const row = toCsvRow({
    category: 'Tarps 防水布',
    keyword: '防水布',
    offerId: '123456',
    title: '防水布',
    url: 'https://detail.1688.com/offer/123456.html',
    priceCNY: 3.5,
    moqText: '2件起批',
    supplier: '某某厂',
  });
  // 卡片级：单价列留空（卡片价只是入口 SKU 最低价，不是拿货价）
  assert.equal(row[6], NOT_FOUND);
  assert.equal(row[7], '');
  assert.equal(row[8], NOT_DETAIL);
  assert.equal(row[9], NOT_DETAIL);
  assert.equal(row[10], NOT_DETAIL);
  assert.equal(row[11], NOT_DETAIL);
  assert.equal(row[13], NOT_DETAIL);
  assert.equal(row[14], '搜索页卡片级');
});

test('csvCell / buildCsv：逗号与引号要转义，表头固定', () => {
  assert.equal(csvCell('普通'), '普通');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('说"话"'), '"说""话"""');
  assert.equal(csvCell(null), '');

  const csv = buildCsv([
    {
      category: 'Pulls 拉手',
      keyword: '橱柜 拉手',
      offerId: '999',
      title: '拉手, 不锈钢',
      url: 'https://detail.1688.com/offer/999.html',
      detail: {
        title: '拉手, 不锈钢',
        entryPriceCNY: 1.2,
        priceTiersText: '2件起批 ¥1.2',
        moqText: '2件起批',
        material: '不锈钢',
        weightText: '30',
        supplier: '某某厂',
        onePieceDropshipText: '否',
      },
    },
  ]);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], CSV_COLUMNS.join(','));
  assert.equal(lines.length, 2);
  assert.match(lines[1], /"拉手, 不锈钢"/);
});
