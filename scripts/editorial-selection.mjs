import {validateBriefing, validateReviewedEvidence} from '../worker/editorial.js';
import {safeUrl} from '../worker/source-registry.js';
import {reviewOriginal} from './original-article.mjs';

function address(value) {
  const valid = safeUrl(value);
  if (!valid) return '';
  const url = new URL(valid);
  url.hash = '';
  for (const name of [...url.searchParams.keys()]) {
    if (/^(utm_.*|fbclid|gclid)$/i.test(name)) url.searchParams.delete(name);
  }
  return url.href;
}

function publisherAllows(url, source) {
  if (!safeUrl(url) || !safeUrl(source?.home)) return false;
  const target = new URL(url), home = new URL(source.home);
  const publisher = home.hostname.replace(/^www\./, '');
  if (target.hostname !== publisher && !target.hostname.endsWith('.' + publisher)) return false;
  // github.com hosts unrelated publishers on the same domain.
  return source.type !== 'github' || target.pathname.startsWith(home.pathname.replace(/\/$/, '') + '/');
}

const sourcesFor = item => item.evidence_candidates?.length ? item.evidence_candidates : [item];
const wordKey = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const kevCatalogue = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const kevMirror = 'https://raw.githubusercontent.com/cisagov/kev-data/develop/known_exploited_vulnerabilities.json';
const dateLabel = day => day.slice(0,4) + '年' + Number(day.slice(5,7)) + '月' + Number(day.slice(8)) + '日';
function validDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().startsWith(value);
}

function catalogueArticle(item, source, checkedAt) {
  const rec = item.catalogue_record;
  const catalogue = rec?.url;
  if (source?.fetch !== 'json' || source.type !== 'government' || source.source_id !== 'cisa' ||
      source.url !== kevCatalogue || ![kevCatalogue,kevMirror].includes(catalogue) ||
      !/^CVE-\d{4}-\d{4,}$/.test(rec.cve) || item.guid !== rec.cve ||
      item.url !== 'https://www.cve.org/CVERecord?id=' + rec.cve ||
      !validDay(rec.added) || !validDay(rec.due) || rec.due < rec.added ||
      ![rec.product,rec.vendor].every(s => typeof s === 'string' && s.trim() && s.length <= 150 && !/[<>\r\n]/.test(s))) return null;
  const product = rec.product.toLowerCase().startsWith(rec.vendor.toLowerCase()) ? rec.product : rec.vendor + ' ' + rec.product;
  const eventId = 'cisa-kev-' + rec.cve.toLowerCase();
  const added = dateLabel(rec.added), due = dateLabel(rec.due);
  const facts = [
    '美國網路安全暨基礎設施安全局將 ' + product + ' 的 ' + rec.cve + ' 列入已知遭利用漏洞目錄。',
    '這筆條目列出的新增日期是' + added + '。',
    '這筆條目列出的處置期限是' + due + '。',
  ];
  const supports = ['條目的 cveID、vendorProject 及 product 欄分別列出漏洞、供應商與產品。',
    'dateAdded 欄明列 ' + rec.added + '，此日是目錄新增日。', 'dueDate 欄明列 ' + rec.due + ' 為目錄處置期限。'];
  const vendorUpdate = /^apply updates (?:per|according to) vendor instructions\.?$/i.test(rec.required_action ?? '');
  const vendorMitigation = /^apply mitigations per vendor instructions, follow applicable BOD 22-01 guidance for cloud services, or discontinue use of the product if mitigations are unavailable\.?$/i.test(rec.required_action ?? '');
  if (vendorUpdate || vendorMitigation) {
    facts.push(vendorUpdate ? '目錄要求依供應商指示套用更新。' :
      '目錄要求依廠商指示緩解風險，雲端服務依適用指引處置，缺乏緩解措施時停用產品。');
    supports.push('requiredAction 欄載明對本條目的處置指示。');
  }
  // The feed exposes a civil date, not an hour; only use this anchor for storage and comparisons.
  return {
    id:eventId, event_id:eventId, status:'edited', verification_status:'official_statement',
    topic:'資安', source:source.name, url:item.url, source_urls:[item.url,catalogue],
    date:rec.added + 'T00:00:00Z', source_published_precision:'date', verified_at:checkedAt,
    title:product + ' 漏洞列入美國已知遭利用目錄（' + rec.cve + '）',
    excerpt:'美國網路安全暨基礎設施安全局的目錄於' + added + '新增 ' + rec.cve + '，受關注的產品為 ' + product + '。',
    facts, evidence:facts.map((fact, i) => ({fact,support:supports[i],url:catalogue,origin_id:eventId,review_state:'original_read'})),
    selection_reason:'官方目錄新增已遭利用的漏洞，與組織的設備盤點及修補優先順序相關。',
    newsworthiness:'已觀察到實際利用，維運團隊可依產品及適用版本評估處置。',
    editorial_kind:'security_advisory',
    analysis:'維運團隊可先比對資產清冊，再查廠商公告列出的受影響版本與處置方式。',
    uncertainty:'新增日期指進入目錄的日期。各單位的暴露程度與適用期限仍須另行確認。',
    speech_script:'美國資安主管機關將 ' + product + ' 的 ' + rec.cve + ' 列入已知遭利用漏洞目錄。目錄是在' + added +
      '新增這筆資料，列出的處置期限是' + due + '。使用相關產品的單位，可以先核對設備與版本，再依官方指引評估處置。',
    correction_history:[],
  };
}

