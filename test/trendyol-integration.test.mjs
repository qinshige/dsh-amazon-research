import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createServer } from 'node:http';
import { validateTrendyolOptions, buildTrendyolMarket, selectCategoryTrendyol, persistTrendyolMarket } from '../host/category-trendyol.js';
import { scoreMarket } from '../host/scoring.js';
import { renderCategoryReport, renderDashboardHtml } from '../host/report.js';
import { parsePriceTRY, parseReviewCount, parseRating } from '../host/web/trendyol-parse.js';
import { waitFor } from '../host/web/chrome.js';
import { createTools } from '../host/tools.js';
import { readConfig, writeConfig } from '../host/paths.js';
import { listRuns, createRun, writeArtifacts } from '../host/runs.js';
import { registerRoutes } from '../host/routes.js';
import { getPlatform } from '../host/platforms/index.js';

const fetchedAt = '2026-11-13T00:00:00.000Z';
const rows = Array.from({ length: 15 }, (_, i) => ({ productId: String(i+1), name: '锅 '+i, brand: 'A', priceTRY: 100+i, rating: 4.5, reviewCount: i, url: 'https://www.trendyol.com/a-p-'+(i+1) }));
async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'trendyol-regression-')); t.after(() => rm(dir,{ recursive:true,force:true })); return dir; }

test('strict Trendyol arguments reject invalid values before browser', async (t) => {
  for (const bad of [{keyword:''},{pages:0},{pages:1.2},{pages:'2'},{detailTopN:6},{detailTopN:-1},{limit:9},{limit:101},{marketplace:'US'}]) {
    assert.throws(() => validateTrendyolOptions({keyword:'tencere', ...bad}), {code:'INVALID_ARGS'});
  }
  const dataDir = await temp(t);
  const tool = createTools({dataDir, providers:{}, secrets:{}}).find((x)=>x.name==='research_category_select');
  for (const args of [
    {platform:'trendyol',marketplace:'US'}, {platform:'amazon',marketplace:'TR'},
    {platform:'trendyol',provider:'sellersprite'}, {platform:'amazon',provider:'trendyol-web'},
    {platform:'trendyol',category:'pot',unitCost:1}, {platform:'trendyol',nodeIdPath:'1'},
    {platform:'trendyol',category:'pot',pages:1.5}, {platform:'trendyol',category:'pot',detailTopN:6},
    {platform:'__proto__'}, {platform:'constructor'}
  ]) assert.equal((await tool.execute(args)).ok,false);
  assert.equal(getPlatform('__proto__'),null);
});

test('mean/median, dedupe, missing fields, half-open buckets and known-brand coverage', () => {
  const market = buildTrendyolMarket({keyword:'pot',fetchedAt,rows:[
    {productId:'1',price:100,reviews:99,brand:'A'}, {productId:'1',price:100,reviews:99,brand:'A'},
    {productId:'2',price:200,reviews:100,brand:'B'}, {productId:'3',price:900,reviews:null,brand:'C'},
    {productId:'4',price:null,reviews:1,brand:null}
  ]});
  assert.equal(market.products.length,4);
  assert.equal(market.avgs.price,400); assert.equal(market.medians.price,200);
  assert.equal(market.totals.units,null); assert.equal(market.totals.revenue,null);
  assert.equal(market.totals.reviewMass,200);
  assert.equal(market.concentration.knownBrandReviewCoverage,199/200);
  const score = scoreMarket(market);
  assert.equal(score.dimensions[1].inputs.lowReviewShare,2/3);
  assert.equal(score.dimensions[4].score,0); assert.equal(score.dimensions[4].inputs.missing,true);
  assert.equal(score.dimensions[3].inputs.selfOperatedShare,null);
  const buckets = market.distributions.ratingsCount;
  assert.equal(buckets.reduce((n,b)=>n+b.products,0),3);
  assert.equal(buckets[2].products,1); assert.equal(buckets[3].products,1);
  assert.equal(buckets.reduce((n,b)=>n+b.productShare,0),1);
  const md = renderCategoryReport({market,score});
  assert.match(md,/非销量/); assert.match(md,/不构成进入建议/); assert.match(md,/未取到/);
  assert.doesNotMatch(md,/FBA|\$[\d,]+|Karaca（/);
});

test('prices and model numbers cannot silently substitute metrics', () => {
  for(const v of ['2.299 TL 2.655,20 TL','ABC 3.5L','1.23.45','foo']) assert.equal(parsePriceTRY(v),null);
  for(const v of ['ABC 4.5 Model','6','4,5 yıldız']) assert.equal(parseRating(v),null);
  for(const v of ['商品 2000','(20) extra','1,25','-1']) assert.equal(parseReviewCount(v),null);
  assert.equal(parsePriceTRY('2.655,20 TL'),2655.2);
  assert.equal(parseReviewCount('(1.234)'),1234);
});

