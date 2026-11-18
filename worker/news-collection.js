import {candidateDecision} from './editorial.js';
import {readSource} from './news-feed.js';
import {safeUrl} from './source-registry.js';

export const defaultCollectionLimits = Object.freeze({
  max_supplement_rounds: 3,
  max_extra_pages_per_source: 3,
  max_candidates_per_source: 100,
  max_http_requests: 120,
  request_timeout_ms: 15000,
  per_source_concurrency: 1,
  global_concurrency: 4,
  minimum_unique_events: null,
  topic_minimums: null,
  region_minimums: null,
});

export function collectionLimits(settings = {}) {
  const limits = {...defaultCollectionLimits};
  for (const key of Object.keys(limits)) {
    if (!Object.hasOwn(settings, key)) continue;
    const value = settings[key];
    const max = defaultCollectionLimits[key];
    const valid = Number.isInteger(max)
      ? Number.isInteger(value) && value > 0 && value <= max
      : value === null || (key === 'minimum_unique_events'
        ? Number.isInteger(value) && value > 0
        : typeof value === 'object' && !Array.isArray(value) &&
          Object.values(value).every(count => Number.isInteger(count) && count > 0));
    if (!valid) throw Error('Invalid collection limit: ' + key);
    limits[key] = value;
  }
  return limits;
}

function canonicalLink(value) {
  const url = new URL(value);
  url.hash = '';
  for (const name of [...url.searchParams.keys()]) {
    if (/^(utm_.*|fbclid|gclid)$/i.test(name)) url.searchParams.delete(name);
  }
  return url.href;
}

function titleKey(item) {
  return item.title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function groupCandidates(states) {
  const byLink = new Map();
  const byGuid = new Map();
  const byTitle = new Map();
  const events = [];
  for (const state of states) {
    state.report.exact_duplicates = 0;
    const eventIds = new Set();
    for (const item of state.items) {
      const link = canonicalLink(item.url);
      const guid = item.guid && item.source_id + ':' + item.guid;
      const exact = byLink.get(link) ?? (guid && byGuid.get(guid));
      const key = titleKey(item);
      const date = Date.parse(item.date);
      const sameTitle = key.length >= 12 && Number.isFinite(date)
        && byTitle.get(key)?.find(match => Math.abs(match.date - date) <= 86400000);
      const event = exact || sameTitle?.event || {event_id: link, item, sources: []};
      if (!exact && !sameTitle) {
        events.push(event);
        if (key.length >= 12 && Number.isFinite(date)) {
          if (!byTitle.has(key)) byTitle.set(key, []);
          byTitle.get(key).push({date, event});
        }
      }
      if (exact) state.report.exact_duplicates++;
      byLink.set(link, event);
      if (guid) byGuid.set(guid, event);
      event.sources.push({
        source_id: item.source_id, url: item.url, title: item.title, date: item.date,
        category: item.category, source_rank: item.source_rank, exact_duplicate: Boolean(exact),
      });
      eventIds.add(event.event_id);
    }
    state.report.unique_events = eventIds.size;
  }
  return events.map(({event_id, item, sources}) => ({
    ...item, ...candidateDecision(item), event_id, evidence_candidates: sources,
    verification_state: 'pending_original_review',
  }));
}

function coverage(items, limits) {
  const review = items.filter(item => item.lane === 'review');
  const count = (field, name) => review.filter(item => item[field] === name).length;
  const gaps = [];
  if (limits.minimum_unique_events && review.length < limits.minimum_unique_events) gaps.push('unique_events');
  for (const [field, set] of [['topic', limits.topic_minimums], ['region', limits.region_minimums]]) {
    for (const [name, minimum] of Object.entries(set ?? {})) {
      if (count(field, name) < minimum) gaps.push(field + ':' + name);
    }
  }
  return {review_candidates: review.length, gaps};
}

function nextPage(response, current) {
  const link = response.headers.get('link') ?? '';
  for (const part of link.split(/,(?=\s*<)/)) {
    const match = part.match(/^\s*<([^>]+)>[\s\S]*?;\s*rel=(?:"next"|next)(?:\s*;|\s*$)/i);
    const next = match && safeUrl(match[1], current);
    if (next && new URL(next).origin === new URL(current).origin) return next;
  }
  return null;
}

async function boundedResponseText(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let bytes = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) return body + decoder.decode();
      bytes += value.byteLength;
      if (bytes > 5 * 1024 * 1024) {
        await reader.cancel();
        throw Error('Source response exceeds 5 MiB');
      }
      body += decoder.decode(value, {stream: true});
    }
  } finally {
    reader.releaseLock();
  }
}

function sampleAcrossCategories(batches, limit) {
  const items = [];
  for (let rank = 0; items.length < limit; rank++) {
    const previous = items.length;
    for (const batch of batches) {
      if (batch[rank]) items.push(batch[rank]);
      if (items.length === limit) break;
    }
    if (items.length === previous) break;
  }
  return items;
}

