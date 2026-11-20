import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {editions} from './fixtures/editions.js';
import {clientHarness} from './fixtures/client-harness.js';

const client = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function clip() {
  return new Response(new Uint8Array(48), {headers:{
    'Content-Type':'audio/wav', 'X-Audio-Voice':'cedar', 'X-Audio-Expires-At':String(Date.now()+60000),
  }});
}

// Browsers retain the selected media resource after removing src until load() runs.
// Media Session owns independent OS action handlers which can already be queued.
async function phone({holdSecond=false}={}) {
  const issue = {...editions.at(-1),articles:editions.at(-1).articles.slice(0,2)};
  const h = clientHarness([issue]);
  const document = h.context.document;
  const pageEvents = new Map(), osActions = new Map(), requests = [], allocated = new Set();
  const mediaSession = {metadata:null, playbackState:'none',
    setActionHandler(action,fn){if(fn)osActions.set(action,fn);else osActions.delete(action)},
    setPositionState(){},
  };
  const audioSession = {type:'auto'};
  const local = h.node('#neural-audio');
  let attr = '', seq=0;
  Object.defineProperty(local,'src',{
    get(){return attr},
    set(value){attr=value;this.currentSrc=value;this.ended=false;this.currentTime=0;this.readyState=4},
  });
  Object.assign(local,{
    currentSrc:'', currentTime:0, duration:19, readyState:0, ended:false, paused:true, plays:0,
    removeAttribute(name){if(name==='src')attr=''},
    getAttribute(name){return name==='src'&&attr?attr:null},
    hasAttribute(name){return name==='src'&&Boolean(attr)},
    load(){this.currentSrc=attr;this.currentTime=0;this.paused=true;this.ended=false;this.readyState=attr?4:0},
    async play(){
      this.plays++;
      if(!this.currentSrc)throw Error('The audio element has no playable source');
      this.paused=false;this.ended=false;this.onplaying?.();
    },
    pause(){const playing=!this.paused;this.paused=true;if(playing)this.onpause?.()},
    finish(){this.currentTime=this.duration;this.ended=true;this.paused=true;this.onpause?.();this.onended?.()},
  });
  class TrackURL extends URL {
    static createObjectURL(){const value='blob:station/'+(++seq);allocated.add(value);return value}
    static revokeObjectURL(value){allocated.delete(value)}
  }
  h.context.URL=TrackURL;
  h.context.MediaMetadata=class{constructor(fields){Object.assign(this,fields)}};
  Object.assign(h.context.navigator,{mediaSession,audioSession});
  h.context.window.addEventListener=(name,fn)=>pageEvents.set(name,fn);
  document.visibilityState='visible';
  h.context.fetch=async (path, options)=>{
    if(path==='/api/editions')return Response.json({editions:[issue]});
    if(path==='/api/audio/status')return Response.json({ready:true,voice:'cedar'});
    assert.equal(path,'/api/audio');
    const item={signal:options.signal};requests.push(item);
    if(holdSecond&&requests.length===2)return new Promise(resolve=>{item.deliver=()=>resolve(clip())});
    return clip();
  };
  const click=dataset=>h.handlers.get('click')({target:{closest:()=>({dataset})}});
  function visibility(state){
    document.visibilityState=state;
    h.handlers.get('visibilitychange')?.({type:'visibilitychange'});
  }
  vm.runInContext(client,h.context);
  await tick();
  return {local,mediaSession,audioSession,osActions,allocated,requests,click,visibility,pageEvents};
}

function handedBack(device) {
  const {local,mediaSession,audioSession,osActions,allocated} = device;
  assert.equal(local.paused,true);
  assert.equal(local.currentSrc,'','reset the selected media resource');
  assert.equal(local.readyState,0);
  assert.equal(local.getAttribute('src'),null);
  assert.equal(allocated.size,0,'no live clip URL');
  assert.equal(mediaSession.metadata,null);
  assert.equal(mediaSession.playbackState,'none');
  assert.deepEqual([...osActions.keys()],[]);
  assert.equal(audioSession.type,'auto');
}

test('finishing the last Cedar story releases the media element and all lock-screen actions',async()=>{
  const d=await phone();
  d.click({action:'neural-play'});await tick();
  assert.equal(d.local.plays,1);
  assert.ok(d.mediaSession.metadata?.title);
  d.local.finish();await tick();
  assert.equal(d.local.plays,2,'second story starts without forfeiting the edition');
  const stalePlay=d.osActions.get('play'),staleEnd=d.local.onended;
  assert.equal(typeof stalePlay,'function');
  d.local.finish();await tick();
  handedBack(d);
  d.visibility('hidden');d.visibility('visible');
  await stalePlay();staleEnd();await tick();
  assert.equal(d.local.plays,2,'late OS events and unlocking must not reclaim audio');
  assert.equal(d.requests.length,2);
  handedBack(d);
});

test('stop while hidden cancels preload, ignores a late clip, and fences earlier OS controls from a later session',async()=>{
  const d=await phone({holdSecond:true});
  d.click({action:'neural-play'});await tick();
  assert.equal(d.requests.length,2,'first story is playing and a second is being prepared');
  const stalePlay=d.osActions.get('play'),stalePause=d.osActions.get('pause'),staleEnd=d.local.onended;
  assert.equal(typeof stalePlay,'function');
  d.visibility('hidden');
  d.click({action:'neural-stop'});
  assert.ok(d.requests[1].signal.aborted);
  d.requests[1].deliver();await tick();
  handedBack(d);
  d.visibility('visible');await stalePlay();staleEnd();await tick();
  assert.equal(d.local.plays,1);
  d.click({neural:'0'});await tick();
  assert.equal(d.local.plays,2);
  await stalePause();await stalePlay();staleEnd();await tick();
  assert.equal(d.local.plays,2);
  assert.equal(d.local.paused,false);
  d.click({action:'neural-stop'});
  handedBack(d);
});

test('a foreground return respects an OS pause and pagehide gives up playback before a cached page can return',async()=>{
  const d=await phone();
  d.click({neural:'0'});await tick();
  const playCount=d.local.plays;
  d.visibility('hidden');
  assert.equal(d.local.paused,false,'locking the screen alone should not end the news');
  d.local.pause();
  d.visibility('visible');await tick();
  assert.equal(d.local.paused,true);
  assert.equal(d.local.plays,playCount);
  const stalePlay=d.osActions.get('play');
  assert.equal(typeof stalePlay,'function');
  const hide=d.pageEvents.get('pagehide');
  assert.equal(typeof hide,'function');
  hide({type:'pagehide',persisted:true});
  handedBack(d);
  d.pageEvents.get('pageshow')?.({type:'pageshow',persisted:true});
  await stalePlay();await tick();
  assert.equal(d.local.plays,playCount);
});
