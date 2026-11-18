const parsers = new Map([
  ['rss', 'rss'],
  ['github_json', 'github'],
  ['html_list:moenv', 'moenv'],
  ['json:cisa', 'cisa'],
]);

export function safeUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch {
    return null;
  }
  return null;
}

export function loadSourceRegistry(registry, {trialIds = []} = {}) {
  if (!Array.isArray(registry?.sources) || !registry.sources.length) {
    throw Error('SOURCE-REGISTRY.yaml must contain a nonempty sources list');
  }
  const ids = new Set();
  const sources = [];
  for (const entry of registry.sources) {
    const {source_id: id, name, topic, url, home, fetch, activation, region} = entry ?? {};
    const type = parsers.get(fetch + ':' + id) ?? parsers.get(fetch);
    if (![id, name, topic].every(value => typeof value === 'string' && value.trim()) || !type) {
      throw Error('Source requires an ID, name, topic, and supported parser: ' + id);
    }
    if (ids.has(id)) throw Error('Duplicate source ID: ' + id);
    ids.add(id);
    if (![undefined, 'active', 'disabled_draft'].includes(activation)) {
      throw Error('Unknown activation for ' + id);
    }
    const trial = trialIds.includes(id);
    if (activation === 'disabled_draft' && !trial) continue;
    const endpoints = (entry.endpoints ?? []).map(endpoint => ({
      category: endpoint.category,
      url: safeUrl(endpoint.url),
    }));
    const primaryUrl = url ?? (trial ? entry.trial_url : null);
    if (primaryUrl) endpoints.unshift({category: null, url: safeUrl(primaryUrl)});
    const sourceHome = safeUrl(home ?? url);
    if (!sourceHome || !endpoints.length || endpoints.some(endpoint => !endpoint.url)) {
      throw Error('Source requires an HTTPS homepage and collection entry: ' + id);
    }
    sources.push({
      id, name, topic, region: region ?? null, type, home: sourceHome, endpoints,
      allowPagination: entry.allow_pagination === true,
    });
  }
  return trialIds.length ? sources.filter(source => trialIds.includes(source.id)) : sources;
}
