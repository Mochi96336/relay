import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('phone calibration probe loses authority before a late AudioContext resume can play it', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(source, /let activeCalibrationProbeRequestId = null/);
  assert.match(source, /activeCalibrationProbeRequestId = requestId;[\s\S]*playCalibrationProbe\(requestId/,
    'each probe request must install an explicit local authority token');
  assert.match(source, /await context\.resume\(\);[\s\S]*if \(activeCalibrationProbeRequestId !== requestId\) return;/,
    'a late resume must re-check that the request is still current before creating audible nodes');
  assert.match(source, /message\.probePhase !== 'mic-requested'[\s\S]*activeCalibrationProbeRequestId = null/,
    'canonical server probe phase must retire timed-out or advanced requests');
  assert.match(source, /next\.addEventListener\('close'[\s\S]*activeCalibrationProbeRequestId = null/,
    'losing the control socket must retire the request locally');
  assert.match(source, /document\.visibilityState === 'hidden'[\s\S]*activeCalibrationProbeRequestId = null/,
    'backgrounding the phone must retire a request that Safari may resume later');
  assert.match(source, /async function stop[\s\S]*activeCalibrationProbeRequestId = null/,
    'Mic teardown must retire any in-flight probe');
});
