import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { DIAGNOSTICS_MESSAGES } from '../public/diagnostics-copy.js';

const ui = readFileSync(new URL('../public/calibration-ui.js', import.meta.url), 'utf8');
const command = readFileSync(new URL('../public/calibration-command.js', import.meta.url), 'utf8');
const system = readFileSync(new URL('../public/calibration-system-details.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

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
  assert.match(ui, /window\.dispatchEvent\(new CustomEvent\('relay-start-timing-calibration'\)\)/,
    'normal calibration must keep using the established publisher command transport, through app.js');
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
  const english = DIAGNOSTICS_MESSAGES.en;
  const keyFor = (text: string) => Object.keys(english).find((key) => key.startsWith('diag.cal.') && english[key] === text);
  for (const marker of [
    'Progress',
    'Agreeing measurements',
    'Measured delay',
    'Confidence',
    'Segment delays',
    'Validation state',
    'Test tone detection',
    'Path difference',
    'Test tone result',
  ]) {
    const key = keyFor(marker);
    assert.ok(key, `missing System calibration copy: ${marker}`);
    assert.ok(html.includes(`data-i18n="${key}"`), `missing System calibration field: ${marker}`);
  }
  assert.match(system, /value === null \|\| value === undefined \|\| value === ''/,
    'diagnostics must not coerce unknown/null timing evidence to numeric zero');
  assert.equal(english['diag.cal.pathReady'], 'Path ready · waiting for playback');
  assert.match(system, /t\('diag\.cal\.pathReady'\)/,
    'path calibration must remain distinct from a complete player-relative alignment');
  assert.doesNotMatch(system, /'Not running'|'Waiting for playback'|'Calibration measurements'/,
    'calibration measurements follow the locale instead of hard-coding English');
});
