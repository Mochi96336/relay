import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const file = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');

test('every Mic gain set by code reaches the local file mix, not only slider input', async () => {
  const mix = await file('../public/mix-controls.js');
  const ui = await file('../public/local-file-ui.js');
  assert.match(mix, /function showMicGain\(value\) \{\s*micGain\.value = String\(value\);\s*window\.dispatchEvent\(new Event\('relay-mic-gain-shown'\)\);/);
  // The helper is the only writer of the slider's value.
  assert.equal(mix.match(/micGain\.value = /g)?.length, 1);
  assert.match(mix, /if \(!secondaryActive && !sliderIsBusy\(micGain\)\) showMicGain\(nextGain\);/);
  assert.match(ui, /window\.addEventListener\('relay-mic-gain-shown', syncVocalGain\);/);
});
