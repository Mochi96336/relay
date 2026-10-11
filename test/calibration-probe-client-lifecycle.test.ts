import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { functionCode, parseTypeScriptSource } from './support/source-contract.js';

const source = parseTypeScriptSource(new URL('../public/app.js', import.meta.url),
  readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'));

function publisher() {
  const calls: unknown[][] = [];
  const env = {
    publisherSessionEpoch: 1, captureGeneration: 2,
    calibrationProbePlayback: {
      play: async (...args: unknown[]) => { calls.push(['play', ...args]); },
      cancelPending: () => calls.push(['cancelPending']),
      retire: () => calls.push(['retire', env.captureGeneration]),
    },
  };
  const scope = vm.createContext(env);
  vm.runInContext(functionCode(source, 'handleServerMessage'), scope);
  return {
    calls, env, scope,
    message: (message: object) => {
      Object.assign(env, { message });
      vm.runInContext('handleServerMessage(message)', scope);
    },
  };
}

test('publisher admits only valid phone probe requests and retains the lead-time default', () => {
  const f = publisher();
  for (const requestId of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, 'bad']) {
    f.message({ type: 'play-calibration-probe', target: 'mic', requestId });
  }
  f.message({ type: 'play-calibration-probe', target: 'backing', requestId: 7 });
  assert.deepEqual(f.calls, []);
  f.message({ type: 'play-calibration-probe', target: 'mic', requestId: 3, leadMs: 40 });
  f.message({ type: 'play-calibration-probe', requestId: 4 });
  assert.deepEqual(f.calls, [['play', 3, 40], ['play', 4, 200]]);
});

test('server phase advancement cancels preparation without retiring acknowledged playback', () => {
  const f = publisher();
  f.message({ type: 'timing-calibration-status', probeActive: true, probePhase: 'mic-requested' });
  assert.deepEqual(f.calls, []);
  f.message({ type: 'timing-calibration-status', probeActive: true, probePhase: 'backing-requested' });
  f.message({ type: 'timing-calibration-status', probeActive: false });
  assert.deepEqual(f.calls, [['cancelPending'], ['cancelPending']]);
});

test('capture generation retires all probe resources before changing the capture identity', () => {
  const f = publisher();
  Object.assign(f.env, {
    micBitratePolicy: { reset() {} }, micOpus: null, resetUplinkEvidence() {},
    mediaStream: null, audioTransport: { resetStats() {} }, dispatchRelayEvent() {},
  });
  vm.runInContext(functionCode(source, 'advanceCaptureGeneration'), f.scope);
  assert.equal(vm.runInContext("advanceCaptureGeneration('test')", f.scope), 3);
  assert.deepEqual(f.calls, [['retire', 2]]);
});

test('background boundary retires probe playback even if the publisher has already stopped', () => {
  const f = publisher();
  Object.assign(f.env, { publisherActive: false });
  vm.runInContext(functionCode(source, 'notePublisherBackgrounded'), f.scope);
  vm.runInContext('notePublisherBackgrounded()', f.scope);
  assert.deepEqual(f.calls, [['retire', 2]]);
});
