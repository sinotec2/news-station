import {validateBriefing, validateReviewedEvidence} from './editorial.js';

const PREFIX = 'editions/v1/days/';
const SLOTS = ['morning', 'evening'];
const MAX_BYTES = 512 * 1024;
const MAX_ATTEMPTS = 4;

function problem(status, code, message = code) {
  return Object.assign(new Error(message), {status, code});
}

function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const instant = new Date(date + 'T00:00:00Z');
  return Number.isFinite(+instant) && instant.toISOString().slice(0, 10) === date;
}

// R2 lists keys lexically. The inverse date puts the latest archive page first.
function dayKey(date) {
  const descending = String(99999999 - Number(date.replaceAll('-', ''))).padStart(8, '0');
  return PREFIX + descending + '/' + date + '.json';
}

function canonical(value, depth = 0) {
  if (depth > 32) throw problem(422, 'invalid_edition', '資料層級過深');
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key], depth + 1)]));
  }
  return value;
}

function identical(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function bundledDay(bundled, date) {
  const slots = {};
  for (const edition of bundled) {
    if (edition.date !== date) continue;
    const previous = slots[edition.edition];
    if (!previous || (edition.version || 1) >= (previous.version || 1)) slots[edition.edition] = edition;
  }
  return slots;
}

async function storedDay(bucket, date) {
  const object = await bucket.get(dayKey(date));
  if (!object) return {etag: null, slots: {}};
  const data = await object.json();
  if (data?.date !== date || !data.slots || !object.etag ||
      Object.entries(data.slots).some(([slot, edition]) => !SLOTS.includes(slot) || edition?.date !== date || edition.edition !== slot)) {
    throw problem(503, 'invalid_edition_store');
  }
  return {etag: object.etag, slots: data.slots};
}

export async function getEditionForDate(env, bundled, date, slot) {
  if (!validDate(date) || !SLOTS.includes(slot)) return null;
  const shipped = bundledDay(bundled, date);
  if (shipped[slot]) return shipped[slot];
  if (!env?.EDITION_BUCKET) return null;
  const day = await storedDay(env.EDITION_BUCKET, date);
  return day.slots[slot] ?? null;
}

export async function readEditionPage(env, bundled, {before = null, limit = 14} = {}) {
  if ((before !== null && !validDate(before)) || !Number.isInteger(limit) || limit < 1 || limit > 31) {
    throw problem(400, 'invalid_archive_page');
  }
  const dates = new Set(bundled.map(e => e.date).filter(date => !before || date < before));
  const bucket = env?.EDITION_BUCKET;
  const storedDates = new Set();
  if (bucket) {
    let cursor;
    do {
      const options = {prefix: PREFIX, limit: limit + 1 - storedDates.size};
      if (cursor) options.cursor = cursor;
      else if (before) options.startAfter = dayKey(before);
      const page = await bucket.list(options);
      for (const {key} of page.objects) {
        const date = key.slice(-15, -5);
        if (validDate(date) && dayKey(date) === key && (!before || date < before)) {
          storedDates.add(date);
          dates.add(date);
        }
      }
      if (page.truncated && (!page.cursor || page.cursor === cursor)) throw problem(503, 'invalid_archive_cursor');
      cursor = page.truncated ? page.cursor : null;
    } while (cursor && storedDates.size <= limit);
  }
  const ordered = [...dates].sort().reverse();
  const selected = ordered.slice(0, limit);
  const editions = [];
  // Keep concurrent R2 reads bounded in the Worker, including a full archive page.
  for (let i = 0; i < selected.length; i += 4) {
    const chunk = await Promise.all(selected.slice(i, i + 4).map(async date => {
      const stored = storedDates.has(date) ? (await storedDay(bucket, date)).slots : {};
      const slots = {...stored, ...bundledDay(bundled, date)};
      return [slots.evening, slots.morning].filter(Boolean);
    }));
    editions.push(...chunk.flat());
  }
  return {editions, next_before: ordered.length > limit ? selected.at(-1) : null};
}

export async function readEditions(env, bundled) {
  const editions = [];
  let before = null;
  do {
    const page = await readEditionPage(env, bundled, {before, limit: 31});
    editions.push(...page.editions);
    before = page.next_before;
  } while (before);
  return editions.sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at));
}

