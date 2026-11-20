import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createContext, runInContext} from 'node:vm';
import {build} from 'esbuild';
import {readSource} from '../worker/news-feed.js';
import {loadSourceRegistry} from '../worker/source-registry.js';
import {validateBriefing} from '../worker/editorial.js';
import {buildReviewedArticles} from '../scripts/editorial-selection.mjs';

const end='2026-11-18T09:30:00Z', now=()=>Date.parse('2026-11-18T09:35:00Z');
const window={date:'2026-11-18',edition:'evening',start:'2026-11-17T23:00:00Z',end};
const catalogue='https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const entries=[
  {source_id:'cisa',name:'美國 CISA',home:'https://www.cisa.gov',url:catalogue,topic:'資安',type:'government',fetch:'json'},
  {source_id:'media',name:'測試媒體',home:'https://paper.example',url:'https://paper.example/rss',topic:'IT',region:'TW',type:'media',fetch:'rss'},
];
const url='https://paper.example/article';
const body='主管機關今天公布電網建設的工程時程，預計將在明年五月開始施工。工程將分成兩個區域，供電方式需要依各地情形規劃。施工預定先從南部地區開始，公布的表格另列後續北部地區的預估工期。主管機關表示，其中還有幾個計畫仍須辦理相關程序，確切進度需依後續公告。';
const day='2026-11-18T05:00:00Z', hash=t=>createHash('sha256').update(t).digest('hex');
const story=(u=url)=>({source_id:'media',source:'測試媒體',url:u,title:'RSS 曾經採用的不同標題',lane:'review',topic:'IT',event_id:u,date:'2026-11-17T01:00:00Z',source_rank:1});
const page=(text=body,title='主管機關公布電網建設計畫工程時程')=>'<meta property="article:published_time" content="'+day+'"><article><h1>'+title+'</h1><p>'+text+'</p></article>';
const facts=['主管機關公布工程時程。','工程預定從南部地區開始。','部分計畫仍須辦理相關程序。'];
const reviewed={id:'power-grid-1',event_id:'power-grid',status:'edited',topic:'環境',title:'主管機關公布電網建設的分區工程時程',
  url,source:'測試媒體',source_urls:[url],date:day,verified_at:end,verification_status:'attributed_report',facts,
  excerpt:'主管機關說明電網建設的工程時程，其中部分計畫仍需辦理相關程序。',
  evidence:facts.map(fact=>({fact,url,support:'原文工程時程與主管機關的說明。',origin_id:'grid-report',review_state:'original_read',original_sha256:hash(body)})),
  editorial_kind:'reported_update',selection_reason:'電力供應是公共建設的一環。',newsworthiness:'電網建設與相關工程時程具公共影響。',
  analysis:'工程單位可留意電網規劃。',uncertainty:'實際施工進度仍待後續公告。',speech_script:'主管機關公布電網工程時程，施工預定先從南部開始。部分計畫仍在辦理相關程序，北部的預估工期也已列入說明，確切時間仍需追蹤後續公告。',correction_history:[]};

function run(items,overrides={}) {
  const registry={sources:entries,x_pipeline_proposal:{topic_minimums:{AI:1}}};
  const options={registry,sources:loadSourceRegistry(registry),existing:[],collection:{items,collected_at:end},window,
    now,deadline:Date.now()+5000,reserve:()=>true,fetcher:async()=>new Response(page(),{headers:{'content-type':'text/html'}})};
  return buildReviewedArticles({...options,...overrides});
}

test('the browser Worker selects a reviewed article with the same body fingerprint as the CLI', async () => {
  const bundle = await build({entryPoints:['worker/editorial-selection.js'],bundle:true,platform:'browser',
    write:false,format:'iife',globalName:'Selection'});
  const context = createContext({URL, TextEncoder, TextDecoder, crypto, atob, AbortSignal, Response});
  runInContext(bundle.outputFiles[0].text, context);
  const registry={sources:entries};
  const options={registry,sources:loadSourceRegistry(registry),existing:[],collection:{items:[story()],collected_at:end},
    window,now,deadline:Date.now()+5000,reserve:()=>true,reviewedArticles:[reviewed],
    fetcher:async()=>new Response(page(),{headers:{'content-type':'text/html'}})};
  const workerResult=await context.Selection.buildReviewedArticles(options);
  assert.deepEqual(workerResult.articles.map(a=>a.id).join(','),reviewed.id);
  assert.equal(workerResult.decisions[0].originals[0].body_sha256,hash(body));
  assert.deepEqual(JSON.parse(JSON.stringify(workerResult)),await buildReviewedArticles(options));
});

