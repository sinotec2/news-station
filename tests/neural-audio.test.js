import test from 'node:test';
import assert from 'node:assert/strict';
import {editions} from './fixtures/editions.js';
import {PRODUCT_PROFILES} from '../worker/product-profiles.js';
import {generateNeuralAudio,prepareNeuralArticle,pcmToWav,neuralStatus,handleNeuralAudio,AUDIO_TTL_MS,NEURAL_MODEL} from '../worker/neural-audio.js';
const article=editions[0].articles[0];
function connection(transcript,confirmedVoice='cedar',pcm=new Uint8Array([0,0,64,0])){
 const sent=[],handlers={};
 let closed=false,requested='';
 const emit=data=>handlers.message?.({data:JSON.stringify(data)});
 const socket={
  addEventListener(type,fn){handlers[type]=fn},
  accept(){queueMicrotask(()=>emit({type:'session.created'}))},
  send(raw){
   const data=JSON.parse(raw);
   sent.push(data);
   if(data.type==='session.update')queueMicrotask(()=>emit({type:'session.updated',session:{audio:{output:{voice:confirmedVoice}}}}));
   if(data.type==='conversation.item.create')requested=data.item.content[0].text;
   if(data.type==='response.create')queueMicrotask(()=>{
    emit({type:'response.output_audio.delta',delta:Buffer.from(pcm).toString('base64')});
    const spoken=typeof transcript==='function'?transcript(requested):transcript??requested;
    emit({type:'response.output_audio_transcript.done',transcript:spoken});
    emit({type:'response.done',response:{status:'completed'}});
   });
  },
  close(){closed=true}
 };
 return {sent,socket,isClosed:()=>closed};
}

test('new provider uses supported Realtime model and refuses unconfigured audio',async()=>{assert.equal(NEURAL_MODEL,'gpt-realtime-2.1-mini');assert.equal(neuralStatus({}).voice,'cedar');assert.equal(neuralStatus({}).ready,false);await assert.rejects(generateNeuralAudio(article.speech_script,{}),e=>e.code==='not_configured');assert.equal(neuralStatus({OPENAI_API_KEY:'test'}).ready,true)});
test('generates one complete story and checks narrated words before returning audio',async()=>{const c=connection();const result=await generateNeuralAudio(article.speech_script,{apiKey:'test-only',connect:async()=>c.socket});assert.equal(c.sent[0].session.model,NEURAL_MODEL);assert.equal(c.sent[0].session.audio.output.voice,'cedar');assert.deepEqual(c.sent[0].session.audio.output.format,{type:'audio/pcm',rate:24000});assert.equal(c.sent[1].item.content[0].text,article.speech_script);assert.match(new TextDecoder().decode(result.audio.slice(0,4)),/RIFF/);assert.equal(new DataView(result.audio.buffer).getUint32(24,true),24000);assert.equal(result.transcript,article.speech_script);assert.ok(c.isClosed())});
test('only starts synthesis when OpenAI confirms Cedar for the session',async()=>{
 const c=connection(article.speech_script,'marin');
 await assert.rejects(generateNeuralAudio(article.speech_script,{apiKey:'test-only',connect:async()=>c.socket}),e=>e.code==='provider_voice_unconfirmed');
 assert.deepEqual(c.sent.map(message=>message.type),['session.update']);
 assert.ok(c.isClosed());
});
test('changed narration is rejected rather than quietly changing the news',async()=>{const c=connection(article.speech_script+'現在已經完全安全。');await assert.rejects(generateNeuralAudio(article.speech_script,{apiKey:'test-only',connect:async()=>c.socket}),e=>e.code==='narration_mismatch');assert.ok(c.isClosed());assert.throws(()=>pcmToWav([new Uint8Array(3)]),e=>e.code==='invalid_audio')});
test('Cedar sends the reviewed product introduction verbatim and keeps the advisory number and due date',async()=>{
 const profile=PRODUCT_PROFILES.find(entry=>entry.id==='sap-netweaver');
 const advisory='這筆公告的漏洞編號是 CVE-2025-42884，目錄列出的處置期限是2026年11月23日。';
 const script=profile.intro+advisory;
 const styled=script.replace('SAP','Ｓ．Ａ．Ｐ．').replace('CVE-','C V E – ');
 const session=connection(styled);
 const result=await generateNeuralAudio(script,{apiKey:'fixture-only',connect:async()=>session.socket});
 assert.equal(session.sent[1].item.content[0].text,script);
 assert.equal(result.transcript,styled);
 for(const changed of [advisory,script.replace('SAP','IBM'),script.replace('42884','42848'),script.replace('23日','24日')]){
  const wrong=connection(changed);
  await assert.rejects(generateNeuralAudio(script,{apiKey:'fixture-only',connect:async()=>wrong.socket}),e=>e.code==='narration_mismatch');
 }
});
test('shared store reuses output, expires it after 72 hours, and keys corrections separately',async()=>{const objects=new Map();let generated=0,deletions=0;const now=Date.now();const store={async get(key){const object=objects.get(key);return object?{customMetadata:object.meta,arrayBuffer:async()=>object.audio}:null},async put(key,audio,options){objects.set(key,{audio,meta:options.customMetadata})},async delete(key){deletions++;objects.delete(key)}};const env={OPENAI_API_KEY:'test-only',AUDIO_BUCKET:store};const generate=async()=>{generated++;return {audio:new Uint8Array([1,2,3,4])}};
 const one=await prepareNeuralArticle(article,env,{generate,now});assert.equal(one.cached,false);assert.equal(one.expires_at,now+AUDIO_TTL_MS);
 const two=await prepareNeuralArticle(article,env,{generate,now:now+1});assert.equal(two.cached,true);assert.equal(generated,1);
 await prepareNeuralArticle(article,env,{generate,now:now+AUDIO_TTL_MS+1});assert.equal(generated,2);assert.equal(deletions,1);
 const corrected=await prepareNeuralArticle({...article,correction_history:[{correction:'測試修訂'}]},env,{generate,now:now+AUDIO_TTL_MS+2});assert.notEqual(corrected.key,one.key);assert.equal(generated,3);
});
test('audio route accepts only published IDs from same-origin POST, never caller scripts or secrets',async()=>{const origin='https://news.test';const request=body=>new Request(origin+'/api/audio',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});let r=await handleNeuralAudio(request({edition_id:editions[0].id,article_id:article.id}),{},editions);assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:'not_configured'});r=await handleNeuralAudio(request({edition_id:editions[0].id,article_id:article.id,script:'Caller content'}),{OPENAI_API_KEY:'secret-never-returned'},editions);assert.equal(r.status,400);assert.doesNotMatch(await r.text(),/secret-never-returned/);r=await handleNeuralAudio(new Request(origin+'/api/audio',{method:'POST',headers:{Origin:'https://elsewhere.test'}}),{},editions);assert.equal(r.status,403);r=await handleNeuralAudio(new Request(origin+'/api/audio/status'),{OPENAI_API_KEY:'secret-never-returned'},editions);assert.equal((await r.json()).ready,true)});

