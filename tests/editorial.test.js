import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {candidateDecision,validateBriefing,speechSegments} from '../worker/editorial.js';
import worker from '../worker/index.js';
const editions=JSON.parse(await readFile('content/editions.json','utf8'));
test('routine SDK updates stay technical; genuine security fixes receive review',()=>{
 const item={title:'v3.52.0',url:'https://github.com/openai/openai-python/releases/tag/v3.52.0',excerpt:'Features: add schedule pause reasons'};
 assert.equal(candidateDecision(item).lane,'technical');
 assert.equal(candidateDecision({...item,excerpt:'Fix CVE-2026-1234 vulnerability'}).lane,'review');
 assert.equal(candidateDecision({title:'Sponsored report',excerpt:'',url:'https://example.com'}).lane,'excluded');
});
test('publication rejects changelogs, unsupported facts, duplicated events and future editions',()=>{
 const edition=editions[0];assert.equal(validateBriefing(edition),edition);
 for(const edit of [e=>{e.articles[0].title='v3.52.0'},e=>{e.articles[0].evidence=[]},e=>{e.articles[0].speech_script='## Release https://example.com'},e=>{e.articles[0].verification_status='unreviewed'},e=>{e.articles[0].editorial_kind='routine_release'},e=>{e.articles.push(e.articles[0])},e=>{e.published_at='2099-01-01T00:00:00Z'}]){const invalid=structuredClone(edition);edit(invalid);assert.throws(()=>validateBriefing(invalid))}
});
test('edited edition endpoint has Chinese summaries, fact citations and clean speech',async()=>{
 const res=await worker.fetch(new Request('https://station.test/api/editions'));assert.equal(res.status,200);const data=await res.json();assert.equal(data.automatic_publication,false);assert.ok(data.editions[0].articles.length>=4);data.editions.forEach(e=>validateBriefing(e));const chunks=speechSegments(data.editions[0].articles);assert.ok(chunks.length>5);assert.ok(chunks.every(c=>c.text.length<=120&&!/https?:\/\/|##|\[[^\]]+\]\(/.test(c.text)));assert.equal(speechSegments([{status:'unreviewed',speech_script:'不該朗讀'}]).length,0);
});
function clientHarness(){
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',hidden:false,classList:{toggle(){}},setAttribute(){},showModal(){this.open=true}});return nodes.get(id)};
 const memory=new Map();let said=[];
 const handlers=new Map();const document={querySelector:node,querySelectorAll(){return []},addEventListener(type,handler){handlers.set(type,handler)}};
 const context=vm.createContext({document,console,localStorage:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v)},window:{speechSynthesis:{}},navigator:{},Intl,Date,URL,Blob,setTimeout:()=>0,clearTimeout(){},fetch:async()=>({ok:true,json:async()=>({editions})}),SpeechSynthesisUtterance:class{constructor(text){this.text=text}},speechSynthesis:{cancel(){},speak(u){said.push(u)},getVoices(){return []}}});
 return {context,nodes,node,said,handlers};
}
test('client renders real summaries, filters SDKs and speaks edited text without requiring imports',async()=>{
 const h=clientHarness();vm.runInContext(await readFile('web/app.js','utf8'),h.context);
 await new Promise(resolve=>setImmediate(resolve));
 const html=h.node('#list').innerHTML;
 assert.match(html,/三|四家外部評估機構/);assert.match(html,/為何重要 · AI 判讀/);assert.match(html,/brief-facts/);assert.doesNotMatch(html,/\[3\.52\.0\]|commit\/|compare\//);
 assert.equal(vm.runInContext('current().articles.length',h.context),5);
 vm.runInContext("beginSpeech(current().articles,current().id)",h.context);assert.equal(h.said.length,1);assert.match(h.said[0].text,/人工智慧安全/);assert.doesNotMatch(h.said[0].text,/https|##/);
 vm.runInContext("stopSpeech();state.view='inbox';state.items=[{id:'sdk',title:'v3.52.0',topic:'AI',lane:'technical',source:'SDK',excerpt:'## Features',url:'https://example.com'},{id:'news',title:'New policy',topic:'AI',lane:'review',source:'Official',url:'https://example.com'}];render()",h.context);
 assert.equal(vm.runInContext('items().length',h.context),1);assert.doesNotMatch(h.node('#list').innerHTML,/v3.52.0|## Features/);
 vm.runInContext("state.showTechnical=true;render();openItem(0)",h.context);assert.match(h.node('#detail').innerHTML,/<details><summary>展開原始摘錄/);
 vm.runInContext("state.view='edition';state.edition='evening';render()",h.context);assert.equal(vm.runInContext('current()',h.context),undefined);assert.match(h.node('#list').innerHTML,/這一期尚未發布/);
});
test('the workspace refresh button fetches sources and shows the collection time', async () => {
 const h = clientHarness();
 vm.runInContext(await readFile('web/app.js','utf8'), h.context);
 await new Promise(resolve => setImmediate(resolve));
 let releaseFetch;
 let requests = 0;
 h.context.fetch = path => {
  assert.equal(path, '/api/inbox');
  requests++;
  return new Promise(resolve => {releaseFetch = resolve});
 };
 vm.runInContext("state.view='inbox';render()", h.context);
 const clickRefresh = () => h.handlers.get('click')({target:{closest:()=>({dataset:{action:'refresh'}})}});
 assert.match(h.node('#body').innerHTML, /重新擷取來源/);
 clickRefresh();
 clickRefresh();
 assert.equal(requests, 1);
 assert.match(h.node('#body').innerHTML, /disabled>擷取中/);
 releaseFetch({ok:true,json:async()=>({items:[],sources:[],collected_at:'2026-11-18T02:00:00Z'})});
 await new Promise(resolve => setImmediate(resolve));
 assert.match(h.node('#body').innerHTML, /最近擷取.*（台北）/);
 assert.match(h.node('#body').innerHTML, /重新擷取來源/);
});
test('play click starts without opening or approving any story',async()=>{
 const h=clientHarness();vm.runInContext(await readFile('web/app.js','utf8'),h.context);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(vm.runInContext('state.read.length',h.context),0);
 const button={dataset:{action:'speak'}};
 h.handlers.get('click')({target:{closest:()=>button}});
 assert.equal(h.said.length,1);assert.equal(vm.runInContext('player.active',h.context),true);
 assert.equal(vm.runInContext('state.read.length',h.context),0);
 assert.doesNotMatch(h.node('#toast').textContent,/尚無審核|需要查證/);
});
test('homepage and updater bypass stale HTML and expose the current release',async()=>{
 const page=await worker.fetch(new Request('https://station.test/'));
 assert.match(page.headers.get('Cache-Control'),/no-store/);
 assert.equal(page.headers.get('X-News-Station-Version'),'0.1.5');
 const version=await worker.fetch(new Request('https://station.test/api/version'));
 assert.equal((await version.json()).version,'0.1.5');
 const sw=await worker.fetch(new Request('https://station.test/sw.js'));
 assert.match(sw.headers.get('Cache-Control'),/no-store/);
 const script=await sw.text();
 const navigations=[];const handlers={};let activated;
 class Channel{constructor(){this.port1={close(){}};this.port2={postMessage:data=>this.port1.onmessage({data})}}}
 const clients=[{url:'https://station.test/',postMessage(){},async navigate(url){navigations.push(url)}},{url:'https://station.test/?current=1',postMessage(msg,ports){ports[0].postMessage({version:'0.1.5'})},async navigate(){throw Error('Current client must retain its playback')}},{url:'https://other.test/',async navigate(){throw Error('Cross-origin client must never navigate')}}];
 const context=vm.createContext({self:{addEventListener:(type,handler)=>handlers[type]=handler,location:{origin:'https://station.test'},clients:{async claim(){},async matchAll(){return clients}}},URL,MessageChannel:Channel,setTimeout:(fn)=>setTimeout(fn,5),clearTimeout});
 vm.runInContext(script,context);
 handlers.activate({waitUntil(promise){activated=promise}});await activated;
 assert.deepEqual(navigations,['https://station.test/?app_version=0.1.5']);
});