function validateNewEdition(edition, trusted) {
  try {
    validateBriefing(edition);
    if (!validDate(edition.date) || edition.date > new Date(Date.parse(edition.published_at) + 8 * 3600000).toISOString().slice(0, 10)) {
      throw Error('刊期晚於台北發布日期');
    }
    if (trusted) return;
    if (edition.window !== undefined) {
      const window = edition.window;
      if (!window || window.date !== edition.date || window.edition !== edition.edition ||
          !Number.isFinite(Date.parse(window.start)) || !Number.isFinite(Date.parse(window.end)) ||
          Date.parse(window.start) >= Date.parse(window.end) || Date.parse(window.end) > Date.parse(edition.cutoff_at) ||
          new Date(Date.parse(window.end) + 8 * 3600000).toISOString().slice(0, 10) !== edition.date) {
        throw Error('採集時段與刊期、版次或截止時間不符');
      }
    }
    const slotId = edition.date + '-' + edition.edition;
    if (edition.id !== slotId && !edition.id.startsWith(slotId + '-')) throw Error('期刊 ID 與日期或版次不符');
    if (new Set(edition.articles.map(a => a.id)).size !== edition.articles.length) throw Error('篇目 ID 重複');
    for (const article of edition.articles) validateReviewedEvidence(article);
  } catch (error) {
    throw problem(422, 'invalid_edition', error.message);
  }
}

function factKey(fact) {
  return fact.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
}

function checkSameDay(morning, evening) {
  if (!morning || !evening) return;
  if (morning.window && evening.window && Date.parse(morning.window.end) > Date.parse(evening.window.start)) throw problem(409, 'slot_time_conflict');
  const morningEvents = new Map(morning.articles.map(a => [a.event_id, a]));
  for (const article of evening.articles) {
    const prior = morningEvents.get(article.event_id);
    if (!prior) continue;
    const previousFacts = new Set(prior.facts.map(factKey));
    if (article.event_update !== true || !Array.isArray(article.new_facts) || !article.new_facts.length ||
        article.new_facts.some(fact => !article.facts.includes(fact) || previousFacts.has(factKey(fact)))) {
      throw problem(409, 'repeated_event_without_new_facts');
    }
  }
}

async function publishEdition(bucket, bundled, edition) {
  if (!validDate(edition?.date) || !SLOTS.includes(edition.edition)) throw problem(422, 'invalid_edition');
  const date = edition.date, slot = edition.edition;
  const bundledSlots = bundledDay(bundled, date);
  const trusted = bundledSlots[slot];
  if (trusted && !identical(trusted, edition)) throw problem(409, 'slot_already_published');
  validateNewEdition(edition, trusted);
  const receipt = {edition_id: edition.id, date, edition: slot};
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const day = await storedDay(bucket, date);
    const existing = day.slots[slot];
    if (existing) {
      if (!identical(existing, edition)) throw problem(409, 'slot_already_published');
      return {...receipt, created: false};
    }
    const slots = {...day.slots, [slot]: edition};
    const effective = {...slots, ...bundledSlots};
    checkSameDay(effective.morning, effective.evening);
    const stored = await bucket.put(dayKey(date), JSON.stringify({date, slots}), {
      onlyIf: day.etag ? {etagMatches: day.etag} : {etagDoesNotMatch: '*'},
      httpMetadata: {contentType: 'application/json'}
    });
    if (stored) return {...receipt, created: true};
  }
  throw problem(503, 'publication_busy');
}

async function validToken(expected, provided) {
  if (!expected || !provided) return false;
  const encoder = new TextEncoder();
  const digest = value => crypto.subtle.digest('SHA-256', encoder.encode(value));
  const [a, b] = (await Promise.all([digest(expected), digest(provided)])).map(buffer => new Uint8Array(buffer));
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

async function readBody(request) {
  if (Number(request.headers.get('Content-Length')) > MAX_BYTES) throw problem(413, 'body_too_large');
  const reader = request.body?.getReader();
  if (!reader) throw problem(400, 'invalid_json');
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let length = 0, text = '';
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) {
        await reader.cancel();
        throw problem(413, 'body_too_large');
      }
      text += decoder.decode(value, {stream: true});
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    if (error.status) throw error;
    throw problem(400, 'invalid_json');
  } finally {
    reader.releaseLock();
  }
}

export async function handleEditionPublish(request, env, bundled) {
  const response = (body, status, extra = {}) => Response.json(body, {
    status, headers: {'Cache-Control': 'private, no-store', ...extra}
  });
  if (request.method !== 'POST') return response({error: 'method_not_allowed'}, 405, {Allow: 'POST'});
  if (request.headers.has('Origin') || !(await validToken(env?.EDITION_PUBLISH_TOKEN, request.headers.get('X-Edition-Publish-Token')))) {
    return response({error: 'forbidden'}, 403);
  }
  if (!env.EDITION_BUCKET) return response({error: 'edition_store_unavailable'}, 503);
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return response({error: 'json_required'}, 415);
  }
  try {
    const edition = await readBody(request);
    const receipt = await publishEdition(env.EDITION_BUCKET, bundled, edition);
    return response(receipt, receipt.created ? 201 : 200);
  } catch (error) {
    return response({error: error.code || 'edition_store_unavailable', ...(error.status === 422 ? {detail: error.message} : {})}, error.status || 503);
  }
}
