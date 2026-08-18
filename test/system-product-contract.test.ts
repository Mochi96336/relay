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
