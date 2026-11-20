export function bucket(pageSize = Infinity) {
  const objects = new Map();
  let serial = 0;
  return {
    objects,
    async get(key) {
      const stored = objects.get(key);
      return stored ? {etag: stored.etag, json: async () => JSON.parse(stored.data)} : null;
    },
    async put(key, data, {onlyIf,customMetadata}) {
      const existing = objects.get(key);
      if (onlyIf.etagDoesNotMatch === '*' && existing) return null;
      if (onlyIf.etagMatches && onlyIf.etagMatches !== existing?.etag) return null;
      const etag = (++serial).toString();
      objects.set(key, {data, etag, customMetadata});
      return {etag};
    },
    async list({prefix, limit, startAfter, cursor}) {
      const keys = [...objects.keys()].filter(k => k.startsWith(prefix) && k > (cursor || startAfter || '')).sort();
      const selected = keys.slice(0, Math.min(pageSize, limit));
      return {objects: selected.map(key => ({key,customMetadata:objects.get(key).customMetadata})), cursor: selected.at(-1), truncated: selected.length < keys.length};
    }
  };
}
