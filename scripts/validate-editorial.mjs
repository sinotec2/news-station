import {readFile} from 'node:fs/promises';
import {validateBriefing} from '../worker/editorial.js';
const editions=JSON.parse(await readFile('content/editions.json','utf8'));
for(const e of editions)validateBriefing(e);
console.log(`Validated ${editions.length} edition(s), ${editions.reduce((n,e)=>n+e.articles.length,0)} edited stories with fact-level citations and spoken scripts.`);
