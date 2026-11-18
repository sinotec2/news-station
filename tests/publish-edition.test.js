import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {publishReport} from '../scripts/publish-edition.mjs';

test('dry runs and empty slots never use publication credentials or contact a site', async () => {
  for (const report of [{status:'dry_run_ready',dry_run:true},{status:'no_qualified_stories'}]) {
    const result = await publishReport(report, '.', {env:{},fetcher:()=>assert.fail('unexpected request')});
    assert.equal(result.published,false);
  }
  await assert.rejects(publishReport({status:'failed'},'.'));
});

test('a report must point to an edition within the run folder and match its slot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'news-publish-'));
  try {
    const report = {status:'published',edition_file:'../elsewhere.json'};
    await assert.rejects(publishReport(report, dir), /Invalid report edition path/);
    await writeFile(join(dir, 'empty.json'), '{}');
    await assert.rejects(publishReport({...report,edition_file:'empty.json'}, dir), /日期/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
