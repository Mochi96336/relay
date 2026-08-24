import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { formatTimingValueMs } from '../public/timing-value.js';

const adapter = readFileSync(new URL('../public/timing-authority.js', import.meta.url), 'utf8');
const calibrationUi = readFileSync(new URL('../public/calibration-ui.js', import.meta.url), 'utf8');
const actionLanguage = readFileSync(new URL('../public/action-language.css', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8');

test('small applied timing values are presented without a deadband', () => {
  assert.equal(formatTimingValueMs(37), '+37 ms');
  assert.equal(formatTimingValueMs(-37), '-37 ms');
  assert.equal(formatTimingValueMs(1), '+1 ms');
  assert.equal(formatTimingValueMs(-1), '-1 ms');
  assert.equal(formatTimingValueMs(0), '0 ms');
});

test('timing formatter rejects missing and coerced values instead of inventing zero', () => {
  for (const value of [null, undefined, '', false, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(formatTimingValueMs(value), null);
  }
});

test('read-only timing adapter publishes only server-applied mixer timing', () => {
  assert.match(adapter, /message\?\.type !== 'source-status'/);
  assert.match(adapter, /appliedMicAdvanceMs/);
  assert.match(adapter, /type: 'source-status-request'/);
  assert.match(adapter, /const REFRESH_MS = 250/);
  assert.match(adapter, /setInterval\(requestSourceStatus, REFRESH_MS\)/);
  assert.match(adapter, /if \(message\.active === true\) startRefresh\(\)/);
  assert.match(adapter, /else stopRefresh\(\)/);
  assert.match(adapter, /publish\(false, null\)/,
    'reconnect must revoke numeric freshness instead of retaining stale truth');
  assert.doesNotMatch(adapter, /requestedMicAdvanceMs|robot-player-offset|source-seeked|provisional/,
    'normal timing authority must not reconstruct candidates or Robot observations');
});

test('calibration presenter changes the number only from timing-authority snapshots', () => {
  assert.match(calibrationUi, /formatTimingValueMs\(timingAuthority\.valueMs\)/);
  assert.match(calibrationUi, /relay-timing-authority/);
  assert.doesNotMatch(calibrationUi, /activeMicLagMs|micLagMs|requestedMicAdvanceMs|robot-player-offset|source-seeked|provisional/,
    'visible number must not consume calibration candidates or player observations');
  assert.match(calibrationUi, /window\.addEventListener\('load', initialize, \{ once: true \}\)/,
    'presenter must wait until app.js has installed the legacy command transport');
  assert.doesNotMatch(calibrationUi, /getLocale/,
    'visible timing copy belongs to shared i18n rather than a private locale switch');
});

test('normal Live hides fine tune and timing copy has no singing restriction', () => {
  assert.match(actionLanguage, /\.more-timing \{\n  display: none !important;/);
  assert.match(i18n, /'timing\.label': 'Timing'/);
  assert.match(i18n, /'timing\.label': '時間對齊'/);
  assert.match(i18n, /'timing\.realign': 'Realign'/);
  assert.match(i18n, /'timing\.realign': '重新對齊'/);
  assert.match(i18n, /'timing\.aligning': 'Aligning…'/);
  assert.match(i18n, /'timing\.aligning': '對齊中…'/);
  assert.match(i18n, /'timing\.unavailable': 'Unable to realign right now'/);
  assert.match(i18n, /'timing\.unavailable': '目前無法重新對齊'/);
  assert.doesNotMatch(i18n, /Don’t sing|Don't sing|先不要唱|不要出聲|停止唱歌/);
});
