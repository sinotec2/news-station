import test from 'node:test';
import assert from 'node:assert/strict';
import {enrichCveArticle, enrichEdition} from '../worker/product-context.js';
import {PRODUCT_PROFILES} from '../worker/product-profiles.js';
import {buildReviewedArticles} from '../worker/editorial-selection.js';
import {readSource} from '../worker/news-feed.js';
import {loadSourceRegistry} from '../worker/source-registry.js';

const four = [
  ['SAP NetWeaver', 'CVE-2025-42884', 'sap-netweaver'],
  ['Broadcom VMware vCenter', 'CVE-2026-123890', 'vmware-vcenter'],
  ['Apache Roller', 'CVE-2026-129448', 'apache-roller'],
  ['Cisco Expressway Series', 'CVE-2026-76466', 'cisco-expressway'],
];
const cve = four[2][1];
const risk = '公告列出受影響的版本，管理者需要查閱公告並核對設備。';
function legacy([product, id]) {
  return Object.freeze({status:'edited', id, event_id:id, topic:'資安',
    title:product + ' 漏洞列入美國已知遭利用目錄（' + id + '）',
    speech_script:'美國資安主管機關將 ' + product + ' 的 ' + id + ' 列入已知遭利用漏洞目錄。' + risk,
    evidence:[{fact:'新增至目錄。',url:'https://www.cisa.gov/'}], source_urls:['https://www.cisa.gov/']});
}
const edit = (title, fields = {}) => ({status:'edited', title, speech_script:risk, ...fields});
const widgetContext = Object.freeze({intro:'Widget 是公司開發的設備管理軟體。維運人員可以用它核對所有設備的狀態。', source_label:'產品手冊',source_url:'https://docs.example/widget'});

test('all four historic templates gain a sourced introduction once while preserving risk, IDs and evidence', () => {
  const unrelated = edit('全國電網預報更新');
  const original = Object.freeze({id:'old-issue',articles:Object.freeze([...four.map(legacy), unrelated])});
  const enriched = enrichEdition(original);
  assert.equal(enrichEdition(enriched), enriched);
  assert.equal(enriched.id, original.id);
  assert.equal(enriched.articles.at(-1), unrelated);
  four.forEach(([, id, profileId], i) => {
    const profile = PRODUCT_PROFILES.find(p => p.id === profileId);
    const before = original.articles[i], after = enriched.articles[i];
    assert.equal(after.id, id);
    assert.equal(after.event_id, id);
    assert.equal(after.title, before.title);
    assert.equal(after.evidence, before.evidence);
    assert.equal(after.source_urls, before.source_urls);
    assert.equal(after.speech_script, profile.intro + '美國資安主管機關將這項產品的 ' + id + ' 列入已知遭利用漏洞目錄。' + risk);
    assert.deepEqual(after.product_context,{intro:profile.intro,source_url:profile.source_url,source_label:profile.source_label});
  });
});

test('recognizes an explicit affected product in a reviewed headline and honors already meaningful spoken context', () => {
  for (const title of ['研究員揭露 Apache Roller 的安全漏洞（'+cve+'）','Apache Roller 修補 '+cve, cve+' 影響 Apache Roller']) {
    const article = edit(title);
    const enriched = enrichCveArticle(article);
    assert.match(enriched.product_context.source_url,/roller\.apache\.org/);
    assert.equal(enriched.speech_script, enriched.product_context.intro + risk);
  }
  const meaningful = 'Apache Roller 是一套讓編輯團隊一起發表文章的部落格系統。' + risk;
  const article = edit('Apache Roller 修補 '+cve, {speech_script:meaningful});
  assert.equal(enrichCveArticle(article).speech_script,meaningful);
  const generic = edit('Apache Roller 修補 '+cve,{speech_script:'Apache Roller 是一套軟體。'+risk});
  const enriched = enrichCveArticle(generic);
  assert.equal(enriched.speech_script,enriched.product_context.intro+risk);
});

test('CVE-only, negated, accessory, conflicting and ambiguous references do not receive product claims', () => {
  const examples = [
    edit(cve+' 已被加入清單'), edit(cve+' 影響 Apache Roller 的外掛'),
    edit('Apache Roller 的漏洞掃描器修補 '+cve),edit('第三方外掛可協助 Apache Roller 偵測 '+cve),
    edit(cve+' 不影響 Apache Roller'),edit('替 Contoso vCenter 修補漏洞 '+cve),
    edit('SAP NetWeaver 與 Apache Roller 漏洞 '+cve),edit('Apache RollerX 漏洞 '+cve),
    edit('Apache Roller 修補 '+cve,{status:'pending'}),
    edit('Apache Roller 修補 '+cve,{affected_product:{vendor:'Other',product:'Apache Roller'}}),
    edit('Apache Roller 修補 '+cve,{affected_product:{vendor:'SAP',product:'NetWeaver'}}),
    edit(cve,{affected_product:{vendor:'Cisco',product:'Expressway Series'}}),
  ];
  for(const article of examples) assert.equal(enrichCveArticle(article),article,article.title);
});