test('offline provider flow enforces unique cap, details cap and real page accounting', async (t) => {
  const outputRoot = await temp(t), calls=[];
  const provider={searchProducts:async (args)=>{calls.push(args);return {rows:[rows[0],...rows],pagesFetched:2,fetchedAt,sourceUrls:['https://www.trendyol.com/sr?q=pot']};},
    productDetail:async ({url})=>({productId:url.split('-').at(-1),url,categoryPath:'Ev > Tencere'})};
  const result=await selectCategoryTrendyol({keyword:'pot',pages:2,limit:10,detailTopN:3,outputRoot,provider,delay:async()=>{}});
  assert.equal(result.market.products,10);assert.equal(result.market.details,3);
  assert.equal(result.usage.calls,5);assert.equal(calls[0].limit,10);
  const manifest=JSON.parse(await readFile(join(result.dir,'manifest.json'),'utf8'));
  assert.equal(manifest.platform,'trendyol');assert.equal(manifest.fetchedAt,fetchedAt);
  const history=await listRuns(outputRoot);assert.equal(history[0].platform,'trendyol');
  const legacy=await createRun({rootDir:outputRoot,label:'legacy',site:'US'});
  await writeArtifacts(legacy,{'manifest.json':{title:'old Amazon',provider:'sellersprite'},'scores.json':{total:60}});
  assert.equal((await listRuns(outputRoot)).find((r)=>r.runId===legacy.runId).platform,'amazon');
});

test('detail safety failures stop immediately, ordinary omissions remain warnings', async (t)=>{
  const outputRoot=await temp(t);
  for(const code of ['CAPTCHA','RATE_LIMIT','ACCESS_DENIED','COUNTRY_NO_ENTRY']) {
    let calls=0;
    await assert.rejects(()=>selectCategoryTrendyol({keyword:'pot',outputRoot,provider:{searchProducts:async()=>({rows,pagesFetched:1,fetchedAt}),productDetail:async()=>{calls++;throw Object.assign(Error(code),{code});}},delay:async()=>{}}),{code});
    assert.equal(calls,1);
  }
  const result=await selectCategoryTrendyol({keyword:'pot',outputRoot,detailTopN:1,provider:{searchProducts:async()=>({rows,pagesFetched:1,fetchedAt}),productDetail:async()=>{throw Error('missing selector');}},delay:async()=>{}});
  assert.equal(result.market.details,0);assert.equal(result.usage.errors.length,1);
  await assert.rejects(()=>selectCategoryTrendyol({keyword:'pot',outputRoot,provider:{searchProducts:async()=>({rows:[],pagesFetched:1})}}),{code:'EMPTY_RESULT'});
});