test('whole-edition requests narrate the published date, count and order and close once',async t=>{
 const evening=editions.find(entry=>entry.date==='2026-11-18'&&entry.edition==='evening');
 const singleEdition={...editions[0],articles:[article]};
 const sessions=[];
 t.mock.method(globalThis,'fetch',async()=>{
  const session=connection();
  sessions.push(session);
  return {webSocket:session.socket};
 });
 async function request(edition,index,mode){
  const story=edition.articles[index];
  const message=new Request('https://news.test/api/audio',{method:'POST',headers:{Origin:'https://news.test','Content-Type':'application/json'},
   body:JSON.stringify({edition_id:edition.id,article_id:story.id,mode})});
  return handleNeuralAudio(message,{OPENAI_API_KEY:'test-only'},[edition]);
 }
 const first=evening.articles[0],middle=evening.articles[1],last=evening.articles.at(-1);
 for(const [edition,index,mode,expected] of [
  [evening,0,'edition','歡迎收聽十一月十八日的晚報。本期共有九則新聞。\n第一則，'+first.speech_script],
  [evening,1,'edition','第二則，'+middle.speech_script],
  [evening,8,'edition','第九則，'+last.speech_script+'\n以上是本期晚報，謝謝收聽。'],
  [singleEdition,0,'edition','歡迎收聽十一月十七日的晨報。本期共有一則新聞。\n第一則，'+article.speech_script+'\n以上是本期晨報，謝謝收聽。'],
  [evening,8,undefined,last.speech_script]
 ]){
  const result=await request(edition,index,mode);
  assert.equal(result.status,200);
  assert.equal(result.headers.get('X-Audio-Voice'),'cedar');
  const generated=sessions.at(-1).sent.find(message=>message.type==='conversation.item.create');
  assert.equal(generated.item.content[0].text,expected);
 }
 const rejected=await request(evening,0,'caller_supplied_intro');
 assert.equal(rejected.status,400);
 assert.equal(sessions.length,5);
});

test('a single, a numbered story and a revised issue produce separate audio cache entries',async()=>{
 const twoStories={...editions[0],articles:editions[0].articles.slice(0,2)};
 const oneStory={...twoStories,articles:[article]};
 const options={generate:async()=>({audio:new Uint8Array([1,2])})};
 const env={OPENAI_API_KEY:'test-only'};
 const single=await prepareNeuralArticle(article,env,options);
 const first=await prepareNeuralArticle(article,env,{...options,edition:twoStories});
 const only=await prepareNeuralArticle(article,env,{...options,edition:oneStory});
 const repeat=await prepareNeuralArticle(article,env,{...options,edition:twoStories});
 assert.equal(new Set([single.key,first.key,only.key]).size,3);
 assert.equal(first.key,repeat.key);
});

