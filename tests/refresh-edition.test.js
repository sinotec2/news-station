import assert from 'node:assert/strict';
import test from 'node:test';
import {bucket} from './fixtures/edition-bucket.js';
import {loadSourceRegistry} from '../worker/source-registry.js';
import {getEditionForDate, readRecentEditions} from '../worker/edition-store.js';
import {latestDueWindow} from '../worker/edition-window.js';
import {refreshEdition} from '../worker/refresh-edition.js';

const canonical = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const cisa = {source_id: 'cisa', fetch: 'json', type: 'government', name: 'CISA', topic: '資安', url: canonical};
const publisher = {source_id: 'news', fetch: 'rss', type: 'media', name: 'Example News', topic: 'IT',
  url: 'https://news.example/feed', home: 'https://news.example/'};

function setup(raw) {
  const registry = {sources: raw};
  return {env: {EDITION_BUCKET: bucket()}, registry, sources: loadSourceRegistry(registry), bundled: []};
}

function catalogue(added = latestDueWindow().end.slice(0, 10)) {
  const due = new Date(Date.parse(added) + 14 * 86400000).toISOString().slice(0, 10);
  return Response.json({vulnerabilities: [{cveID: 'CVE-2025-10000', vulnerabilityName: 'Test product',
    vendorProject: 'Example', product: 'Storage System', dateAdded: added, dueDate: due}]});
}

test('the most recent due cutoff includes both exact boundaries and the previous year before dawn', () => {
  const verify = (time, date, edition) => {
    const actual = latestDueWindow(Date.parse(time + '+08:00'));
    assert.deepEqual([actual.date, actual.edition], [date, edition]);
  };
  verify('2026-01-01T00:00:00', '2025-12-31', 'evening');
  verify('2026-01-01T06:59:59', '2025-12-31', 'evening');
  verify('2026-01-01T07:00:00', '2026-01-01', 'morning');
  verify('2026-01-01T16:29:59', '2026-01-01', 'morning');
  verify('2026-01-01T16:30:00', '2026-01-01', 'evening');
  verify('2026-01-01T23:59:59', '2026-01-01', 'evening');
});

test('two refreshes share the slot, publish checked source data and read the same issue on retry', async () => {
  const options = setup([cisa]);
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  let calls = 0;
  const fetcher = async url => {
    calls++;
    assert.equal(url, canonical);
    started.resolve();
    await release.promise;
    return catalogue();
  };
  const first = refreshEdition({...options, fetcher});
  await started.promise;
  const waiting = await refreshEdition({...options, fetcher});
  assert.equal(waiting.status, 'in_progress');
  assert.ok(waiting.retry_after_seconds >= 1);
  release.resolve();
  const done = await first;
  assert.equal(done.status, 'published');
  assert.equal(done.sources_ok, 1);
  assert.equal(done.stories, 1);
  const readback = await getEditionForDate(options.env, [], done.date, done.edition);
  assert.equal(readback.id, done.edition_id);
  assert.equal(readback.articles[0].verification_status, 'official_statement');
  assert.ok(readback.articles[0].evidence.every(item => item.review_state === 'original_read'));
  const repeat = await refreshEdition({...options, fetcher});
  assert.equal(repeat.status, 'already_published');
  assert.equal(repeat.edition_id, done.edition_id);
  assert.equal(calls, 1);
});

test('a failed feed, old structured record or blocked original cannot create a blank issue and the lease is released', async () => {
  const options = setup([cisa]);
  const down = await refreshEdition({...options, fetcher: async () => new Response(null, {status:503})});
  assert.equal(down.status, 'sources_unavailable');
  assert.equal(down.partial, true);
  const old = await refreshEdition({...options, fetcher: async () => catalogue('2001-01-01')});
  assert.equal(old.status, 'no_qualified_stories');
  const news = setup([publisher]);
  const inaccessible = await refreshEdition({...news, fetcher: async url =>
    url === publisher.url ? new Response('<rss><channel><item><title>科技消息</title><link>https://news.example/story</link></item></channel></rss>') :
      new Response(null,{status:403})});
  assert.equal(inaccessible.status, 'sources_unavailable');
  assert.equal(inaccessible.sources_ok, 1);
  assert.equal(inaccessible.original_failures, 1);
  assert.deepEqual(await readRecentEditions(options.env, [], old.date), []);
  assert.deepEqual(await readRecentEditions(news.env, [], inaccessible.date), []);
});

test('the hosted request budget covers both feeds and original requests', async () => {
  const options = setup([publisher]);
  const items = Array.from({length: 60}, (_, i) => '<item><title>Information technology update ' + i +
    '</title><link>https://news.example/news/' + i + '</link></item>').join('');
  let calls = 0;
  const fetcher = async url => {
    calls++;
    return url === publisher.url ? new Response('<rss><channel>'+items+'</channel></rss>') : new Response(null,{status:503});
  };
  const report = await refreshEdition({...options, fetcher});
  assert.equal(calls, 22);
  assert.equal(report.http_requests, calls);
  assert.equal(report.original_failures, 21);
  assert.equal(report.unchecked_events, 60);
  assert.equal(report.stories, 0);
});

test('recently published events are excluded when a new slot is compiled', async () => {
  const first = setup([cisa]);
  const previous = await refreshEdition({...first, fetcher:async()=>catalogue()});
  const edition = await getEditionForDate(first.env, [], previous.date, previous.edition);
  const priorDay = new Date(Date.parse(previous.date) - 86400000).toISOString().slice(0,10);
  const other = setup([cisa]);
  other.bundled = [{...edition, date: priorDay, id: priorDay+'-morning-prior', edition:'morning'}];
  const result = await refreshEdition({...other, fetcher:async()=>catalogue()});
  assert.equal(result.status, 'no_qualified_stories');
  assert.equal(result.edition_id, null);
});
