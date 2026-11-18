import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { listPlatforms } from '../host/platforms/index.js';

async function loadClient() {
  let api, state, overview, filter='all';
  const React={
    Fragment:'fragment',
    createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)}),
    useEffect:()=>{},
    useState:(initial)=>{
      if(initial && typeof initial==='object' && 'platform' in initial) {
        state ||= {...initial,phase:'ready',platforms:listPlatforms(),providers:[{id:'sellersprite',label:'Sellersprite'},{id:'sellersprite-web',label:'Amazon Web'},{id:'trendyol-web',label:'Trendyol Web'},{id:'sorftime',label:'Sorftime'}]};
        return [state,(fn)=>{state=typeof fn==='function'?fn(state):fn;}];
      }
      if(initial && typeof initial==='object' && 'data' in initial) return [{...initial,phase:'ready',data:overview},()=>{}];
      if(initial==='all') return [filter,(v)=>{filter=v;}];
      return [initial,()=>{}];
    },
  };
  const source=(await readFile(new URL('../client.js',import.meta.url),'utf8')).replace('return { name: PLUGIN, inject:', "i18n = createI18n({locale:{bind:()=>key=>({'runs.site':'站点 {site}','runs.productSelection':'单品筛选'}[key]||key)}}); return { testApi: { SettingsPage, Panel, RunRow, ProviderNotice, findProvider, groupRunsByCategory }, name: PLUGIN, inject:");
  runInNewContext(source,{window:{__ModuleLoader__:{load:({factory})=>{api=factory(()=>React).testApi;}}},document:{baseURI:'http://127.0.0.1:55484/'},URL,console,AbortController,setTimeout,clearTimeout});
  return {api,getState:()=>state,setOverview:(v)=>{overview=v;}};
}
function nodes(tree){return tree && typeof tree==='object'?[tree,...(tree.children||[]).flatMap(nodes)]:[];}
const byId=(tree,id)=>nodes(tree).find(n=>n.props.id===id);

test('client settings retain Amazon US keys and non-SA sites; Trendyol exposes only SA without key',async()=>{
  const {api,getState}=await loadClient();
  let view=api.SettingsPage();
  assert.ok(byId(view,'amz-key'));
  assert.equal(getState().platform,'amazon');assert.equal(getState().marketplace,'US');
  assert.deepEqual(Array.from(byId(view,'research-platform').props.options,o=>o.value),['amazon','trendyol']);
  assert.deepEqual(Array.from(byId(view,'amz-marketplace').props.options,o=>o.value),['US','UK','DE','FR','IT','ES','CA','JP','MX','AU','IN','AE','BR']);
  assert.deepEqual(Array.from(byId(view,'research-provider').props.options,o=>o.value),['sellersprite','sellersprite-web']);
  byId(view,'research-platform').props.onChange({target:{value:'trendyol'}});
  assert.equal(getState().provider,'trendyol-web');assert.equal(getState().marketplace,'SA');
  view=api.SettingsPage();
  assert.equal(byId(view,'amz-key'),undefined);
  assert.deepEqual(Array.from(byId(view,'research-provider').props.options,o=>o.value),['trendyol-web']);
  const sites = Array.from(byId(view,'amz-marketplace').props.options);
  assert.equal(sites.length,1);
  assert.equal(sites[0].value,'SA');assert.equal(sites[0].label,'沙特阿拉伯');
  byId(view,'research-platform').props.onChange({target:{value:'amazon'}});
  assert.equal(getState().platform,'amazon');assert.equal(getState().marketplace,'US');
  assert.equal(getState().provider,'sellersprite');assert.ok(byId(api.SettingsPage(),'amz-key'));
});

test('client groups runs into collapsible first- and second-level categories',async()=>{
  const {api}=await loadClient();
  const groups=api.groupRunsByCategory([
    {runId:'locks',title:'Cabinet Locks (橱柜锁)',kind:'category'},
    {runId:'edge',title:'Edge & Corner Guards',kind:'category'},
    {runId:'hardware',title:'Cabinet Hardware (橱柜硬件)',kind:'category'},
    {runId:'tk',title:'vibedor · tiktok-shop',kind:'selection'},
  ]);
  assert.equal(groups[0].label,'Baby Products');
  assert.equal(groups[0].count,2);
  assert.equal(groups[0].children[0].label,'Safety');
  assert.deepEqual(Array.from(groups[0].children[0].runs,r=>r.runId),['locks','edge']);
  assert.equal(groups[1].label,'Tools & Home Improvement');
  assert.equal(groups[1].children[0].label,'Hardware');
  assert.equal(groups[2].label,'单品筛选');
  assert.equal(groups[2].children[0].label,'tiktok-shop');
});

test('client history preserves legacy Amazon and all historical runs with platform filtering',async()=>{
  const {api,setOverview}=await loadClient();
  const overview={config:{platform:'trendyol',provider:'trendyol-web'},platforms:listPlatforms(),providers:[{id:'sellersprite'},{id:'trendyol-web',label:'Trendyol.sa'}],runs:[{runId:'old'},{runId:'tr',platform:'trendyol',site:'TR'},{runId:'sa',platform:'trendyol',site:'SA'},{runId:'workflow',platform:'trendyol-sa'}]};
  setOverview(overview);
  assert.equal(api.findProvider(overview).id,'trendyol-web');
  const view=api.Panel();
  const list=nodes(view).find(n=>n.type?.name==='RunList').props.runs;
  assert.deepEqual(Array.from(list,r=>r.runId),['old','tr','sa','workflow']);
  const filter=byId(view,'research-history-platform');assert.ok(filter);
  filter.props.onChange({target:{value:'amazon'}});
  assert.deepEqual(Array.from(nodes(api.Panel()).find(n=>n.type?.name==='RunList').props.runs,r=>r.runId),['old']);
  filter.props.onChange({target:{value:'trendyol'}});
  assert.deepEqual(Array.from(nodes(api.Panel()).find(n=>n.type?.name==='RunList').props.runs,r=>r.runId),['tr','sa','workflow']);
  const sa=api.RunRow({run:{runId:'sa',platform:'trendyol',site:'SA'},platforms:listPlatforms()});
  assert.ok(JSON.stringify(sa).includes('沙特阿拉伯'));
});
