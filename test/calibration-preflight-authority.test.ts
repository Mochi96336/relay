import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../public/calibration-ui.js', import.meta.url), 'utf8');

test('no-Song boot preflight does not inherit publisher command-channel freshness', () => {
  assert.match(
    source,
    /commandChannelFresh:\s*needsPreflightCommandPath\(\)\s*\|\|\s*commandAuthority\?\.commandChannelFresh === true/,
    'the dedicated authenticated preflight socket must stay actionable even when the legacy publisher command socket is stale',
  );
  assert.match(
    source,
    /if \(needsPreflightCommandPath\(\)\) \{[\s\S]*sendPreflightCalibrationCommand\(\)/,
    'the bypass must remain scoped to the dedicated no-Song preflight transport',
  );
  assert.match(
    source,
    /authorityFresh:\s*productAuthority\?\.authorityFresh === true[\s\S]*authorized:\s*selfOwnsServerMic\(\)[\s\S]*serverAllowed:\s*latestAction\?\.canStartCalibration === true/,
    'preflight still requires fresh ProductStatus, Mic ownership and server policy',
  );
});
