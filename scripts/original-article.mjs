import {load} from 'cheerio';
import {createHash} from 'node:crypto';
import {safeUrl} from '../worker/source-registry.js';
import {candidateDecision} from '../worker/editorial.js';

const topicRules = [
  ['資安', /資安|勒索軟體|資料外洩|零時差漏洞|網路攻擊|駭客攻擊|通行密鑰|\bpasskeys?\b|\b(?:cybersecurity|ransomware|data breach|zero-day|CVE-\d{4}|malware|phishing|cyberattack)\b/iu],
  ['AI', /人工智慧|生成式[ＡA][ＩI]|大型語言模型|基礎模型|\bAI\b|\b(?:artificial intelligence|generative AI|large language models?|LLMs?|AI (?:models?|agents?|coding|regulation))\b/iu],
  ['環境', /氣候變遷|減碳|淨零|再生能源|空氣污染|水污染|廢棄物|資源回收|環境影響|碳排|碳權|空污|海洋保育|電網|能源轉型|太陽光電|水庫光電|核電|非廢核|野生動物|都市林|濕地|生態|森林保育|保育物種|海廢|環境政策|\bCOP\d{2}\b|\b(?:climate change|decarbonization|carbon emissions?|renewable energy|air pollution|water pollution|waste management|recycling|power grid|grid reliability|electric utility|landfill|methane|environmental regulations?)\b/iu],
  ['IT', /半導體|晶片|雲端運算|資料中心|軟體開發|電動車|數位基礎設施|衛星通訊|衛星發射|資訊系統|資安服務|晶圓|\b(?:Windows 11|GPUs?|HPC|chip exports?|privacy rules?|cloud migration|satellite(?:s| launch(?:es)?| to orbit))\b|\b(?:semiconductors?|data cent(?:er|re)s?|cloud computing|software engineering|open source|computer chips?|electric vehicles?|digital infrastructure|satellite communications?|video game engines?|Unreal Engine)\b/iu],
  ['綜合', /(?:立法|國會|行政院|主管機關|政府).{0,24}(?:法案|政策|法規|公共建設|緊急措施|預算)|台海和平|\bAPEC\b|(?:地震|颱風|洪災|停電).{0,20}(?:撤離|警報|災情|停班停課)|\b(?:public health emergency|emergency evacuation|infrastructure funding|public policy reform|government shutdown)\b/iu],
];
const unrelated = /賽事|戰績|職棒|職籃|比數|季後賽|羽賽|紅毯|演唱會|音樂會|新劇|影視花絮|藝人戀情|星座運勢|抽獎|折扣碼|\b(?:game score|playoff results|celebrity gossip|red carpet|concert tour|horoscope|giveaway|coupon codes?)\b/iu;

function normalizedHost(address) {
  return new URL(address).hostname.replace(/^www\./, '');
}

function samePublisher(a, b) {
  const x = normalizedHost(a);
  const y = normalizedHost(b);
  return x === y || x.endsWith('.' + y) || y.endsWith('.' + x);
}

function parseSchema($) {
  function articles(node) {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(articles);
    if ([node['@type']].flat().some(value => typeof value === 'string' && /(?:Article|BlogPosting)$/i.test(value))) return [node];
    return articles(node['@graph']);
  }
  return $('script[type="application/ld+json"]').toArray().flatMap(script => {
    try { return articles(JSON.parse($(script).text())); } catch { return []; }
  })[0];
}

function plain(value) {
  return value?.replace(/\s+/gu, ' ').trim() ?? '';
}

