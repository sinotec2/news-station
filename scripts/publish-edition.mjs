import {readFile} from 'node:fs/promises';
import http from 'node:http';
import {dirname, isAbsolute, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual, parseArgs} from 'node:util';
import {validateBriefing} from '../worker/editorial.js';

export async function publishReport(report, directory, {env = process.env, fetcher = fetch} = {}) {
  if (!['published', 'already_published'].includes(report.status) || report.dry_run) {
    if (['no_qualified_stories','not_due','dry_run_ready'].includes(report.status) || report.dry_run) {
      return {published:false, status:report.status};
    }
    throw Error('The update report does not contain a publishable issue: ' + report.status);
  }
  if (typeof report.edition_file !== 'string') throw Error('Missing reviewed edition file.');
  const path = resolve(directory, report.edition_file);
  const local = relative(directory, path);
  if (isAbsolute(report.edition_file) || local.startsWith('..') || isAbsolute(local)) throw Error('Invalid report edition path.');
  const edition = validateBriefing(JSON.parse(await readFile(path, 'utf8')));
  if (edition.id !== report.edition_id || edition.date !== report.date || edition.edition !== report.edition) {
    throw Error('The exported issue does not match the update report.');
  }
  const site = new URL(env.NEWS_STATION_URL);
  if (site.protocol !== 'https:' || site.username || site.password || site.pathname !== '/' || site.search || site.hash) {
    throw Error('NEWS_STATION_URL must be the HTTPS origin of your station.');
  }
  if (!env.EDITION_PUBLISH_TOKEN) throw Error('Missing EDITION_PUBLISH_TOKEN.');
  if (fetcher === fetch) http.setGlobalProxyFromEnv?.();
  const access = {};
  if (env.SITES_ACCESS_TOKEN) access['OAI-Sites-Authorization'] = 'Bearer ' + env.SITES_ACCESS_TOKEN;
  async function request(pathname, options = {}) {
    const response = await fetcher(new URL(pathname, site), {
      ...options, headers:{...access, ...options.headers}, redirect:'error', signal:AbortSignal.timeout(30000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body) throw Error('Station returned HTTP ' + response.status + (typeof body?.error === 'string' ? ' (' + body.error + ')' : ''));
    return body;
  }
  const receipt = await request('/api/editions/publish', {
    method:'POST', headers:{'Content-Type':'application/json','X-Edition-Publish-Token':env.EDITION_PUBLISH_TOKEN}, body:JSON.stringify(edition),
  });
  if (receipt.edition_id !== edition.id) throw Error('Station returned a receipt for a different edition.');
  const query = new URLSearchParams({date:edition.date, edition:edition.edition});
  const result = await request('/api/editions?' + query);
  if (!isDeepStrictEqual(result.editions?.find(row => row.id === edition.id), edition)) {
    throw Error('Edition readback did not match. Re-run the same slot to reconcile.');
  }
  return {published:true, status:receipt.created?'created':'already_present', edition_id:edition.id, stories:edition.articles.length, verified:true};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const {values} = parseArgs({options:{report:{type:'string'}}});
    if (!values.report) throw Error('Usage: node scripts/publish-edition.mjs --report <slot-directory>/report.json');
    const path = resolve(values.report);
    const report = JSON.parse(await readFile(path,'utf8'));
    console.log(JSON.stringify(await publishReport(report, dirname(path))));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