function priority(title, topic, date, end) {
  const reasons = [];
  if (/公告|政策|草案|預告|法案|生效|停供|基礎設施|電網|水質|公共|regulat|infrastructure|legislat|policy/i.test(title)) reasons.push('public_impact');
  if (/漏洞|修補|排放|能源|資料外洩|許可|供應鏈|半導體|晶片|電力|資安|vulnerab|energy|semiconductor|supply.chain|privacy/i.test(title)) reasons.push('work_relevance');
  if (topic === '資安' && /已知遭利用|勒索|資料外洩|actively exploited|ransomware|data breach/i.test(title)) reasons.push('time_sensitive');
  const age = Date.parse(end) - Date.parse(date);
  if (age >= 0 && age <= 86400000) reasons.push('recent');
  return {priority:reasons.length, priority_reasons:reasons};
}

async function readOriginals(items, sourceMap, reviewedArticles, options) {
  const byHost = new Map(), seen = new Map(), queued = new Set();
  const packUrls = new Set(reviewedArticles.map(a => address(a?.url)));
  function add(link, source) {
    const key = address(link.url);
    if (!key || queued.has(key)) return;
    if (!publisherAllows(key, source)) return;
    queued.add(key);
    const host = new URL(key).hostname.replace(/^www\./,'');
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push({link, key, source});
  }
  const packItem = item => sourcesFor(item).some(link => packUrls.has(address(link.url)));
  const eligible = items.filter(item => item.source_id !== 'cisa' && !(item.lane === 'technical' && sourceMap.get(item.source_id)?.type === 'github'));
  eligible.sort((a,b) => Number(packItem(b)) - Number(packItem(a)) || (a.source_rank ?? Infinity) - (b.source_rank ?? Infinity));
  for (const item of eligible) {
    for (const link of sourcesFor(item)) add(link, sourceMap.get(link.source_id));
  }
  // A reviewed story may cite an official document from another approved publisher.
  for (const article of reviewedArticles) {
    if (!queued.has(address(article?.url)) || !Array.isArray(article?.source_urls)) continue;
    for (const url of article.source_urls) {
      const source = [...sourceMap.values()].find(s => publisherAllows(url, s));
      if (source) add({url, title:'', date:null}, source);
    }
  }
  const queues = [...byHost.values()];
  async function worker() {
    while (queues.length && Date.now() < options.deadline) {
      const entries = queues.shift();
      const {link,key,source} = entries.shift();
      const review = await reviewOriginal(link, options);
      if (!review) return;
      const proof = {...review, source_id:source.id};
      seen.set(key, proof);
      if (proof.original_url) seen.set(address(proof.original_url), proof);
      if (entries.length) queues.push(entries);
    }
  }
  await Promise.all(Array.from({length:Math.min(4, queues.length)}, worker));
  return seen;
}

