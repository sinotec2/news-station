import test from 'node:test';
import assert from 'node:assert/strict';
import {validateReviewedEvidence} from '../worker/editorial.js';
import {readSource} from '../worker/news-feed.js';
import {collectNews} from '../worker/news-collection.js';
import {loadSourceRegistry} from '../worker/source-registry.js';

function source(id, topic = 'IT') {
  const home = 'https://' + id + '.example/';
  return {id, name: id, home, type: 'rss', topic, allowPagination: true,
    endpoints: [{url: home + 'feed', category: '最新'}]};
}

function rss(items) {
  return '<rss><channel>' + items.map(item =>
    `<item><title>Professional news bulletin ${item}</title><guid>${item}</guid><link>/news/${item}</link></item>`
  ).join('') + '</channel></rss>';
}

test('Atom keeps alternate links, relative bases, CDATA entities, and dates independently', () => {
  const feed = `<a:feed xmlns:a="http://www.w3.org/2005/Atom" xml:base="https://news.example/news/">
    <a:entry xml:base="regional/"><a:id>entry:xyz</a:id><a:title>A &amp; B</a:title>
    <a:link rel="self" href="metadata.xml"/><a:link rel="alternate" href="article"/>
    <a:summary><![CDATA[<p>Evidence &copy; 2026</p>]]></a:summary>
    <a:published>bad date</a:published><a:updated>2026-11-18T01:00:00Z</a:updated></a:entry>
    <a:entry><a:title>Another</a:title><a:link href="another"/><a:updated>bad</a:updated></a:entry>
    </a:feed>`;
  const data = readSource(source('test'), feed);
  assert.equal(data.format, 'Atom');
  assert.equal(data.items[0].url, 'https://news.example/news/regional/article');
  assert.equal(data.items[0].excerpt, 'Evidence © 2026');
  assert.equal(data.items[0].published_at, null);
  assert.equal(data.items[0].updated_at, '2026-11-18T01:00:00.000Z');
  assert.equal(data.items[1].date, null);
});

test('thirty candidates across categories reduce to five events and fetch a confirmed next page', async () => {
  const newspaper = source('news');
  for (let category = 1; category <= 5; category++) {
    newspaper.endpoints.push({url: newspaper.home + 'feed/' + category, category});
  }
  const urls = [];
  const result = await collectNews([newspaper], {
    settings: {minimum_unique_events: 6},
    fetcher: async url => {
      urls.push(url);
      return url.endsWith('/page2') ? new Response(rss([6])) :
        new Response(rss([1, 2, 3, 4, 5]), {headers: {link: '</page2>; rel="next"'}});
    },
  });
  assert.equal(urls.length, 7);
  assert.equal(result.collection.rounds[0].unique_events, 5);
  assert.equal(result.collection.unique_events, 6);
  assert.equal(result.sources[0].exact_duplicates, 25);
  assert.equal(result.items[0].evidence_candidates.length, 6);
});

test('topic gaps trigger supplementation and all-duplicate pages terminate it', async () => {
  const newspaper = source('news');
  const result = await collectNews([newspaper], {
    settings: {minimum_unique_events: 1, topic_minimums: {環境: 1}},
    fetcher: async url => new Response(rss([1]), {
      headers: {link: url.endsWith('/page2') ? '</page3>; rel="next"' : '</page2>; rel="next"'},
    }),
  });
  assert.equal(result.collection.requests, 2);
  assert.deepEqual(result.collection.gaps, ['topic:環境']);
  assert.equal(result.collection.stop_reason, 'no_new_unique_events');
});

test('isolates HTTP and XML errors and never advances cursor after a failed page', async () => {
  const result = await collectNews([source('ok'), source('bad'), source('timeout')], {
    fetcher: async url => {
      if (url.includes('timeout')) throw new DOMException('timed out','TimeoutError');
      if (url.includes('bad')) return new Response('<rss>');
      if (url.endsWith('/next')) return new Response('unavailable', {status: 503});
      return new Response(rss([1]), {headers: {link: '</next>; rel=next'}});
    },
  });
  assert.equal(result.sources[0].cursor, 'https://ok.example/feed');
  assert.equal(result.sources[0].pages[1].error, 'HTTP 503');
  assert.equal(result.sources[1].parse_failures, 1);
  assert.equal(result.sources[2].error, 'timed out');
  assert.equal(result.collection.unique_events, 1);
});

