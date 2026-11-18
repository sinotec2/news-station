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
function clientHarness(clientEditions=editions){
 const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',hidden:false,classList:{toggle(){}},setAttribute(){},showModal(){this.open=true}});return nodes.get(id)};
 const memory=new Map();let said=[];
 const handlers=new Map();const document={querySelector:node,querySelectorAll(){return []},addEventListener(type,handler){handlers.set(type,handler)}};
 const context=vm.createContext({document,console,AbortController,localStorage:{getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v)},window:{speechSynthesis:{}},navigator:{},Intl,Date,URL,Blob,setTimeout:()=>0,clearTimeout(){},fetch:async()=>({ok:true,json:async()=>({editions:clientEditions})}),SpeechSynthesisUtterance:class{constructor(text){this.text=text}},speechSynthesis:{cancel(){},speak(u){said.push(u)},getVoices(){return []}}});
 return {context,nodes,node,said,handlers};
}
test('client renders real summaries, filters SDKs and speaks edited text without requiring imports',async()=>{
 const h=clientHarness([editions[0]]);vm.runInContext(await readFile('web/app.js','utf8'),h.context);
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
 assert.equal(page.headers.get('X-News-Station-Version'),'0.1.8');
 const version=await worker.fetch(new Request('https://station.test/api/version'));
 assert.equal((await version.json()).version,'0.1.8');
 const sw=await worker.fetch(new Request('https://station.test/sw.js'));
 assert.match(sw.headers.get('Cache-Control'),/no-store/);
 const script=await sw.text();
 const navigations=[];const handlers={};let activated;
 class Channel{constructor(){this.port1={close(){}};this.port2={postMessage:data=>this.port1.onmessage({data})}}}
 const clients=[{url:'https://station.test/',postMessage(){},async navigate(url){navigations.push(url)}},{url:'https://station.test/?current=1',postMessage(msg,ports){ports[0].postMessage({version:'0.1.8'})},async navigate(){throw Error('Current client must retain its playback')}},{url:'https://other.test/',async navigate(){throw Error('Cross-origin client must never navigate')}}];
 const context=vm.createContext({self:{addEventListener:(type,handler)=>handlers[type]=handler,location:{origin:'https://station.test'},clients:{async claim(){},async matchAll(){return clients}}},URL,MessageChannel:Channel,setTimeout:(fn)=>setTimeout(fn,5),clearTimeout});
 vm.runInContext(script,context);
 handlers.activate({waitUntil(promise){activated=promise}});await activated;
 assert.deepEqual(navigations,['https://station.test/?app_version=0.1.8']);
});

test('home opens the most recent published edition and preserves a reader’s manual switch',async()=>{
 const evening=editions.find(edition=>edition.id==='2026-11-18-evening-editorial-1');
 assert.equal(evening.articles.length,9);
 const h=clientHarness([editions[0],evening]);
 vm.runInContext(await readFile('web/app.js','utf8'),h.context);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(vm.runInContext('current().id',h.context),evening.id);
 assert.match(h.node('#list').innerHTML,/柴油車/);
 h.handlers.get('click')({target:{closest:()=>({dataset:{edition:'morning'}})}});
 await vm.runInContext('loadEditions()',h.context);
 assert.equal(vm.runInContext('current().id',h.context),editions[0].id);
});

