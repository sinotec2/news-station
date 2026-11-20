import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, rm} from 'node:fs/promises';
import http from 'node:http';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {parse} from 'yaml';
import {collectNews, collectionLimits} from '../worker/news-collection.js';
import {loadSourceRegistry} from '../worker/source-registry.js';
import {validateBriefing} from '../worker/editorial.js';
import {checkEditionForAppend, withEditionLock, writeJsonAtomic} from './add-edition.mjs';
import {buildReviewedArticles} from './editorial-selection.mjs';
import {editionWindow, taipeiDate} from '../worker/edition-window.js';
import {createScheduledEdition, emptyRunStatus, summarizeEditionRun} from '../worker/edition-generation.js';

export {editionWindow};

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const iso = millis => new Date(millis).toISOString();

async function reviewedPack(file, required) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && !required) return {articles: [], sha256: null};
    throw error;
  }
  const data = JSON.parse(text);
  const articles = Array.isArray(data) ? data : data?.articles;
  if (!Array.isArray(articles)) throw Error('Reviewed pack requires an array or an object with an articles array.');
  return {articles, sha256: hash(text)};
}

export async function updateEdition(options, dependencies = {}) {
  const {root = projectRoot, edition, dryRun = false, reviewedFile} = options;
  const {fetcher = fetch, collect = collectNews, select = buildReviewedArticles, now = Date.now} = dependencies;
  if (!dependencies.fetcher) http.setGlobalProxyFromEnv?.();
  const date = options.date ?? taipeiDate(now());
  const window = editionWindow(edition, date);
  const slot = date + '-' + edition;
  const runDir = resolve(options.runDir ?? join(root, '.generated', 'edition-runs'), slot);
  const storePath = join(root, 'content', 'editions.json');
  return withEditionLock(storePath, async () => {
    const started = now();
    const auditDir = join('attempts', iso(started).replaceAll(':', '-') + '-' + randomUUID());
    const attemptPath = join(runDir, auditDir);
    await mkdir(attemptPath, {recursive: true, mode: 0o700});
    const report = {date, edition, window, dry_run: dryRun, started_at: iso(started), attempt: auditDir,
      edition_id: null, edition_file: null};
    async function finish(status, product) {
      report.status = status;
      report.finished_at = iso(now());
      if (product) {
        report.edition_id = product.id;
        report.edition_file = join(auditDir, 'edition.json');
        report.stories = product.articles.length;
        await writeJsonAtomic(join(runDir, report.edition_file), product);
        await writeJsonAtomic(join(runDir, 'edition.json'), product);
      } else {
        await rm(join(runDir, 'edition.json'), {force: true});
      }
      await writeJsonAtomic(join(attemptPath, 'report.json'), report);
      await writeJsonAtomic(join(runDir, 'report.json'), report);
      return report;
    }
    try {
      const existing = JSON.parse(await readFile(storePath, 'utf8'));
      const published = existing.filter(entry => entry.date === date && entry.edition === edition)
        .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at) || b.version - a.version)[0];
      if (published && !dryRun) {
        validateBriefing(published, {now: now()});
        return await finish('already_published', published);
      }
      if (started < Date.parse(window.end)) return await finish('not_due');

      const registryText = await readFile(join(root, 'SOURCE-REGISTRY.yaml'), 'utf8');
      const registry = parse(registryText, {maxAliasCount: 0});
      const sources = loadSourceRegistry(registry);
      const settings = collectionLimits(registry.x_pipeline_proposal);
      const pack = await reviewedPack(reviewedFile ?? join(root, 'content', 'reviewed', slot + '.json'), !!reviewedFile);
      Object.assign(report, {registry_sha256: hash(registryText), reviewed_sha256: pack.sha256,
        active_source_ids: sources.map(source => source.id)});
      const deadline = Date.now() + 120_000;
      const collection = await collect(sources, {settings, fetcher, deadline: Math.min(deadline, Date.now() + 60_000)});
      const intake = {...collection, items: collection.items.map(({excerpt, ...item}) => item)};
      report.collection_file = join(auditDir, 'collection.json');
      await writeJsonAtomic(join(runDir, report.collection_file), intake);
      let requests = collection.collection.requests;
      const reserve = () => {
        if (requests >= settings.max_http_requests || Date.now() >= deadline) return false;
        requests++;
        return true;
      };
      const {articles, ...audit} = await select({collection, sources, registry, existing, window, deadline,
        reserve, fetcher, reviewedArticles: pack.articles, now});
      report.selection_file = join(auditDir, 'selection.json');
      await writeJsonAtomic(join(runDir, report.selection_file), audit);
      const decisions = audit.decisions ?? [];
      Object.assign(report, summarizeEditionRun(collection, decisions, requests), {selected: articles.length});
      report.coverage = audit.coverage;
      report.per_source = collection.sources.map(source => {
        const related = decisions.filter(d => d.source_id === source.source_id ||
          d.originals?.some(original => original.source_id === source.source_id));
        return {source_id: source.source_id, candidates: source.candidates, parse_failures: source.parse_failures,
          exact_duplicates: source.exact_duplicates, unique_events: source.unique_events,
          selected_events: related.filter(d => d.status === 'selected').length,
          pending_events: related.filter(d => d.status === 'pending').length};
      });
      if (dryRun && published?.id === slot + '-1') return await finish('already_published', published);
      if (!articles.length) return await finish(emptyRunStatus(report, decisions));
      const completed = now();
      const product = createScheduledEdition(window, articles, completed);
      checkEditionForAppend(product, existing, {now: completed});
      if (!dryRun) await writeJsonAtomic(storePath, [...existing, product]);
      return await finish(dryRun ? 'dry_run_ready' : 'published', product);
    } catch (error) {
      report.error = error.message;
      await finish('failed');
      throw error;
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const {values, positionals} = parseArgs({allowPositionals: true, options: {
      date: {type: 'string'}, 'dry-run': {type: 'boolean'}, 'run-dir': {type: 'string'},
      reviewed: {type: 'string'}, help: {type: 'boolean', short: 'h'},
    }});
    if (values.help) {
      console.log('Usage: node scripts/update-edition.mjs morning|evening [--date YYYY-MM-DD] [--dry-run] [--reviewed FILE] [--run-dir DIR]');
    } else {
      if (positionals.length !== 1) throw Error('Supply one edition: morning or evening. See --help.');
      const report = await updateEdition({edition: positionals[0], date: values.date, dryRun: values['dry-run'],
        reviewedFile: values.reviewed, runDir: values['run-dir']});
      console.log(JSON.stringify(report, null, 2));
      if (report.status === 'sources_unavailable') process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
