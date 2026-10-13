import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { computeRelayBuild, createRelayBuildTracker, validPageBuild } from '../src/relay-build.js';

test('the build follows the served files and nothing else', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-build-'));
  try {
    const publicDir = path.join(root, 'public');
    const sharedDir = path.join(root, 'shared');
    await mkdir(path.join(publicDir, 'nested'), { recursive: true });
    await mkdir(sharedDir);
    await writeFile(path.join(publicDir, 'app.js'), 'export const v = 1;\n');
    await writeFile(path.join(publicDir, 'nested', 'a.css'), 'a {}\n');
    await writeFile(path.join(sharedDir, 'policy.js'), 'export const p = 1;\n');

    const first = computeRelayBuild([publicDir, sharedDir]);
    assert.match(first, /^[0-9a-f]{12}$/);
    assert.equal(computeRelayBuild([publicDir, sharedDir]), first, 'stable for unchanged files');

    // A local browser-test setup links shared/ into public/; it is not content.
    await symlink(sharedDir, path.join(publicDir, 'shared'));
    assert.equal(computeRelayBuild([publicDir, sharedDir]), first);

    await writeFile(path.join(sharedDir, 'policy.js'), 'export const p = 2;\n');
    const changed = computeRelayBuild([publicDir, sharedDir]);
    assert.notEqual(changed, first, 'a shared module edit is a new build');

    await writeFile(path.join(publicDir, 'nested', 'a.css'), 'a { color: red }\n');
    assert.notEqual(computeRelayBuild([publicDir, sharedDir]), changed, 'a nested file edit is a new build');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the tracked build follows files updated after startup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-build-tracker-'));
  try {
    const publicDir = path.join(root, 'public');
    const sharedDir = path.join(root, 'shared');
    await mkdir(publicDir);
    await mkdir(sharedDir);
    await writeFile(path.join(publicDir, 'youtube.js'), 'export const v = 1;\n');
    await writeFile(path.join(sharedDir, 'policy.js'), 'export const p = 1;\n');

    let nowMs = 0;
    const tracker = createRelayBuildTracker([publicDir, sharedDir], { maxAgeMs: 2_000, now: () => nowMs });
    const started = tracker.current();
    assert.equal(started, computeRelayBuild([publicDir, sharedDir]));

    // Deploying a front-end fix without restarting Relay.
    await writeFile(path.join(publicDir, 'youtube.js'), 'export const v = 22;\n');
    nowMs = 500;
    assert.equal(tracker.current(), started, 'rechecked at most every maxAgeMs');
    nowMs = 2_500;
    const updated = tracker.current();
    assert.notEqual(updated, started, 'the served files changed, so the build did');
    assert.equal(updated, computeRelayBuild([publicDir, sharedDir]));

    nowMs = 5_000;
    assert.equal(tracker.current(), updated, 'unchanged files keep the build');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a page build is accepted only as a short lowercase hex string', () => {
  assert.equal(validPageBuild('0a1b2c3d4e5f'), '0a1b2c3d4e5f');
  assert.equal(validPageBuild(undefined), null, 'an old page sends none');
  assert.equal(validPageBuild(''), null);
  assert.equal(validPageBuild('ABC'), null);
  assert.equal(validPageBuild('"><script>'), null);
  assert.equal(validPageBuild('a'.repeat(65)), null);
  assert.equal(validPageBuild(12), null);
});
