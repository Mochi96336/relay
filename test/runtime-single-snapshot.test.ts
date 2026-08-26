import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findUniqueFunctionSource,
  readRepositoryTextFile,
} from './helpers/source-contract.js';

const product = readRepositoryTextFile('src/product-view-model.ts');

function functionBody(name: string) {
  return findUniqueFunctionSource(name).declaration;
}

test('/statusz projects readiness-owned facts from one sampled snapshot', () => {
  const body = functionBody('remoteStatusPayload');

  assert.match(body, /const readiness = readinessPayload\(nowMs\);/);
  assert.match(body, /const health = deriveRemoteStatusHealth\(readiness\);/);
  assert.match(body, /ok: health\.ok/);
  assert.match(body, /state: health\.state/);
  assert.match(body, /faults: health\.faults/);
  assert.match(body, /warnings: health\.warnings/);
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
  assert.doesNotThrow(() => functionBody('robotProbeTimingActive'));
  assert.throws(() => functionBody('robotRouteActive'), /found 0/);
  assert.match(product, /requiresRobotPlayerDelta: boolean/);
  assert.match(product, /!input\.timing\.requiresRobotPlayerDelta \|\| input\.timing\.robotDeltaFresh/);
  assert.doesNotMatch(product, /timing\.robotRoute/);

  const status = functionBody('productStatusPayload');
  assert.match(status, /requiresRobotPlayerDelta: robotProbeTimingActive\(\)/);
  assert.doesNotMatch(status, /robotRoute: robotProbeTimingActive\(\)/);
});
