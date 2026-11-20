import assert from 'node:assert/strict';
import test from 'node:test';
import {bucket} from './fixtures/edition-bucket.js';
import {editions as bundled} from './fixtures/editions.js';
import {getEditionForDate, handleEditionPublish, readEditionPage, readEditions,
  claimEditionRefresh, releaseEditionRefresh, publishEdition, readRecentEditions} from '../worker/edition-store.js';

const template = bundled.find(e => e.edition === 'evening');

function edition(date, slot, name = slot) {
  const item = structuredClone(template);
  item.date = date;
  item.id = date + '-' + slot + '-1';
  item.edition = slot;
  item.published_at = date + (slot === 'morning' ? 'T07:00:00+08:00' : 'T17:30:00+08:00');
  item.cutoff_at = item.published_at;
  item.articles = [item.articles[0]];
  Object.assign(item.articles[0], {id: 'story-' + name, event_id: name, date: item.cutoff_at, verified_at: item.cutoff_at});
  return item;
}

const envFor = editionBucket => ({EDITION_BUCKET: editionBucket, EDITION_PUBLISH_TOKEN: 'fixture-key'});
function post(env, body, options = {}, shipped = []) {
  const {headers = {}, method = 'POST'} = options;
  const request = new Request('https://example.test/api/editions/publish', {
    method, headers: {'Content-Type': 'application/json', 'X-Edition-Publish-Token': 'fixture-key', ...headers},
    ...(method === 'POST' ? {body: typeof body === 'string' ? body : JSON.stringify(body)} : {})
  });
  return handleEditionPublish(request, env, shipped);
}

test('publisher gates method, browser origin, secret, content type and both body-size paths', async () => {
  const env = envFor(bucket());
  assert.equal((await post(env, {}, {method: 'GET'})).status, 405);
  assert.equal((await post(env, {}, {headers: {Origin: 'https://example.test'}})).status, 403);
  assert.equal((await post({...env, EDITION_PUBLISH_TOKEN: ''}, {})).status, 403);
  assert.equal((await post(env, {}, {headers: {'X-Edition-Publish-Token': 'wrong'}})).status, 403);
  assert.equal((await post({...env, EDITION_BUCKET: null}, {})).status, 503);
  assert.equal((await post(env, {}, {headers: {'Content-Type': 'text/plain'}})).status, 415);
  assert.equal((await post(env, '{bad json')).status, 400);
  assert.equal((await post(env, {}, {headers: {'Content-Length': '800000'}})).status, 413);
  assert.equal((await post(env, ' '.repeat(512 * 1024 + 1))).status, 413);
  assert.equal(env.EDITION_BUCKET.objects.size, 0);
});

test('published slots require original evidence, matching Taipei date, IDs and unique story IDs', async () => {
  const env = envFor(bucket());
  const original = edition('2026-11-15', 'morning');
  for (const change of [
    e => {delete e.articles[0].evidence[0].review_state;},
    e => {e.articles[0].evidence.pop();},
    e => {e.date = '2026-11-16';},
    e => {e.date = '2026-11-31';},
    e => {e.id = 'other';},
    e => {e.window = {date: e.date, edition: 'evening', start: e.cutoff_at, end: e.published_at};},
    e => {e.articles.push({...e.articles[0], event_id: 'another'});}
  ]) {
    const invalid = structuredClone(original);
    change(invalid);
    assert.equal((await post(env, invalid)).status, 422);
  }
});

test('backfills retain their issue date and actual later date of publication', async () => {
  const env = envFor(bucket());
  const morning = edition('2026-11-15', 'morning');
  morning.window = {date: morning.date, edition: 'morning', start: '2026-11-14T17:30:00+08:00', end: morning.cutoff_at};
  morning.cutoff_at = morning.published_at = '2026-11-16T08:00:00+08:00';
  assert.equal((await post(env, morning)).status, 201);
  assert.deepEqual(await getEditionForDate(env, [], morning.date, 'morning'), morning);
});

test('concurrent publishers preserve slots, retries reuse the object, different content cannot replace it', async () => {
  const env = envFor(bucket());
  const morning = edition('2026-11-15', 'morning'), evening = edition(morning.date, 'evening');
  const [first, second] = await Promise.all([post(env, morning), post(env, evening)]);
  assert.deepEqual([first.status, second.status], [201, 201]);
  assert.equal((await first.json()).created, true);
  assert.equal(env.EDITION_BUCKET.objects.size, 1);
  assert.deepEqual(await getEditionForDate(env, [], morning.date, 'morning'), morning);
  assert.deepEqual(await getEditionForDate(env, [], morning.date, 'evening'), evening);
  const repeat = await post(env, Object.fromEntries(Object.entries(morning).reverse()));
  assert.equal(repeat.status, 200);
  assert.equal((await repeat.json()).created, false);
  assert.equal((await post(env, {...morning, label: '另一次發稿'})).status, 409);
  const racingEnv = envFor(bucket());
  const versions = await Promise.all([post(racingEnv, morning), post(racingEnv, {...morning, label: '另一份稿'})]);
  assert.deepEqual(versions.map(r => r.status).sort(), [201, 409]);
});

