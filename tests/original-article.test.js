import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewOriginal} from '../scripts/original-article.mjs';

const source = 'https://news.example/story';
const feed = {url: source, title: 'RSS 編輯另寫的標題', date: '2026-11-18T11:00:13Z'};
const deadline = () => Date.now() + 10000;
const readable = content => '<html><head><meta property="og:type" content="article"></head><body>' + content + '</body></html>';

function review(html, item = feed) {
  return reviewOriginal(item, {
    deadline: deadline(), reserve: () => true,
    fetcher: async () => new Response(html,{headers:{'content-type':'text/html; charset=utf-8'}}),
  });
}

test('original coverage keeps a relevant story even when the RSS title and time differ', async () => {
  const result = await review(readable(`
  <link rel="canonical" href="/canonical">
  <meta property="article:published_time" content="2026-11-18T11:00:00Z">
  <main><h1>水庫光電與公共能源政策</h1>
  <div class="post-content__Content-sc-example">${'研究評估水面型光電對供電與水質的影響，並提出長期監測。'.repeat(8)}</div></main>`));
  assert.equal(result.status, 'in_scope');
  assert.equal(result.topic, '環境');
  assert.equal(result.original_url, 'https://news.example/canonical');
  assert.equal(result.original_published_at, '2026-11-18T11:00:00Z');
  assert.equal(result.feed_date, '2026-11-18T11:00:13Z');
});

test('RSS wording never puts an unrelated original into the collection', async () => {
  const result = await review(readable(`<article><h1>職棒季後賽比數</h1>
  <p>${'本場比賽由兩支球隊對戰，球員陸續在後半場得分。'.repeat(8)}</p></article>`),
  {...feed,title:'人工智慧政策與公共建設'});
  assert.equal(result.status,'out_of_scope');
});

test('blocked or ambiguous articles are held for review while the queue advances', async () => {
  const locked = await reviewOriginal(feed, {
    deadline: deadline(), reserve: () => true,
    fetcher: async () => new Response(null,{status:429,headers:{'retry-after':'60'}}),
  });
  assert.equal(locked.status,'pending_original');
  assert.equal(locked.retry_after,'60');
  const weak = await review(readable(`<article><h1>新計畫</h1>
  <p>${'原文介紹專案，但是沒有交代它屬於哪一個工作領域。'.repeat(8)}</p></article>`));
  assert.equal(weak.status,'pending_scope');
});

test('only article metadata and accessible text are used, and an HTTP budget defers remaining work', async () => {
  const locked = await review(readable(`
    <script type="application/ld+json">{"@type":"NewsArticle","headline":"生成式 AI 產業案例","isAccessibleForFree":false}</script>
    <article><p>${'人工智慧報導'.repeat(20)}</p></article>`));
  assert.equal(locked.status,'pending_original');
  assert.equal(locked.original_body_read,false);
  assert.equal(await reviewOriginal(feed,{deadline:deadline(),reserve:()=>false,
    fetcher:async()=>assert.fail('budget exhausted')}),null);
});
