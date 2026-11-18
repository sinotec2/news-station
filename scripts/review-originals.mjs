import {readFile, writeFile, rename} from 'node:fs/promises';
import {reviewOriginal} from './original-article.mjs';

const [input, output, batchLimit = '120', mode] = process.argv.slice(2);
if (!input || !output || input === output || !/^\d+$/.test(batchLimit) || Number(batchLimit) < 1 ||
    Number(batchLimit) > 120 || (mode && mode !== '--retry')) {
  throw Error('Usage: node scripts/review-originals.mjs <trial-report.json> <review-report.json> [requests: 1–120] [--retry]');
}
const prior = await readFile(output, 'utf8').then(JSON.parse).catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
const {tried_at: collectedAt, candidates, sources} = JSON.parse(await readFile(input,'utf8'));
if (prior && prior.collected_at !== collectedAt) throw Error('Review report refers to a different collection');
const seen = new Map(Object.entries(prior?.articles ?? {}));
const key = value => new URL(value).hostname.replace(/^www\./,'');
const approvedHosts = new Map(sources.map(source => [source.source_id, key(source.home)]));
const queue = new Map();
const now = Date.now();
function canRetry(article) {
  if (mode !== '--retry' || (article.attempts ?? 1) >= 2) return false;
  const waitUntil = /^\d+$/.test(article.retry_after ?? '')
    ? Date.parse(article.checked_at) + Number(article.retry_after) * 1000
    : Date.parse(article.retry_after);
  return !(waitUntil > now) && (article.reason === 'original_request_failed' ||
    [408, 425, 429].includes(article.http_status) || article.http_status >= 500);
}
for (const candidate of candidates) {
  const links = candidate.evidence_candidates?.length ? candidate.evidence_candidates : [{
    url: candidate.url, title: candidate.title, date: candidate.feed_date,
  }];
  for (const article of links) {
    if (seen.has(article.url) && !canRetry(seen.get(article.url))) continue;
    const host = key(article.url);
    const publisher = approvedHosts.get(article.source_id);
    if (!publisher || (host !== publisher && !host.endsWith('.' + publisher))) {
      seen.set(article.url, {feed_url: article.url, status: 'pending_original', reason: 'publisher_host_unconfirmed'});
      continue;
    }
    if (!queue.has(host)) queue.set(host, new Map());
    queue.get(host).set(article.url, article);
  }
}
const deadline = Date.now() + 60000;
let requests = 0;
const reserve = () => {
  if (requests >= Number(batchLimit) || Date.now() >= deadline) return false;
  requests++;
  return true;
};
const active = new Set();
async function worker() {
  while (Date.now() < deadline && requests < Number(batchLimit)) {
    const next = [...queue].find(([host, articles]) => !active.has(host) && articles.size);
    if (!next) return;
    const [host, articles] = next;
    const [url, candidate] = articles.entries().next().value;
    active.add(host);
    try {
      const result = await reviewOriginal(candidate, {reserve, deadline});
      if (!result) return;
      seen.set(url, {
        ...result, attempts: (seen.get(url)?.attempts ?? 0) + 1, checked_at: new Date().toISOString(),
      });
      articles.delete(url);
    } finally {
      active.delete(host);
    }
  }
}
await Promise.all(Array.from({length: 4}, worker));

function summarize(items) {
  return items.reduce((counts, {status}) => ({...counts, [status]: (counts[status] ?? 0) + 1}), {});
}
const events = candidates.map(candidate => {
  const reviewed = [...new Set([candidate.url, ...(candidate.evidence_candidates ?? []).map(article => article.url)])]
    .map(url => seen.get(url));
  const accepted = reviewed.find(article => article?.status === 'in_scope');
  const status = accepted ? 'in_scope'
    : reviewed.every(article => article?.status === 'out_of_scope') ? 'out_of_scope'
    : reviewed.some(article => !article) ? 'not_checked'
    : reviewed.some(article => article.status === 'pending_scope') ? 'pending_scope' : 'pending_original';
  return {event_id: candidate.event_id, status, ...(accepted ? {
    title: accepted.original_title || accepted.feed_title, url: accepted.original_url,
    published_at: accepted.original_published_at ?? accepted.feed_date,
    date_source: accepted.original_published_at ? 'original' : accepted.feed_date ? 'feed' : null,
    topic: accepted.topic, matched_term: accepted.matched_term,
  } : {})};
});
const summary = {
  articles: summarize([...seen.values()]), events: summarize(events),
  article_links_remaining: [...queue.values()].reduce((count, links) => count + links.size, 0),
};
const report = {
  collected_at: collectedAt, updated_at: new Date().toISOString(), summary,
  articles: Object.fromEntries(seen), events,
};
await writeFile(output + '.tmp', JSON.stringify(report,null,2)+'\n');
await rename(output + '.tmp', output);
console.log(JSON.stringify({...summary, requests}));
