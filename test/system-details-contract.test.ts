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
  assert.match(html, />Development tools</);
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
  assert.match(system, /The Robot route is not armed\. Missing Robot audio is expected in this state\./);
  assert.doesNotMatch(liveStatus, /robotProblem \? 'Needs attention' : 'Ready'/);
});

test('legacy backing failure is Audio attention rather than a false Robot failure', () => {
  assert.match(liveStatus, /'audio-unavailable': 'Room audio unavailable'/);
  assert.match(liveStatus, /const audioProblem = attention\?\.scope === 'audio' \|\| attention\?\.scope === 'song'/);
  assert.match(system, /const audioAttention = product\.attention\?\.scope === 'audio'/);
  assert.match(system, /The room audio path is unavailable\. Open Technical details for backing evidence\./);
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

test('remaining engineering controls stay below Technical details and Development tools', () => {
  const technical = position('id="diagnostics-panel"');
  const development = position('class="legacy-tools"');
  const source = position('Open source');
  const clickTest = position('id="start-sync-test"');

  assert.ok(technical < development);
  assert.ok(development < source);
  assert.ok(development < clickTest);
  assert.doesNotMatch(html, /id="monitor-gain"|id="start-monitor"|legacy-transport-controls/);
});
