import {collectNews, collectionLimits} from './news-collection.js';
import {buildReviewedArticles} from './editorial-selection.js';
import {createScheduledEdition, emptyRunStatus, summarizeEditionRun} from './edition-generation.js';
import {latestDueWindow} from './edition-window.js';
import {claimEditionRefresh, getEditionForDate, publishEdition, readRecentEditions, releaseEditionRefresh} from './edition-store.js';

// Leave subrequests for seven archive days, the fenced publication, and readback.
const SOURCE_REQUEST_LIMIT = 22;
const RUN_TIME_MS = 32_000;

function publishedResult(base, edition, status) {
  return {...base, status, edition_id: edition.id, stories: edition.articles.length,
    published_at: edition.published_at};
}

export async function refreshEdition({
  env, bundled, sources, registry, settings = {}, reviewedPacks = {}, reviewedArticles, fetcher = fetch, now = Date.now,
}) {
  const started = now();
  const window = latestDueWindow(started);
  const {date, edition: slot} = window;
  const base = {date, edition: slot, window, edition_id: null, stories: 0};
  const pending = (expiresAt) => ({...base, status: 'in_progress',
    retry_after_seconds: Math.max(1, Math.min(5, Math.ceil((expiresAt - now()) / 1000)))});
  let claim;
  try {
    claim = await claimEditionRefresh(env, bundled, date, slot, {now: started});
  } catch (error) {
    if (error.code === 'publication_busy') return pending(now() + 1000);
    throw error;
  }
  if (claim.status === 'already_published') return publishedResult(base, claim.edition, claim.status);
  if (claim.status === 'in_progress') return pending(claim.expiresAt);

  let committed = false;
  try {
    const history = await readRecentEditions(env, bundled, date, {days: 7});
    const limits = collectionLimits(settings);
    limits.max_http_requests = Math.min(limits.max_http_requests, SOURCE_REQUEST_LIMIT);
    limits.request_timeout_ms = Math.min(limits.request_timeout_ms, 6000);
    const deadline = Date.now() + RUN_TIME_MS;
    const collection = await collectNews(sources, {
      settings: limits, fetcher, deadline: deadline - 14_000,
    });
    let requests = collection.collection.requests;
    const reserve = () => {
      if (requests >= limits.max_http_requests || Date.now() >= deadline) return false;
      requests++;
      return true;
    };
    const approved = reviewedArticles ?? reviewedPacks[date + '-' + slot] ?? [];
    const {articles, decisions} = await buildReviewedArticles({
      collection, sources, registry, existing: history, window, deadline, reserve, fetcher, reviewedArticles: approved, now,
    });
    const completed = now();
    const stats = {...base, ...summarizeEditionRun(collection, decisions, requests),
      checked_at: new Date(completed).toISOString()};
    if (!articles.length) return {...stats, status: emptyRunStatus(stats, decisions)};

    const product = createScheduledEdition(window, articles, completed);
    const receipt = await publishEdition(env, bundled, product, {leaseId: claim.leaseId, now: completed});
    committed = true;
    const stored = await getEditionForDate(env, bundled, date, slot);
    if (!stored || JSON.stringify(stored) !== JSON.stringify(product)) {
      throw Object.assign(Error('Could not verify the published edition'), {code:'edition_readback_failed', status:503});
    }
    return publishedResult(stats, stored, receipt.created ? 'published' : 'already_published');
  } catch (error) {
    if (!['slot_already_published', 'publication_busy', 'refresh_lease_lost', 'repeated_event_without_new_facts'].includes(error.code)) throw error;
    const winner = await getEditionForDate(env, bundled, date, slot);
    if (winner) return publishedResult(base, winner, 'already_published');
    return pending(now() + 1000);
  } finally {
    // A process interruption is covered by the lease expiry. A completed write remains durable.
    try { if (!committed) await releaseEditionRefresh(env, date, slot, claim.leaseId); }
    catch { console.warn('edition_refresh_lease_release_failed', date, slot); }
  }
}