function validatedPack(article, primary, originals, sourceEntry, edition) {
  if (article.source !== sourceEntry?.name || address(article.url) !== address(primary.original_url) &&
      address(article.url) !== address(primary.feed_url)) throw Error('review_source_mismatch');
  if (article.verification_status === 'official_statement' && !['government','first_party_announcement','first_party_release'].includes(sourceEntry.type)) throw Error('media_is_not_official');
  validateBriefing({...edition,articles:[article]}, {now:Date.parse(edition.published_at)});
  validateReviewedEvidence(article);
  if (Date.parse(article.verified_at) < Date.parse(article.date) || new Set(article.facts.map(wordKey)).size !== article.facts.length) throw Error('invalid_reviewed_facts');
  if (article.source_urls.some(url => !originals.get(address(url))?.original_body_read)) throw Error('supporting_original_unread');
  const originDigests = new Map();
  for (const fact of article.facts) {
    const publishers = new Set();
    for (const evidence of article.evidence.filter(e => e.fact === fact)) {
      const proof = originals.get(address(evidence.url));
      if (!proof?.body_sha256 || proof.body_sha256 !== evidence.original_sha256) throw Error('review_body_changed_or_unbound');
      if (proof.editorial_lane === 'excluded') throw Error('sponsored_evidence');
      const existingOrigin = originDigests.get(proof.body_sha256);
      if (existingOrigin && existingOrigin !== evidence.origin_id) throw Error('duplicate_original');
      originDigests.set(proof.body_sha256, evidence.origin_id);
      publishers.add(proof.source_id);
    }
    if (article.verification_status === 'corroborated' && publishers.size < 2) throw Error('independent_publishers_required');
  }
  return article;
}

function recordPrior(article, oldArticles) {
  const prior = oldArticles.filter(old => old.event_id === article.event_id || old.id === article.id || address(old.url) === address(article.url));
  if (!prior.length) return null;
  const oldFacts = new Set(prior.flatMap(old => old.facts).map(wordKey));
  if (prior.some(old => old.id === article.id) || !article.event_update || !Array.isArray(article.new_facts) ||
      !article.new_facts.length || !article.new_facts.every(f => article.facts.includes(f) && !oldFacts.has(wordKey(f)))) return 'previously_published';
  return null;
}

// Treat date-only releases as a publisher day, with no fabricated publication time.
function inWindow(time, window, dayOnly = false) {
  const t = Date.parse(time), start = Date.parse(window.start), end = Date.parse(window.end);
  return t <= end && (dayOnly ? t + 86400000 > start : t > start);
}