test('explicit approval gates draft sources and rejects title-only or syndicated corroboration', () => {
  const registry = {sources: [
    {source_id:'first', name:'First', topic:'IT', fetch:'rss', url:'https://first.example/feed'},
    {source_id:'draft', name:'Draft', topic:'IT', fetch:'rss', url:'https://draft.example/feed', activation:'disabled_draft'},
  ]};
  assert.deepEqual(loadSourceRegistry(registry).map(item => item.id), ['first']);
  assert.deepEqual(loadSourceRegistry(registry, {trialIds:['draft']}).map(item => item.id), ['draft']);
  const evidence = {fact:'已核對的事實', review_state:'original_read', origin_id:'wire-release', url:'https://first.example/a'};
  const article = {verification_status:'corroborated', facts:[evidence.fact],
    evidence:[evidence, {...evidence,url:'https://other.example/a'}]};
  assert.throws(() => validateReviewedEvidence(article), /同一通稿/);
  article.evidence[1].origin_id = 'independent-report';
  assert.doesNotThrow(() => validateReviewedEvidence(article));
  article.evidence[1].review_state = 'title_only';
  assert.throws(() => validateReviewedEvidence(article), /可讀原文/);
});

test('visits all configured categories before sampling and counts HTTPS redirects against the HTTP budget', async () => {
  const newspaper = source('news');
  newspaper.endpoints.push({url: newspaper.home + 'finance', category: '財經'});
  const result = await collectNews([newspaper], {
    settings: {max_candidates_per_source: 2, max_http_requests: 3},
    fetcher: async url => url.endsWith('/feed')
      ? new Response(null, {status: 302, headers: {location: '/absolute-feed'}})
      : new Response(url.endsWith('/finance') ? rss([4, 5]) : rss([1, 2, 3])),
  });
  assert.equal(result.collection.requests, 3);
  assert.equal(result.sources[0].pages[0].final_url, 'https://news.example/absolute-feed');
  assert.equal(result.sources[0].pages[0].redirected, true);
  assert.deepEqual(result.items.map(item => item.category), ['最新','財經']);
  assert.equal(result.sources[0].candidate_limit_reached, true);
});

test('the configured publisher mirror is fetched only after failure within the original request budget', async () => {
  const primary = 'https://catalog.example/kev.json';
  const mirror = 'https://mirror.example/kev.json';
  const source = {id: 'cisa', name: 'Catalog', topic: '資安', type: 'cisa', home: 'https://catalog.example/',
    endpoints: [{url: primary}], publisherMirror: mirror};
  const data = {vulnerabilities: [{cveID: 'CVE-2026-10000', vulnerabilityName: 'Catalog entry',
    vendorProject: 'Example', product: 'Service', dateAdded: '2026-11-17', dueDate: '2026-12-01'}]};
  const fetcher = async url => url === primary ? new Response(null, {status: 403}) : Response.json(data);
  const recovered = await collectNews([source], {fetcher});
  assert.equal(recovered.collection.requests, 2);
  assert.equal(recovered.sources[0].pages[0].http, 403);
  assert.equal(recovered.sources[0].pages[1].publisher_mirror, true);
  assert.equal(recovered.items[0].catalogue_record.url, mirror);
  const limited = await collectNews([source], {fetcher, settings: {max_http_requests: 1}});
  assert.equal(limited.collection.requests, 1);
  assert.equal(limited.items.length, 0);
  const healthy = await collectNews([source], {fetcher: async () => Response.json(data)});
  assert.equal(healthy.collection.requests, 1);
  assert.equal(healthy.items[0].catalogue_record.url, primary);
});
