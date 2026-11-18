import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {parse} from 'yaml';
import {validateBriefing} from './worker/editorial.js';
const editions=JSON.parse(await readFile('content/editions.json','utf8'));
for(const edition of editions)validateBriefing(edition);
const registry = parse(await readFile('SOURCE-REGISTRY.yaml', 'utf8'), {maxAliasCount: 0});
if (!Array.isArray(registry?.sources) || !registry.sources.length) {
  throw Error('SOURCE-REGISTRY.yaml must contain a nonempty sources list');
}
const sourceTypes = new Map([
  ['rss', 'rss'],
  ['html_list', 'moenv'],
  ['github_json', 'github'],
  ['json', 'cisa'],
]);
const sourceIds = new Set();
const sources = registry.sources.map((entry, index) => {
  const {source_id: id, name, topic, url, home, fetch} = entry ?? {};
  const type = sourceTypes.get(fetch);
  const label = `SOURCE-REGISTRY.yaml source #${index + 1}`;
  if (![id, name, topic].every(value => typeof value === 'string' && value.trim()) || !type) {
    throw Error(`${label} requires source_id, name, topic, and a supported fetch type`);
  }
  if (sourceIds.has(id)) throw Error(`${label} duplicates source_id "${id}"`);
  sourceIds.add(id);
  return {id, name, topic, type, url: sourceUrl(url, label, 'url'), home: sourceUrl(home ?? url, label, 'home')};
});
function sourceUrl(value, label, field) {
  if (typeof value === 'string') {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
    } catch {
      // Report malformed and unsupported URLs with the same source-specific error.
    }
  }
  throw Error(`${label} requires an HTTPS ${field} without credentials`);
}
const client=await readFile('web/app.js','utf8');
new Function(client);
if(client.toLowerCase().includes('</script'))throw Error('Unexpected closing script tag');
await mkdir('.generated',{recursive:true});
await writeFile('.generated/edition-data.js','export const EDITIONS = '+JSON.stringify(editions)+';\n');
await writeFile('.generated/client-data.js','export const CLIENT_SCRIPT = '+JSON.stringify(client)+';\n');
await writeFile('.generated/source-data.js', 'export const SOURCES = ' + JSON.stringify(sources) + ';\n');
let worker=await readFile('worker/index.js','utf8');
worker=worker.replace(/^import .*;\n/gm,'');
const policy=(await readFile('worker/editorial.js','utf8')).replace(/export /g,'');
const neural=(await readFile('worker/neural-audio.js','utf8')).replace(/export /g,'');
const bundle='const EDITIONS='+JSON.stringify(editions)+';\nconst CLIENT_SCRIPT='+JSON.stringify(client)+';\nconst SOURCES='+JSON.stringify(sources)+';\n'+policy+'\n'+neural+'\n'+worker;
await mkdir('dist/server',{recursive:true});
await mkdir('dist/.openai',{recursive:true});
await writeFile('dist/server/index.js',bundle);
await copyFile('.openai/hosting.json','dist/.openai/hosting.json');
console.log(`Built ${editions.length} edition(s), ${sources.length} source(s), and client with validated scripts.`);
