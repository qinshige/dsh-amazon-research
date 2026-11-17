/**
 * dsh-amazon-research · host/selection/detail-enrich.js
 *
 * 给候选池逐个补齐 Amazon 详情页字段：包装尺寸重量、商品尺寸重量、件数、品牌、上架日期、
 * 卖家、变体数、类目路径、FBA 费（页面有就取）。
 *
 * 这些字段是「包装对齐」与「头程/体积重」的输入，缺了就只能给区间估算。
 */
import { openTab, runJson, runJs, waitFor, closeTab, focusTab } from '../web/chrome.js';

/** 页面内：抽取详情页规格 + 面包屑 + 卖家信息。 */
export const READ_DETAIL = [
  '(function(){',
  '  var NL=String.fromCharCode(10);',
  '  function clean(s){ return String(s==null?"":s).split(NL).map(function(l){return l.trim();}).filter(Boolean).join(" "); }',
  '  var specs={};',
  '  var els=document.querySelectorAll("#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, .prodDetTable tr, #detailBullets_feature_div li");',
  '  for(var i=0;i<els.length;i++){',
  '    var el=els[i]; var k=el.querySelector("th"), v=el.querySelector("td");',
  '    if(k&&v){ specs[clean(k.innerText)]=clean(v.innerText); }',
  '    else { var t=clean(el.innerText); var p=t.indexOf(":"); if(p>0) specs[t.slice(0,p).trim()]=t.slice(p+1).trim(); }',
  '  }',
  '  var title=document.querySelector("#productTitle");',
  '  var crumbs=[];',
  '  var cs=document.querySelectorAll("#wayfinding-breadcrumbs_feature_div a");',
  '  for(var i=0;i<cs.length;i++) crumbs.push(clean(cs[i].innerText));',
  '  var bullets=[];',
  '  var bl=document.querySelectorAll("#feature-bullets li");',
  '  for(var i=0;i<bl.length;i++){ var s=clean(bl[i].innerText); if(s.length>3) bullets.push(s); }',
  '  var price=document.querySelector(".a-price .a-offscreen");',
  '  var seller=document.querySelector("#sellerProfileTriggerId")||document.querySelector("#merchant-info");',
  '  var variation=document.querySelectorAll("#twister [id^=\'quantity\'], #twister select option");',
  '  var qopts=[];',
  '  for(var i=0;i<variation.length && i<40;i++){ var o=variation[i]; var t=clean(o.innerText)||o.value||""; if(t) qopts.push(t); }',
  '  return JSON.stringify({',
  '    title: title?clean(title.innerText):"",',
  '    specs: specs, crumbs: crumbs, bullets: bullets.slice(0,12),',
  '    price: price?clean(price.innerText):null,',
  '    seller: seller?clean(seller.innerText):null,',
  '    qopts: qopts',
  '  });',
  '})()'
].join('\n');

/** 从规格文本里取尺寸（厘米）与重量（克）。 */
export function parseSizeWeight(specText) {
  const text = String(specText || '');
  const inch = text.match(/([0-9.]+)\s*x\s*([0-9.]+)\s*x\s*([0-9.]+)\s*inches/i);
  const cm = text.match(/([0-9.]+)\s*x\s*([0-9.]+)\s*x\s*([0-9.]+)\s*cm/i);
  let dims = null;
  if (inch) dims = { l: Math.round(Number(inch[1]) * 2.54), w: Math.round(Number(inch[2]) * 2.54), h: Math.round(Number(inch[3]) * 2.54) };
  else if (cm) dims = { l: Math.round(Number(cm[1])), w: Math.round(Number(cm[2])), h: Math.round(Number(cm[3])) };
  const oz = text.match(/([0-9.]+)\s*ounces/i);
  const lb = text.match(/([0-9.]+)\s*(?:pounds|lbs)/i);
  const gram = text.match(/([0-9.]+)\s*(?:grams|克)/i);
  const kg = text.match(/([0-9.]+)\s*(?:kg|千克)/i);
  let weightG = null;
  if (oz) weightG = Math.round(Number(oz[1]) * 28.3495);
  else if (lb) weightG = Math.round(Number(lb[1]) * 453.592);
  else if (gram) weightG = Math.round(Number(gram[1]));
  else if (kg) weightG = Math.round(Number(kg[1]) * 1000);
  return { dims, weightG };
}

/**
 * 逐个 ASIN 抓详情页。
 * @param {{asins:string[], marketplace?:string, onProgress?:Function, maxDetail?:number}} input
 */
