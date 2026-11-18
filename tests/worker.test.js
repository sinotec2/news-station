import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parse} from 'yaml';
import deployedWorker from '../dist/server/index.js';
import worker,{safeUrl,parseSource} from '../worker/index.js';
test('only HTTPS source links survive normalization',()=>{assert.equal(safeUrl('javascript:alert(1)'),null);assert.equal(safeUrl('http://example.com'),null);assert.equal(safeUrl('https://example.com'),'https://example.com/');const rows=parseSource({id:'sdk',type:'github',name:'SDK',home:'https://example.com',topic:'AI'},JSON.stringify([{id:1,name:'release',html_url:'javascript:alert(1)'},{id:2,name:'valid',html_url:'https://example.com/release',body:'<b>Announcement</b>',published_at:'2026-11-16T00:00:00Z'},{id:3,prerelease:true}]));assert.equal(rows.length,1);assert.equal(rows[0].status,'unreviewed');assert.equal(rows[0].excerpt,'Announcement')});
test('RSS preserves original evidence and removes markup',()=>{const rows=parseSource({id:'earth',type:'rss',name:'Earth',topic:'環境',home:'https://example.com'},'<rss><item><title>Ocean &amp; Land</title><link>https://example.com/earth</link><description><![CDATA[<p>Evidence</p>]]></description><pubDate>Mon, 16 Nov 2026 00:00:00 GMT</pubDate></item></rss>');assert.equal(rows[0].title,'Ocean & Land');assert.equal(rows[0].excerpt,'Evidence');assert.equal(rows[0].date,'2026-11-16T00:00:00.000Z')});
test('routes return app, manifest and explicit 404',async()=>{let r=await worker.fetch(new Request('https://station.test/'));assert.equal(r.status,200);let html=await r.text();assert.match(html,/發生什麼/);const script=html.match(/<script>([\s\S]*)<\/script>/)[1];new Function(script);r=await worker.fetch(new Request('https://station.test/manifest.webmanifest'));assert.equal((await r.json()).display,'standalone');r=await worker.fetch(new Request('https://station.test/missing'));assert.equal(r.status,404)});
test('the bundled inbox fetches URLs from the YAML registry and reports upstream failures', async () => {
 const registry = parse(await readFile('SOURCE-REGISTRY.yaml', 'utf8'));
 const active = registry.sources.filter(source => source.activation !== 'disabled_draft');
 const originalFetch = globalThis.fetch;
 const fetchedUrls = [];
 globalThis.fetch = async url => {
  fetchedUrls.push(url);
  return new Response('unavailable', {status:503});
 };
 try {
  const response = await deployedWorker.fetch(new Request('https://station.test/api/inbox'));
  const data = await response.json();
  assert.deepEqual(fetchedUrls, active.map(source => new URL(source.url).href));
  assert.deepEqual(data.sources.map(source => source.source), active.map(source => source.name));
  assert.deepEqual(data.items, []);
  assert.ok(data.sources.every(source => !source.ok && source.error === 'HTTP 503'));
 } finally {
  globalThis.fetch = originalFetch;
 }
});
test('restricted Workers default cache must never be accessed',async()=>{const previousFetch=globalThis.fetch;const previousCaches=Object.getOwnPropertyDescriptor(globalThis,'caches');let calls=0;globalThis.fetch=async()=>{calls++;return new Response('unavailable',{status:503})};Object.defineProperty(globalThis,'caches',{configurable:true,value:{get default(){throw Error('This Worker is not permitted to access the default cache.')}}});try{for(let i=0;i<2;i++){const r=await worker.fetch(new Request('https://station.test/api/inbox'));assert.equal(r.status,200);assert.equal(r.headers.get('Cache-Control'),'private, no-store');const data=await r.json();assert.equal(data.sources.length,6);assert.ok(data.sources.every(s=>s.ok===false))}assert.equal(calls,12)}finally{globalThis.fetch=previousFetch;if(previousCaches)Object.defineProperty(globalThis,'caches',previousCaches);else delete globalThis.caches}});
