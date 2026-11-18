import {SaxesParser} from 'saxes';
import {decode} from 'he';
import {safeUrl} from './source-registry.js';

const excerptLimit = 750;

function clean(value) {
  return decode(String(value ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function timestamp(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function feedRows(body, address) {
  const parser = new SaxesParser({xmlns: true});
  const stack = [];
  const rows = [];
  let root;
  let row;
  let rowDepth;
  parser.on('doctype', () => { throw Error('Feed DTD is unsupported'); });
  parser.on('opentag', tag => {
    const parent = stack.at(-1);
    const base = tag.attributes['xml:base']?.value;
    const node = {
      local: tag.local, base: safeUrl(base, parent?.base ?? address) ?? parent?.base ?? address, text: '',
    };
    stack.push(node);
    root ??= node.local.toLowerCase();
    if (!row && ['item', 'entry'].includes(node.local)) {
      row = {links: [], fields: {}};
      rowDepth = stack.length;
    }
    if (row && stack.length === rowDepth + 1 && node.local === 'link') {
      const href = tag.attributes.href?.value;
      const rel = tag.attributes.rel?.value ?? 'alternate';
      if (href && rel === 'alternate') row.links.push(safeUrl(href, node.base));
    }
  });
  const addText = text => {
    if (row) {
      const field = stack[rowDepth];
      if (field) field.text += text;
    }
  };
  parser.on('text', addText);
  parser.on('cdata', addText);
  parser.on('closetag', () => {
    const node = stack.pop();
    if (!row) return;
    if (stack.length === rowDepth) {
      if (node.local === 'link') row.links.push(safeUrl(node.text.trim(), node.base));
      row.fields[node.local] ??= node.text;
    }
    if (stack.length === rowDepth - 1) {
      const f = row.fields;
      const url = row.links.find(Boolean) ?? safeUrl(f.guid, node.base);
      rows.push({
        guid: (f.guid ?? f.id)?.trim(), url, title: clean(f.title),
        date: timestamp(f.pubDate ?? f.published ?? f.date) ?? timestamp(f.updated),
        published_at: timestamp(f.pubDate ?? f.published ?? f.date),
        updated_at: timestamp(f.updated),
        excerpt: clean(f.description ?? f.summary ?? f.encoded ?? f.content).slice(0, excerptLimit),
      });
      row = null;
    }
  });
  parser.write(body).close();
  if (!['rss', 'rdf', 'feed'].includes(root)) throw Error('Not an RSS or Atom feed');
  return {rows, format: root === 'feed' ? 'Atom' : 'RSS'};
}

export function readSource(source, body, {address = source.home, category = null} = {}) {
  let rows;
  let format;
  if (source.type === 'github') {
    format = 'JSON';
    rows = JSON.parse(body).filter(item => !item.draft && !item.prerelease).map(item => ({
      guid: String(item.id), title: item.name || item.tag_name, url: item.html_url,
      date: timestamp(item.published_at), excerpt: clean(item.body).slice(0, excerptLimit),
    }));
  } else if (source.type === 'cisa') {
    format = 'JSON';
    rows = JSON.parse(body).vulnerabilities.map(item => ({
      guid: item.cveID, title: item.cveID + ' · ' + item.vulnerabilityName,
      url: 'https://www.cve.org/CVERecord?id=' + encodeURIComponent(item.cveID),
      date: timestamp(item.dateAdded), excerpt: clean(item.shortDescription).slice(0, excerptLimit),
      catalogue_record: {
        url: address, cve: item.cveID, vendor: item.vendorProject, product: item.product,
        added: item.dateAdded, due: item.dueDate, required_action: item.requiredAction,
      },
    })).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  } else if (source.type === 'moenv') {
    format = 'HTML';
    rows = [...body.matchAll(/<a\b[^>]*href=["']([^"']*\/News\/\d+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
      .map(match => ({title: clean(match[2]), url: match[1], date: null, excerpt: ''}))
      .filter(row => row.title.length >= 8);
  } else {
    ({rows, format} = feedRows(body, address));
  }
  const items = rows.flatMap((row, index) => {
    const url = safeUrl(row.url, address);
    if (!row.title || !url) return [];
    return [{
      ...row, url, id: source.id + ':' + (row.guid || url), source_id: source.id,
      source: source.name, source_url: source.home, topic: source.topic, region: source.region,
      category, source_rank: index + 1, status: 'unreviewed',
    }];
  });
  return {items, format, rejected: rows.length - items.length, parsed: rows.length};
}
