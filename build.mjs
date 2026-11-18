import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {parse} from 'yaml';
import {build} from 'esbuild';
import {validateBriefing} from './worker/editorial.js';
import {loadSourceRegistry} from './worker/source-registry.js';
import {collectionLimits} from './worker/news-collection.js';
const editions=JSON.parse(await readFile('content/editions.json','utf8'));
for(const edition of editions)validateBriefing(edition);
const registry = parse(await readFile('SOURCE-REGISTRY.yaml', 'utf8'), {maxAliasCount: 0});
const sources = loadSourceRegistry(registry);
const settings = collectionLimits(registry.x_pipeline_proposal);
const client=await readFile('web/app.js','utf8');
new Function(client);
if(client.toLowerCase().includes('</script'))throw Error('Unexpected closing script tag');
await mkdir('.generated',{recursive:true});
await writeFile('.generated/edition-data.js','export const EDITIONS = '+JSON.stringify(editions)+';\n');
await writeFile('.generated/client-data.js','export const CLIENT_SCRIPT = '+JSON.stringify(client)+';\n');
await writeFile('.generated/source-data.js',
  'export const SOURCES = ' + JSON.stringify(sources) + ';\n' +
  'export const COLLECTION_SETTINGS = ' + JSON.stringify(settings) + ';\n');
await build({
  entryPoints: ['worker/index.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: 'dist/server/index.js',
});
await mkdir('dist/.openai',{recursive:true});
await copyFile('.openai/hosting.json','dist/.openai/hosting.json');
console.log(`Built ${editions.length} edition(s), ${sources.length} source(s), and client with validated scripts.`);
