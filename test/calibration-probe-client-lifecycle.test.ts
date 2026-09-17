import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('phone calibration probe loses authority before a late AudioContext resume can play it', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(source, /let activeCalibrationProbeRequestId = null/);
  assert.match(source, /activeCalibrationProbeRequestId = requestId;[\s\S]*playCalibrationProbe\(requestId/,
    'each probe request must install an explicit local authority token');
  assert.match(
    source,
    /async function playCalibrationProbe\(requestId, leadMs\)[\s\S]*const sessionEpoch = publisherSessionEpoch;[\s\S]*const expectedGeneration = captureGeneration >>> 0;/,
    'probe playback must snapshot the Mic session and capture generation that own the request',
  );
  assert.match(
    source,
    /await context\.resume\(\);[\s\S]*activeCalibrationProbeRequestId !== requestId[\s\S]*!isCurrentPublisherCapture\(sessionEpoch, expectedGeneration\)[\s\S]*const startTime/,
    'a late resume must re-prove request and capture ownership before creating audible nodes',
  );
  assert.match(
    source,
    /function advanceCaptureGeneration\(reason\) \{[\s\S]*activeCalibrationProbeRequestId = null;[\s\S]*captureGeneration = \(\(captureGeneration >>> 0\) \+ 1\) >>> 0;/,
    'a capture-clock boundary must synchronously retire the old probe request',
  );
  assert.match(
    source,
    /type: 'calibration-probe-played',[\s\S]*requestId,[\s\S]*generation: expectedGeneration/,
    'a successful probe reply must report the immutable generation that authorized playback',
  );
  assert.match(
    source,
    /type: 'calibration-probe-failed',[\s\S]*requestId,[\s\S]*generation: expectedGeneration/,
    'a failed probe reply must stay on the immutable generation too',
  );
  assert.match(source, /message\.probePhase !== 'mic-requested'[\s\S]*activeCalibrationProbeRequestId = null/,
    'canonical server probe phase must retire timed-out or advanced requests');
  assert.match(source, /ws\.addEventListener\('close'[\s\S]*activeCalibrationProbeRequestId = null/,
    'losing the control socket must retire the request locally');
  assert.match(source, /document\.visibilityState === 'hidden'[\s\S]*activeCalibrationProbeRequestId = null/,
    'backgrounding the phone must retire a request that Safari may resume later');
  assert.match(source, /async function stop[\s\S]*activeCalibrationProbeRequestId = null/,
    'Mic teardown must retire any in-flight probe');
});