test('published playback uses the configured voice for the issue and story, advances on end and stops pending work',async()=>{
 const edition=editions.at(-1);
 const h=clientHarness([edition]);
 const requests=[];
 let provideStatus;
 let deliverTrack;
 const status=new Promise(resolve=>{provideStatus=resolve});
 const hero={dataset:{}};
 const note={};
 const playerStatus={setAttribute(){}};
 h.context.document.querySelectorAll=selector=>({
  '[data-hero-audio]':[hero], '[data-hero-audio-note]':[note], '[data-player-status]':[playerStatus],
 }[selector]||[]);
 h.context.fetch=async(path,options)=>{
  if(path==='/api/editions')return Response.json({editions:[edition]});
  if(path==='/api/audio/status')return status;
  assert.equal(path,'/api/audio');
  requests.push({body:JSON.parse(options.body),signal:options.signal});
  return new Promise(resolve=>{deliverTrack=resolve});
 };
 const audio=h.node('#neural-audio');
 Object.assign(audio,{play:async()=>{audio.paused=false},pause(){audio.paused=true},load(){},removeAttribute(){}});
 const detail=h.node('#detail');
 detail.close=()=>{detail.open=false};
 const click=dataset=>h.handlers.get('click')({target:{closest:()=>({dataset})}});
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 const wav=(voice='cedar')=>new Response(new Uint8Array(48),{headers:{'X-Audio-Voice':voice,'Content-Type':'audio/wav','X-Audio-Expires-At':String(Date.now()+60000)}});
 vm.runInContext(await readFile('web/app.js','utf8'),h.context);
 await settle();
 assert.ok(hero.disabled);
 assert.equal(requests.length,0);
 provideStatus(Response.json({ready:true,voice:'cedar'}));
 await settle();
 assert.equal(hero.disabled,false);
 assert.equal(hero.dataset.action,'neural-play');
 assert.match(hero.textContent,/Cedar/);
 assert.match(h.node('#body').innerHTML,/data-action="neural-play"[^>]*>▶ Cedar/);
 assert.match(h.node('#list').innerHTML,/data-neural="0">▷ Cedar/);
 assert.match(note.textContent,/按播放後/);
 assert.equal(requests.length,0);
 click(hero.dataset);click(hero.dataset);
 assert.deepEqual(requests.map(r=>r.body),[{edition_id:edition.id,article_id:edition.articles[0].id}]);
 deliverTrack(wav());await settle();
 assert.match(playerStatus.textContent,/Cedar 播報中 · 1 \/ 9 則/);
 assert.equal(h.said.length,0);
 assert.equal(requests.length,1);
 audio.onended();
 assert.deepEqual(requests[1].body,{edition_id:edition.id,article_id:edition.articles[1].id});
 click({action:'neural-stop'});
 assert.ok(requests[1].signal.aborted);
 deliverTrack(wav());await settle();
 assert.equal(h.node('#neural-player').hidden,true);
 assert.equal(audio.onended,null);
 click({neural:'0'});await settle();
 assert.equal(requests.length,2);
 assert.match(h.node('#neural-state').textContent,/分頁暫存重播/);
 click({action:'neural-stop'});
 vm.runInContext('openItem(1)',h.context);
 assert.match(detail.innerHTML,/class="primary" data-neural="1">▷ Cedar/);
 assert.match(detail.innerHTML,/data-speak="1">▷ 裝置朗讀/);
 click({neural:'1'});
 assert.equal(detail.open,false);
 assert.equal(requests[2].body.article_id,edition.articles[1].id);
 deliverTrack(Response.json({error:'provider_auth_failed'},{status:502}));await settle();
 assert.match(h.node('#neural-state').textContent,/API 金鑰/);
 click({neural:'1'});deliverTrack(wav('marin'));await settle();
 assert.match(h.node('#neural-state').textContent,/指定音色不符/);
 assert.equal(h.said.length,0);
 click({neural:'1'});deliverTrack(wav());await settle();
 assert.equal(requests.length,5);
 audio.onerror();click({neural:'1'});deliverTrack(wav());await settle();
 assert.equal(requests.length,6,'a decoding error evicts the clip');
 vm.runInContext("current().articles[1].speech_script+='更新。'",h.context);
 click({neural:'1'});deliverTrack(wav());await settle();
 assert.equal(requests.length,7,'a corrected script must be regenerated');
 const later=Date.now()+61000;
 h.context.Date=class extends Date{static now(){return later}};
 click({neural:'0'});deliverTrack(wav());await settle();
 assert.equal(requests.length,8,'expired clips must be regenerated');
 assert.match(h.node('#neural-state').textContent,/已到期/);
 click({speak:'1'});
 assert.equal(h.said.length,1);
});

test('an issue skips only an unfaithful narration, retains its title at completion and stops on provider failure',async()=>{
 const edition={...editions.at(-1),articles:editions.at(-1).articles.slice(0,3)};
 const h=clientHarness([edition]);
 const ids=[];
 let played=0;
 let problem='narration_mismatch';
 const audio=h.node('#neural-audio');
 Object.assign(audio,{play:async()=>{played++},pause(){},load(){},removeAttribute(){}});
 h.context.fetch=async(path,options)=>{
  if(path==='/api/editions')return Response.json({editions:[edition]});
  if(path==='/api/audio/status')return Response.json({ready:true,voice:'cedar'});
  const id=JSON.parse(options.body).article_id;ids.push(id);
  if(id===edition.articles[1].id)return Response.json({error:problem},{status:502});
  return new Response(new Uint8Array(48),{headers:{'Content-Type':'audio/wav','X-Audio-Voice':'cedar','X-Audio-Expires-At':String(Date.now()+60000)}});
 };
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 const click=dataset=>h.handlers.get('click')({target:{closest:()=>({dataset})}});
 vm.runInContext(await readFile('web/app.js','utf8'),h.context);await settle();
 click({action:'neural-play'});await settle();
 assert.equal(played,1);
 audio.onended();await settle();
 assert.deepEqual(ids,edition.articles.map(a=>a.id));
 assert.equal(played,2);
 audio.onended();
 assert.match(h.node('#neural-state').textContent,/已播完 2 則。1 則/);
 assert.ok(h.node('#neural-state').textContent.includes(edition.articles[1].title));
 click({neural:'1'});await settle();
 assert.match(h.node('#neural-state').textContent,/口播稿不一致/);
 assert.equal(played,2);
 problem='provider_quota_exceeded';
 click({action:'neural-play'});await settle();
 assert.equal(played,3);
 audio.onended();await settle();
 assert.equal(played,3);
 assert.equal(ids.length,5);
 assert.match(h.node('#neural-state').textContent,/額度/);
});

test('tab cache evicts least-recently-used audio within its byte budget',async()=>{
 const h=clientHarness();
 vm.runInContext(await readFile('web/app.js','utf8'),h.context);
 vm.runInContext(`const clip={expires:Date.now()+60000,blob:{size:RECENT_AUDIO_LIMIT/3}};
  for(const key of ['one','two','three','one','four'])rememberAudioClip(key,clip);
  rememberAudioClip('too large',{...clip,blob:{size:RECENT_AUDIO_LIMIT+1}});`,h.context);
 assert.deepEqual(Array.from(vm.runInContext('recentAudio.keys()',h.context)),['three','one','four']);
});
