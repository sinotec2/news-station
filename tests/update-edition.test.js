import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {editionWindow, updateEdition} from '../scripts/update-edition.mjs';
import {editions} from './fixtures/editions.js';
import {checkEditionForAppend} from '../scripts/add-edition.mjs';

const registry = {sources: [
  {source_id: 'official', name: '官方網站', topic: 'IT', url: 'https://example.org/rss', fetch: 'rss'},
  {source_id: 'draft', name: '草案來源', topic: 'IT', url: 'https://example.org/trial', fetch: 'rss', activation: 'disabled_draft'},
]};
const date = '2026-11-18';
const verified = '2026-11-18T10:00:00.000Z';
const existingArticle = editions.flatMap(edition => edition.articles).find(article => article.verification_status === 'attributed_report');
const article = {...existingArticle, verified_at: verified, date: '2026-11-18T04:00:00.000Z'};

async function fixture(t, selected = [article]) {
  const root = await mkdtemp(join(tmpdir(), 'news-edition-job-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, 'content'));
  const store = join(root, 'content', 'editions.json');
  await writeFile(store, '[]\n');
  await writeFile(join(root, 'SOURCE-REGISTRY.yaml'), JSON.stringify(registry));
  const counters = {collect: 0, select: 0};
  const dependencies = {
    now: () => Date.parse(verified),
    collect: async sources => {
      assert.deepEqual(sources.map(source => source.id), ['official']);
      counters.collect++;
      return {items: [{title: '測試', excerpt: '內文不進執行報告'}], sources: [{ok: true}],
        collection: {requests: 2, unique_events: 1}};
    },
    select: async ({reserve}) => {
      assert.ok(reserve());
      counters.select++;
      return {articles: selected, decisions: [{decision: 'fixture'}]};
    },
  };
  const run = (args = {}, overrides = {}) => updateEdition({root, date, edition: 'evening', ...args},
    {...dependencies, ...overrides});
  return {root, run, counters, store, slot: join(root, '.generated', 'edition-runs', date + '-evening')};
}

test('Taipei issue windows cover the preceding period across calendar boundaries', () => {
  assert.equal(editionWindow('morning', '2027-01-01').start, '2026-12-31T08:30:00.000Z');
  assert.equal(editionWindow('morning', '2027-01-01').end, '2026-12-31T23:00:00.000Z');
  assert.equal(editionWindow('evening', '2027-01-01').start, '2026-12-31T23:00:00.000Z');
  assert.equal(editionWindow('evening', '2027-01-01').end, '2027-01-01T08:30:00.000Z');
  assert.throws(() => editionWindow('morning', '2026-02-31'));
  assert.throws(() => editionWindow('noon', '2026-01-01'));
});

test('preview stores the reviewed product, decision and bounded intake without changing publication', async t => {
  const f = await fixture(t);
  const result = await f.run({dryRun: true});
  assert.equal(result.status, 'dry_run_ready');
  assert.equal(result.http_requests, 3);
  assert.equal(await readFile(f.store, 'utf8'), '[]\n');
  assert.equal(JSON.parse(await readFile(join(f.slot, result.edition_file))).articles.length, 1);
  assert.match(await readFile(join(f.slot, result.selection_file), 'utf8'), /fixture/);
  assert.doesNotMatch(await readFile(join(f.slot, result.collection_file), 'utf8'), /內文不進/);
});

test('concurrent and repeated jobs emit one edition, and can re-export it without re-fetching', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.run(), f.run()]);
  assert.deepEqual(results.map(result => result.status).sort(), ['already_published', 'published']);
  assert.deepEqual(f.counters, {collect: 1, select: 1});
  assert.equal(JSON.parse(await readFile(f.store)).length, 1);
  await rm(f.slot, {recursive: true});
  const repeat = await f.run();
  assert.equal(repeat.status, 'already_published');
  assert.equal(JSON.parse(await readFile(join(f.slot, repeat.edition_file))).id, repeat.edition_id);
});

test('early, empty, failed and unavailable runs preserve the publication store and record why', async t => {
  const f = await fixture(t, []);
  assert.equal((await f.run({}, {now: () => Date.parse('2026-11-18T06:00:00Z')})).status, 'not_due');
  assert.equal(f.counters.collect, 0);
  assert.equal((await f.run()).status, 'no_qualified_stories');
  const unavailable = await f.run({}, {collect: async () => ({items: [], sources: [{ok: false}],
    collection: {requests: 1, unique_events: 0}})});
  assert.equal(unavailable.status, 'sources_unavailable');
  await assert.rejects(f.run({}, {select: async () => {throw Error('Unexpected reviewer error');}}), /reviewer error/);
  const report = JSON.parse(await readFile(join(f.slot, 'report.json')));
  assert.equal(report.status, 'failed');
  assert.equal(report.edition_file, null);
  assert.equal(await readFile(f.store, 'utf8'), '[]\n');
  assert.equal((await f.run()).status, 'no_qualified_stories');
});

test('the shared publication guard rejects a repeat with an old fact presented as new', async t => {
  const f = await fixture(t);
  const first = await f.run();
  const edition = JSON.parse(await readFile(join(f.slot, first.edition_file)));
  const second = {...edition, id: 'same-event-again', articles: [
    {...article, event_update: true, new_facts: [article.facts[0]]},
  ]};
  assert.throws(() => checkEditionForAppend(second, [edition], {now: Date.parse(verified)}), /Repeated same-day/);
});
