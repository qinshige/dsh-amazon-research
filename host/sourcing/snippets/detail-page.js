/**
 * 1688 详情页 · 抽取片段。
 *
 * 在 detail.1688.com/offer/<offerId>.html 页面上执行，返回详情页真实文本与结构化表格。
 * 只读页面可见文本，不做价格推断；阶梯价 / 材质 / 件重 / 供应商 等字段由 Node 侧纯函数解析。
 *
 * 返回：JSON 字符串 {
 *   url, docTitle, h1, bodyText,
 *   priceComponents: string[],   // 每个价格档位组件的 textContent（如 "¥0.7510件起批"）
 *   priceInfoParts: string[],    // 主价格区的结构化片段（['¥','0','.25']）
 *   tables: [{ rows: string[][] }],
 *   skuText: string,
 *   flags: string[]
 * }
 */
(() => {
  const norm = (s) => String(s || '').replace(/[\u00a0\u3000]/g, ' ').replace(/\s+/g, ' ').trim();
  const body = document.body;

  const h1El = document.querySelector('h1');
  const h1 = norm(h1El ? (h1El.textContent || '') : '');

  // 商品标题候选（h1 常常是公司名，标题在 title-text / offer-title 之类的容器里）
  const titleCandidates = [...document.querySelectorAll(
    'h1,[class*="title-text"],[class*="detail-title"],[class*="od-pc-offer-title"],[class*="mainTitle"],[class*="offer-title"],[class*="titleText"]',
  )]
    .map((el) => norm(el.textContent))
    .filter((t) => t && t.length >= 8 && t.length <= 300);

  // 价格档位组件：class 名稳定部分为 price-component（后缀是构建期哈希）
  const priceComponents = [...document.querySelectorAll('[class*="price-component"]')]
    .map((el) => norm(el.textContent))
    .filter((t) => t && /[0-9]/.test(t) && t.length < 300);

  // 主价格区的结构化片段（¥ / 整数 / 小数分开渲染，直接拼即可避免小数位被qty吃掉）
  const infoEl = document.querySelector('[class*="price-info"]');
  const priceInfoParts = infoEl
    ? [...infoEl.querySelectorAll('[class*="price-symbol"],[class*="price-integer"],[class*="price-fraction"]')]
        .map((el) => norm(el.textContent))
        .filter(Boolean)
    : [];

  // 表格：商品属性 / 包装信息（商品件重尺）/ 商家代发
  const tables = [...document.querySelectorAll('table')]
    .map((t) => ({
      rows: [...t.querySelectorAll('tr')]
        .slice(0, 140)
        .map((tr) => [...tr.querySelectorAll('td,th')].map((c) => norm(c.innerText || c.textContent).slice(0, 300))),
    }))
    .filter((t) => t.rows.length)
    .slice(0, 8);

  // SKU 区（颜色/尺寸等）
  const skuRoot = document.querySelector('[class*="sku-selection"],[class*="module-od-sku"],[class*="skuSelection"]');
  const skuText = norm(skuRoot ? (skuRoot.innerText || '') : '').slice(0, 4000);

  // 页面标签（代发 / 跨境 / 定制 …）
  const flags = [...document.querySelectorAll('[class*="tag"],[class*="label"],[class*="icon-text"]')]
    .map((el) => norm(el.textContent))
    .filter((t) => t && t.length <= 14 && /代发|定制|打样|验厂|包邮|跨境|源头|实力|首单|保障|退换|先用后付|铺货|密文|工厂/.test(t));
  const uniqFlags = [];
  for (const f of flags) if (uniqFlags.indexOf(f) === -1) uniqFlags.push(f);

  return JSON.stringify({
    url: location.href,
    docTitle: document.title,
    h1: h1,
    titleCandidates: titleCandidates,
    bodyText: (body ? body.innerText : '').slice(0, 26000),
    priceComponents: priceComponents,
    priceInfoParts: priceInfoParts,
    tables: tables,
    skuText: skuText,
    flags: uniqFlags.slice(0, 30),
  });
})()
