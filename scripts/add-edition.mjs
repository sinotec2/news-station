// Accept a completed editorial JSON file, validate it, and append it to the publication store.
import {readFile,writeFile,rename} from 'node:fs/promises';
import {validateBriefing} from '../worker/editorial.js';
const file=process.argv[2];if(!file)throw Error('Usage: node scripts/add-edition.mjs <completed-edition.json>');
const edition=validateBriefing(JSON.parse(await readFile(file,'utf8')));
const existing=JSON.parse(await readFile('content/editions.json','utf8'));
if(existing.some(e=>e.id===edition.id))throw Error('Edition ID already exists; corrections require a new edition version and correction history.');
const priorEvents=new Map(existing.filter(e=>e.date===edition.date).flatMap(e=>e.articles.map(a=>[a.event_id,a])));
for(const a of edition.articles){const prior=priorEvents.get(a.event_id);if(prior&&(!a.event_update||!Array.isArray(a.new_facts)||!a.new_facts.length||a.new_facts.some(f=>!a.facts.includes(f)||prior.facts.includes(f))))throw Error('Repeated same-day events require an event_update flag and substantive new_facts included in the cited facts.');}
const next=[...existing,edition];
await writeFile('content/editions.json.tmp',JSON.stringify(next,null,2)+'\n');
await rename('content/editions.json.tmp','content/editions.json');
console.log(`Added ${edition.id}. Run npm test, build, and the Sites publishing workflow to publish.`);
