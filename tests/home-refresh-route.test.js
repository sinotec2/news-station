import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../dist/server/index.js';
import {latestDueWindow} from '../worker/edition-window.js';
import {publishEdition} from '../worker/edition-store.js';
import {bucket} from './fixtures/edition-bucket.js';
import {editions as fixtures} from './fixtures/editions.js';

const origin = 'https://station.test';
const refreshUrl = origin + '/api/editions/refresh';
const optedIn = {EDITION_REFRESH_ORIGIN: origin};

async function request(env, {method = 'POST', headers = {Origin: origin}, url = refreshUrl, body} = {}) {
  const response = await worker.fetch(new Request(url, {method, headers, body}), env);
  assert.match(response.headers.get('Cache-Control') || '', /\bno-store\b/);
  return response;
}

test('bundled home update accepts only an opted-in HTTPS origin with same-origin fetch metadata', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('denied updates must not call any source'));
  const env = {...optedIn, EDITION_BUCKET: bucket()};
  const get = await request(env, {method: 'GET'});
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('Allow'), 'POST');
  for (const [caseEnv, options] of [
    [env, {headers: {}}],
    [env, {headers: {Origin: 'null'}}],
    [env, {headers: {Origin: 'https://station.test.evil.example'}}],
    [env, {headers: {Origin: origin, 'Sec-Fetch-Site': 'same-site'}}],
    [env, {headers: {Origin: origin, 'Sec-Fetch-Site': 'cross-site'}}],
    [{EDITION_BUCKET: env.EDITION_BUCKET}, {}],
    [{...env, EDITION_REFRESH_ORIGIN: 'https://another-private-site.test'}, {}],
    [{...env, EDITION_REFRESH_ORIGIN: 'http://station.test'}, {url: refreshUrl.replace('https:', 'http:'), headers: {Origin: 'http://station.test'}}],
  ]) {
    const response = await request(caseEnv, options);
    assert.equal(response.status, 403);
  }
  assert.equal((await request(env, {url: refreshUrl + '?date=2026-11-12'})).status, 400);
  assert.equal((await request(env, {body:'{}', headers: {Origin: origin, 'Content-Length': '2'}})).status, 400);
  assert.equal((await request(env, {body:'{}'})).status, 400);
  assert.equal(env.EDITION_BUCKET.objects.size, 0);
  const unconfigured = await request(optedIn);
  assert.equal(unconfigured.status, 503);
  assert.equal((await unconfigured.json()).error, 'edition_store_unavailable');
});

test('bundled button POST recognises a completed current slot and the edition listing returns that exact edition', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('a published slot must not reload sources'));
  // Freeze the current instant so a real Taipei deadline cannot split fixture setup and the click.
  t.mock.timers.enable({apis: ['Date'], now: Date.now()});
  const {date, edition: slot, end} = latestDueWindow();
  const query = origin + '/api/editions?date=' + date + '&edition=' + slot;
  const existing = await (await worker.fetch(new Request(query), {})).json();
  const env = {...optedIn, EDITION_BUCKET: bucket()};
  let expected = existing.editions[0];
  if (!expected) {
    expected = structuredClone(fixtures.find(e => e.edition === 'evening'));
    Object.assign(expected, {id: date + '-' + slot + '-fixture', date, edition: slot, published_at: end, cutoff_at: end});
    for (const article of expected.articles) Object.assign(article, {date: end, verified_at: end});
  }
  await publishEdition(env, existing.editions, expected);
  for (const headers of [{Origin: origin}, {Origin: origin, 'Sec-Fetch-Site': 'same-origin'}]) {
    const response = await request(env, {headers});
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, 'already_published');
    assert.equal(result.edition_id, expected.id);
    assert.equal(result.stories, expected.articles.length);
    assert.equal(result.date, date);
    assert.equal(result.edition, slot);
  }
  const readback = await worker.fetch(new Request(query), env);
  assert.equal(readback.status, 200);
  assert.match(readback.headers.get('Cache-Control') || '', /\bno-store\b/);
  assert.deepEqual((await readback.json()).editions, [expected]);
});
