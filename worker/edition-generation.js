// Shared by the local cron publisher and the hosted update button.
export function createScheduledEdition(window, articles, completed) {
  const checkedAt = new Date(completed).toISOString();
  return {
    id: window.date + '-' + window.edition + '-1', date: window.date, edition: window.edition,
    timezone: 'Asia/Taipei', window, cutoff_at: checkedAt, published_at: checkedAt,
    label: window.edition === 'morning' ? '編輯晨報' : '編輯晚報', version: 1,
    coverage_note: '本期依台北時間的晨晚報時段選稿，以已核對的原文資料出刊。', articles,
  };
}

const uncheckedReasons = new Set([
  'invalid_catalogue_record', 'original_not_checked', 'original_request_failed', 'original_http_error',
  'unsupported_original_format', 'original_body_unavailable', 'restricted_original',
  'invalid_original_url', 'unconfirmed_redirect', 'redirect_limit',
]);

export function summarizeEditionRun(collection, decisions, requests) {
  const unavailableOriginals = new Set();
  for (const decision of decisions) {
    for (const original of decision.originals ?? []) {
      if (original.status === 'pending_original') unavailableOriginals.add(original.feed_url);
    }
  }
  const unfinished = decisions.filter(d => uncheckedReasons.has(d.reason));
  const sourcesOk = collection.sources.filter(source => source.ok).length;
  return {
    sources_ok: sourcesOk, sources_total: collection.sources.length,
    http_requests: requests, unique_events: collection.collection.unique_events,
    pending_review: decisions.filter(d => d.reason === 'needs_fact_review_and_chinese_copy').length,
    original_failures: unavailableOriginals.size, unchecked_events: unfinished.length,
    partial: sourcesOk < collection.sources.length || unfinished.length > 0,
  };
}

export function emptyRunStatus(stats, decisions) {
  // Distinguish originals that could not be assessed from a clean "no matching news".
  const editorialCandidates = decisions.filter(d => d.status !== 'technical' && d.status !== 'excluded');
  const unassessed = editorialCandidates.length > 0 && editorialCandidates.every(d => uncheckedReasons.has(d.reason));
  return !stats.sources_ok || unassessed ? 'sources_unavailable' : 'no_qualified_stories';
}
