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
  const source=(await readFile(new URL('../client.js',import.meta.url),'utf8')).replace('return { name: PLUGIN, inject:', "i18n = createI18n({locale:{bind:()=>key=>key==='runs.site'?'站点 {site}':key}}); return { testApi: { SettingsPage, Panel, RunRow, ProviderNotice, findProvider }, name: PLUGIN, inject:");
  runInNewContext(source,{window:{__ModuleLoader__:{load:({factory})=>{api=factory(()=>React).testApi;}}},document:{baseURI:'http://127.0.0.1:55484/'},URL,console,AbortController,setTimeout,clearTimeout});
  return {api,getState:()=>state,setOverview:(v)=>{overview=v;}};
}
function nodes(tree){return tree && typeof tree==='object'?[tree,...(tree.children||[]).flatMap(nodes)]:[];}
const byId=(tree,id)=>nodes(tree).find(n=>n.props.id===id);

test('client settings platform change updates provider and sites without requiring a key',async()=>{
  const {api,getState}=await loadClient();
  let view=api.SettingsPage();
  assert.ok(byId(view,'amz-key'));
  byId(view,'research-platform').props.onChange({target:{value:'trendyol'}});
  assert.equal(getState().provider,'trendyol-web');assert.equal(getState().marketplace,'TR');
  view=api.SettingsPage();
  assert.equal(byId(view,'amz-key'),undefined);
  assert.deepEqual(Array.from(byId(view,'research-provider').props.options,o=>o.value),['trendyol-web']);
  const sites = Array.from(byId(view,'amz-marketplace').props.options);
  assert.equal(sites.length,39);
  assert.equal(sites.find(s=>s.value==='SA').label,'沙特阿拉伯');
  assert.match(sites.find(s=>s.value==='DE').label,/抓取待接通/);
  assert.ok(sites.every(s=>/[\u4e00-\u9fff]/.test(s.label)));
  assert.ok(!sites.some(s=>s.value==='US'));
  byId(view,'amz-marketplace').props.onChange({target:{value:'SA'}});
  assert.equal(getState().marketplace,'SA');
  byId(view,'research-platform').props.onChange({target:{value:'amazon'}});
  view=api.SettingsPage();
  assert.equal(getState().provider,'sellersprite');assert.equal(getState().marketplace,'US');assert.ok(byId(view,'amz-key'));
  assert.ok(byId(view,'research-provider').props.options.every(o=>o.value!=='trendyol-web'&&o.value!=='sorftime'));
});

test('client history filters platform but keeps legacy Amazon records and correct active provider',async()=>{
  const {api,setOverview}=await loadClient();
  const overview={config:{platform:'trendyol',provider:'trendyol-web'},platforms:listPlatforms(),providers:[{id:'sellersprite'},{id:'trendyol-web',label:'Trendyol'}],runs:[{runId:'old'},{runId:'tr',platform:'trendyol'}]};
  setOverview(overview);
  assert.equal(api.findProvider(overview).id,'trendyol-web');
  let view=api.Panel();
  const list=(tree)=>nodes(tree).find(n=>n.type?.name==='RunList').props.runs;
  assert.equal(list(view).length,2);
  byId(view,'research-history-platform').props.onChange({target:{value:'trendyol'}});
  view=api.Panel();assert.equal(list(view).length,1);assert.equal(list(view)[0].runId,'tr');
  byId(view,'research-history-platform').props.onChange({target:{value:'amazon'}});
  view=api.Panel();assert.equal(list(view)[0].runId,'old');
  const row=api.RunRow({run:{runId:'tr',platform:'trendyol',site:'TR'}});
  assert.ok(JSON.stringify(row).includes('Trendyol'));
  const sa=api.RunRow({run:{runId:'sa',platform:'trendyol',site:'SA'},platforms:listPlatforms()});
  assert.ok(JSON.stringify(sa).includes('沙特阿拉伯'));
});
