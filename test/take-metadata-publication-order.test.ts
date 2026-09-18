import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  classMethodCode,
  parseTypeScriptSource,
} from './support/source-contract.js';

const controller = parseTypeScriptSource(
  new URL('../src/take-controller.ts', import.meta.url),
  readFileSync(new URL('../src/take-controller.ts', import.meta.url), 'utf8'),
);

test('Take finalization stages rich metadata before publishing the WAV', () => {
  const finalize = classMethodCode(controller, 'TakeController', 'finalizeWriter');
  const stage = finalize.indexOf('this.library.stageFinalizing(');
  const publish = finalize.indexOf('const file = await writer.finalize();');
  const complete = finalize.indexOf('const completed = this.session.complete(');
  const commit = finalize.indexOf('this.library.commitStaged(readyTake)');
  const fallback = finalize.indexOf('this.library.record(readyTake)');

  assert.ok(stage >= 0, 'rich metadata must be staged during finalization');
  assert.ok(publish > stage, 'metadata partial must be fsynced before WAV durable publication');
  assert.ok(complete > publish, 'Take may only become ready after the WAV is published');
  assert.ok(commit > complete, 'the staged sidecar may only commit after the Take is ready');
  assert.ok(fallback > complete, 'legacy metadata write fallback remains post-publication only');

  assert.match(
    finalize,
    /if \(metadataStaged\) \{\s*libraryEntry = this\.library\.commitStaged\(readyTake\);\s*metadataStaged = false;\s*\} else \{\s*libraryEntry = this\.library\.record\(readyTake\);\s*\}/,
  );
  assert.match(
    finalize,
    /discardStagedMetadata\(\);\s*await writer\.discardFinalized\(\);/,
    'failed or rejected WAV publication must not leave an in-process staged sidecar orphan',
  );
});