test('reviewed sourced context supports a new product and existing narration without storing narration twice', () => {
  const headline='Widget 修補 '+cve;
  const article=edit(headline,{product_context:widgetContext,speech_script:'Widget 是一套軟體。'+risk});
  const expected=widgetContext.intro + risk;
  const enriched=enrichCveArticle(article);
  assert.equal(enriched.product_context,widgetContext);
  assert.equal(enriched.speech_script,expected);
  assert.equal(enrichCveArticle(enriched),enriched);
  const firstSentence=widgetContext.intro.slice(0,widgetContext.intro.indexOf('。')+1);
  assert.equal(enrichCveArticle({...article,speech_script:firstSentence+risk}).speech_script,expected);
  const custom={...widgetContext,intro:'這款軟體讓管理者核對各地設備的狀態。'};
  assert.equal(enrichCveArticle(edit(headline,{product_context:custom,affected_product:{vendor:'Example',product:'Widget'}})).speech_script,custom.intro+risk);
  // An editor-approved source overrides the general product profile for an explicitly identified product.
  const specific={...widgetContext,intro:'Apache Roller 的群組部落格讓多位作者共同編輯文章。'};
  assert.equal(enrichCveArticle(edit('Apache Roller 修補 '+cve,{product_context:specific})).speech_script,specific.intro+risk);
});
test('unsafe or unassociated custom text is never added to the narration', () => {
  for(const invalid of [
    {intro:'<b>產品介紹</b>'},{intro:'產品說明 https://docs.example/widget'}, {intro:'程式碼 `eval`'},
    {intro:'產品'.repeat(150)},{intro:'Widget is a hardware inventory tool.'},{source_url:'javascript:alert(10)'},
    {source_url:'https://name:password@docs.example/widget'},{source_label:'<script>標籤'},
  ]) {
    const article=edit('Widget 修補 '+cve,{product_context:{...widgetContext,...invalid}});
    assert.equal(enrichCveArticle(article).speech_script,risk);
  }
  for(const title of ['Widget 外掛修補 '+cve,cve+' 公告','另項產品修補 '+cve]) {
    const article=edit(title,{product_context:widgetContext});
    assert.equal(enrichCveArticle(article),article);
  }
});

test('selection saves actual vendor and product even without a curated introduction and flags missing context for editorial review', async () => {
  const url='https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
  const registry={sources:[{source_id:'cisa',name:'美國 CISA',home:'https://www.cisa.gov',url,topic:'資安',type:'government',fetch:'json'}]};
  const sources=loadSourceRegistry(registry);
  const records=[['SAP','NetWeaver','CVE-2025-42884'],['Elsewhere','Roller','CVE-2026-87654']].map(([vendorProject,product,cveID])=>({
    cveID,vendorProject,product,vulnerabilityName:'公告項目',dateAdded:'2026-11-18',dueDate:'2026-12-01',requiredAction:'Apply updates per vendor instructions.',
  }));
  const {items}=readSource(sources[0],JSON.stringify({vulnerabilities:records}),{address:url});
  const now=Date.parse('2026-11-18T09:35:00Z');
  const {articles, decisions}=await buildReviewedArticles({collection:{collected_at:new Date(now).toISOString(),items:items.map(item=>({...item,event_id:item.guid}))},
    existing:[],sources,registry,now:()=>now,deadline:Date.now()+2500,reserve:()=>true,fetcher:()=>assert.fail('Structured catalogue is already verified'),
    window:{date:'2026-11-18',edition:'evening',start:'2026-11-17T23:00:00Z',end:'2026-11-18T08:30:00Z'}});
  assert.equal(articles.length,2);
  const known=articles.find(a=>a.affected_product.vendor==='SAP'), unknown=articles.find(a=>a.affected_product.vendor==='Elsewhere');
  assert.ok(known.speech_script.startsWith(known.product_context.intro));
  assert.equal(known.product_context.source_label,'SAP 官方文件');
  assert.equal(unknown.product_context,undefined);
  assert.deepEqual(unknown.affected_product,{vendor:'Elsewhere',product:'Roller'});
  const flag=decisions.find(d=>d.article_id===unknown.id);
  assert.equal(flag.status,'selected');
  assert.equal(flag.product_context_review,'needs_official_product_intro');
  assert.deepEqual(flag.affected_product,unknown.affected_product);
});
