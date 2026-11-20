import {execFile} from 'node:child_process';
import {stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {latestDueWindow} from '../worker/edition-window.js';
import {updateEdition} from './update-edition.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const editionFile=new URL('../content/editions.json',import.meta.url);
const bundle=new URL('../dist/server/index.js',import.meta.url);
const build=promisify(execFile);
let worker,revision,pendingBuild;

async function currentWorker(){
  const file=await stat(editionFile,{bigint:true});
  const next=[file.ino,file.mtimeNs,file.size].join('-');
  if(revision===next)return worker;
  if(pendingBuild){
    await pendingBuild;
    return currentWorker();
  }
  pendingBuild=(async()=>{
    await build(process.execPath,['build.mjs'],{cwd:root});
    const module=await import(bundle.href+'?edition='+next);
    worker=module.default;
    revision=next;
  })().finally(()=>{pendingBuild=null});
  await pendingBuild;
  return worker;
}

function json(data,status=200,headers={}){
  return Response.json(data,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',...headers}});
}

export function createPreviewServer({refresh=updateEdition,getApplication=currentWorker,now=Date.now}={}){
  let refreshing;
  async function handle(req){
    // Verify the requested host before serving data or trusting a browser Origin.
    const port=req.socket.localPort;
    const host=req.headers.host;
    const loopback=['127.0.0.1','localhost'].some(name=>host===name+':'+port||(port===80&&host===name));
    if(!loopback)return json({error:'refresh_forbidden'},403);
    const origin=new URL('http://'+host).origin;
    const url=new URL(req.url,origin);
    if(url.origin!==origin)return json({error:'refresh_forbidden'},403);
    if(url.pathname==='/api/editions/refresh'){
      if(req.method!=='POST')return json({error:'method_not_allowed'},405,{Allow:'POST'});
      if(req.headers.origin!==origin||(req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin')){
        return json({error:'refresh_forbidden'},403);
      }
      if(req.url!=='/api/editions/refresh'||req.headers['transfer-encoding']||
          (req.headers['content-length']!==undefined&&req.headers['content-length']!=='0')){
        return json({error:'unexpected_refresh_parameters'},400);
      }
      if(refreshing)return json({...refreshing,status:'in_progress',retry_after_seconds:5},202,{'Retry-After':'5'});
      const window=latestDueWindow(now());
      const {date,edition}=window;
      refreshing={date,edition,window,stories:0,edition_id:null};
      try{
        const report=await refresh({root,date,edition});
        const {status,edition_id,stories,sources_ok,sources_total,http_requests,unique_events,
          pending_review,original_failures,unchecked_events,partial,finished_at}=report;
        let published_at;
        if(status==='published'||status==='already_published'){
          const application=await getApplication();
          const query=new URLSearchParams({date,edition});
          const response=await application.fetch(new Request(origin+'/api/editions?'+query),{});
          const page=response.ok?await response.json():null;
          const issue=page?.editions?.find(item=>item.id===edition_id);
          if(!issue||issue.articles?.length!==stories)return json({error:'edition_readback_failed'},503);
          published_at=issue.published_at;
        }
        const unavailable=status==='sources_unavailable';
        return json({status,date,edition,window,edition_id:edition_id??null,stories:stories??0,published_at,
          sources_ok,sources_total,http_requests,unique_events,pending_review,original_failures,unchecked_events,partial,
          checked_at:finished_at,...(unavailable?{error:status}:{})},unavailable?503:200);
      }finally{refreshing=null}
    }
    if(!['GET','HEAD'].includes(req.method))return json({error:'method_not_allowed'},405,{Allow:'GET, HEAD'});
    const application=await getApplication();
    return application.fetch(new Request(url,{method:req.method}),{});
  }

  return createServer(async(req,res)=>{
    try{
      const response=await handle(req);
      res.writeHead(response.status,Object.fromEntries(response.headers));
      if(req.method==='HEAD'||!response.body){res.end();return}
      await pipeline(Readable.fromWeb(response.body),res);
    }catch(error){
      if(req.destroyed&&res.destroyed)return;
      console.error('Preview failed:',error.message);
      if(res.headersSent){res.destroy();return}
      res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'private, no-store'});
      res.end(JSON.stringify({error:'edition_store_unavailable'}));
    }
  });
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const port=Number(process.env.PORT??8787);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('PORT must be between 1 and 65535');
  await currentWorker();
  createPreviewServer().listen(port,'127.0.0.1',()=>console.log('News Station 本機預覽 http://127.0.0.1:'+port));
}
