import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const sourcePath = 'scripts/tmp-voice-only-runtime.mjs';
const source = readFileSync(sourcePath, 'utf8');
const needle = "]) assert.equal(issueCodes.has(code), false, `${code} must not describe an intentional voice-only Take`);";
const replacement = "]) assert.equal(issueCodes.has(code), false, String(code) + ' must not describe an intentional voice-only Take');";
assert.equal(source.split(needle).length - 1, 1, 'expected one nested template diagnostic');
const fixedPath = '/tmp/relay-voice-only-runtime-fixed.mjs';
writeFileSync(fixedPath, source.replace(needle, replacement));
await import(pathToFileURL(fixedPath).href);
