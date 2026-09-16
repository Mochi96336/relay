import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(
  path.join(root, 'src', 'robot-semantic-recovery-live.ts'),
  'utf8',
);

test('live recovery durably commits restart budget before the restart effect', () => {
  assert.match(source, /await handle\.writeFile\([\s\S]*await handle\.sync\(\)[\s\S]*await durableRename\(temporary, stateFile\)/);
  assert.match(source, /await writeRobotSemanticRecoveryLiveState\(options\.stateFile, decision\.state\);[\s\S]*await restartRobotRouteService/);
  assert.doesNotMatch(source, /await rename\(temporary, stateFile\)/);
});