export async function enrichDetails({ asins = [], marketplace = 'US', onProgress = null, maxDetail = 120 } = {}) {
  const domain = marketplace.toUpperCase() === 'US' ? 'amazon.com' : 'amazon.com';
  const out = [];
  const list = asins.slice(0, maxDetail);
  // **复用同一个标签页**循环导航：每采一个 ASIN 就开新标签会把 Chrome 堆成上百个标签页
  // （实测：抓 90 个详情页后 Chrome 有 189 个标签页）。
  let tabId = null;
  try {
  for (let i = 0; i < list.length; i += 1) {
    const asin = list[i];
    try {
      const url = 'https://www.' + domain + '/dp/' + asin;
      if (tabId === null) {
        tabId = await openTab(url);
      } else {
        await runJs(tabId, 'location.href = ' + JSON.stringify(url) + '; "OK"', { timeout: 30_000 }).catch(() => {});
      }
      await focusTab(tabId).catch(() => {});
      // 必须等 **URL 里的 ASIN 匹配**再读：复用标签页时，旧页面也是 /dp/ 路径，
      // 只判断 pathname 会立刻通过 → 读到上一个 ASIN 的数据（实测串台：
      // BrenixCraft 读出了 Seibertron 的品牌）。
      const ready = await waitFor(tabId, 'location.href.indexOf("' + asin + '") >= 0 && document.querySelectorAll("#productDetails_techSpec_section_1 tr, .prodDetTable tr, #detailBullets_feature_div li").length > 3', { timeout: 30 });
      if (!ready) { out.push({ asin, ok: false, reason: '详情页未就绪' }); continue; }
      const raw = await runJson(tabId, READ_DETAIL, { timeout: 35000, strict: false });
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const specs = data.specs || {};
      const packRaw = specs['Package Dimensions'] || specs['Package Dimensions ‏'] || specs['商品包装尺寸'] || '';
      const itemRaw = specs['Item Dimensions'] || specs['Item Dimensions ‏'] || specs['商品尺寸'] || '';
      const itemWeightRaw = specs['Item Weight'] || specs['Item Weight ‏'] || specs['商品重量'] || '';
      const pack = parseSizeWeight(packRaw);
      const item = parseSizeWeight(itemRaw);
      // 页面常常只给 Item Dimensions（没有 Package Dimensions）→ 用商品尺寸兜底，
      // 但要标明来源（体积重会偏小，报告里标注）。
      const packDims = pack.dims || item.dims;
      let packWeightG = pack.weightG || item.weightG || parseSizeWeight(itemWeightRaw).weightG;
      // 页面没给重量时，用**体积重**估算（亚马逊计费重 = max(实重, 体积重)）：
      // 体积重(kg) = 长×宽×高(cm) ÷ 6000 → 克 = 长×宽×高 ÷ 6。
      let weightBasis = packWeightG ? '页面重量' : null;
      if (!packWeightG && packDims) {
        const volumetricG = Math.round((packDims.l * packDims.w * packDims.h) / 6);
        if (volumetricG > 0) {
          packWeightG = volumetricG;
          weightBasis = '体积重估算（页面未给重量）';
        }
      }
      out.push({
        asin,
        ok: true,
        title: data.title || '',
        brand: specs['Brand Name'] || specs['品牌'] || '',
        priceText: data.price,
        seller: data.seller,
        bullets: data.bullets || [],
        qopts: data.qopts || [],
        categoryPath: (data.crumbs || []).join(' > '),
        packDims,
        packWeightG,
        packDimsSource: pack.dims ? 'Package Dimensions' : (item.dims ? 'Item Dimensions（页面未给包装尺寸）' : null),
        packWeightSource: pack.weightG ? 'Package Dimensions' : (item.weightG ? 'Item Dimensions/Item Weight' : weightBasis),
        itemDims: item.dims,
        itemWeightG: item.weightG,
        itemWeightRaw,
        listedDate: specs['Date First Available'] || specs['Date First Available ‏'] || specs['商品首次上架时间'] || '',
        bsrText: specs['Best Sellers Rank'] || specs['Best Sellers Rank ‏'] || '',
        material: specs['Material'] || specs['材质'] || '',
      });
    } catch (error) {
      out.push({ asin, ok: false, reason: String(error?.message ?? error).slice(0, 80) });
    }
    if (onProgress) onProgress({ done: i + 1, total: list.length, asin });
  }
  return out;
  } finally {
    if (tabId) await closeTab(tabId).catch(() => {});
  }
}
