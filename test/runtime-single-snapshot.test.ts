import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const product = readFileSync(new URL('../src/product-view-model.ts', import.meta.url), 'utf8');

function functionBody(name: string) {
  const start = server.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const end = server.indexOf('\nfunction ', start + 1);
  assert.ok(end > start, `${name} must have a following function boundary`);
  return server.slice(start, end);
}

test('/statusz projects readiness-owned facts from one sampled snapshot', () => {
  const body = functionBody('remoteStatusPayload');

  assert.match(body, /const readiness = readinessPayload\(nowMs\);/);
  assert.match(body, /const components = readiness\.components;/);
  assert.match(body, /components\.backing\.connected/);
  assert.match(body, /components\.backing\.streaming/);
  assert.match(body, /components\.backing\.sampleRate/);
  assert.match(body, /components\.backing\.robot/);
  assert.match(body, /components\.mic\.connected/);
  assert.match(body, /components\.mic\.streaming/);
  assert.match(body, /components\.route\.mode/);
  assert.match(body, /components\.robotSource\.connected/);
  assert.match(body, /components\.player\.offsetFresh/);
  assert.match(body, /components\.calibration\.stale/);
  assert.match(body, /components\.calibration\.kind/);

  assert.doesNotMatch(body, /backing\?\.readyState|micMediaConnected\(\)/);
  assert.doesNotMatch(body, /activeRobotSource\?\.readyState|robotDeltaIsFresh\(/);
  assert.doesNotMatch(body, /calibrationIsStale\(\)/);
});

test('canonical readiness recognizes either Mic media transport, including WebTransport', () => {
  const body = functionBody('readinessPayload');
  assert.match(body, /micConnected: micMediaConnected\(\)/);
  assert.doesNotMatch(body, /micConnected: publisher\?\.readyState/);
});

test('Robot route identity stays separate from Robot player-delta timing dependency', () => {
  assert.match(server, /function robotProbeTimingActive\(\)/);
  assert.doesNotMatch(server, /function robotRouteActive\(\)/);
  assert.match(product, /requiresRobotPlayerDelta: boolean/);
  assert.match(product, /!input\.timing\.requiresRobotPlayerDelta \|\| input\.timing\.robotDeltaFresh/);
  assert.doesNotMatch(product, /timing\.robotRoute/);

  const status = functionBody('productStatusPayload');
  assert.match(status, /requiresRobotPlayerDelta: robotProbeTimingActive\(\)/);
  assert.doesNotMatch(status, /robotRoute: robotProbeTimingActive\(\)/);
});