export async function buildReviewedArticles({collection, sources, registry, existing, window, deadline, reserve,
  fetcher=fetch, reviewedArticles=[], now=Date.now}) {
  const nowIso = new Date(now()).toISOString();
  const raw = new Map(registry.sources.filter(s => s.activation === undefined || s.activation === 'active').map(s => [s.source_id,s]));
  const live = new Map(sources.filter(s => raw.has(s.id)).map(s=>[s.id,s]));
  const items = collection.items.filter(item => live.has(item.source_id));
  const originals = await readOriginals(items, live, reviewedArticles, {fetcher,deadline,reserve});
  const published = existing.flatMap(e => e.articles);
  const edition = {date:window.date,edition:window.edition,id:window.date+'-'+window.edition,timezone:'Asia/Taipei',
    published_at:nowIso,cutoff_at:nowIso};
  const decisions=[], candidates=[];
  const packs = new Map(), conflictingPacks = new Set();
  for (const article of reviewedArticles) {
    const key=address(article?.url);
    if (!key) continue;
    if (packs.has(key)) conflictingPacks.add(key);
    packs.set(key,article);
  }
  for (const item of items) {
    const evidence = [...new Set(sourcesFor(item).map(link=>originals.get(address(link.url))).filter(Boolean))];
    const decision = {event_id:item.event_id, url:item.url, title:item.title, source_id:item.source_id, topic:item.topic,
      region:raw.get(item.source_id)?.region ?? 'unspecified', status:'pending', reason:'original_not_checked', originals:evidence};
    decisions.push(decision);
    let article, time, dayOnly=false;
    if (item.source_id==='cisa') {
      article=catalogueArticle(item,raw.get(item.source_id),collection.collected_at ?? nowIso);
      if (!article) {decision.reason='invalid_catalogue_record';continue;}
      try {validateBriefing({...edition,articles:[article]},{now:Date.parse(nowIso)});}
      catch(error){decision.reason='invalid_catalogue_record';decision.detail=error.message;continue;}
      time=article.date;dayOnly=true;decision.source_date_precision='date';
      Object.assign(decision,{title:article.title,topic:article.topic,region:'US'});
    } else {
      const located = evidence.filter(p=>p.status==='in_scope' && p.original_body_read && p.editorial_lane!=='excluded' && p.editorial_lane!=='technical');
      if (!located.length) {
        if ((item.lane==='technical' && live.get(item.source_id).type==='github') || evidence.length && evidence.every(p=>p.editorial_lane==='technical')) {
          Object.assign(decision,{status:'technical',reason:'routine_release'});
        } else if (evidence.length && evidence.length === new Set(sourcesFor(item).map(p=>address(p.url))).size &&
            evidence.every(p=>p.status==='out_of_scope'||p.editorial_lane==='excluded')) {
          Object.assign(decision,{status:'excluded',reason:evidence.some(p=>p.editorial_lane==='excluded')?'sponsored':'original_out_of_scope'});
        } else decision.reason=evidence[0]?.reason ?? 'original_not_checked';
        continue;
      }
      const pickPack = proof => packs.get(address(proof.original_url)) ?? packs.get(address(proof.feed_url));
      const primary=located.find(pickPack) ?? located[0];
      const approved=pickPack(primary);
      if (conflictingPacks.has(address(primary.original_url)) || conflictingPacks.has(address(primary.feed_url))) {
        decision.reason='conflicting_reviewed_articles';continue;
      }
      time=(approved?.event_update && primary.original_updated_at) || primary.original_published_at || primary.feed_date || approved?.date;
      Object.assign(decision,{title:primary.original_title || item.title,url:primary.original_url,topic:primary.topic,source_id:primary.source_id,
        region:raw.get(primary.source_id)?.region ?? 'unspecified',date_source:approved?.event_update && primary.original_updated_at ? 'original_update' :
          primary.original_published_at ? 'original' : primary.feed_date ? 'feed' : approved?.date ? 'editor_review' : null});
      Object.assign(decision,priority(decision.title,decision.topic,time,window.end));
      if (!time) {decision.reason='date_requires_review';continue;}
      if (!inWindow(time,window)) {decision.reason='outside_window';continue;}
      if (!approved) {
        const prior=published.find(article=>address(article.url)===address(primary.original_url) || article.event_id===item.event_id);
        decision.reason=prior && !(Date.parse(primary.original_updated_at)>Date.parse(prior.verified_at))
          ? 'previously_published' : 'needs_fact_review_and_chinese_copy';
        continue;
      }
      try {article=validatedPack(approved,primary,originals,raw.get(primary.source_id),edition);}
      catch(error){decision.reason='review_invalid';decision.detail=error.message;continue;}
    }
    if (!inWindow(time,window,dayOnly)) {decision.reason='outside_window';continue;}
    const previous=recordPrior(article,published);
    if (previous) {decision.reason=previous;continue;}
    Object.assign(decision,priority(decision.title,decision.topic,time,window.end),{published_source_date:time});
    candidates.push({article,decision});
  }
  const articles=[],topics=new Set(),regions=new Set();
  const limit=window.edition==='morning'?20:10;
  const score=d=> d.priority + Number(!topics.has(d.topic)) + Number(d.region!=='unspecified'&&!regions.has(d.region));
  while (candidates.length) {
    candidates.sort((a,b)=>score(b.decision)-score(a.decision) || Date.parse(b.decision.published_source_date)-Date.parse(a.decision.published_source_date) ||
      a.decision.event_id.localeCompare(b.decision.event_id));
    const {article,decision}=candidates.shift();
    if (articles.some(a=>a.event_id===article.event_id || a.id===article.id || address(a.url)===address(article.url))) {decision.reason='duplicate_event';continue;}
    if (articles.length>=limit) {decision.reason='edition_limit';continue;}
    topics.add(decision.topic);regions.add(decision.region);articles.push(article);
    decision.status='selected';decision.reason='reviewed_facts';decision.article_id=article.id;
  }
  const configured=registry.x_pipeline_proposal ?? {}, gaps=[];
  for (const [field,minima] of [['topic',configured.topic_minimums],['region',configured.region_minimums]]) {
    for (const [name,min] of Object.entries(minima ?? {})) if (decisions.filter(d=>d.status==='selected' && d[field]===name).length<min) gaps.push(field+':'+name);
  }
  if (configured.minimum_unique_events>articles.length) gaps.push('unique_events');
  const review_queue=decisions.filter(d=>d.reason==='needs_fact_review_and_chinese_copy')
    .sort((a,b)=>score(b)-score(a) || a.event_id.localeCompare(b.event_id)).map(d=>d.event_id);
  return {articles,decisions,review_queue,coverage:{unique_selected:articles.length,topics:[...topics],regions:[...regions],gaps}};
}
