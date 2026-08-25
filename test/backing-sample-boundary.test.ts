import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const bridgeSource = readFileSync(new URL('../src/backing-stdin.ts', import.meta.url), 'utf8');

test('Robot backing boundary is answered from the PCM socket capture cursor', () => {
  assert.match(bridgeSource, /message\.type === 'backing-sample-boundary-request'/);
  assert.match(bridgeSource, /type: 'backing-sample-boundary'/);
  assert.match(bridgeSource, /generation,\s*firstSampleIndex: sampleCursor,/s);
  assert.doesNotMatch(bridgeSource, /firstSampleIndex:\s*(Date|performance)\./);
});
