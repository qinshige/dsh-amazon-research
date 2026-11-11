/**
 * 重抓已验证 offer 的 SKU 价格矩阵，用于把「1688 单件价」对齐到「Amazon 可售单位」。
 * 只进详情页（不进搜索页），避开搜索频控。
 */
import { fetchOfferDetail } from '../host/sourcing/1688.js';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const OUT = process.env.DSR_SKUS_OUT || fileURLToPath(new URL('../.cache/offer-skus.json', import.meta.url));

const OFFERS = [
  { sub: 'Furniture Pads 家具脚垫', id: '773465438884' },
  { sub: 'Furniture Pads 家具脚垫', id: '1056661525058' },
  { sub: 'Furniture Pads 家具脚垫', id: '971157205648' },
  { sub: 'Picture Hangers 画框挂架', id: '885610098020' },
  { sub: 'Picture Hangers 画框挂架', id: '952957514797' },
  { sub: 'Tarps 防水布', id: '855272212925' },
  { sub: 'Tarps 防水布', id: '1087138890766' },
];

const log = (m) => console.log('[log] ' + m);
const results = [];
for (const offer of OFFERS) {
  try {
    const d = await fetchOfferDetail({ url: 'https://detail.1688.com/offer/' + offer.id + '.html', log });
    results.push({
      sub: offer.sub,
      id: offer.id,
      packSpec: d.packSpec,
      packSpecQty: d.packSpecQty,
      entryPriceCNY: d.entryPriceCNY,
      entryPriceMaxCNY: d.entryPriceMaxCNY,
      priceRangeCNY: d.priceRangeCNY,
      moqText: d.moqText,
      weightG: d.weightG,
      weightText: d.weightText,
      packTiersText: d.packTiersText,
      skuList: (d.skuList || []).slice(0, 40),
      material: d.material,
    });
    console.log('OK ' + offer.id + ' packSpec=' + d.packSpec + ' entry=' + d.entryPriceCNY + '~' + d.entryPriceMaxCNY);
    for (const sku of (d.skuList || []).slice(0, 12)) {
      console.log('    SKU ' + sku.sku + ' => ¥' + sku.priceCNY);
    }
  } catch (error) {
    console.log('ERR ' + offer.id + ' ' + String(error?.message ?? error));
  }
  await new Promise((r) => setTimeout(r, 12000));
}

await writeFile(OUT, JSON.stringify(results, null, 2));
console.log('saved ' + OUT);