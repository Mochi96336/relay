import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../public/calibration-ui.js', import.meta.url), 'utf8');
const actionLanguage = readFileSync(new URL('../public/action-language.css', import.meta.url), 'utf8');

test('applied timing value is part of the Realign action instead of a separate row', () => {
  assert.match(source, /function installTimingButtonSurface\(button\)/);
  assert.match(source, /button\.replaceChildren\(label, value\)/);
  assert.match(source, /value\.id = 'timing-active-value'/);
  assert.match(source, /setText\(calibrateLabel, t\('timing\.realign'\)\)/);
  assert.match(source, /setText\(activeTimingValue, formatted \?\? '—'\)/);

  assert.doesNotMatch(source, /more-timing-authority/,
    'the timing number must not become a standalone menu row again');
  assert.doesNotMatch(source, /insertAdjacentElement/,
    'the presenter should not insert timing as a sibling of the Realign action');
});

test('applied timing value is explicitly pinned to the far right of Realign', () => {
  assert.match(actionLanguage,
    /#calibrate-timing \.calibrate-timing-value \{[\s\S]*margin-inline-start: auto;/);
  assert.match(actionLanguage,
    /#calibrate-timing \.calibrate-timing-value \{[\s\S]*flex: 0 0 auto;/);
  assert.match(actionLanguage,
    /#calibrate-timing \.calibrate-timing-value \{[\s\S]*text-align: right;/);
  assert.match(actionLanguage,
    /#calibrate-timing \.calibrate-timing-value \{[\s\S]*font-variant-numeric: tabular-nums;/,
    'changing authoritative millisecond values should not create avoidable horizontal jitter');
});
