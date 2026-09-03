import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ui = readFileSync(new URL('../public/calibration-ui.js', import.meta.url), 'utf8');
const command = readFileSync(new URL('../public/calibration-command.js', import.meta.url), 'utf8');
const system = readFileSync(new URL('../public/calibration-system-details.js', import.meta.url), 'utf8');

test('normal timing value follows fresh mixer authority independently of ProductStatus lifecycle', () => {
  assert.doesNotMatch(ui, /timingIsProductRelevant|timing\?\.state !== 'idle'/,
    'Song/product lifecycle must not hide the user-facing mixer timing value');
  assert.match(ui, /timingAuthority\?\.authorityFresh === true[\s\S]*?formatTimingValueMs\(timingAuthority\.valueMs\)/,
    'a fresh server-applied mixer value must be painted directly');
});

test('no-Song Robot boot-probe bypasses only the legacy Song-gated command listener', () => {
  assert.match(ui, /latestAction\?\.startCalibrationMode === 'boot-probe'/);
  assert.match(ui, /latestProductStatus\?\.room\?\.song\?\.videoId == null/);
  assert.match(ui, /sendPreflightCalibrationCommand\(\)/);
  assert.match(ui, /commandTarget\.dispatchEvent/,
    'normal calibration must keep using the established publisher command transport');
});

test('preflight command authenticates the Mic owner before sending calibration', () => {
  assert.match(command, /sendParticipantAuthentication\(socket\)/);
  assert.match(
    command,
    /if \(message\?\.type === 'participant-authenticated' && !sent\) \{[\s\S]*?socket\.send\(JSON\.stringify\(\{ type: 'start-timing-calibration' \}\)\);/,
    'calibration command must only be emitted from the authenticated acknowledgement branch',
  );
});

test('System timing diagnostics expose content, validation, and path evidence separately', () => {
  for (const marker of [
    'Content progress',
    'Content agreement',
    'Content candidate',
    'Content confidence',
    'Content segments',
    'Runtime validation',
    'Path probe',
    'Probe correlations',
    'Path difference',
    'Player delta',
    'Effective calibration',
  ]) {
    assert.ok(system.includes(marker), `missing System calibration field: ${marker}`);
  }
  assert.match(system, /value === null \|\| value === undefined \|\| value === ''/,
    'diagnostics must not coerce unknown/null timing evidence to numeric zero');
  assert.match(system, /Path ready · waiting for playback/,
    'path calibration must remain distinct from a complete player-relative alignment');
});
