// Applies one mutation from a spec, runs the tests that should notice it,
// and prints one JSON line describing what happened.
//
//   node scripts/mutation-check.mjs <spec.json> <index>
//
// Index -1 runs the tests with no mutation: the baseline has to be green for
// any "not caught" to mean something. A mutation is "caught" when the tests
// fail with it applied. Each run is meant to have the machine to itself;
// timing-sensitive tests fail under load, which reads as a false catch.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const [specPath, indexArg] = process.argv.slice(2);
if (!specPath || indexArg === undefined) {
  console.error('usage: node scripts/mutation-check.mjs <spec.json> <index>');
  process.exit(64);
}
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const index = Number(indexArg);
const mutation = index >= 0 ? spec.mutations[index] : null;
if (index >= 0 && !mutation) {
  console.error(`no mutation at index ${index}`);
  process.exit(64);
}

const result = { index, label: mutation ? (mutation.label ?? mutation.find.split('\n')[0].trim()) : 'baseline' };

if (mutation) {
  const file = mutation.file ?? spec.file;
  const source = readFileSync(file, 'utf8');
  // Scope the edit to one top-level function, so a line that also appears
  // elsewhere in the file is never the one changed.
  let start = 0;
  let end = source.length;
  if (mutation.function) {
    start = source.indexOf(`function ${mutation.function}(`);
    end = start < 0 ? -1 : source.indexOf('\n}\n', start);
    if (start < 0 || end < 0) {
      console.log(JSON.stringify({ ...result, error: `function ${mutation.function} not found` }));
      process.exit(2);
    }
  }
  const body = source.slice(start, end);
  const occurrences = body.split(mutation.find).length - 1;
  if (occurrences !== 1) {
    console.log(JSON.stringify({ ...result, error: `expected one match, found ${occurrences}` }));
    process.exit(2);
  }
  writeFileSync(file, source.slice(0, start) + body.replace(mutation.find, mutation.replace ?? '') + source.slice(end));
  result.function = mutation.function ?? null;
}

const tests = mutation?.tests ?? spec.tests;
const started = Date.now();
const run = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-concurrency=1', ...tests],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
);
const output = `${run.stdout}\n${run.stderr}`;
const failures = Number(/^# fail (\d+)/m.exec(output)?.[1] ?? Number.NaN);
result.failures = Number.isFinite(failures) ? failures : null;
result.failedTests = [...output.matchAll(/^not ok \d+ - (.*)$/gm)].map((match) => match[1]);
result.caught = run.status !== 0;
result.seconds = Math.round((Date.now() - started) / 1000);
console.log(JSON.stringify(result));
