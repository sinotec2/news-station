import {readFile} from 'node:fs/promises';
import {parse} from 'yaml';
import {decode} from 'he';
import {collectNews} from '../worker/news-collection.js';
import {loadSourceRegistry} from '../worker/source-registry.js';

const registry = parse(await readFile('SOURCE-REGISTRY.yaml','utf8'));
const draft = registry.sources.filter(source => source.activation === 'disabled_draft');
const allowed = draft.filter(source => source.url || source.trial_url || source.endpoints?.length);
const pending = draft.filter(source => !allowed.includes(source)).map(source => ({
  source: source.name, source_id: source.source_id, discovery_url: source.discovery_url,
  reason: '未確認可試收的 Feed 網址',
}));
const requested = process.argv.slice(2);
const selected = allowed.filter(source => !requested.length || requested.includes(source.source_id));
if (!selected.length) throw Error('No selected draft sources have a trial endpoint');
const sources = loadSourceRegistry(registry, {trialIds: selected.map(source => source.source_id)});
const settings = registry.x_pipeline_proposal;
const deadline = Date.now() + 60000;
const result = await collectNews(sources, {settings, deadline});
let originalRequests = 0;

async function sampleArticleMetadata(response, sample) {
  if (!response.ok || !response.headers.get('content-type')?.includes('html') || !response.body) {
    await response.body?.cancel();
    return {};
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let remaining = 192 * 1024;
  try {
    while (remaining > 0 && !/<\/head\s*>/i.test(text)) {
      const {value, done} = await reader.read();
      if (done) break;
      text += decoder.decode(value.subarray(0, remaining), {stream: true});
      remaining -= value.byteLength;
    }
  } finally {
    await reader.cancel();
  }
  const head = text.split(/<\/head\s*>/i)[0];
  const meta = new Map();
  for (const match of head.matchAll(/<meta\s+[^>]+>/gi)) {
    const attributes = Object.fromEntries([...match[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
      .map(([,key,double,single]) => [key.toLowerCase(), double ?? single]));
    if (attributes.property || attributes.name) meta.set(attributes.property ?? attributes.name, attributes.content);
  }
  const title = meta.get('og:title') ?? head.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  const published = meta.get('article:published_time') ?? meta.get('datePublished');
  const feedTime = Date.parse(sample.date);
  const originalTime = Date.parse(published);
  const bothTimesKnown = Number.isFinite(feedTime) && Number.isFinite(originalTime);
  const taipeiDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const normalized = value => decode(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return {
    original_title: title ? decode(title).trim() : null,
    original_published_at: published ?? null,
    title_matches_feed: title ? normalized(title).includes(normalized(sample.title)) : null,
    time_difference_seconds: bothTimesKnown ? (originalTime - feedTime) / 1000 : null,
    crosses_taipei_date: bothTimesKnown ? taipeiDate.format(feedTime) !== taipeiDate.format(originalTime) : null,
  };
}

async function inspectSample(sample) {
  if (!sample || Date.now() >= deadline || result.collection.requests + originalRequests >= settings.max_http_requests) {
    return null;
  }
  originalRequests++;
  try {
    const response = await fetch(sample.url, {
      signal: AbortSignal.timeout(Math.max(1, Math.min(settings.request_timeout_ms, deadline - Date.now()))),
      headers: {'User-Agent':'NewsStation/0.1'},
      redirect: 'manual',
    });
    return {
      ...sample, status: response.status, final_url: response.url,
      content_type: response.headers.get('content-type'),
      redirect_location: response.headers.get('location'),
      review: '檢查公開原文連結和頁首中可讀的標題、日期。事實仍待人工逐項核對',
      ...await sampleArticleMetadata(response, sample),
    };
  } catch (error) {
    return {...sample, error: error.cause?.message ?? error.message};
  }
}

const reachable = sample => sample?.status >= 200 && sample.status < 300;
for (const source of result.sources) {
  source.original_sample = await inspectSample(source.pages.find(page => page.sample)?.sample);
}

for (const source of result.sources) {
  const first = source.original_sample;
  const samples = first ? [first] : [];
  if (first && (!reachable(first) || first.title_matches_feed === false)) {
    const alternate = result.items.find(item => item.source_id === source.source_id && item.url !== first.url);
    const additional = await inspectSample(alternate && {title: alternate.title, url: alternate.url, date: alternate.date});
    if (additional) samples.push(additional);
  }
  source.original_samples = samples;
  source.trial_status = !source.ok ? 'feed_unavailable'
    : samples.some(reachable) ? 'technical_pass' : 'original_link_pending';
  source.editorial_notes = samples.flatMap(sample => [
    ...(sample.title_matches_feed === false ? [{url: sample.url, note: 'Feed 標題與原文頁首不同，選稿時採用原文標題。'}] : []),
    ...(sample.crosses_taipei_date ? [{url: sample.url, note: 'Feed 與原文落在不同台北日期，出刊前確認截稿歸屬。'}] : []),
  ]);
}

console.log(JSON.stringify({
  tried_at: result.collected_at, sources: result.sources,
  candidates: result.items.filter(item => item.lane === 'review').map(item => ({
    event_id: item.event_id,
    title: item.title,
    url: item.url,
    source: item.source,
    topic: item.topic,
    feed_date: item.date,
    status: item.verification_state,
    evidence_candidates: item.evidence_candidates,
  })),
  summary: {
    ...result.collection, original_requests: originalRequests,
    technical_pass: result.sources.filter(source => source.trial_status === 'technical_pass').length,
  },
  pending,
}, null, 2));