test('CISA original catalogue additions produce sourced Chinese stories without inferring a discovery date',async()=>{
  const rec={cveID:'CVE-2026-12345',vendorProject:'Example',product:'Gateway',dateAdded:'2026-11-18',dueDate:'2026-12-02',
    vulnerabilityName:'Test record',requiredAction:'Apply updates per vendor instructions.'};
  const source=loadSourceRegistry({sources:entries})[0];
  const [candidate]=readSource(source,JSON.stringify({vulnerabilities:[rec]}),{address:catalogue}).items;
  const item={...candidate,event_id:candidate.url};
  const fetcher=()=>assert.fail('Structured original was already fetched');
  const result=await run([item],{fetcher});
  assert.equal(result.articles.length,1);
  const [article]=result.articles;
  assert.equal(article.source_published_precision,'date');
  assert.ok(article.evidence.every(e=>e.url===catalogue));
  assert.ok(article.facts.some(f=>f.includes('依供應商指示')));
  assert.match(article.speech_script,/目錄是在二|目錄是在2026年11月18日新增/);
  assert.deepEqual(result.coverage.gaps,['topic:AI']);
  validateBriefing({id:'test',date:window.date,edition:'evening',timezone:'Asia/Taipei',cutoff_at:end,published_at:end,articles:[article]},{now:now()});
  assert.equal((await run([item],{fetcher,existing:[{articles:[article]}]})).decisions[0].reason,'previously_published');
  item.catalogue_record.url='https://unrelated.example/kev.json';
  assert.equal((await run([item],{fetcher})).decisions[0].reason,'invalid_catalogue_record');
});

test('RSS date or title differences retain an in-scope original; only current body-bound, edited facts publish',async()=>{
  const intake=await run([story()]);
  assert.equal(intake.articles.length,0);
  assert.equal(intake.decisions[0].reason,'needs_fact_review_and_chinese_copy');
  assert.equal(intake.decisions[0].originals[0].body_sha256,hash(body));
  assert.equal(intake.decisions[0].date_source,'original');
  const ok=await run([story()],{reviewedArticles:[reviewed]});
  assert.equal(ok.articles[0].id,reviewed.id);
  const changed=await run([story()],{reviewedArticles:[reviewed],fetcher:async()=>new Response(page(body+'正式時程已有更動。'),{headers:{'content-type':'text/html'}})});
  assert.equal(changed.decisions[0].detail,'review_body_changed_or_unbound');
  const disguised=await run([story()],{reviewedArticles:[{...reviewed,verification_status:'official_statement'}]});
  assert.equal(disguised.decisions[0].detail,'media_is_not_official');
});

test('paid labels on originals are excluded while reporting on sponsorship remains eligible; denied and unknown originals stay pending',async()=>{
  const items=['ad','regular','denied','unknown'].map(p=>story('https://paper.example/'+p));
  const report=await run(items,{fetcher:async u=>{
    if (u.endsWith('denied')) return new Response(null,{status:403});
    const text=u.endsWith('unknown')?'這是一份地方日常生活的報導，作者描述了他的觀察與想法。'.repeat(6):body;
    const title=u.endsWith('ad')?'【廣編特輯】電網能源服務':u.endsWith('regular')?'電網工程報導檢視贊助內容的認定標準':'日常生活觀察記錄';
    return new Response(page(text,title),{headers:{'content-type':'text/html'}});
  }});
  assert.deepEqual(report.decisions.map(d=>[d.status,d.reason]),[
    ['excluded','sponsored'],['pending','needs_fact_review_and_chinese_copy'],['pending','original_http_error'],['pending','original_scope_unclear'],
  ]);
});

test('syndicated evidence with different URLs and origin labels cannot establish independent reporting',async()=>{
  const second={...entries[1],source_id:'media-2',name:'另一媒體',url:'https://second.example/rss',home:'https://second.example'};
  const otherUrl='https://second.example/same';
  const registry={sources:[...entries,second]};
  const pack={...reviewed,verification_status:'corroborated',source_urls:[url,otherUrl],
    evidence:[...reviewed.evidence,...reviewed.evidence.map(e=>({...e,url:otherUrl,origin_id:'other-report'}))]};
  const r=await run([story()],{registry,sources:loadSourceRegistry(registry),reviewedArticles:[pack]});
  assert.equal(r.articles.length,0);
  assert.equal(r.decisions[0].detail,'duplicate_original');
});

test('prior events require reviewed new facts and a new story ID; conflicting packs are held without replacing a story',async()=>{
  const previous={...reviewed,id:'first-publication',verified_at:'2026-11-18T05:30:00Z',facts:[facts[0],facts[1],'舊稿列出北部工期。']};
  const existing=[{articles:[previous]}];
  const old=await run([story()],{existing,reviewedArticles:[reviewed]});
  assert.equal(old.decisions[0].reason,'previously_published');
  const actualUpdate={...reviewed,event_update:true,new_facts:[facts[2]]};
  const updated=await run([story()],{existing,reviewedArticles:[actualUpdate]});
  assert.deepEqual(updated.articles.map(a=>a.id),[actualUpdate.id]);
  const copy={...actualUpdate,new_facts:[facts[0]]};
  assert.equal((await run([story()],{existing,reviewedArticles:[copy]})).decisions[0].reason,'previously_published');
  assert.equal((await run([story()],{reviewedArticles:[copy,actualUpdate]})).decisions[0].reason,'conflicting_reviewed_articles');
});
