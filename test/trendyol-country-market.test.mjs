import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { TRENDYOL_SITES, getTrendyolSite, requireTrendyolCaptureSite } from '../host/platforms/trendyol-sites.js';
import { listPlatforms } from '../host/platforms/index.js';
import { parsePriceSAR, parseSaudiRatingCount, parsePriceTRY } from '../host/web/trendyol-parse.js';
import { toProductCard, validatePageGuard, fetchProductDetail, searchProducts } from '../host/web/trendyol.js';
import { validateTrendyolOptions, buildTrendyolMarket, selectCategoryTrendyol, persistTrendyolMarket } from '../host/category-trendyol.js';
import { renderCategoryReport, renderDashboardHtml } from '../host/report.js';
const site = getTrendyolSite('SA');
const fetchedAt = '2026-11-13T08:00:00.000Z';
const rows = [
  { productId:'1',name:'杯架',brand:'A',price:19.15,currency:'SAR',marketplace:'SA',rating:4.4,ratingCount:702,url:site.origin+'/en/a-p-1' },
  { productId:'2',name:'杯架二',brand:'B',price:30,currency:'SAR',rating:5,ratingCount:0,url:site.origin+'/en/b-p-2' },
  { productId:'3',name:'会员卡片',brand:null,price:null,currency:'SAR',rating:null,ratingCount:null,url:site.origin+'/en/c-p-3' },
];
const build = (args={}) => buildTrendyolMarket({keyword:'cup holder',marketplace:'SA',rows,pagesFetched:1,fetchedAt,sourceUrls:[site.origin+'/en/sr?q=cup%20holder'],...args});
async function temp(t) { const dir=await mkdtemp(join(tmpdir(),'trendyol-sa-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir; }

test('official registry: 39 enabled Chinese countries, 8 excluded, ISO unique despite storefront-id collisions', async () => {
  const snap=JSON.parse(await readFile(new URL('../host/platforms/trendyol-countries.snapshot.json',import.meta.url),'utf8'));
  assert.equal(snap.countries.length,47);assert.equal(TRENDYOL_SITES.length,39);
  assert.deepEqual(new Set(TRENDYOL_SITES.map(s=>s.value)),new Set(snap.countries.filter(c=>c.enabled).map(c=>c.code)));
  for(const code of ['IE','MT','GB','RU','US','CA','JO','LB']) assert.equal(getTrendyolSite(code),null);
  assert.equal(new Set(TRENDYOL_SITES.map(s=>s.value)).size,39);
  assert.ok(TRENDYOL_SITES.every(s=>/[\u4e00-\u9fff]/.test(s.label)));
  assert.equal(getTrendyolSite('TR').storefrontId,getTrendyolSite('GE').storefrontId);
  assert.equal(listPlatforms().find(p=>p.id==='trendyol').sites.length,39);
});
test('official Saudi locale and actual storefront currencies are retained', () => {
  assert.equal(site.label,'沙特阿拉伯');assert.equal(site.currency,'SAR');assert.equal(site.origin,'https://www.trendyol.sa');
  assert.equal(site.culture,'ar-SA');assert.ok(site.otherLanguages.includes('en'));assert.equal(site.searchPath,'/en/sr');
  for(const c of ['BG','DK','SE']) assert.equal(getTrendyolSite(c).currency,'EUR');
  assert.equal(getTrendyolSite('TR').currency,'TRY');
  assert.deepEqual(TRENDYOL_SITES.filter(s=>s.captureSupported).map(s=>s.value),['TR','SA']);
});
test('unsupported official country fails before provider calls, unknown countries are invalid', async () => {
  assert.throws(()=>requireTrendyolCaptureSite('DE'),{code:'UNSUPPORTED_SITE'});
  assert.throws(()=>requireTrendyolCaptureSite('US'),{code:'INVALID_ARGS'});
  validateTrendyolOptions({keyword:'cup holder',marketplace:'SA'});
  let calls=0;
  await assert.rejects(selectCategoryTrendyol({keyword:'x',marketplace:'DE',provider:{searchProducts:()=>calls++}}),{code:'UNSUPPORTED_SITE'});
  await assert.rejects(searchProducts({keyword:'x',marketplace:'DE'}),{code:'UNSUPPORTED_SITE'});
  assert.equal(calls,0);
});
test('SAR prices do not use Turkish separators, ambiguous/cross-currency/Plus strings remain missing', () => {
  assert.equal(parsePriceSAR('19.15 SAR'),19.15);assert.equal(parsePriceSAR('SAR 1,234.56'),1234.56);assert.equal(parsePriceSAR(50.02),50.02);
  for(const s of ['',null,'19.15 SAR 63.83 SAR','2.655,20 TL','1.234,56 SAR','Plus 17.69 SAR','30 AED','SAR -1','12.345']) assert.equal(parsePriceSAR(s),null,s);
  assert.equal(parsePriceTRY('2.655,20 TL'),2655.2);
});
test('Saudi rating counts accept English grouped integers but never infer abbreviations or decimals', () => {
  assert.equal(parseSaudiRatingCount('(1,234)'),1234);assert.equal(parseSaudiRatingCount('(0)'),0);
  for(const s of ['1.234','1.2k','(1) extra','12,34','-1','']) assert.equal(parseSaudiRatingCount(s),null,s);
});
test('Saudi cards separate ratings from comments, do not read prices from product names', () => {
  const c=toProductCard({productId:'1',href:'/en/x-p-1',priceText:'19.15 SAR',countText:'(702)',ratingText:'4.4',fullText:'Model 2026 99.90'},'SA');
  assert.equal(c.price,19.15);assert.equal(c.ratingCount,702);assert.equal(c.reviewCount,undefined);assert.equal(c.currency,'SAR');assert.equal(c.priceTRY,undefined);
  const missing=toProductCard({href:'/en/x-p-1',fullText:'Cup 2026 19.99 500'},'SA');
  assert.equal(missing.price,null);assert.equal(missing.ratingCount,null);
  assert.equal(toProductCard({href:'https://www.trendyol.com/x-p-1'},'SA').url,null);
  const tr=toProductCard({href:'/x-p-2',priceText:'2.299 TL',countText:'(2.183)'},'TR');
  assert.equal(tr.priceTRY,2299);assert.equal(tr.reviewCount,2183);
});
test('detail URL rejects wrong storefront, userinfo and non-default ports before opening Chrome', async () => {
  for(const url of ['https://www.trendyol.com/en/a-p-1','https://www.trendyol.sa.evil.test/a-p-1','http://www.trendyol.sa/a-p-1','https://u@www.trendyol.sa/a-p-1','https://www.trendyol.sa:444/a-p-1']) {
    await assert.rejects(fetchProductDetail({url,marketplace:'SA'}),{code:'INVALID_ARGS'});
  }
});
test('page guard parses inline JSON, accepts en-SA, refuses country/currency/origin mismatch and unknown state', async () => {
  const code=await readFile(new URL('../host/web/snippets/trendyol-page-guard.js',import.meta.url),'utf8');
  const probe=(over={})=>JSON.parse(runInNewContext(code,{expectedCountry:'SA',expectedOrigin:site.origin,expectedCurrency:'SAR',location:{href:over.url||site.origin+'/en'},document:{title:'Trendyol',cookie:over.cookie||'',body:{innerText:'Public product search '.repeat(20)},scripts:over.unknown?[]:[{textContent:'window["__navigation__PROPS"]='+JSON.stringify({context:{storefront:{code:over.country||'SA',currency:over.currency||'SAR',language:'en',culture:'en-SA'}}})+';'}]}}));
  assert.equal(validatePageGuard(probe(),site).country,'SA');
  for(const patch of [{country:'TR'},{currency:'TRY'},{cookie:'countryCode=AE'},{url:'https://www.trendyol.com/en'}]) assert.throws(()=>validatePageGuard(probe(patch),site),{code:'COUNTRY_MISMATCH'});
  assert.throws(()=>validatePageGuard(probe({unknown:true}),site),{code:'COUNTRY_UNKNOWN'});
  assert.throws(()=>validatePageGuard(probe({unknown:true,cookie:'countryCode=SA'}),site),{code:'COUNTRY_UNKNOWN'});
  assert.throws(()=>validatePageGuard({...probe(),captcha:true},site),{code:'CAPTCHA'});
  assert.throws(()=>validatePageGuard({...probe(),rateLimited:true},site),{code:'RATE_LIMIT'});
});
test('search selector excludes sponsored store cards and chooses one dedicated Saudi sale price', async () => {
  const code=await readFile(new URL('../host/web/snippets/trendyol-search-cards.js',import.meta.url),'utf8');
  const card={className:'product-card',innerText:'Cup 19.15 SAR 63.83 SAR',getAttribute:()=>'/en/x-p-1',querySelector:sel=>sel==='.sale-price, [data-testid="sale-price"]'?{innerText:'19.15 SAR'}:null,querySelectorAll:()=>[]};
  const data=JSON.parse(runInNewContext(code,{expectedCountry:'SA',location:{search:''},document:{querySelectorAll:()=>[card,{...card,className:'product-card seller-store-product-card'}],querySelector:()=>null}}));
  assert.equal(data.count,1);assert.equal(data.items[0].priceText,'19.15 SAR');
});
test('Saudi market has independent rating metric, missingness, currency and no fabricated sources', () => {
  const m=build();assert.equal(m.currency,'SAR');assert.equal(m.marketplace,'SA');assert.equal(m.siteLabel,'沙特阿拉伯');assert.equal(m.reviewMetric,'rating_count');
  assert.equal(m.totals.reviewMass,702);assert.equal(m.sample.reviewsObserved,2);assert.equal(m.sample.pricesObserved,2);
  assert.equal(m.products[0].commentCount,null);assert.equal(m.products[2].price,null);
  assert.equal(build({rows:[{productId:'1',reviewCount:55}]}).products[0].ratingCount,null);
  assert.deepEqual(build({sourceUrls:undefined}).sourceUrls,[]);
  assert.equal(m.totals.units,null);assert.equal(m.totals.revenue,null);
});
test('mixed currencies/countries and incompatible metric are rejected rather than relabeled', () => {
  for(const args of [{currency:'TRY'},{reviewMetric:'review_count'},{rows:[{productId:'1',currency:'TRY'}]},{rows:[{productId:'1',marketplace:'TR'}]},{rows:[{productId:'1',priceTRY:100}]},{rows:[{productId:'1',reviewMetric:'review_count'}]},{details:[{currency:'AED'}]}]) assert.throws(()=>build(args),{code:'INVALID_ARGS'});
});
test('Saudi report uses Chinese country, SAR, rating semantics, same-origin links and no unsafe markup', () => {
  const market=build({rows:[...rows,{productId:'4',name:'<script>alert(1)</script>',url:'https://www.trendyol.com/a-p-4'}]});
  const md=renderCategoryReport({market});
  assert.match(md,/沙特阿拉伯/);assert.match(md,/SAR 24.58/);assert.match(md,/评价数（含仅评分，非文字评论数）/);
  assert.match(md,/www\.trendyol\.sa/);assert.doesNotMatch(md,/www\.trendyol\.com|TL24|<script>/);
  assert.match(md,/92/);assert.match(md,/未取到/);assert.match(md,/不能据占位评级决策进货/);
  const html=renderDashboardHtml({market});assert.doesNotMatch(html,/<script>alert/);assert.match(html,/<table>/);
});
test('SA end-to-end provider forwarding, artifacts, generic price summary and offline regeneration', async t => {
  const root=await temp(t), calls=[];
  const provider={searchProducts:async args=>{calls.push(args);return {rows,currency:'SAR',marketplace:'SA',pagesFetched:1,fetchedAt,sourceUrls:[site.origin+'/en/sr?q=cup%20holder']};},productDetail:async args=>{calls.push(args);return {productId:'1',url:args.url,currency:'SAR',marketplace:'SA',ratingCount:702,commentCount:83,metricSource:'Product JSON-LD'};}};
  const result=await selectCategoryTrendyol({keyword:'cup holder',marketplace:'SA',pages:1,limit:10,detailTopN:1,outputRoot:root,provider});
  assert.ok(calls.every(c=>c.marketplace==='SA'));assert.equal(result.site,'SA');assert.equal(result.market.priceMedian,24.575);assert.equal(result.market.priceMedianTRY,undefined);
  const saved=JSON.parse(await readFile(join(result.dir,'market.json'),'utf8'));
  assert.equal(saved.detailSamples[0].ratingCount,702);assert.equal(saved.detailSamples[0].commentCount,83);
  const manifest=JSON.parse(await readFile(join(result.dir,'manifest.json'),'utf8'));assert.equal(manifest.currency,'SAR');assert.equal(manifest.reviewMetric,'rating_count');
  const csv=await readFile(join(result.dir,'tables/top_products.csv'),'utf8');assert.match(csv,/price,currency,marketplace,reviewMetric/);assert.match(csv,/SAR,SA,rating_count/);assert.doesNotMatch(csv,/priceTRY/);
  const regenerated=JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('../scripts/regenerate-trendyol.mjs',import.meta.url)),join(result.dir,'market.json'),root],{encoding:'utf8'}));
  const again=JSON.parse(await readFile(join(regenerated.dir,'market.json'),'utf8'));
  assert.notEqual(regenerated.dir,result.dir);assert.equal(again.fetchedAt,fetchedAt);assert.deepEqual(again.sourceUrls,saved.sourceUrls);assert.equal(again.currency,'SAR');assert.equal(again.reviewMetric,'rating_count');
  await assert.rejects(persistTrendyolMarket({market:{...saved,currency:'TRY'},outputRoot:root}),{code:'INVALID_ARGS'});
});
