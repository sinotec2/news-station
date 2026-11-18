import {execFile} from 'node:child_process';
import {stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const root=fileURLToPath(new URL('..',import.meta.url));
const editionFile=new URL('../content/editions.json',import.meta.url);
const bundle=new URL('../dist/server/index.js',import.meta.url);
const port=Number(process.env.PORT??8787);
if(!Number.isInteger(port)||port<1||port>65535)throw Error('PORT must be between 1 and 65535');
const origin='http://127.0.0.1:'+port;
const build=promisify(execFile);
let worker,revision,pendingBuild;

async function currentWorker(){
  const file=await stat(editionFile,{bigint:true});
  const next=[file.ino,file.mtimeNs,file.size].join('-');
  if(revision===next)return worker;
  if(!pendingBuild){
    pendingBuild=(async()=>{
      await build(process.execPath,['build.mjs'],{cwd:root});
      const module=await import(bundle.href+'?edition='+next);
      worker=module.default;
      revision=next;
    })().finally(()=>{pendingBuild=null});
  }
  await pendingBuild;
  return worker;
}

await currentWorker();
const server=createServer(async(req,res)=>{
  try{
    if(!['GET','HEAD'].includes(req.method)){
      res.writeHead(405,{Allow:'GET, HEAD'}).end();
      return;
    }
    const url=new URL(req.url,origin);
    if(url.origin!==origin){res.writeHead(400).end();return}
    const application=await currentWorker();
    const response=await application.fetch(new Request(url,{method:req.method}),{});
    res.writeHead(response.status,Object.fromEntries(response.headers));
    if(req.method==='HEAD'||!response.body){res.end();return}
    await pipeline(Readable.fromWeb(response.body),res);
  }catch(error){
    if(req.destroyed&&res.destroyed)return;
    console.error('Preview failed:',error.message);
    if(!res.headersSent)res.writeHead(500,{'Content-Type':'text/plain; charset=utf-8'});
    res.end('無法載入本機預覽，請查看終端機。');
  }
});
server.listen(port,'127.0.0.1',()=>console.log('News Station 本機預覽 '+origin));
