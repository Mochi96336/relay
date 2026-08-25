import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const builder = readFileSync(new URL('../scripts/build-live-visual-fixture.mjs', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('./fixtures/live-visual-bootstrap.js', import.meta.url), 'utf8');

test('Live visual proof is generated from production index instead of a second DOM copy', () => {
  assert.match(workflow, /node scripts\/build-live-visual-fixture\.mjs public\/index\.html public\/__live-visual\.html/);
  assert.doesNotMatch(workflow, /cp test\/fixtures\/live-visual\.html/);
  assert.doesNotMatch(workflow, /live-visual-ribbon/);
  assert.match(builder, /readFileSync\(inputPath/);
  assert.match(builder, /<script\\b/);
  assert.match(builder, /__live-visual-bootstrap\.js/);
});

test('deterministic Live state goes through production presenters rather than fixture copy writers', () => {
  for (const modulePath of [
    '/live-ia.js',
    '/mic-actions.js',
    '/room-sound-ui.js',
    '/recording-ui.js',
    '/song-surface.js',
    '/live-status.js',
  ]) {
    assert.match(bootstrap, new RegExp(`import\\('${modulePath.replaceAll('/', '\\/')}\\'\\)`));
  }

  assert.doesNotMatch(bootstrap, /\.textContent\s*=/,
    'fixture authority may select/open surfaces, but production presenters own visible copy');
  assert.doesNotMatch(bootstrap, /\.innerHTML\s*=/);
  assert.doesNotMatch(bootstrap, /\.insertAdjacentHTML\(/);
});
