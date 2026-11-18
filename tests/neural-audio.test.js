import test from 'node:test';
import assert from 'node:assert/strict';
import {editions} from './fixtures/editions.js';
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
    emit({type:'response.output_audio_transcript.done',transcript:transcript??requested});
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