test('morning/evening event checks apply in either write order and across bundled and stored issues', async () => {
  const morning = edition('2026-11-15', 'morning', 'repeated');
  const evening = edition(morning.date, 'evening', 'repeated');
  const env = envFor(bucket());
  assert.equal((await post(env, evening)).status, 201);
  assert.equal((await post(env, morning)).status, 409);
  assert.equal((await post(envFor(bucket()), evening, {}, [morning])).status, 409);
  const updated = structuredClone(evening);
  updated.articles[0].event_update = true;
  const fact = '法案審議時間已正式公告。';
  updated.articles[0].facts[0] = fact;
  updated.articles[0].evidence[0].fact = fact;
  updated.articles[0].new_facts = [fact];
  assert.equal((await post(envFor(bucket()), updated, {}, [morning])).status, 201);
  const punctuation = structuredClone(updated);
  const restated = morning.articles[0].facts[0] + '。';
  punctuation.articles[0].facts[0] = restated;
  punctuation.articles[0].evidence[0].fact = restated;
  punctuation.articles[0].new_facts = [restated];
  assert.equal((await post(envFor(bucket()), punctuation, {}, [morning])).status, 409);
});

test('legacy canonical seeds are idempotent, bundled corrections win reads, archive paginates merged days', async () => {
  const env = envFor(bucket(1));
  const legacy = bundled.find(e => e.edition === 'morning');
  assert.equal((await post(env, legacy, {}, bundled)).status, 201);
  assert.equal((await post(env, legacy, {}, bundled)).status, 200);
  const newBundled = bundled.map(e => e === legacy ? {...e, version: 2, label: '更正版'} : e);
  assert.equal((await getEditionForDate(env, newBundled, legacy.date, legacy.edition)).label, '更正版');
  assert.equal((await post(env, legacy, {}, newBundled)).status, 409);
  assert.equal((await post(env, newBundled[0], {}, newBundled)).status, 409);
  const archived = ['2026-11-10', '2026-11-11', '2026-11-12'].map(date => edition(date, 'morning'));
  for (const e of archived) assert.equal((await post(env, e)).status, 201);
  const first = await readEditionPage(env, newBundled, {limit: 2});
  assert.deepEqual(first.editions.map(e => e.date), ['2026-11-18', '2026-11-17']);
  assert.equal(first.next_before, '2026-11-17');
  const second = await readEditionPage(env, newBundled, {limit: 2, before: first.next_before});
  assert.deepEqual(second.editions.map(e => e.date), ['2026-11-12', '2026-11-11']);
  assert.equal(second.next_before, '2026-11-11');
  const last = await readEditionPage(env, newBundled, {limit: 2, before: second.next_before});
  assert.deepEqual(last.editions, [archived[0]]);
  assert.equal(last.next_before, null);
  const full = await readEditions(env, newBundled);
  assert.equal(full.length, 5);
  assert.equal(full.at(-2).label, '更正版');
});

test('cross-worker claims coalesce before generation and are fenced across expiration, release and publish', async () => {
  const env=envFor(bucket());
  const date='2026-11-14', slot='morning', now=Date.now(), product=edition(date,slot);
  const acquire=(at=now)=>claimEditionRefresh(env,[],date,slot,{now:at,ttlMs:1000});
  const contenders=await Promise.all([acquire(),acquire(),acquire()]);
  assert.equal(contenders.filter(c=>c.status==='in_progress').length,2);
  const winner=contenders.find(c=>c.status==='claimed');
  assert.ok(winner.leaseId);
  assert.equal((await post(env, product)).status,409);
  await assert.rejects(publishEdition(env,[],product,{leaseId:winner.leaseId,now:now+1000}),{code:'refresh_lease_lost'});
  const replacement=await acquire(now+1001);
  assert.equal(replacement.status,'claimed');
  assert.notEqual(winner.leaseId,replacement.leaseId);
  assert.equal(await releaseEditionRefresh(env,date,slot,winner.leaseId),false);
  await assert.rejects(publishEdition(env,[],product,{leaseId:winner.leaseId,now:now+1001}),{code:'refresh_lease_lost'});
  const opposite=await claimEditionRefresh(env,[],date,'evening',{now,ttlMs:3000});
  assert.equal(opposite.status,'claimed');
  assert.equal((await publishEdition(env,[],product,{leaseId:replacement.leaseId,now:now+1001})).created,true);
  assert.equal(await releaseEditionRefresh(env,date,slot,replacement.leaseId),false);
  assert.equal((await claimEditionRefresh(env,[],date,'evening',{now:now+1001})).status,'in_progress');
  assert.deepEqual(await acquire(now+5000),{status:'already_published',edition:product});
  assert.equal(await releaseEditionRefresh(env,date,'evening',opposite.leaseId),true);
});

test('history point-reads only requested days, includes both target slots, and hides unpublished lease-only dates',async()=>{
  const storage=bucket(),env=envFor(storage);
  const outside=edition('2026-11-10','morning');
  const included=edition('2026-11-13','morning');
  const today=edition('2026-11-14','evening');
  const shipped=edition(today.date,'morning');
  for(const e of [outside,included,today])await publishEdition(env,[],e);
  const unfilled=await claimEditionRefresh(env,[],'2026-11-15','morning');
  const live=await readEditionPage(env,[shipped],{limit:2});
  assert.deepEqual(live.editions.map(e=>e.id),[today.id,shipped.id,included.id]);
  assert.equal(live.next_before,included.date);
  assert.equal(await releaseEditionRefresh(env,'2026-11-15','morning',unfilled.leaseId),true);
  assert.deepEqual((await readEditionPage(env,[],{limit:1})).editions,[today]);
  const calls=[];const get=storage.get;storage.get=key=>{calls.push(key);return get(key)};
  storage.list=()=>assert.fail('history must not scan archive lists');
  assert.deepEqual((await readRecentEditions(env,[shipped],today.date,{days:2})).map(e=>e.id),[included.id,shipped.id,today.id]);
  assert.equal(calls.length,2);
  await assert.rejects(readRecentEditions(env,[],'invalid'),{code:'invalid_archive_page'});
  await assert.rejects(claimEditionRefresh({},[],today.date,'morning'),{code:'edition_store_unavailable'});
});
