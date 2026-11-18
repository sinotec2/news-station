import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {updateEdition} from './update-edition.mjs';
import {publishReport} from './publish-edition.mjs';

try {
  const {values, positionals} = parseArgs({allowPositionals:true, options:{
    date:{type:'string'}, 'run-dir':{type:'string'}, reviewed:{type:'string'}, 'dry-run':{type:'boolean'},
  }});
  if (positionals.length !== 1) throw Error('Usage: scripts/cron-edition.sh morning|evening [--date YYYY-MM-DD] [--dry-run] [--reviewed FILE]');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const runDir = resolve(values['run-dir'] || resolve(root, '.generated/edition-runs'));
  const report = await updateEdition({root, runDir, edition:positionals[0], date:values.date, dryRun:values['dry-run'], reviewedFile:values.reviewed});
  const directory = resolve(runDir, report.date + '-' + report.edition);
  console.log(JSON.stringify({status:report.status, edition_id:report.edition_id, report:resolve(directory, 'report.json')}));
  if (report.status === 'sources_unavailable') process.exitCode = 1;
  if (!report.dry_run && process.env.NEWS_STATION_URL) console.log(JSON.stringify(await publishReport(report,directory)));
} catch (error) { console.error(error.message); process.exitCode = 1; }
