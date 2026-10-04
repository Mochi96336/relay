import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { DIAGNOSTICS_MESSAGES } from '../public/diagnostics-copy.js';

/** Values of the zh-Hant table in a locale file, keyed for error messages. */
function chineseValues(path: string) {
  const text = readFileSync(new URL(path, import.meta.url), 'utf8');
  const zh = text.slice(text.indexOf("'zh-Hant': {"));
  return [...zh.matchAll(/^\s*'([^']+)':\s*'(.*)',\s*$/gm)].map(([, key, value]) => [key, value] as const);
}

test('Technical details in Chinese say 時序 and 校正, never Timing or a second word for either', () => {
  // The Live button is 「重新對齊」. Technical details may use its own words,
  // but one set of them, and may name that button only by its label.
  for (const [key, value] of Object.entries(DIAGNOSTICS_MESSAGES['zh-Hant'])) {
    assert.doesNotMatch(value, /Timing|開機|System|校準/, key);
    assert.doesNotMatch(value.replaceAll('「重新對齊」', ''), /對齊/, key);
  }
});

test('the Chinese Live interface says 時間對齊 and 對齊, never Timing or 校正', () => {
  for (const path of ['../public/i18n.js', '../public/live-i18n.js']) {
    const values = chineseValues(path);
    assert.ok(values.length > 50, `found the zh-Hant table in ${path}`);
    for (const [key, value] of values) {
      assert.doesNotMatch(value, /Timing|Technical details|校正|校準/, `${path} ${key}`);
    }
  }
});
