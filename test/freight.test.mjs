import test from 'node:test';
import assert from 'node:assert/strict';
import { getFreight, resolveFreight, parseFreightPayload, fetchLiveFreight, freightTable } from '../host/sourcing/freight.js';
import { resolveCostProfile } from '../host/sourcing/cost-profile.js';
import { landedCost } from '../host/sourcing/cost-model.js';
import { evaluateCandidate } from '../host/selection/kpis.js';
import { compareChannels } from '../host/selection/brief.js';
import { screenCandidates } from '../host/selection/pipeline.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('missing freight stays unknown, including alternate modes', async () => {
  const freight = await getFreight();
  assert.equal(freight.source, 'missing');
  assert.equal(freight.perKgCNY, null);
  assert.ok(freightTable(freight).every(x => x.perKgCNY === null));
  assert.equal(landedCost({priceUSD:20, priceCNY:10, weightG:100, freight}), null);
  assert.ok(landedCost({priceUSD:20, priceCNY:10, weightG:100, freight, firstMileUSD:2}));
});
test('manual sea/air quote overrides API without network', async () => {
  const q = await getFreight({ mode:'air', perKgCNY:45, apiUrl:'https://example.com', fetchImpl:()=>{ throw Error('must not fetch'); } });
  assert.equal(q.source,'manual'); assert.equal(q.mode,'air'); assert.equal(q.perKgCNY,45);
  assert.equal(freightTable(q)[1].perKgCNY,45);
});
test('API preserves source, quote date, fetched time and rejects wrong units', async () => {
  const q = await getFreight({mode:'air',apiUrl:'https://example.com/quotes?key=secret',fetchImpl:async()=>({ok:true,json:async()=>({rates:{sea:20,air:50},date:'2026-11-17',currency:'CNY',unit:'kg'})})});
  assert.equal(q.perKgCNY,50); assert.equal(q.endpoint,'https://example.com/quotes');
  assert.equal(q.quotedAt,'2026-11-17'); assert.ok(q.fetchedAt);
  assert.equal(parseFreightPayload({sea:20,currency:'USD'}),null);
  assert.equal(parseFreightPayload({sea:20,unit:'cbm'}),null);
  assert.equal(parseFreightPayload({sea:true}),null);
  assert.equal(resolveFreight({mode:'toString'}).mode,'sea');
});
test('failure, expired quotes and hanging response bodies never fall back to estimated freight', async () => {
  assert.equal(await fetchLiveFreight({apiUrl:'https://example.com',fetchImpl:async()=>{throw Error('offline');}}),null);
  assert.equal(await fetchLiveFreight({apiUrl:'https://example.com',fetchImpl:async()=>({ok:true,json:async()=>({sea:20,validUntil:'2000-01-01'})})}),null);
  const q = await getFreight({apiUrl:'https://example.com',timeoutMs:5,fetchImpl:async()=>({ok:true,json:()=>new Promise(()=>{})})});
  assert.equal(q.source,'missing');
});
test('user profile has safe defaults and distinct sea/air costs', () => {
  const profile=resolveCostProfile({referralRate:null,adRate:10,returnRate:5,freightMode:'bad'});
  assert.equal(profile.referralRate,.06); assert.equal(profile.adRate,.10); assert.equal(profile.returnRate,.05); assert.equal(profile.otherUSD,0); assert.equal(profile.freightMode,'sea');
  const params={priceUSD:20,priceCNY:14,weightG:1000,costFx:7,settleFx:7,profile,fbaFeeUSD:0};
  const sea=landedCost({...params,freight:resolveFreight({mode:'sea',perKgCNY:14})});
  const air=landedCost({...params,freight:resolveFreight({mode:'air',perKgCNY:42})});
  assert.equal(sea.firstMileUSD,2); assert.equal(air.firstMileUSD,6);
  assert.equal(sea.referralUSD,1.2); assert.equal(sea.adUSD,2); assert.equal(sea.returnUSD,1); assert.equal(sea.otherUSD,0);
  assert.equal(sea.netProfitUSD,11.8); assert.equal(air.netProfitUSD,7.8);
  assert.equal(landedCost({...params,weightG:null,freight:resolveFreight({perKgCNY:14})}),null);
});
test('KPI and channel comparison use the same user cost profile and FX', () => {
  const opts={costFx:7,settleFx:7,profile:resolveCostProfile(),freight:resolveFreight({perKgCNY:14})};
  const c=evaluateCandidate({ASIN:'B0TEST',售价USD:20,采购价CNY:14,重量g:1000,FBA配送费USD:0},opts);
  assert.equal(c.profit.commissionUSD,1.2); assert.equal(c.profit.firstMileUSD,2); assert.equal(c.profit.costFx,7);
  assert.ok(compareChannels(c,opts).every(x=>x.referralRate===.06 && x.adRate===.1 && x.returnRate===.05));
});
test('screen persists missing freight and user profile without inventing profit', async () => {
  const dir=await mkdtemp(join(tmpdir(),'freight-screen-'));
  try {
    const out=await screenCandidates({rows:[{ASIN:'B0TEST',售价USD:20,采购价CNY:14,重量g:100}],outputRoot:dir,liveFx:false,costFx:7,settleFx:7});
    const prov=JSON.parse(await readFile(join(out.dir,'provenance.json'),'utf8'));
    assert.equal(prov.freight.source,'missing'); assert.equal(prov.costProfile.referralRate,.06); assert.equal(prov.results[0].profit,null);
    const report=await readFile(join(out.dir,'report.md'),'utf8');
    assert.match(report,/未取到/); assert.doesNotMatch(report,/¥null|内置估算表/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
