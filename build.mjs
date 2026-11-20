import {mkdir,readdir,readFile,writeFile,rm} from 'node:fs/promises';
import {parse} from 'yaml';
import {build} from 'esbuild';
import {validateBriefing} from './worker/editorial.js';
import {loadSourceRegistry} from './worker/source-registry.js';
import {collectionLimits} from './worker/news-collection.js';
// A checkout used for local reading may have no Sites identity.
const builtManifest='dist/.openai/hosting.json';
await rm(builtManifest,{force:true});
const manifestText=await readFile('.openai/hosting.json','utf8').catch(error=>{
  if(error.code==='ENOENT')return '';
  throw error;
});
const siteManifest=manifestText.trim()?JSON.parse(manifestText):{};
if(!siteManifest||typeof siteManifest!=='object'||Array.isArray(siteManifest))throw Error('Invalid Sites hosting manifest');
const editions=JSON.parse(await readFile('content/editions.json','utf8'));
for(const edition of editions)validateBriefing(edition);
const registry = parse(await readFile('SOURCE-REGISTRY.yaml', 'utf8'), {maxAliasCount: 0});
const sources = loadSourceRegistry(registry);
const settings = collectionLimits(registry.x_pipeline_proposal);
const activeIds = new Set(sources.map(source => source.id));
const editorialRegistry = {
  sources: registry.sources.filter(source => activeIds.has(source.source_id)),
  x_pipeline_proposal: registry.x_pipeline_proposal,
};
const reviewedDir = 'content/reviewed';
const reviewedFiles = await readdir(reviewedDir).catch(error => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
const reviewedPacks = {};
for (const filename of reviewedFiles.sort()) {
  if (!/^\d{4}-\d{2}-\d{2}-(morning|evening)\.json$/.test(filename)) continue;
  const pack = JSON.parse(await readFile(reviewedDir + '/' + filename, 'utf8'));
  const articles = Array.isArray(pack) ? pack : pack?.articles;
  if (!Array.isArray(articles)) throw Error('Invalid reviewed articles in ' + filename);
  reviewedPacks[filename.slice(0, -5)] = articles;
}
const client=await readFile('web/app.js','utf8');
new Function(client);
if(client.toLowerCase().includes('</script'))throw Error('Unexpected closing script tag');
await mkdir('.generated',{recursive:true});
await writeFile('.generated/edition-data.js','export const EDITIONS = '+JSON.stringify(editions)+';\n');
await writeFile('.generated/client-data.js','export const CLIENT_SCRIPT = '+JSON.stringify(client)+';\n');
await writeFile('.generated/source-data.js',
  'export const SOURCES = ' + JSON.stringify(sources) + ';\n' +
  'export const SOURCE_REGISTRY = ' + JSON.stringify(editorialRegistry) + ';\n' +
  'export const REVIEWED_PACKS = ' + JSON.stringify(reviewedPacks) + ';\n' +
  'export const COLLECTION_SETTINGS = ' + JSON.stringify(settings) + ';\n');
await build({
  entryPoints: ['worker/index.js'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: 'dist/server/index.js',
});
if(typeof siteManifest.project_id==='string'&&siteManifest.project_id.trim()){
  await mkdir('dist/.openai',{recursive:true});
  await writeFile(builtManifest,manifestText);
}
console.log(`Built ${editions.length} edition(s), ${sources.length} source(s), and client with validated scripts.`);
