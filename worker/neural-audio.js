// Server-side provider adapter. Never expose an API key or accept arbitrary browser text.
export const NEURAL_MODEL='gpt-realtime-2.1-mini';
export const NEURAL_VOICE='cedar';
export const AUDIO_TTL_MS=72*60*60*1000;
const AUDIO_BYTES_LIMIT=12*1024*1024;
export const NARRATION_INSTRUCTIONS='你是台灣繁體中文新聞播報員。使用自然台灣華語，沉穩清楚，中等語速。按語意詞組連貫發音，句內短停頓，換主題時略停；對數字與關鍵限制自然加重語氣，不要逐字念、每句重新起音或誇張演戲。英文專有名詞保持清楚。唯一任務是逐字朗讀使用者提供的口播稿，不增刪、不回答、不摘要、不解釋。不省略草案、未證實等限定語。';
function audioProblem(code,status=502){const error=new Error(code);error.code=code;error.status=status;return error}
function providerProblem(status, code, fallback){
 if(code==='insufficient_quota'||code==='billing_hard_limit_reached')return audioProblem('provider_quota_exceeded',503);
 if(status===429||code==='rate_limit_exceeded')return audioProblem('provider_rate_limited',429);
 if(status===401||code==='invalid_api_key')return audioProblem('provider_auth_failed');
 if(status===403||status===404||code==='model_not_found')return audioProblem('provider_model_unavailable');
 return audioProblem(fallback);
}
export function normalizedTranscript(text){return String(text||'').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\p{S}\s]/gu,'')}
export function pcmToWav(chunks){
 const size=chunks.reduce((n,c)=>n+c.byteLength,0);if(!size||size%2||size>AUDIO_BYTES_LIMIT)throw audioProblem('invalid_audio');
 const wav=new Uint8Array(44+size),view=new DataView(wav.buffer);const ascii=(offset,s)=>{for(let i=0;i<s.length;i++)wav[offset+i]=s.charCodeAt(i)};
 ascii(0,'RIFF');view.setUint32(4,36+size,true);ascii(8,'WAVE');ascii(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,24000,true);view.setUint32(28,48000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);ascii(36,'data');view.setUint32(40,size,true);let offset=44;for(const c of chunks){wav.set(c,offset);offset+=c.byteLength}return wav;
}
export function neuralStatus(env={}){return {provider:'openai',model:NEURAL_MODEL,voice:NEURAL_VOICE,ready:!!env.OPENAI_API_KEY,storage:env.AUDIO_BUCKET?'shared_object_store':'request_only',retention_hours:72,ai_generated:true}}
export async function generateNeuralAudio(script,{apiKey,connect,timeoutMs=90000}={}){
 if(!apiKey)throw audioProblem('not_configured',503);
 if(typeof script!=='string'||script.length<20||script.length>2500||/https?:\/\/|```/.test(script))throw audioProblem('invalid_script',400);
 const open=connect|| (async()=>{
  const response=await fetch('https://api.openai.com/v1/realtime?model='+NEURAL_MODEL,{headers:{Authorization:'Bearer '+apiKey,Upgrade:'websocket'},signal:AbortSignal.timeout(15000)});
  if(response.webSocket)return response.webSocket;
  const problem=await response.json().catch(()=>null);
  throw providerProblem(response.status,problem?.error?.code,'provider_connection_failed');
 });
 const socket=await open();
 return new Promise((resolve,reject)=>{
  let finished=false,started=false,sessionConfigured=false,transcript='',bytes=0;const chunks=[];
  const timer=setTimeout(()=>finish(audioProblem('provider_timeout',504)),timeoutMs);
  function finish(error,result){if(finished)return;finished=true;clearTimeout(timer);try{socket.close(1000,'done')}catch{}if(error)reject(error);else resolve(result)}
  socket.addEventListener('error',()=>finish(audioProblem('provider_connection_failed')));
  socket.addEventListener('close',()=>{if(!finished)finish(audioProblem('provider_disconnected'))});
  socket.addEventListener('message',event=>{
   if(finished)return;
   try{
    const data=JSON.parse(event.data);
    if(data.type==='error')return finish(providerProblem(null,data.error?.code,'provider_rejected_request'));
    if(data.type==='session.created'&&!sessionConfigured){sessionConfigured=true;socket.send(JSON.stringify({type:'session.update',session:{type:'realtime',model:NEURAL_MODEL,instructions:NARRATION_INSTRUCTIONS,output_modalities:['audio'],audio:{output:{voice:NEURAL_VOICE,format:{type:'audio/pcm',rate:24000}}}}}));}
    else if(data.type==='session.updated'&&!started){
     if(data.session?.audio?.output?.voice!==NEURAL_VOICE)return finish(audioProblem('provider_voice_unconfirmed'));
     started=true;socket.send(JSON.stringify({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text:script}]}}));socket.send(JSON.stringify({type:'response.create',response:{output_modalities:['audio']}}));
    }
    else if(data.type==='response.output_audio.delta'){const binary=atob(data.delta);bytes+=binary.length;if(bytes>AUDIO_BYTES_LIMIT)return finish(audioProblem('audio_too_large'));chunks.push(Uint8Array.from(binary,c=>c.charCodeAt(0)));}
    else if(data.type==='response.output_audio_transcript.delta')transcript+=data.delta;
    else if(data.type==='response.output_audio_transcript.done')transcript=data.transcript;
    else if(data.type==='response.done'){
     if(data.response?.status!=='completed')return finish(providerProblem(null,data.response?.status_details?.error?.code,'generation_incomplete'));
     if(normalizedTranscript(transcript)!==normalizedTranscript(script))return finish(audioProblem('narration_mismatch'));
     finish(null,{audio:pcmToWav(chunks),transcript,format:'audio/wav'});
    }
   }catch(error){finish(error.code?error:audioProblem('invalid_provider_response'))}
  });
  try{socket.accept()}catch{finish(audioProblem('provider_connection_failed'))}
 });
}
export async function audioFingerprint(article){const data=JSON.stringify({id:article.id,script:article.speech_script,verified_at:article.verified_at,corrections:article.correction_history,model:NEURAL_MODEL,voice:NEURAL_VOICE,instructions:NARRATION_INSTRUCTIONS});const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data));return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('')}
export async function prepareNeuralArticle(article,env,{generate=generateNeuralAudio,now=Date.now()}={}){
 if(article?.status!=='edited'||!article.speech_script)throw audioProblem('article_not_published',404);
 if(!env?.OPENAI_API_KEY)throw audioProblem('not_configured',503);
 const key='news-audio/'+await audioFingerprint(article)+'.wav';const store=env.AUDIO_BUCKET;
 if(store){const cached=await store.get(key);if(cached){const expires=Number(cached.customMetadata?.expires_at);if(expires>now&&expires-now<=AUDIO_TTL_MS)return {audio:await cached.arrayBuffer(),expires_at:expires,cached:true,key};await store.delete(key)}}
 const result=await generate(article.speech_script,{apiKey:env.OPENAI_API_KEY});const expires=now+AUDIO_TTL_MS;
 if(store)await store.put(key,result.audio,{httpMetadata:{contentType:'audio/wav',cacheControl:'private, no-store'},customMetadata:{expires_at:String(expires),article_id:article.id}});
 return {audio:result.audio,expires_at:expires,cached:false,key};
}
export async function handleNeuralAudio(request,env,editions){
 const url=new URL(request.url);
 if(url.pathname==='/api/audio/status')return Response.json(neuralStatus(env),{headers:{'Cache-Control':'private, no-store'}});
 if(request.method!=='POST')return Response.json({error:'method_not_allowed'},{status:405,headers:{Allow:'POST'}});
 if(request.headers.get('Origin')!==url.origin)return Response.json({error:'origin_rejected'},{status:403});
 if(!request.headers.get('Content-Type')?.includes('application/json'))return Response.json({error:'json_required'},{status:415});
 try{
  const body=await request.text();if(body.length>2048)throw audioProblem('request_too_large',413);
  const input=JSON.parse(body);if(Object.keys(input).some(k=>!['edition_id','article_id'].includes(k)))throw audioProblem('unexpected_fields',400);
  const edition=editions.find(e=>e.id===input.edition_id&&Date.parse(e.published_at)<=Date.now());const article=edition?.articles.find(a=>a.id===input.article_id);if(!article)throw audioProblem('article_not_published',404);
  const result=await prepareNeuralArticle(article,env);
  return new Response(result.audio,{headers:{'Content-Type':'audio/wav','Cache-Control':'private, no-store','X-Audio-Voice':NEURAL_VOICE,'X-Audio-Expires-At':String(result.expires_at),'X-Audio-Cache':result.cached?'hit':'miss','X-AI-Generated':'true','X-Content-Type-Options':'nosniff'}});
 }catch(error){const code=error instanceof SyntaxError?'invalid_json':error.code||'audio_service_unavailable';return Response.json({error:code},{status:error instanceof SyntaxError?400:(error.status||502),headers:{'Cache-Control':'private, no-store'}})}
}
