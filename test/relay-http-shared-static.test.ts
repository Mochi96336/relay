import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRelayHttpServer } from '../src/relay-http-server.js';

test('HTTP serves the explicit shared sibling at /shared without widening the public root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'relay-shared-static-'));
  const publicDir = path.join(root, 'public');
  const sharedDir = path.join(root, 'shared');
  const takeDir = path.join(root, 'takes');
  await Promise.all([
    mkdir(publicDir),
    mkdir(sharedDir),
    mkdir(takeDir),
  ]);
  await writeFile(path.join(publicDir, 'index.html'), '<p>public</p>\n');
  await writeFile(path.join(sharedDir, 'policy.js'), 'export const shared = true;\n');

  const server = createRelayHttpServer({
    publicDir,
    takeDir,
    relayKey: null,
    remoteStatus: () => ({ ok: true }),
    observationStatusV1: () => ({ schema: 'relay.observation.v1' }),
    readiness: () => ({ ready: true }),
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;

    const shared = await fetch(`${origin}/shared/policy.js`);
    assert.equal(shared.status, 200);
    assert.equal(await shared.text(), 'export const shared = true;\n');

    const publicIndex = await fetch(`${origin}/index.html`);
    assert.equal(publicIndex.status, 200);
    assert.match(await publicIndex.text(), /public/);

    const notPromotedToPublicRoot = await fetch(`${origin}/policy.js`);
    assert.equal(notPromotedToPublicRoot.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(root, { recursive: true, force: true });
  }
});
