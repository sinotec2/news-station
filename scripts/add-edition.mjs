import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir, open, readFile, realpath, rename, rm} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateBriefing, validateReviewedEvidence} from '../worker/editorial.js';

export async function writeJsonAtomic(path, data) {
  const tmp = path + '.' + randomUUID() + '.tmp';
  try {
    const file = await open(tmp, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(data, null, 2) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, path);
  } finally {
    await rm(tmp, {force: true});
  }
}

// All local publishers share this kernel lock, including when a job is killed mid-run.
export async function withEditionLock(storePath, operation) {
  const store = await realpath(storePath);
  const lockDir = join(dirname(store), '..', '.generated', 'locks');
  await mkdir(lockDir, {recursive: true});
  const lockFile = join(lockDir, 'publication.lock');
  const holder = spawn('flock', ['-x', '-w', '180', lockFile, process.execPath,
    '-e', 'process.stdout.write("locked");process.stdin.resume()'], {stdio: ['pipe', 'pipe', 'inherit']});
  const closed = once(holder, 'close');
  try {
    await Promise.race([
      once(holder.stdout, 'data'),
      closed.then(([code]) => { throw Error('Could not acquire the edition publication lock (' + code + ')'); }),
    ]);
    return await operation();
  } finally {
    holder.stdin.end();
    await closed;
  }
}

export function checkEditionForAppend(edition, existing, options) {
  validateBriefing(edition, options);
  for (const article of edition.articles) validateReviewedEvidence(article);
  if (existing.some(entry => entry.id === edition.id)) {
    throw Error('Edition ID already exists; corrections require a new edition version and correction history.');
  }
  const prior = existing.filter(entry => entry.date === edition.date).flatMap(entry => entry.articles);
  for (const article of edition.articles) {
    const previous = prior.filter(entry => entry.event_id === article.event_id);
    if (previous.length && (!article.event_update || !Array.isArray(article.new_facts) || !article.new_facts.length
      || article.new_facts.some(fact => !article.facts.includes(fact) || previous.some(entry => entry.facts.includes(fact))))) {
      throw Error('Repeated same-day events require an event_update flag and cited, substantive new_facts.');
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file] = process.argv.slice(2);
  if (!file) throw Error('Usage: node scripts/add-edition.mjs <completed-edition.json>');
  const edition = JSON.parse(await readFile(file, 'utf8'));
  const store = fileURLToPath(new URL('../content/editions.json', import.meta.url));
  await withEditionLock(store, async () => {
    const existing = JSON.parse(await readFile(store, 'utf8'));
    checkEditionForAppend(edition, existing);
    await writeJsonAtomic(store, [...existing, edition]);
  });
  console.log(`Added ${edition.id}. Run npm test, build, and the hosting workflow to publish.`);
}
