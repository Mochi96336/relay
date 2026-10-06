import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const runtime = fs.readFileSync(path.join(root, 'src/mic-transport-grace-runtime.ts'), 'utf8');
const server = fs.readFileSync(path.join(root, 'src/server.ts'), 'utf8');

const lifecycle = fs.readFileSync(path.join(root, 'src/relay-mic-lifecycle.ts'), 'utf8');

function withoutComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

test('MicTransportGraceRuntime owns only timer lifecycle, not Mic lease or transport authority', () => {
  assert.match(server, /new MicTransportGraceRuntime\(\{/);
  assert.doesNotMatch(server, /let micTransportGraceTimer:/);
  assert.doesNotMatch(server, /let micTransportGraceOwnerId:/);
  assert.doesNotMatch(server, /function cancelMicTransportGrace\(/);
  assert.doesNotMatch(server, /function scheduleMicTransportGrace\(/);
  assert.match(server, /micTransportGrace\.pending/);

  const production = withoutComments(runtime);
  assert.doesNotMatch(production, /^import\s/m, 'timer runtime should remain dependency-free');
  assert.doesNotMatch(
    production,
    /ParticipantSession|MicRuntime|AudioSession|releaseMic|clearMediaAuthority|broadcastJson|broadcastSessionStatus|applyMicOwnerEffects/,
  );

  // Timer stays isolated; lease/liveness effects now belong to the Mic assembly.
  assert.match(lifecycle, /participants\.micOwnerId !== expectedOwnerId/);
  assert.match(lifecycle, /micRuntime\.controlConnected\(\)/);
  assert.match(lifecycle, /micRuntime\.mediaOwnerId === expectedOwnerId/);
  assert.match(lifecycle, /participants\.releaseMic\(expectedOwnerId, 'transport-expired'\)/);
  assert.match(server, /clearMicMediaAuthority\(\)/);
  assert.match(lifecycle, /commands\.applyOwnershipEffects\(released\.effects\)/);
  assert.match(lifecycle, /effects\.reportSessionStatus\(\)/);
  assert.match(server, /relayMicLifecycle\.expire\(expectedOwnerId\)/);
  assert.match(server, /broadcastSessionStatus\(\)/);
});
