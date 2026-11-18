import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { listPlatforms, resolveSite, getPlatform } from '../host/platforms/index.js';
import { readConfig, writeConfig } from '../host/paths.js';
import { registerRoutes } from '../host/routes.js';

async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'sa-platform-')); t.after(() => rm(dir, {recursive:true,force:true})); return dir; }
test('Amazon original non-SA sites remain; Saudi is exclusively Trendyol', () => {
  assert.deepEqual(listPlatforms().map(p => p.id), ['amazon','trendyol']);
  assert.deepEqual(getPlatform('amazon').sites.map(s=>s.value), ['US','UK','DE','FR','IT','ES','CA','JP','MX','AU','IN','AE','BR']);
  assert.equal(resolveSite('amazon', 'SA'), null);
  assert.equal(resolveSite('trendyol'), 'SA');
  assert.equal(resolveSite('trendyol', 'TR'), null);
  assert.equal(getPlatform('trendyol').currency, 'SAR');
});

test('config preserves legacy Amazon US and unrelated preferences; platform switching chooses valid defaults', async t => {
  const dir = await temp(t);
  await writeFile(join(dir,'config.json'), JSON.stringify({marketplace:'US',provider:'sellersprite',defaultLimit:37,custom:'preserved'}));
  let config = await readConfig(dir);
  assert.equal(config.platform,'amazon'); assert.equal(config.marketplace,'US'); assert.equal(config.provider,'sellersprite');
  assert.equal(config.defaultLimit,37); assert.equal(config.custom,'preserved');
  await writeConfig(dir,{marketplace:'DE',provider:'sellersprite-web'});
  config=await readConfig(dir); assert.equal(config.marketplace,'DE'); assert.equal(config.provider,'sellersprite-web');
  config=await writeConfig(dir,{platform:'trendyol'}); assert.equal(config.marketplace,'SA'); assert.equal(config.provider,'trendyol-web');
  assert.equal((await readConfig(dir)).platform,'trendyol');
  for (const patch of [{marketplace:'TR'},{provider:'sellersprite'},{platform:null},{marketplace:null},{provider:''}]) await assert.rejects(writeConfig(dir,patch),{code:'invalid_args'});
  config=await writeConfig(dir,{platform:'amazon'}); assert.equal(config.marketplace,'US'); assert.equal(config.provider,'sellersprite');
  await assert.rejects(writeConfig(dir,{marketplace:'SA'}),{code:'invalid_args'});
  assert.equal((await writeConfig(dir,{defaultLimit:42})).defaultLimit,42);
});

test('HTTP permits Amazon credentials and switching but rejects Amazon SA and Trendyol TR', async t => {
  const dataDir = await temp(t); let handler; const saved=[];
  registerRoutes({get:()=>({register(route){handler=route.handler;return()=>{};}})}, {dataDir,providers:{list:()=>[]},secrets:{set:(...args)=>saved.push(args),clear:()=>{}},version:'test'});
  async function request(path,body) {
    const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.url='/amazon-research/api/'+path;req.method='POST';req.headers={host:'localhost'};req.socket={remoteAddress:'127.0.0.1'};
    let code,payload;await handler(req,{writeHead(c){code=c;},end(raw){payload=JSON.parse(raw);}});return {code,payload};
  }
  assert.equal((await request('credentials',{provider:'sellersprite',key:'test-key'})).code,200); assert.deepEqual(saved,[['sellersprite','test-key']]);
  let r=await request('settings',{platform:'trendyol'}); assert.equal(r.code,200);assert.equal(r.payload.config.marketplace,'SA');
  assert.equal((await request('settings',{marketplace:'TR'})).code,400);
  r=await request('settings',{platform:'amazon'});assert.equal(r.code,200);assert.equal(r.payload.config.marketplace,'US');assert.equal(r.payload.config.provider,'sellersprite');
  for(const body of [{marketplace:'SA'},{platform:null},{provider:'trendyol-web'}]) assert.equal((await request('settings',body)).code,400);
});

function nodes(tree) { return tree && typeof tree==='object' ? [tree,...(tree.children||[]).flatMap(nodes)] : []; }
async function client(platform='amazon') {
  let api;
  const React={Fragment:'fragment',createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)}),useEffect:()=>{},useState(initial){
    if(initial && typeof initial==='object' && 'platform' in initial) return [{...initial,phase:'ready',platform,marketplace:platform==='amazon'?'US':'SA',provider:platform==='amazon'?'sellersprite':'trendyol-web',platforms:listPlatforms(),providers:[{id:'sellersprite',label:'SellerSprite'},{id:'sellersprite-web',label:'Web'},{id:'trendyol-web',label:'Trendyol'}]},()=>{}];
    if(initial && typeof initial==='object' && 'data' in initial) return [{...initial,phase:'ready',data:{runs:[{runId:'old-us',site:'US'},{runId:'new-sa',platform:'trendyol',site:'SA'}],platforms:listPlatforms()}},()=>{}];
    return [initial,()=>{}];
  }};
  const source=(await readFile(new URL('../client.js',import.meta.url),'utf8')).replace('return { name: PLUGIN, inject:',"i18n = createI18n({locale:{bind:()=>key=>key}}); return { testApi: { SettingsPage, Panel }, name: PLUGIN, inject:");
  runInNewContext(source,{window:{__ModuleLoader__:{load:({factory})=>{api=factory(()=>React).testApi;}}},document:{baseURI:'http://localhost/'},URL,console,AbortController,setTimeout,clearTimeout});return api;
}
test('client restores Amazon key, platform switching and original history list',async()=>{
  const api=await client();const view=api.SettingsPage();const byId=id=>nodes(view).find(n=>n.props.id===id);
  assert.ok(byId('amz-key'));
  assert.deepEqual(Array.from(byId('research-platform').props.options,o=>o.value),['amazon','trendyol']);
  assert.deepEqual(Array.from(byId('research-provider').props.options,o=>o.value),['sellersprite','sellersprite-web']);
  assert.ok(byId('amz-marketplace').props.options.some(o=>o.value==='US'));
  assert.ok(!byId('amz-marketplace').props.options.some(o=>o.value==='SA'));
  const panel=nodes(api.Panel());assert.ok(panel.some(n=>n.props.id==='research-panel-platform'));assert.ok(panel.some(n=>n.props.id==='research-history-platform'));
  assert.deepEqual(Array.from(panel.find(n=>n.props.runs).props.runs,r=>r.runId),['old-us','new-sa']);
});
test('Trendyol settings remain Saudi-only without key inputs',async()=>{
  const api=await client('trendyol');const view=api.SettingsPage();const byId=id=>nodes(view).find(n=>n.props.id===id);
  assert.equal(byId('amz-key'),undefined);
  assert.deepEqual(Array.from(byId('research-provider').props.options,o=>o.value),['trendyol-web']);
  assert.deepEqual(Array.from(byId('amz-marketplace').props.options,o=>o.value),['SA']);
});