export async function collectNews(sources, {fetcher = fetch, settings = {}, deadline = Date.now() + 60000} = {}) {
  const limits = collectionLimits(settings);
  let requests = 0;
  let stopped = null;
  const rounds = [];
  const states = sources.map(source => ({
    source, items: [], batches: [], initial: [...source.endpoints], next: [], visited: new Set(), extra: 0,
    report: {
      source: source.name, source_id: source.id, topic: source.topic, home: source.home,
      ok: false, pages: [], candidates: 0, parse_failures: 0, exact_duplicates: 0,
      unique_events: 0, verified: 0, awaiting_review: 0, selected: 0,
    },
  }));

  function budgetStop() {
    if (Date.now() >= deadline) return 'deadline';
    if (requests >= limits.max_http_requests) return 'http_budget';
    return null;
  }

  async function retrieve(state, entry) {
    if (state.visited.has(entry.url)) return;
    if (budgetStop()) return;
    const {source, report} = state;
    const page = {requested_url: entry.url, category: entry.category, collected_at: new Date().toISOString()};
    if (entry.publisherMirror) page.publisher_mirror = true;
    try {
      let address = entry.url;
      let response;
      const trail = [];
      const signal = AbortSignal.timeout(Math.max(1, Math.min(limits.request_timeout_ms, deadline - Date.now())));
      for (;;) {
        const reason = budgetStop();
        if (reason) throw Error(reason);
        requests++;
        response = await fetcher(address, {
          headers: {'User-Agent': 'NewsStation/0.1', Accept: source.type === 'github' ? 'application/vnd.github+json' : '*/*'},
          signal, redirect: 'manual',
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const target = safeUrl(response.headers.get('location'), address);
        await response.body?.cancel();
        if (!target || target === address || trail.includes(target) || trail.length >= 5) {
          throw Error('Invalid or repeated HTTPS redirect');
        }
        trail.push(address);
        address = target;
      }
      const finalAddress = response.url ? safeUrl(response.url) : address;
      if (!finalAddress) throw Error('Source response is not HTTPS');
      address = finalAddress;
      Object.assign(page, {
        http: response.status, final_url: address, redirected: trail.length > 0 || response.redirected,
        content_type: response.headers.get('content-type'),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Error('HTTP ' + response.status);
      }
      const result = readSource(source, await boundedResponseText(response), {address, category: entry.category});
      Object.assign(page, {
        format: result.format, parsed: result.parsed, candidates: result.items.length, rejected: result.rejected,
        latest_published_at: result.items.map(item => item.date).filter(Boolean).sort().at(-1) ?? null,
        sample: result.items[0] ? {title: result.items[0].title, url: result.items[0].url, date: result.items[0].date} : null,
      });
      if (!result.items.length) throw Error('沒有可解析的項目');
      state.batches.push(result.items.slice(0, limits.max_candidates_per_source)
        .map(item => ({...item, collected_at: page.collected_at})));
      state.visited.add(entry.url);
      report.cursor = address;
      report.ok = true;
      const next = source.allowPagination && nextPage(response, address);
      if (next && !state.visited.has(next) && !state.next.some(entry => entry.url === next)) {
        state.next.push({url: next, category: entry.category});
      }
    } catch (error) {
      page.error = error.message;
      report.error = error.message;
      if (page.http >= 200 && page.http < 300) report.parse_failures++;
    }
    report.pages.push(page);
    report.checked_at = page.collected_at;
  }

  async function runWave(supplement) {
    let index = 0;
    async function runSources() {
      while (index < states.length && !budgetStop()) {
        const state = states[index++];
        if (supplement && state.extra >= limits.max_extra_pages_per_source) continue;
        const entries = supplement ? state.next.splice(0, 1) : state.initial;
        for (const entry of entries) {
          if (budgetStop() || (supplement && state.items.length >= limits.max_candidates_per_source)) break;
          if (supplement) state.extra++;
          await retrieve(state, entry);
        }
        if (!supplement && !state.report.ok && state.source.publisherMirror && !budgetStop()) {
          await retrieve(state, {url: state.source.publisherMirror, category: null, publisherMirror: true});
        }
        state.items = sampleAcrossCategories(state.batches, limits.max_candidates_per_source);
      }
    }
    await Promise.all(Array.from({length: Math.min(limits.global_concurrency, states.length)}, runSources));
  }

  await runWave(false);
  let items = groupCandidates(states);
  let status = coverage(items, limits);
  rounds.push({round: 0, unique_events: items.length, ...status});
  for (let round = 1; round <= limits.max_supplement_rounds; round++) {
    stopped = budgetStop();
    if (stopped) break;
    if ([limits.minimum_unique_events, limits.topic_minimums, limits.region_minimums].some(Boolean)
        && status.gaps.length === 0) {
      stopped = 'coverage_met';
      break;
    }
    const hasNext = states.some(state => state.next.length && state.extra < limits.max_extra_pages_per_source
      && state.items.length < limits.max_candidates_per_source);
    if (!hasNext) {
      stopped = 'sources_exhausted';
      break;
    }
    const previous = items.length;
    await runWave(true);
    items = groupCandidates(states);
    status = coverage(items, limits);
    rounds.push({round, unique_events: items.length, ...status});
    if (items.length === previous) {
      stopped = budgetStop() ?? 'no_new_unique_events';
      break;
    }
  }
  for (const state of states) {
    state.report.candidates = state.items.length;
    state.report.candidate_limit_reached = state.batches.reduce((count, batch) => count + batch.length, 0)
      > state.items.length || state.report.pages.some(page => page.candidates > limits.max_candidates_per_source);
    state.report.awaiting_review = items.filter(item => item.lane === 'review'
      && item.evidence_candidates.some(evidence => evidence.source_id === state.source.id)).length;
    if (state.report.ok) delete state.report.error;
  }
  return {
    collected_at: new Date().toISOString(), sources: states.map(state => state.report), items,
    collection: {requests, rounds, unique_events: items.length, ...status, stop_reason: stopped ?? budgetStop() ?? 'round_limit'},
  };
}
