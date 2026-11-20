import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {once} from 'node:events';
import {createPreviewServer} from '../scripts/preview.mjs';

async function localPreview(t,options){
  const server=createPreviewServer(options).listen(0,'127.0.0.1');
  await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return function send({path='/api/editions/refresh',method='POST',headers={},body}={}){
    return new Promise((resolve,reject)=>{
      const req=request(origin+path,{method,headers:{Origin:origin,...headers},agent:false},res=>{
        let text='';
        res.setEncoding('utf8').on('data',chunk=>{text+=chunk});
        res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(text)}));
      });
      req.on('error',reject);
      req.end(body);
    });
  };
}

test('preview accepts one empty same-origin refresh and serves the newly written release',async t=>{
  const {promise,resolve}=Promise.withResolvers();
  const started=Promise.withResolvers();
  let updates=0,builds=0,read=false;
  const send=await localPreview(t,{
    now:()=>Date.parse('2026-11-20T06:59:59+08:00'),
    refresh:async({date,edition})=>{
      updates++;
      assert.deepEqual({date,edition},{date:'2026-11-19',edition:'evening'});
      started.resolve();
      await promise;
      return {status:'published',edition_id:'local-news',stories:3,selection_file:'private/path'};
    },
    getApplication:async()=>{
      builds++;
      return {fetch:async(req,env)=>{
        assert.deepEqual(env,{});
        assert.equal(new URL(req.url).pathname,'/api/editions');
        read=true;
        return Response.json({editions:[{id:'local-news',articles:[{},{},{}],published_at:'2026-11-19T16:31:00+08:00'}]});
      }};
    }
  });
  const first=send();
  await started.promise;
  try{
    const concurrent=await send();
    assert.equal(concurrent.status,202);
    assert.equal(concurrent.data.status,'in_progress');
    assert.equal(concurrent.data.edition,'evening');
    assert.equal(updates,1);
  }finally{resolve()}
  const done=await first;
  assert.equal(done.status,200);
  assert.equal(done.data.edition_id,'local-news');
  assert.equal(done.data.stories,3);
  assert.equal(done.data.selection_file,undefined);
  assert.equal(builds,1);
  const page=await send({method:'GET',path:'/api/editions'});
  assert.equal(page.data.editions[0].id,'local-news');
  assert.equal(done.data.published_at,page.data.editions[0].published_at);
  assert.equal(read,true);
});

test('loopback host, origin, method and input guards reject requests before any local work',async t=>{
  const send=await localPreview(t,{getApplication:assert.fail,refresh:assert.fail});
  for(const [options,expected] of [
    [{headers:{Host:'reader.example'}},403],[{headers:{Origin:'null'}},403],
    [{headers:{Origin:'https://reader.example'}},403],[{headers:{'Sec-Fetch-Site':'cross-site'}},403],
    [{method:'GET'},405],[{path:'/api/editions/publish'},405],[{path:'/api/editions/refresh?date=2040-01-01'},400],
    [{body:'{}'},400],[{headers:{'Transfer-Encoding':'chunked'}},400]
  ]){
    const response=await send(options);
    assert.equal(response.status,expected);
  }
});

test('no stories or unreachable sources leave the local edition visible and return public counts',async t=>{
  let status='no_qualified_stories';
  const send=await localPreview(t,{
    getApplication:assert.fail,refresh:async()=>({status,sources_ok:status==='sources_unavailable'?0:1,
      sources_total:2,unique_events:6,pending_review:2,original_failures:1,partial:true})
  });
  let response=await send();
  assert.equal(response.status,200);
  assert.equal(response.data.unique_events,6);
  assert.equal(response.data.pending_review,2);
  assert.equal(response.data.edition_id,null);
  status='sources_unavailable';
  response=await send();
  assert.equal(response.status,503);
  assert.equal(response.data.error,'sources_unavailable');
});
