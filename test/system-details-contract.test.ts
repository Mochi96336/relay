import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const system = readFileSync(new URL('../public/system-details.js', import.meta.url), 'utf8');
const liveStatus = readFileSync(new URL('../public/live-status.js', import.meta.url), 'utf8');

function position(fragment: string) {
  const index = html.indexOf(fragment);
  assert.notEqual(index, -1, `expected index.html to contain ${fragment}`);
  return index;
}

test('System stays a flat six-line equipment composition before Technical details', () => {
  assert.match(html, /href="\/system-details\.css"/);
  assert.match(html, /src="\/system-details\.js"/);

  for (const scope of ['relay', 'phones', 'robot', 'audio', 'timing', 'recording']) {
    assert.match(html, new RegExp(`class="system-item" data-system-scope="${scope}"`));
  }

  const systemStart = position('id="system-panel"');
  const diagnosticsStart = position('id="diagnostics-panel"');
  assert.ok(systemStart < diagnosticsStart);
  assert.doesNotMatch(html.slice(systemStart, diagnosticsStart), /diagnostic-block/);
});

test('Technical details exposes Overview, Session, Audio, Timing, Robot, and Raw progressively', () => {
  for (const tab of ['overview', 'session', 'audio', 'timing', 'robot', 'raw']) {
    assert.match(html, new RegExp(`data-diagnostics-tab="${tab}"`));
    assert.match(html, new RegExp(`data-diagnostics-panel="${tab}"`));
  }
  assert.match(html, /id="copy-diagnostics"/);
  assert.match(html, /id="diagnostics-raw"/);
});

test('L2 consumes ProductStatus and keeps readiness fresh only while System is open', () => {
  assert.match(system, /relay-product-status/);
  assert.match(system, /const READINESS_REFRESH_MS = 1_000/);
  assert.match(system, /function startReadinessRefresh\(\)/);
  assert.match(system, /if \(systemPanel\.open\) startReadinessRefresh\(\)/);
  assert.match(system, /else stopReadinessRefresh\(\)/);
  assert.match(system, /setInterval\([\s\S]*?refreshReadiness\(\)[\s\S]*?READINESS_REFRESH_MS/);
  assert.match(system, /if \(readinessRefreshInFlight\) return latestReadiness/);
  assert.match(system, /fetch\(readyzUrl\(\), \{ cache: 'no-store' \}\)/);
  assert.match(system, /components\?\.route\?\.mode|components\.route\?\.mode/);
  assert.match(system, /t\('system\.robotIdleDetail'\)/);
  assert.doesNotMatch(liveStatus, /robotProblem \? 'Needs attention' : 'Ready'/);
});

test('legacy backing failure is Audio attention rather than a false Robot failure', () => {
  assert.match(liveStatus, /'audio-unavailable': \(\) => t\('system\.attention\.audio-unavailable'\)/);
  assert.match(liveStatus, /const audioProblem = attention\?\.scope === 'audio' \|\| attention\?\.scope === 'song'/);
  assert.match(system, /const audioAttention = product\.attention\?\.scope === 'audio'/);
  assert.match(system, /t\('system\.audioUnavailableDetail'\)/);
  assert.match(system, /audio:\s*'audio'/);
});

test('L3 opens an evidence socket only while Technical details is open', () => {
  assert.match(system, /if \(!diagnosticsPanel\.open\) return/);
  assert.match(system, /diagnosticsPanel\.addEventListener\('toggle'/);
  assert.match(system, /closeDiagnosticsSocket\(\)/);

  for (const request of [
    'product-status-request',
    'session-status-request',
    'source-status-request',
    'timing-calibration-status-request',
    'take-status-request',
    'youtube-timeline-request',
  ]) {
    assert.match(system, new RegExp(request));
  }
});

test('product attention opens the matching L2 evidence line instead of jumping straight to Raw', () => {
  assert.match(system, /audio:\s*'audio'/);
  assert.match(system, /robot:\s*'robot'/);
  assert.match(system, /song:\s*'audio'/);
  assert.match(system, /mic:\s*'phones'/);
  assert.match(system, /timing:\s*'timing'/);
  assert.match(system, /take:\s*'recording'/);
  assert.match(system, /item\.open = true/);
});

test('Technical details ships diagnostics without retired development controls', () => {
  assert.match(html, />Technical details</);
  for (const retired of [
    'Development tools',
    'legacy-tools',
    'Robot / development source',
    'Open source',
    'start-sync-test',
    'stop-sync-test',
    'Legacy click sync test',
    'source.html',
  ]) {
    assert.equal(html.includes(retired), false);
  }
  assert.doesNotMatch(html, /id="monitor-gain"|id="start-monitor"|legacy-transport-controls/);
});
/**
 * The System panel showed `() => t('system.timing.recovering')` to the singer:
 * the label maps hold thunks so they re-read the active locale, and two of the
 * three readers assigned the thunk itself to `textContent`, which stringifies
 * the function source. The third called it, which is why only two lines were
 * wrong and the bug survived review.
 */
test('every localized label thunk is called before it reaches the DOM', () => {
  const thunkMaps = [...liveStatus.matchAll(/const (\w+) = \{[\s\S]*?\n {2}\};/g)]
    .filter(([body]) => /\(\) => t\(/.test(body))
    .map(([, name]) => name);
  assert.ok(thunkMaps.length > 0, 'expected live-status to hold localized label maps');

  for (const name of thunkMaps) {
    for (const [lookup] of liveStatus.matchAll(new RegExp(`${name}\\[[^\\]]+\\](\\?\\.\\(\\)|\\(\\))?`, 'g'))) {
      assert.match(
        lookup,
        /\)$/,
        `${name} is a map of thunks, so ${lookup} must be called, not rendered`,
      );
    }
  }
});
