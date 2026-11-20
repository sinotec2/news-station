import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {candidateDecision,validateBriefing,speechSegments} from '../worker/editorial.js';
import worker from '../worker/index.js';
import {enrichEdition} from '../worker/product-context.js';
import {editions} from './fixtures/editions.js';
import {clientHarness} from './fixtures/client-harness.js';
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
test('the production bundle serves the configured archive grouped by date and edition',async()=>{
 const {default:deployedWorker}=await import('../dist/server/index.js');
 const configured=JSON.parse(await readFile('content/editions.json','utf8'));
 const expected=new Map();
 for(const issue of configured){
  const key=issue.date+'-'+issue.edition;
  if(!expected.has(key)||(issue.version||1)>=(expected.get(key).version||1))expected.set(key,issue);
 }
 const received=[];
 const cursors=new Set();
 let before=null;
 do{
  const suffix=before?'?before='+encodeURIComponent(before):'';
  const response=await deployedWorker.fetch(new Request('https://station.test/api/editions'+suffix));
  assert.equal(response.status,200);
  const page=await response.json();
  assert.equal(page.automatic_publication,false);
  received.push(...page.editions);
  before=page.next_before;
  if(before){assert.ok(!cursors.has(before),'archive cursor must advance');cursors.add(before)}
 }while(before);
 const byId=(a,b)=>a.id.localeCompare(b.id);
 assert.deepEqual(received.sort(byId),[...expected.values()].map(enrichEdition).sort(byId));
});
test('verified articles produce clean, bounded speech segments and unreviewed items stay silent',()=>{
 for(const issue of editions)validateBriefing(issue);
 const chunks=speechSegments(editions[0].articles);
 assert.ok(chunks.length>5);
 assert.ok(chunks.every(c=>c.text.length<=120&&!/https?:\/\/|##|\[[^\]]+\]\(/.test(c.text)));
 assert.equal(speechSegments([{status:'unreviewed',speech_script:'不該朗讀'}]).length,0);
});
test('client renders real summaries, filters SDKs and speaks edited text without requiring imports',async()=>{
 const h=clientHarness([editions[0]]);vm.runInContext(await readFile('web/app.js','utf8'),h.context);
 await new Promise(resolve=>setImmediate(resolve));
 const html=h.node('#list').innerHTML;
 assert.ok(html.includes(editions[0].articles[0].title));assert.match(html,/為何重要 · AI 判讀/);assert.match(html,/brief-facts/);assert.doesNotMatch(html,/\[3\.52\.0\]|commit\/|compare\//);
 assert.equal(vm.runInContext('current().articles.length',h.context),5);
 vm.runInContext("beginSpeech(current().articles,current().id)",h.context);assert.equal(h.said.length,1);assert.ok(editions[0].articles[0].speech_script.startsWith(h.said[0].text));assert.doesNotMatch(h.said[0].text,/https|##/);
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
 assert.equal(page.headers.get('X-News-Station-Version'),'0.1.12');
 const version=await worker.fetch(new Request('https://station.test/api/version'));
 assert.equal((await version.json()).version,'0.1.12');
 const sw=await worker.fetch(new Request('https://station.test/sw.js'));
 assert.match(sw.headers.get('Cache-Control'),/no-store/);
 const script=await sw.text();
 const navigations=[];const handlers={};let activated;
 class Channel{constructor(){this.port1={close(){}};this.port2={postMessage:data=>this.port1.onmessage({data})}}}
 const clients=[{url:'https://station.test/',postMessage(){},async navigate(url){navigations.push(url)}},{url:'https://station.test/?current=1',postMessage(msg,ports){ports[0].postMessage({version:'0.1.12'})},async navigate(){throw Error('Current client must retain its playback')}},{url:'https://other.test/',async navigate(){throw Error('Cross-origin client must never navigate')}}];
 const context=vm.createContext({self:{addEventListener:(type,handler)=>handlers[type]=handler,location:{origin:'https://station.test'},clients:{async claim(){},async matchAll(){return clients}}},URL,MessageChannel:Channel,setTimeout:(fn)=>setTimeout(fn,5),clearTimeout});
 vm.runInContext(script,context);
 handlers.activate({waitUntil(promise){activated=promise}});await activated;
 assert.deepEqual(navigations,['https://station.test/?app_version=0.1.12']);
});

test('home opens the most recent published edition and preserves a reader’s manual switch',async()=>{
 const evening=editions.find(edition=>edition.edition==='evening');
 assert.equal(evening.articles.length,9);
 const h=clientHarness([editions[0],evening]);
 vm.runInContext(await readFile('web/app.js','utf8'),h.context);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(vm.runInContext('current().id',h.context),evening.id);
 assert.ok(h.node('#list').innerHTML.includes(evening.articles[0].title));
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
 Object.assign(audio,{play:async()=>{audio.paused=false;audio.onplaying?.()},pause(){audio.paused=true;audio.onpause?.()},load(){},removeAttribute(){}});
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
 assert.deepEqual(requests.map(r=>r.body),[{edition_id:edition.id,article_id:edition.articles[0].id,mode:'edition'}]);
 deliverTrack(wav());await settle();
 assert.match(playerStatus.textContent,/Cedar 播報中 · 1 \/ 9 則/);
 assert.equal(h.said.length,0);
 assert.equal(requests.length,2,'only the next track is prepared while the current one plays');
 audio.onplaying();audio.onplaying();
 assert.equal(requests.length,2);
 audio.onended();
 assert.equal(requests.length,2,'the handoff joins the same in-flight request');
 assert.match(h.node('#neural-state').textContent,/銜接第 2 則/);
 assert.deepEqual(requests[1].body,{edition_id:edition.id,article_id:edition.articles[1].id,mode:'edition'});
 click({action:'neural-stop'});
 assert.ok(requests[1].signal.aborted);
 deliverTrack(wav());await settle();
 assert.equal(h.node('#neural-player').hidden,true);
 assert.equal(audio.onended,null);
 click({neural:'0'});
 assert.deepEqual(requests[2].body,{edition_id:edition.id,article_id:edition.articles[0].id},'single narration has its own script and key');
 deliverTrack(wav());await settle();
 click({neural:'0'});await settle();
 assert.equal(requests.length,3,'single replay uses the tab cache');
 assert.match(h.node('#neural-state').textContent,/分頁暫存重播/);
 click({action:'neural-stop'});
 vm.runInContext('openItem(1)',h.context);
 assert.match(detail.innerHTML,/class="primary" data-neural="1">▷ Cedar/);
 assert.match(detail.innerHTML,/data-speak="1">▷ 裝置朗讀/);
 click({neural:'1'});
 assert.equal(detail.open,false);
 assert.equal(requests[3].body.article_id,edition.articles[1].id);
 deliverTrack(Response.json({error:'provider_auth_failed'},{status:502}));await settle();
 assert.match(h.node('#neural-state').textContent,/API 金鑰/);
 click({neural:'1'});deliverTrack(wav('marin'));await settle();
 assert.match(h.node('#neural-state').textContent,/指定音色不符/);
 assert.equal(h.said.length,0);
 click({neural:'1'});deliverTrack(wav());await settle();
 assert.equal(requests.length,6);
 audio.onerror();click({neural:'1'});deliverTrack(wav());await settle();
 assert.equal(requests.length,7,'a decoding error evicts the clip');
 vm.runInContext("current().articles[1].speech_script+='更新。'",h.context);
 click({neural:'1'});deliverTrack(wav());await settle();
 assert.equal(requests.length,8,'a corrected script must be regenerated');
 const later=Date.now()+61000;
 h.context.Date=class extends Date{static now(){return later}};
 click({neural:'0'});deliverTrack(wav());await settle();
 assert.equal(requests.length,9,'expired clips must be regenerated');
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
 Object.assign(audio,{play:async()=>{played++;audio.paused=false;audio.onplaying?.()},pause(){audio.paused=true;audio.onpause?.()},load(){},removeAttribute(){}});
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

test('issue preload waits for actual playback, respects a paused handoff, and aborts on edition changes',async()=>{
 const edition=editions.at(-1);
 const h=clientHarness([edition]);
 const requests=[];
 const audio=h.node('#neural-audio');
 let plays=0;
 Object.assign(audio,{
  paused:true,
  async play(){this.paused=false;plays++;this.onplaying?.()},
  pause(){this.paused=true;this.onpause?.()},load(){},removeAttribute(){},
 });
 h.context.fetch=async(path,options)=>{
  if(path==='/api/editions')return Response.json({editions:[edition]});
  if(path==='/api/audio/status')return Response.json({ready:true,voice:'cedar'});
  const response=new Promise(resolve=>requests.push({signal:options.signal,finish:()=>resolve(new Response(new Uint8Array(48),{headers:{'Content-Type':'audio/wav','X-Audio-Voice':'cedar','X-Audio-Expires-At':String(Date.now()+60000)}}))}));
  return response;
 };
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 const click=dataset=>h.handlers.get('click')({target:{closest:()=>({dataset})}});
 vm.runInContext(await readFile('web/app.js','utf8'),h.context);await tick();
 click({action:'neural-play'});
 click({action:'pause'});
 requests[0].finish();await tick();
 assert.equal(plays,0);assert.equal(requests.length,1);
 assert.match(h.node('#neural-state').textContent,/按播放可續播/);
 click({action:'pause'});await tick();
 assert.equal(plays,1);assert.equal(requests.length,2);
 click({action:'pause'});
 assert.ok(audio.paused);assert.equal(requests.length,2);
 click({action:'pause'});await tick();
 assert.equal(plays,2);assert.equal(requests.length,2);
 audio.onended();await tick();
 click({action:'pause'});
 requests[1].finish();await tick();
 assert.equal(plays,2);assert.equal(requests.length,2);
 click({action:'pause'});await tick();
 assert.equal(plays,3);assert.equal(requests.length,3);
 click({edition:'morning'});
 assert.ok(requests[2].signal.aborted);
 requests[2].finish();await tick();
 assert.equal(plays,3);assert.equal(requests.length,3);
 assert.equal(h.node('#neural-player').hidden,true);
});

test('archive pagination retries the same cursor, merges once and keeps the selected issue playing',async()=>{
 const latest=editions.at(-1);
 const existing={...latest,id:'saved-edition',date:'2026-11-16',published_at:'2026-11-16T20:00:00+08:00'};
 const earlier={...existing,id:'older-edition',date:'2026-11-03',published_at:'2026-11-03T20:00:00+08:00'};
 const h=clientHarness();
 const paths=[];
 let returnPage;
 h.context.fetch=async path=>{
  paths.push(path);
  if(path==='/api/editions')return Response.json({editions:[latest,existing],next_before:'2026-11-04'});
  if(path==='/api/audio/status')return Response.json({ready:true,voice:'cedar'});
  if(path==='/api/audio')return new Response(new Uint8Array(48),{headers:{'Content-Type':'audio/wav','X-Audio-Voice':'cedar','X-Audio-Expires-At':String(Date.now()+60000)}});
  assert.equal(path,'/api/editions?before=2026-11-04');
  return new Promise(resolve=>{returnPage=resolve});
 };
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 const click=dataset=>h.handlers.get('click')({target:{closest:()=>({dataset})}});
 const audio=h.node('#neural-audio');
 Object.assign(audio,{play:async()=>{audio.paused=false},pause(){audio.paused=true},load(){},removeAttribute(){}});
 vm.runInContext(await readFile('web/app.js','utf8'),h.context);await tick();
 assert.match(h.node('#body').innerHTML,/載入較早期刊/);
 assert.equal(paths.some(path=>path.includes('?before=')),false);
 h.handlers.get('change')({target:{matches:()=>false,id:'edition-archive',value:existing.id}});
 click({neural:'0'});await tick();
 const playing=audio.src;
 assert.ok(playing);assert.equal(audio.paused,false);
 click({action:'older-editions'});click({action:'older-editions'});
 assert.equal(paths.filter(path=>path.includes('?before=')).length,1);
 returnPage(new Response('unavailable',{status:503}));await tick();
 assert.match(h.node('#body').innerHTML,/重試載入較早期刊/);
 assert.match(h.node('#body').innerHTML,/503/);
 click({action:'older-editions'});
 returnPage(Response.json({editions:[existing,earlier,earlier],next_before:null}));await tick();
 assert.equal(vm.runInContext('state.published.length',h.context),3);
 assert.equal(vm.runInContext('current().id',h.context),existing.id);
 assert.equal(audio.src,playing);assert.equal(audio.paused,false);
 assert.match(h.node('#body').innerHTML,/older-edition/);
 assert.doesNotMatch(h.node('#body').innerHTML,/data-action="older-editions"|503/);
 assert.equal(paths.filter(path=>path==='/api/audio').length,1);
});

test('home refresh publishes via a single POST, loads the due issue, and stops playback only on a switch',async()=>{
 const [morning,evening]=editions;
 const h=clientHarness();
 const audio=h.node('#neural-audio');
 Object.assign(audio,{play:async()=>{audio.paused=false},pause(){audio.paused=true},load(){},removeAttribute(){}});
 const calls=[];
 let releasePost;
 let listed=[morning];
 h.context.fetch=async(path,options={})=>{
  calls.push({path,options});
  if(path==='/api/editions')return Response.json({editions:listed});
  if(path==='/api/audio/status')return Response.json({ready:true,voice:'cedar'});
  if(path==='/api/audio')return new Response(new Uint8Array(48),{headers:{'Content-Type':'audio/wav','X-Audio-Voice':'cedar','X-Audio-Expires-At':String(Date.now()+60000)}});
  assert.equal(path,'/api/editions/refresh');
  return new Promise(resolve=>{releasePost=(status,issue)=>resolve(Response.json({status,edition:issue.edition,date:issue.date,edition_id:issue.id}))});
 };
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 const click=dataset=>h.handlers.get('click')({target:{closest:()=>({dataset})}});
 vm.runInContext(await readFile('web/app.js','utf8'),h.context);await tick();
 assert.match(h.node('#body').innerHTML,/data-action="refresh-edition"[^>]*>更新新聞/);
 click({neural:'0'});await tick();
 const firstAudio=audio.src;
 assert.ok(firstAudio);
 click({action:'refresh-edition'});click({action:'refresh-edition'});
 assert.match(h.node('#body').innerHTML,/disabled>更新中/);
 const posts=()=>calls.filter(c=>c.path==='/api/editions/refresh');
 assert.equal(posts().length,1);
 assert.equal(posts()[0].options.method,'POST');
 assert.equal(posts()[0].options.credentials,'same-origin');
 assert.equal(posts()[0].options.body,undefined);
 releasePost('already_published',morning);await tick();
 assert.equal(audio.src,firstAudio);assert.equal(audio.paused,false);
 assert.match(h.node('#body').innerHTML,/晨報 已是最新一期/);
 click({action:'refresh-edition'});listed=[evening];
 releasePost('published',evening);await tick();
 assert.equal(audio.paused,true);assert.equal(h.node('#neural-player').hidden,true);
 assert.equal(vm.runInContext('current().id',h.context),evening.id);
 assert.ok(vm.runInContext('state.published',h.context).some(e=>e.id===morning.id));
 assert.equal(calls.filter(c=>c.path==='/api/editions'&&c.options.cache==='no-store').length,3);
 assert.match(h.node('#body').innerHTML,/晚報 已發布，?共 9 則/);
});

test('home refresh on an empty or archived station reports recoverable outcomes and preserves prior news',async()=>{
 const [morning]=editions;
 const h=clientHarness();
 let listed=[];
 let outcome={status:'no_qualified_stories',unique_events:17,pending_review:4};
 let http=200;
 h.context.fetch=async path=>{
  if(path==='/api/editions')return Response.json({editions:listed});
  if(path==='/api/audio/status')return Response.json({ready:false});
  assert.equal(path,'/api/editions/refresh');
  return Response.json({date:morning.date,edition:morning.edition,...outcome},{status:http});
 };
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 const refresh=()=>vm.runInContext('refreshEdition()',h.context);
 vm.runInContext(await readFile('web/app.js','utf8'),h.context);await tick();
 assert.match(h.node('#body').innerHTML,/更新新聞/);
 await refresh();
 assert.match(h.node('#body').innerHTML,/role="status" aria-live="polite">共收集 17 則候選/);
 assert.match(h.node('#body').innerHTML,/4 則待核對/);
 listed=[morning];await vm.runInContext('loadEditions()',h.context);
 for(const [result,status,message] of [
  [{status:'in_progress'},202,/正在更新中/],
  [{status:'sources_unavailable'},200,/無法取得新聞來源/],
  [{error:'edition_store_unavailable'},503,/無法連上期刊庫/],
  [{status:'published',edition_id:'missing-issue'},200,/尚未回傳這一期/],
 ]){
  outcome=result;http=status;await refresh();
  assert.match(h.node('#body').innerHTML,message);
  assert.equal(vm.runInContext('current().id',h.context),morning.id);
  assert.ok(h.node('#list').innerHTML.includes(morning.articles[0].title));
 }
});

test('edition and saved readers show the canonical product intro and keep its official source separate from event evidence',async()=>{
 const issue=structuredClone(editions[0]);
 const a=issue.articles[0];
 const original=a.speech_script;
 const intro='示範產品負責設備管理。';
 a.product_context={intro,source_label:'原廠產品介紹',source_url:'https://docs.example/product?x=1&y=2'};
 a.speech_script=intro+original;
 const h=clientHarness([issue]);
 vm.runInContext(await readFile('web/app.js','utf8'),h.context);
 await new Promise(resolve=>setImmediate(resolve));
 const card=h.node('#list').innerHTML;
 assert.ok(card.indexOf(intro)>card.indexOf(a.title));
 assert.ok(card.indexOf(intro)<card.indexOf(a.facts[0]));
 assert.equal(card.split(intro).length,2);
 assert.doesNotMatch(card,/docs\.example/);
 vm.runInContext("state.saved=[{...current().articles[0],product_context:undefined,speech_script:'更新前口播'}];go('saved');openItem(0)",h.context);
 const detail=h.node('#detail').innerHTML;
 assert.match(detail,/原廠產品介紹 ↗/);
 assert.match(detail,/href="https:\/\/docs\.example\/product\?x=1&amp;y=2"/);
 assert.ok(detail.indexOf(intro)<detail.indexOf('發生什麼'));
 assert.equal(detail.split(intro).length,2);
 h.handlers.get('click')({target:{closest:()=>({dataset:{speak:'0'}})}});
 assert.equal(h.said[0].text,intro);
 vm.runInContext("const ctx=state.published[0].articles[0].product_context;ctx.intro='<b>內容</b>';ctx.source_label='<img>';openItem(0)",h.context);
 assert.match(h.node('#detail').innerHTML,/&lt;b&gt;內容&lt;\/b&gt;/);
 assert.match(h.node('#detail').innerHTML,/&lt;img&gt; ↗/);
 vm.runInContext("ctx.source_url='javascript:alert(1)';openItem(0)",h.context);
 assert.doesNotMatch(h.node('#detail').innerHTML,/javascript:|&lt;img&gt;/);
});

test('a revised upcoming script invalidates an already prepared clip in the same issue',async()=>{
 const issue={...editions[0],articles:editions[0].articles.slice(0,2)};
 const h=clientHarness();
 const ids=[];
 const audio=h.node('#neural-audio');
 Object.assign(audio,{play:async()=>{audio.onplaying?.()},pause(){},load(){},removeAttribute(){}});
 h.context.fetch=async(path,options)=>{
  if(path==='/api/editions')return Response.json({editions:[issue]});
  if(path==='/api/audio/status')return Response.json({voice:'cedar',ready:true});
  ids.push(JSON.parse(options.body).article_id);
  return new Response(new Uint8Array(48),{headers:{'Content-Type':'audio/wav','X-Audio-Voice':'cedar','X-Audio-Expires-At':String(Date.now()+60000)}});
 };
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 vm.runInContext(await readFile('web/app.js','utf8'),h.context);await tick();
 h.handlers.get('click')({target:{closest:()=>({dataset:{action:'neural-play'}})}});
 await tick();
 assert.deepEqual(ids,issue.articles.map(a=>a.id));
 vm.runInContext("current().articles[1].speech_script='新增產品用途。'+current().articles[1].speech_script",h.context);
 audio.onended();await tick();
 assert.deepEqual(ids,[issue.articles[0].id,issue.articles[1].id,issue.articles[1].id]);
});

test('terminal media errors release just the owned session and stale callbacks cannot clear new audio',async()=>{
 const h=clientHarness([editions[0]]);
 const actions=new Map();
 const session={metadata:{title:'先前狀態'},playbackState:'paused',setActionHandler(name,fn){actions.set(name,fn)}};
 let canceledSpeech=0;
 h.context.speechSynthesis.cancel=()=>{canceledSpeech++};
 h.context.navigator.mediaSession=session;
 h.context.MediaMetadata=class{constructor(data){Object.assign(this,data)}};
 h.context.fetch=async path=>{
  if(path==='/api/editions')return Response.json({editions:[editions[0]]});
  if(path==='/api/audio/status')return Response.json({ready:true,voice:'cedar'});
  return new Response(new Uint8Array(48),{headers:{'Content-Type':'audio/wav','X-Audio-Voice':'cedar','X-Audio-Expires-At':String(Date.now()+60000)}});
 };
 const audio=h.node('#neural-audio');
 let released=0;
 Object.assign(audio,{async play(){this.paused=false;this.onplaying?.()},pause(){this.paused=true},load(){released++},removeAttribute(name){delete this[name]}});
 const click=dataset=>h.handlers.get('click')({target:{closest:()=>({dataset})}});
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 vm.runInContext(await readFile('web/app.js','utf8'),h.context);await tick();
 click({action:'stop'});
 assert.deepEqual(session.metadata,{title:'先前狀態'});
 assert.equal(actions.size,0);assert.equal(canceledSpeech,0);
 click({neural:'0'});await tick();
 assert.equal(session.playbackState,'playing');
 const oldError=audio.onerror;
 const oldTimeUpdate=audio.ontimeupdate;
 oldError();
 assert.equal(released,1);assert.equal(audio.src,undefined);
 assert.equal(audio.ontimeupdate,null);assert.equal(audio.onplaying,null);
 assert.equal(session.metadata,null);assert.equal(session.playbackState,'none');
 assert.deepEqual([...actions.values()],[null,null,null,null]);
 assert.match(h.node('#neural-state').textContent,/無法播放/);
 click({neural:'1'});await tick();
 const url=audio.src;oldTimeUpdate();oldError();
 assert.equal(audio.src,url);assert.equal(session.playbackState,'playing');
 actions.get('stop')();
 assert.equal(session.playbackState,'none');assert.equal(audio.src,undefined);
 session.metadata={title:'其他播放器'};
 audio.play=async()=>{throw Object.assign(Error('invalid source'),{name:'NotSupportedError'})};
 click({neural:'1'});await tick();
 assert.equal(audio.src,undefined);
 assert.deepEqual(session.metadata,{title:'其他播放器'},'a session that never played did not own the controls');
 assert.equal(canceledSpeech,0);
});
