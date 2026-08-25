import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('normal System renders product issues without reconstructing diagnostics', () => {
  const system = read('public/system-details.js');
  const start = system.indexOf('function renderProductSystem()');
  const end = system.indexOf('function text(', start);
  assert.ok(start >= 0 && end > start);

  const productSurface = system.slice(start, end);
  assert.match(productSurface, /product\.issues/);
  assert.match(system, /issue\?\.cause/);
  assert.match(system, /issue\?\.affects/);
  assert.match(system, /issue\?\.recovery/);
  assert.doesNotMatch(productSurface, /latestReadiness|readyz|components|WebSocket|\.attention/);
});

test('normal System product copy is owned by relayI18n while diagnostics stay technical', () => {
  const system = read('public/system-details.js');
  const liveCopy = read('public/live-i18n.js');
  const technicalStart = system.indexOf('function yesNo(');
  assert.ok(technicalStart >= 0);

  const productSurface = system.slice(0, technicalStart);
  const technicalDetails = system.slice(technicalStart);

  assert.match(system, /import '\.\/live-i18n\.js';/);
  assert.doesNotMatch(productSurface, /localeIsChinese|productCopy\(/,
    'normal System must not own a second bilingual product dictionary');
  assert.match(productSurface, /t\('system\.issue\.affects'\)/);
  assert.match(productSurface, /t\('system\.product\.connecting'\)/);
  assert.match(productSurface, /t\('system\.product\.normal'\)/);
  assert.match(productSurface, /t\('system\.product\.noProblems'\)/);
  assert.match(productSurface, /issueCauseKeys/);
  assert.match(productSurface, /issueRecoveryKeys/);

  for (const key of [
    'system.issue.cause.mic-audio-stalled',
    'system.issue.recovery.retry-mic',
    'system.issue.affects',
    'system.product.connecting',
    'system.product.normal',
    'system.product.noProblems',
  ]) {
    assert.equal((liveCopy.match(new RegExp(`'${key.replaceAll('.', '\\.')}':`, 'g')) ?? []).length, 2, key);
  }

  assert.match(technicalDetails, /return 'Yes'/);
  assert.match(technicalDetails, /return 'Disconnected'/);
  assert.match(technicalDetails, /diagnosticsState\.textContent = 'Open to refresh'/);
  assert.match(technicalDetails, /copyButton\.textContent = 'Copy diagnostics'/);
  assert.doesNotMatch(technicalDetails, /system\.issue\.|system\.product\./,
    'Technical details must not consume normal product copy keys');
});

test('readiness and diagnostics only start from Technical details', () => {
  const system = read('public/system-details.js');

  assert.doesNotMatch(system, /systemPanel\.addEventListener\(['"]toggle/);
  assert.match(system, /function startReadinessRefresh\(\) \{\s*if \(!diagnosticsPanel\.open\) return;/);

  const toggleStart = system.indexOf("diagnosticsPanel.addEventListener('toggle'");
  const toggleEnd = system.indexOf("document.querySelectorAll('[data-diagnostics-tab]'", toggleStart);
  assert.ok(toggleStart >= 0 && toggleEnd > toggleStart);
  const toggle = system.slice(toggleStart, toggleEnd);
  assert.match(toggle, /startReadinessRefresh\(\)/);
  assert.match(toggle, /connectDiagnostics\(\)/);
  assert.match(toggle, /stopReadinessRefresh\(\)/);
  assert.match(toggle, /closeDiagnosticsSocket\(\)/);
});

test('backend-shaped System rows are compatibility-only while product surface stays single-layer', () => {
  const system = read('public/system-details.js');
  const css = read('public/system-details.css');
  const html = read('public/index.html');

  assert.match(css, /\.system-item \{\s*display: none;/);
  assert.match(system, /productSurface\.id = 'system-product'/);
  assert.match(system, /systemSheet\.insertBefore\(productSurface, diagnosticsPanel\)/);
  assert.doesNotMatch(system, /renderL2|focusSystemScope|system-relay-detail/);

  // Compatibility nodes remain available to the existing Live owner for this focused PR.
  assert.match(html, /id="system-relay"/);
  assert.match(html, /id="system-recording"/);
});

test('Technical details retains raw operational evidence as a separate developer surface', () => {
  const system = read('public/system-details.js');
  const html = read('public/index.html');
  const css = read('public/system-details.css');

  assert.match(system, /`\/readyz\$\{query \? `\?\$\{query\}` : ''\}`/);
  assert.match(system, /new WebSocket\(wsUrl\(\)\)/);
  assert.match(system, /rawNode\.textContent = JSON\.stringify/);
  assert.match(html, /id="diagnostics-panel"/);
  assert.match(html, />Technical details</);
  assert.match(css, /\.diagnostics-panel > summary \{[\s\S]*?min-height: 44px;/);
});