test('long scripts are read in order and merged into one WAV after every part passes verification',async()=>{
 const script=article.speech_script.repeat(30);
 const sessions=[];
 const options={apiKey:'test-only',connect:async()=>{
  const session=connection();
  sessions.push(session);
  return session.socket;
 }};
 const result=await generateNeuralAudio(script,options);
 const parts=sessions.map(s=>s.sent.find(m=>m.type==='conversation.item.create').item.content[0].text);
 assert.ok(sessions.length>1&&sessions.every(s=>s.isClosed()));
 assert.ok(parts.every(p=>p.length<=550));
 assert.equal(parts.join(''),script);
 assert.equal(result.transcript,script);
 assert.equal(result.audio.byteLength,44+4*parts.length);
 let count=0;
 await assert.rejects(generateNeuralAudio(script,{...options,connect:async()=>connection(++count===2?'漏讀事實':undefined).socket}),e=>e.code==='narration_mismatch');
 assert.equal(count,2);
});

test('only long quiet edges are shortened, preserving internal pauses and soft margins',async()=>{
 const sound=new Int16Array(24020);
 sound[7800]=96;
 sound[8200]=80;
 sound[8580]=105;
 const pcm=new Uint8Array(sound.buffer);
 const session=connection(undefined,'cedar',pcm);
 const result=await generateNeuralAudio(article.speech_script,{apiKey:'test-only',connect:async()=>session.socket});
 const expected=sound.slice(7800-2400,8580+1+3600);
 assert.deepEqual(result.audio.slice(44),new Uint8Array(expected.buffer));
 assert.equal(new DataView(result.audio.buffer).getUint32(40,true),expected.byteLength);
});

test('a repeated 年 in a framed story recovers from exact Cedar fragments without the failed audio',async t=>{
 const story={...article,speech_script:'示範測站計畫運作到二〇三〇年底。觀測資料將持續公布，研究人員可以查閱各地站點的水溫紀錄。'};
 const edition={...editions[0],articles:[story,editions[0].articles[1]]};
 const sessions=[];
 t.mock.method(globalThis,'fetch',async()=>{
  const n=sessions.length+1;
  const session=connection(n===1?text=>text.replace('年底','年年底'):undefined,'cedar',new Uint8Array([n,1]));
  sessions.push(session);
  return {webSocket:session.socket};
 });
 const origin='https://news.test';
 const request=new Request(origin+'/api/audio',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
  body:JSON.stringify({edition_id:edition.id,article_id:story.id,mode:'edition'})});
 const response=await handleNeuralAudio(request,{OPENAI_API_KEY:'test-only'},[edition]);
 assert.equal(response.status,200);
 const [initial,...recovery]=sessions.map(s=>s.sent.find(m=>m.type==='conversation.item.create').item.content[0].text);
 assert.deepEqual(recovery,[
  '歡迎收聽十一月十七日的晨報。本期共有兩則新聞。\n',
  '第一則，示範測站計畫運作到二〇三〇年底。',
  '觀測資料將持續公布，研究人員可以查閱各地站點的水溫紀錄。'
 ]);
 assert.equal(recovery.join(''),initial);
 assert.equal(sessions.length,4);
 assert.ok(sessions.every(s=>s.isClosed()));
 assert.notEqual(sessions[1].sent[0].session.instructions,sessions[0].sent[0].session.instructions);
 const wav=new Uint8Array(await response.arrayBuffer());
 assert.deepEqual(wav.slice(44),new Uint8Array([2,1,3,1,4,1]));
});

test('recovery stops on the first failed fragment and skips quota, voice, and single-story failures',async()=>{
 const script='歡迎收聽十一月十七日的晨報。本期共有兩則新聞。\n第一則，'+article.speech_script;
 let requests=0;
 const options={editionMode:true,apiKey:'test-only',connect:async()=>{
  requests++;
  return connection(requests===1||requests===3?'持續多念了一個字':undefined).socket;
 }};
 await assert.rejects(generateNeuralAudio(script,options),e=>e.code==='narration_mismatch');
 assert.equal(requests,3);
 for(const [mode,code] of [[true,'provider_quota_exceeded'],[true,'provider_voice_unconfirmed'],[false,'narration_mismatch']]){
  requests=0;
  await assert.rejects(generateNeuralAudio(script,{...options,editionMode:mode,connect:async()=>{
   requests++;
   if(code==='provider_quota_exceeded')throw Object.assign(Error('quota'),{code});
   return connection('偏離口播稿',code==='provider_voice_unconfirmed'?'marin':'cedar').socket;
  }}),e=>e.code===code);
  assert.equal(requests,1);
 }
});

test('a long story gets at most one recovery pass across its original segments',async()=>{
 const script=('長'.repeat(360)+'。').repeat(4);
 let requests=0;
 await assert.rejects(generateNeuralAudio(script,{editionMode:true,apiKey:'test-only',connect:async()=>{
  requests++;
  return connection(requests===2?undefined:'未依原稿').socket;
 }}),e=>e.code==='narration_mismatch');
 assert.equal(requests,3);
});