test('regeneration preserves provenance, avoids overwrite and escapes hostile scraped content',async (t)=>{
  const outputRoot=await temp(t);
  const market=buildTrendyolMarket({keyword:'<script>alert(1)</script>',fetchedAt,rows:[{productId:'1',name:'=SUM(1,2) <img src=x onerror=alert(1)> | trap',brand:'@evil',priceTRY:100,reviewCount:5,url:'javascript:alert(1)'}]});
  const a=await persistTrendyolMarket({market,outputRoot,regeneratedFrom:'saved-snapshot'});
  const b=await persistTrendyolMarket({market,outputRoot,regeneratedFrom:'saved-snapshot'});
  assert.notEqual(a.runId,b.runId);
  const m=JSON.parse(await readFile(join(a.dir,'manifest.json'),'utf8'));
  assert.equal(m.fetchedAt,fetchedAt);assert.equal(m.regeneratedFrom,'saved-snapshot');assert.ok(m.createdAt);
  const csv=await readFile(join(a.dir,'tables/top_products.csv'),'utf8');assert.match(csv,/'=SUM/);assert.match(csv,/'@evil/);
  const html=renderDashboardHtml({market});
  assert.match(html,/<table>/);assert.doesNotMatch(html,/<script|<img|href="javascript:/);assert.match(html,/&lt;img/);
  const md=renderCategoryReport({market});assert.doesNotMatch(md,/<img|<script|javascript:alert/);
  assert.equal(a.score.missingDimensions,2);assert.equal(a.score.dataQuality,'C');assert.match(md,/数据质量 C/);assert.match(html,/数据质量 C/);
});

test('page guards distinguish robot products and prices from access blocks',async()=>{
  const source=await readFile(new URL('../host/web/snippets/trendyol-page-guard.js',import.meta.url),'utf8');
  const guard=(text,title='Trendyol',cookie='')=>JSON.parse(runInNewContext(source,{location:{href:'https://www.trendyol.com/sr'},document:{title,cookie,body:{innerText:text}}}));
  for(const text of ['Robot Süpürge 429 TL Güvenlik Kamera','Tencere 429 indirim']) {
    const g=guard(text);assert.equal(g.captcha,false);assert.equal(g.rateLimited,false);assert.equal(g.accessDenied,false);
  }
  assert.equal(guard('Verify you are human').captcha,true);
  assert.equal(guard('HTTP 429').rateLimited,true);
  assert.equal(guard('Too many requests').rateLimited,true);
  assert.equal(guard('Access denied').accessDenied,true);
  assert.equal(guard('Tencere','Trendyol','countryCode=DE; language=de').wrongCountry,true);
  assert.equal(guard('Tencere','Trendyol','foo=1; countryCode=TR').wrongCountry,false);
});

test('shared Chrome wait uses seconds externally and millisecond request budget',async()=>{
  let clock=0,calls=0;
  const budgets=[];
  const ready=await waitFor(1,'x',{timeout:5,intervalMs:2000,now:()=>clock,sleep:async(ms)=>{clock+=ms;},check:async(_id,_js,{timeout})=>{budgets.push(timeout);return ++calls===3?'true':'false';}});
  assert.equal(ready,true);assert.equal(clock,4000);assert.deepEqual(budgets,[5000,3000,1000]);
});

test('HTTP defaults preserve Amazon US and reject Amazon SA / non-SA Trendyol atomically',async(t)=>{
  const dataDir=await temp(t);let handler;
  registerRoutes({get:()=>({register:(route)=>{handler=route.handler;return ()=>{};}})},{dataDir,providers:{list:()=>[]},secrets:{},version:'test'});
  const server=createServer((req,res)=>handler(req,res));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const post=async(body)=>{const response=await fetch('http://127.0.0.1:'+server.address().port+'/amazon-research/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,data:await response.json()};};
  const tr=await post({platform:'trendyol'});assert.equal(tr.status,200);assert.equal(tr.data.config.marketplace,'SA');assert.equal(tr.data.config.provider,'trendyol-web');
  for(const body of [{platform:'trendyol',marketplace:'US'},{platform:'trendyol',marketplace:'TR'},{platform:'trendyol',provider:'sellersprite'},{platform:'unknown'},{platform:'amazon',marketplace:'SA'}]) assert.equal((await post(body)).status,400);
  assert.equal((await readConfig(dataDir)).platform,'trendyol');
  assert.equal((await readConfig(dataDir)).marketplace,'SA');
  // Restored old configuration cannot re-enable the unsupported storefront.
  await assert.rejects(writeConfig(dataDir,{platform:'trendyol',provider:'trendyol-web',marketplace:'TR'}),{code:'invalid_args'});
  await assert.rejects(writeConfig(dataDir,{platform:'amazon',provider:'sellersprite',marketplace:'SA'}),{code:'invalid_args'});
  const us=await post({platform:'amazon'});assert.equal(us.status,200);
  assert.equal(us.data.config.marketplace,'US');assert.equal(us.data.config.provider,'sellersprite');
  await writeFile(join(dataDir,'config.json'),JSON.stringify({platform:'amazon',provider:'sellersprite',marketplace:'US'}));
  assert.equal((await readConfig(dataDir)).marketplace,'US');
  assert.equal((await readConfig(dataDir)).platform,'amazon');
  const tool=createTools({dataDir,providers:{},secrets:{}}).find(t=>t.name==='research_category_select');
  for (const args of [{platform:'amazon',marketplace:'SA'}, {platform:'trendyol',marketplace:'TR'}, {platform:'trendyol',marketplace:'US'}]) {
    const result=await tool.execute(args);assert.equal(result.ok,false);assert.equal(result.error.code,'MARKET_ROUTE_INVALID');
  }
  const selection=createTools({dataDir,providers:{},secrets:{}}).find(t=>t.name==='research_product_select');
  const usPlan=await selection.execute({platform:'amazon',marketplace:'US',action:'plan',category:'vases'});
  assert.notEqual(usPlan.error?.code,'MARKET_ROUTE_INVALID');
  assert.equal(usPlan.ok,true);
  const saPlan=await selection.execute({platform:'trendyol',marketplace:'SA',action:'plan'});
  assert.equal(saPlan.ok,true);assert.equal(saPlan.model,'trendyol-saudi-workflow-v1');
});