export function inspectArticleHtml(html, finalUrl) {
  const $ = load(html);
  const info = parseSchema($);
  const meta = property => $('meta').filter((_, node) =>
    $(node).attr('property') === property || $(node).attr('name') === property
  ).first().attr('content');
  const address = safeUrl($('link[rel="canonical"]').first().attr('href') ?? meta('og:url'), finalUrl);
  const canonicalUrl = address && samePublisher(finalUrl, address) ? address : finalUrl;
  const published = info?.datePublished ?? meta('article:published_time') ?? meta('datePublished');
  const updated = info?.dateModified ?? meta('article:modified_time');
  const title = plain(info?.headline || $('main h1, article h1').first().text() || meta('og:title') || $('title').first().text());
  const locked = [false, 'false', 0].includes(info?.isAccessibleForFree);
  $('nav, footer, aside, [aria-hidden="true"], script, style, [class*="related"], [class*="recommend"]').remove();
  const story = $('[itemprop="articleBody"], .article-body, .article-content, .entry-content, .node__content, .field-name-body, .article__body, .paragraph, [class*="post-content__Content"]').first();
  const articlePage = Boolean(info || story.length || $('article h1').length || meta('og:type') === 'article');
  const fallback = $('article').first().length ? $('article').first() : $('main').first();
  const paragraphs = (story.length ? story : fallback).find('p').toArray();
  const body = locked ? '' : plain(paragraphs.map(node => $(node).text()).join(' ') || (story.length ? story.text() : ''));
  return {title, body, articlePage, locked, canonicalUrl, sponsored: Boolean(info?.sponsor),
    publishedAt: Number.isFinite(Date.parse(published)) ? published : null,
    updatedAt: Number.isFinite(Date.parse(updated)) ? updated : null};
}

export function decideArticle(article) {
  if (!article.articlePage || article.locked || article.body.length < 100) {
    return {status: 'pending_original', reason: article.locked ? 'restricted_original' : 'original_body_unavailable'};
  }
  const head = article.title;
  const lede = article.body.slice(0, 4200);
  const out = head.match(unrelated);
  const bodyScope = out ? lede.slice(0, 650) : lede;
  const match = topicRules.find(([, rule]) => rule.test(head))
    ?? topicRules.find(([, rule]) => rule.test(bodyScope));
  if (match) {
    const [topic, rule] = match;
    return {status: 'in_scope', topic, reason: 'original_scope_match',
      matched_term: head.match(rule)?.[0] ?? bodyScope.match(rule)?.[0]};
  }
  if (out) return {status: 'out_of_scope', reason: 'original_covers_unrelated_subject', matched_term: out[0]};
  return {status: 'pending_scope', reason: 'original_scope_unclear'};
}

async function readLimited(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const limit = 512 * 1024;
  let bytes = 0;
  let html = '';
  try {
    while (bytes < limit && !/<\/article\s*>/i.test(html)) {
      const {done, value} = await reader.read();
      if (done) break;
      html += decoder.decode(value.subarray(0, limit - bytes), {stream: true});
      bytes += value.byteLength;
    }
    return html + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function reviewOriginal(candidate, {fetcher = fetch, reserve, deadline, timeout = 15000}) {
  const input = safeUrl(candidate.url);
  const checked = {feed_url: candidate.url, feed_title: candidate.title, feed_date: candidate.date ?? null};
  if (!input) return {...checked, status: 'pending_original', reason: 'invalid_original_url'};
  let url = input;
  const signal = AbortSignal.timeout(Math.max(1, Math.min(timeout, deadline - Date.now())));
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (!reserve()) return null;
      const response = await fetcher(url, {headers: {'User-Agent': 'NewsStation/0.1'}, redirect: 'manual', signal});
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const target = safeUrl(response.headers.get('location'), url);
        await response.body?.cancel();
        if (!target || !samePublisher(input, target) || target === url) {
          return {...checked, status: 'pending_original', reason: 'unconfirmed_redirect', http_status: response.status};
        }
        url = target;
        continue;
      }
      if (!response.ok || !response.headers.get('content-type')?.includes('html')) {
        await response.body?.cancel();
        return {...checked, status: 'pending_original', reason: response.ok ? 'unsupported_original_format' : 'original_http_error',
          http_status: response.status, retry_after: response.headers.get('retry-after')};
      }
      const article = inspectArticleHtml(await readLimited(response), url);
      const classification = candidateDecision({title:article.title, excerpt:article.body.slice(0, 750),
        sponsored:article.sponsored, url:article.canonicalUrl});
      return {
        ...checked, ...decideArticle(article), http_status: response.status,
        original_url: article.canonicalUrl, original_title: article.title || null,
        original_published_at: article.publishedAt, original_body_read: Boolean(article.body),
        original_updated_at: article.updatedAt,
        editorial_lane: classification.lane,
        ...(article.body && !article.locked ? {body_sha256: createHash('sha256').update(article.body).digest('hex')} : {}),
      };
    }
    return {...checked, status: 'pending_original', reason: 'redirect_limit'};
  } catch (error) {
    return {...checked, status: 'pending_original', reason: 'original_request_failed', error: error.cause?.message ?? error.message};
  }
}
