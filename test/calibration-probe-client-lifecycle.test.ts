import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { functionCode, parseTypeScriptSource } from './support/source-contract.js';

async function hiddenProbe(afterResume = false, stale = false) {
  const url = new URL('../public/app.js', import.meta.url);
  const source = parseTypeScriptSource(url, await readFile(url, 'utf8'));
  const messages: any[] = [];
  let resumes = 0;
  const document = { visibilityState: afterResume ? 'visible' : 'hidden' };
  const context = vm.createContext({
    performance: { now: () => 100 }, publisherSessionEpoch: 1, captureGeneration: 2,
    activeCalibrationProbeRequestId: 3, activeCalibrationProbePlayback: null,
    isCurrentPublisherCapture: () => !stale, document,
    socket: { readyState: 1 }, WebSocket: { OPEN: 1 },
    audioContext: { state: 'running', resume: async () => { resumes++; document.visibilityState = 'hidden'; } },
    audioTransport: { sendControlJson: (message: any) => { messages.push(message); return { sent: true }; } },
    console: { warn: () => {} },
  });
  await vm.runInContext('async ' + functionCode(source, 'playCalibrationProbe') + '\nplayCalibrationProbe(3, 200);', context);
  return { messages, resumes, context };
}

test('hidden publisher reports why Boot cannot play instead of silently timing out', async () => {
  const result = await hiddenProbe();
  assert.equal(result.resumes, 0);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].type, 'calibration-probe-failed');
  assert.equal(result.messages[0].requestId, 3);
  assert.equal(result.messages[0].generation, 2);
  assert.match(result.messages[0].reason, /page is hidden/);
  assert.equal(result.context.activeCalibrationProbeRequestId, null);
});

test('publisher hidden during resume reports the visibility cause with no oscillator scheduled', async () => {
  const result = await hiddenProbe(true);
  assert.equal(result.resumes, 1);
  assert.equal(result.messages.length, 1);
  assert.match(result.messages[0].reason, /page is hidden/);
});

test('hidden stale publisher cannot fail another capture probe', async () => {
  const result = await hiddenProbe(false, true);
  assert.equal(result.resumes, 0);
  assert.equal(result.messages.length, 0);
});

test('phone calibration probe stays capture-scoped before and after future playback is scheduled', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(source, /let activeCalibrationProbeRequestId = null/);
  assert.match(source, /let activeCalibrationProbePlayback = null/,
    'future-scheduled probe nodes need an explicit capture-scoped owner');
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
    /await context\.resume\(\);[\s\S]*socket\?\.readyState !== WebSocket\.OPEN[\s\S]*const startTime/,
    'a control socket already entering CLOSING must not schedule a probe the server cannot acknowledge',
  );
  assert.match(
    source,
    /function retireCalibrationProbePlayback\(\)[\s\S]*activeCalibrationProbePlayback = null;[\s\S]*oscillator\?\.disconnect\(\)[\s\S]*gain\?\.disconnect\(\)[\s\S]*oscillator\?\.stop\(\)/,
    'retiring a scheduled probe must make already-created future nodes inaudible',
  );
  assert.match(
    source,
    /const playback = \{[\s\S]*requestId,[\s\S]*sessionEpoch,[\s\S]*generation: expectedGeneration,[\s\S]*context,[\s\S]*nodes: \[\][\s\S]*\};[\s\S]*activeCalibrationProbePlayback = playback;/,
    'scheduled nodes must be owned by the request, session, generation and AudioContext that created them',
  );
  assert.match(
    source,
    /playback\.nodes\.push\(\{ oscillator, gain \}\)/,
    'every scheduled note must be reachable from the playback owner for synchronous retirement',
  );
  assert.match(
    source,
    /function advanceCaptureGeneration\(reason\) \{[\s\S]*activeCalibrationProbeRequestId = null;[\s\S]*retireCalibrationProbePlayback\(\);[\s\S]*captureGeneration = \(\(captureGeneration >>> 0\) \+ 1\) >>> 0;/,
    'a capture-clock boundary must retire both pending and already-scheduled old-generation probes',
  );
  assert.match(
    source,
    /activeCalibrationProbeRequestId = null;[\s\S]*if \(socket\?\.readyState !== WebSocket\.OPEN\) \{[\s\S]*retireCalibrationProbePlayback\(\);[\s\S]*return;[\s\S]*\}[\s\S]*const result = audioTransport\.sendControlJson\(/,
    'a control socket that closes after scheduling must retire playback before returning',
  );
  assert.match(
    source,
    /type: 'calibration-probe-played',[\s\S]*requestId,[\s\S]*generation: expectedGeneration/,
    'a successful probe reply must report the immutable generation that authorized playback',
  );
  assert.match(
    source,
    /type: 'calibration-probe-played',[\s\S]*generation: expectedGeneration[\s\S]*if \(!result\.sent\) \{[\s\S]*retireCalibrationProbePlayback\(\)/,
    'scheduled playback must be retired if its played acknowledgement cannot be sent',
  );
  assert.match(
    source,
    /type: 'calibration-probe-failed',[\s\S]*requestId,[\s\S]*generation: expectedGeneration/,
    'a failed probe reply must stay on the immutable generation too',
  );
  assert.match(source, /message\.probePhase !== 'mic-requested'[\s\S]*activeCalibrationProbeRequestId = null/,
    'canonical server probe phase must retire timed-out or advanced pending requests');
  assert.match(source, /ws\.addEventListener\('close'[\s\S]*activeCalibrationProbeRequestId = null/,
    'losing the control socket must retire a pending request locally');
  assert.match(source, /document\.visibilityState === 'hidden'[\s\S]*activeCalibrationProbeRequestId = null;[\s\S]*retireCalibrationProbePlayback\(\)/,
    'backgrounding the phone must also silence any future-scheduled probe playback');
  assert.match(source, /async function stop[\s\S]*activeCalibrationProbeRequestId = null;[\s\S]*retireCalibrationProbePlayback\(\)/,
    'Mic teardown must retire pending and already-scheduled probes');
});
