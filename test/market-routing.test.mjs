import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saOnlyTools } from '../host/market/sa-tools.js';

async function fixture(t, config = { platform:'amazon', marketplace:'US', provider:'sellersprite' }) {
  const dir = await mkdtemp(join(tmpdir(),'market-routing-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'config.json'), JSON.stringify({...config,outputRoot:join(dir,'runs')}));
  const calls=[];
  const names=['research_provider_status','research_category_select','research_product_select','research_unit_cost','mcp_call','research_runs','research_page','research_market_macro'];
  const legacy=names.map(name=>({ name,description:'Original '+name,parameters:{type:'object',properties:{category:{type:'string'},action:{type:'string',enum:['plan','collect','screen']},rows:{type:'array',items:{type:'object'}},csv:{type:'string'},costProfile:{type:'object',additionalProperties:true},profile:{type:'string'},freightPerKgCNY:{type:'number'},channel:{type:'string'},provider:{type:'string'},args:{type:'object'}},required:['action'],additionalProperties:false},execute:async(args,exec)=>{calls.push({name,args,exec});return {ok:true,legacy:name,args};}}));
  const before=legacy.map(tool=>structuredClone(tool.parameters));
  const tools=Object.fromEntries(saOnlyTools(legacy,{dataDir:dir}).map(tool=>[tool.name,tool]));
  assert.deepEqual(legacy.map(tool=>tool.parameters),before,'legacy schema remains untouched');
  return {dir,tools,calls,legacy};
}

test('preserves original schemas/actions and status all; macro stays unregistered',async t=>{
  const {tools,calls,legacy}=await fixture(t);
  assert.equal(tools.research_market_macro,undefined);
  assert.equal(tools.research_provider_status,legacy[0]);
  await tools.research_provider_status.execute({provider:'all'});
  assert.equal(calls[0].args.provider,'all');
  const p=tools.research_product_select.parameters.properties;
  assert.deepEqual(p.action.enum,['plan','collect','screen']);
  for(const key of ['rows','csv','costProfile','profile','freightPerKgCNY','channel','candidates','platform','marketplace']) assert.ok(p[key],key);
});

test('Amazon US category retains parameters and execution context despite Saudi default',async t=>{
  const {tools,calls}=await fixture(t,{platform:'trendyol',marketplace:'SA',provider:'trendyol-web'});
  const exec={signal:'sentinel'};
  const r=await tools.research_category_select.execute({marketplace:'US',category:'vases',nodeIdPath:'123',unitCost:4,month:'202610',costs:[{priceCNY:2}]},exec);
  assert.equal(r.legacy,'research_category_select');
  assert.equal(calls[0].args.platform,'amazon');assert.equal(calls[0].args.marketplace,'US');assert.equal(calls[0].args.provider,'sellersprite');
  assert.equal(calls[0].args.nodeIdPath,'123');assert.equal(calls[0].args.unitCost,4);assert.equal(calls[0].exec,exec);
});

test('explicit SA category selects only Trendyol without changing legacy Amazon default',async t=>{
  const {tools,calls}=await fixture(t);
  const r=await tools.research_category_select.execute({marketplace:'SA',category:'cup holder',pages:1,detailTopN:0});
  assert.equal(r.ok,true);assert.equal(calls[0].args.platform,'trendyol');assert.equal(calls[0].args.provider,'trendyol-web');
  for(const args of [{platform:'amazon',marketplace:'SA'},{platform:'trendyol',marketplace:'US'},{platform:'trendyol',marketplace:'TR'},{marketplace:'SA',provider:'sellersprite'},{marketplace:'SA',unitCost:4},{marketplace:null}]) assert.equal((await tools.research_category_select.execute(args)).ok,false,JSON.stringify(args));
  assert.equal(calls.length,1);
});

test('Amazon plan/collect/screen and original cost/profile inputs use legacy selection',async t=>{
  const {tools,calls}=await fixture(t,{platform:'trendyol',marketplace:'SA',provider:'trendyol-web'});
  for(const action of ['plan','collect','screen']) {
    const r=await tools.research_product_select.execute({action,marketplace:'US',category:'vases',rows:[{ASIN:'test'}],profile:'factory',channel:'amazon-fbm',costProfile:{adRate:0.1},freightPerKgCNY:18});
    assert.equal(r.legacy,'research_product_select');assert.equal(r.args.marketplace,'US');assert.equal(r.args.profile,'factory');assert.equal(r.args.costProfile.adRate,0.1);assert.equal(r.args.freightPerKgCNY,18);
  }
  assert.equal(calls.length,3);
  assert.equal((await tools.research_product_select.execute({action:'plan',platform:'amazon'})).args.marketplace,'US');
});

test('SA plan and screen use strict engine/report; no legacy selection invocation',async t=>{
  const {tools,calls,dir}=await fixture(t);
  const plan=await tools.research_product_select.execute({action:'plan',marketplace:'SA'});
  assert.equal(plan.model,'trendyol-saudi-workflow-v1');assert.equal(plan.currency,'SAR');assert.ok(plan.inputTemplate);
  const screen=await tools.research_product_select.execute({action:'screen',marketplace:'SA',candidates:[{id:'test-fixture',platform:'trendyol-sa'}],outDir:join(dir,'strict')});
  assert.equal(screen.ok,true);assert.equal(screen.summary.paused,1);assert.equal(calls.length,0);
  const report=await readFile(screen.reportPath,'utf8');assert.match(report,/Trendyol/);
  for(const args of [{action:'collect',marketplace:'SA'},{action:'screen',marketplace:'SA',rows:[]},{action:'plan',platform:'amazon',marketplace:'SA'},{action:'screen',marketplace:'US',candidates:[]}]) assert.equal((await tools.research_product_select.execute(args)).ok,false);
});

test('restores Amazon unit cost while rejecting accidental Saudi model use',async t=>{
  const {tools,calls}=await fixture(t,{platform:'trendyol',marketplace:'SA',provider:'trendyol-web'});
  assert.equal((await tools.research_unit_cost.execute({category:'vases'})).ok,false);
  assert.equal((await tools.research_unit_cost.execute({marketplace:'SA',category:'vases'})).ok,false);
  const r=await tools.research_unit_cost.execute({marketplace:'US',provider:'1688',subMarkets:[{keyword:'vases'}],freightPerKgCNY:18,costProfile:{adRate:0.1}});
  assert.equal(r.legacy,'research_unit_cost');assert.equal(r.args.provider,'1688');assert.equal(r.args.freightPerKgCNY,18);assert.equal(calls.length,1);
});

test('MCP keeps Amazon payload intact but rejects default Saudi, SA and nested markers',async t=>{
  const {tools,calls}=await fixture(t,{platform:'trendyol',marketplace:'SA',provider:'trendyol-web'});
  const base={provider:'sellersprite',tool:'asin_detail'};
  assert.equal((await tools.mcp_call.execute(base)).ok,false);
  const payload={request:{marketplace:'US',asin:'fixture'}};
  const r=await tools.mcp_call.execute({...base,marketplace:'US',args:payload,saveToFile:false});
  assert.equal(r.legacy,'mcp_call');assert.deepEqual(r.args.args,payload);assert.equal(r.args.saveToFile,false);
  for(const args of [{marketplace:'SA'},{platform:'amazon',marketplace:'SA'},{marketplace:'US',args:{request:{marketplace:'SA'}}},{marketplace:'US',args:{request:{country:'Saudi Arabia'}}},{marketplace:'US',args:{request:[{site:'SA'}]}},{marketplace:'US',args:{url:'https://www.amazon.sa/dp/test'}},{marketplace:'US',args:{marketplaceId:'A17E79C6D8DWNP'}}]) assert.equal((await tools.mcp_call.execute({...base,...args})).ok,false,JSON.stringify(args));
  assert.equal(calls.length,1);
});
