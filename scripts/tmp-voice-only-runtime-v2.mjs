import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const sourcePath = 'scripts/tmp-voice-only-runtime.mjs';
let source = readFileSync(sourcePath, 'utf8');

function patchOnce(before, after, label) {
  assert.equal(source.split(before).length - 1, 1, label);
  source = source.replace(before, after);
}

patchOnce(
  "]) assert.equal(issueCodes.has(code), false, `${code} must not describe an intentional voice-only Take`);",
  "]) assert.equal(issueCodes.has(code), false, String(code) + ' must not describe an intentional voice-only Take');",
  'expected one nested template diagnostic',
);
patchOnce(
  'function feedMic(client, frames, value = 4_000) {',
  'function feedMic(client: RelayClient, frames: number, value = 4_000) {',
  'expected one feedMic test helper',
);
patchOnce(
  '.map((issue) => issue.code)',
  '.map((issue: { code: string }) => issue.code)',
  'expected one issue-code mapper',
);

const fixedPath = '/tmp/relay-voice-only-runtime-fixed.mjs';
writeFileSync(fixedPath, source);
await import(pathToFileURL(fixedPath).href);
