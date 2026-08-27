import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AudioPacketReceiver } from '../src/audio-packet-receiver.js';
import { encodeAudioPacket } from '../src/audio-packet.js';
import { parseAudioUplinkHealth } from '../src/audio-uplink-health.js';
import { AudioSessionPolicy, resolveAudioSessionType } from '../public/audio-session-policy.js';
import { RelayClient, startRelay } from './helpers/harness.js';

const serverSource = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const micRuntimeSource = readFileSync(new URL('../src/mic-runtime.ts', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const listenSource = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');
const liveStatusSource = readFileSync(new URL('../public/live-status.js', import.meta.url), 'utf8');
const presenceSource = readFileSync(new URL('../public/presence.js', import.meta.url), 'utf8');
const youtubeSyncSource = readFileSync(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');

test('server process incarnation scopes Presence and room Song revisions', async () => {
  assert.match(serverSource, /import \{ SERVER_INCARNATION \} from '\.\/server-incarnation\.js'/);
  assert.match(serverSource, /function roomSongCommandStatusPayload[\s\S]*serverIncarnation: SERVER_INCARNATION/);
  assert.match(presenceSource, /sameIncarnation[\s\S]*Number\(message\.revision\) < Number\(latestSession\.revision\)/);
  assert.match(youtubeSyncSource, /incarnation !== roomCommandServerIncarnation[\s\S]*roomCommandRevision = revision/);

  const server = await startRelay({ RELAY_HEARTBEAT_MS: '60000' });
  try {
    const presence = await RelayClient.connect(server, '?participant=epoch-test&name=Epoch');
    const session = await presence.waitForType('session-status');
    assert.equal(typeof session.serverIncarnation, 'string');
    assert.ok(session.serverIncarnation.length > 0);

    const playback = await RelayClient.connect(server, '?participant=epoch-test&name=Epoch');
    playback.send({ type: 'room-song-command-status-request' });
    const commandStatus = await playback.waitForType('room-song-command-status');
    assert.equal(commandStatus.serverIncarnation, session.serverIncarnation);
    presence.close();
    playback.close();
  } finally {
    await server.stop();
  }
});

test('fresh receiver can resume a continuing non-zero sequence after Relay restart', () => {
  const receiver = new AudioPacketReceiver({
    source: 'mic',
    generation: 77,
    reorderWindowPackets: 4,
    reorderDeadlineMs: 20,
    maxForwardJumpPackets: 32,
  });
  const encoded = encodeAudioPacket({
    source: 'mic', generation: 77, sequence: 420, firstSampleIndex: 84_000, pcm: Buffer.alloc(4),
  });
  assert.deepEqual(receiver.receive(encoded, 0).map((packet) => packet.sequence), [420]);
  assert.match(appSource, /initialSequence: capturePacketSequence >>> 0/);
  assert.match(serverSource, /initialSequence: initialSequence \?\? undefined/);
});

test('Take freezes applied timing calibration until recording and finalizing finish', () => {
  assert.match(serverSource, /function syncAppliedCalibration\(\) \{\n  if \(takeBlocksCalibration\(\)\) return false;/);
  assert.match(serverSource, /function maybeReapplyBootCalibration[\s\S]*if \(takeBlocksCalibration\(\)\) return;/);
});

test('Listen consumes mix rate, stays at unity or below, and recovers suspended contexts', () => {
  assert.match(listenSource, /message\.mixSampleRate \?\? message\.sampleRate/);
  assert.match(listenSource, /return \(percent \/ 100\) \*\* 1\.5;/);
  assert.doesNotMatch(listenSource, /\* 8;/);
  // iOS Safari can leave `resume()` pending for the life of the page - no
  // error, no resolution - and awaiting it stranded the whole graph: the
  // worklet was never fetched and the cached setup promise never cleared, so
  // Listen stayed dead for the rest of the session.
  assert.match(listenSource, /function startResume\(context\)/);
  assert.match(listenSource, /const pending = context\.resume\(\)/);
  assert.match(listenSource, /function resumeAudioGraph\(\) \{\n    startResume\(audioContext\);\n  \}/);
  assert.doesNotMatch(listenSource, /await (?:audioContext|context)\.resume\(\)/);
  // Including through the wrapper: it returns nothing precisely so that it
  // cannot be waited on by accident.
  assert.doesNotMatch(listenSource, /await\s+resumeAudioGraph\(/);
  assert.match(listenSource, /addEventListener\('statechange'/);
  assert.match(listenSource, /document\.addEventListener\('visibilitychange'/);
  assert.match(
    listenSource,
    /function recoverForegroundAudio\(\) \{\n    recoverAudioGraph\(\);\n    scheduleIosAudioDestinationRecovery\(`foreground:\$\{foregroundAudioBoundary\}`\);\n  \}/,
  );
  assert.match(listenSource, /window\.addEventListener\('pageshow', recoverForegroundAudio\)/);
});

test('page audio session arbitration prefers microphone capture over playback', () => {
  assert.equal(resolveAudioSessionType(), 'auto');
  assert.equal(resolveAudioSessionType({ playback: true }), 'playback');
  assert.equal(resolveAudioSessionType({ microphone: true }), 'play-and-record');
  assert.equal(resolveAudioSessionType({ playback: true, microphone: true }), 'play-and-record');

  const session = { type: 'auto' };
  const policy = new AudioSessionPolicy(() => ({ audioSession: session }));
  assert.equal(policy.claimPlayback(true), 'playback');
  assert.equal(session.type, 'playback');
  assert.equal(policy.claimMicrophone(true), 'play-and-record');
  assert.equal(session.type, 'play-and-record');
  assert.equal(policy.claimMicrophone(false), 'playback');
  assert.equal(session.type, 'playback');
  assert.equal(policy.claimPlayback(false), 'auto');
  assert.equal(session.type, 'auto');
});

test('Listen treats OS interruption as recovery, not a user transport teardown', () => {
  assert.match(listenSource, /function audioGraphReady\(\)/);
  assert.match(listenSource, /function audioRendering\(\)/);
  assert.match(listenSource, /function monitorTransportWanted\(\)[\s\S]*audioEverRunning/);
  assert.match(listenSource, /createAudioInterruptionTracker\(\{ staleAfterMs: PREBUFFER_MS \}\)/);
  assert.match(listenSource, /function restartMonitorAtLiveEdge\(\)[\s\S]*abandonTransportConnection\(\)[\s\S]*ensureTransport\('reconnecting'\)/);

  const reconcile = listenSource.match(/function reconcile\(phase = ''\) \{[\s\S]*?\n  \}\n\n  function forceMicMute/)?.[0] ?? '';
  assert.notEqual(reconcile, '', 'Listen must expose a readable reconciliation boundary');
  const interruptionBranch = reconcile.match(/if \(!audioRendering\(\)\) \{[\s\S]*?\n    \}/)?.[0] ?? '';
  assert.notEqual(interruptionBranch, '', 'Listen must handle a non-rendering graph explicitly');
  assert.doesNotMatch(interruptionBranch, /closeTransport\(\)/);
  assert.doesNotMatch(interruptionBranch, /liveEdgeRecoveryRequired = true/);
  assert.match(interruptionBranch, /audioInterruption\.begin\(\)/);
  assert.match(interruptionBranch, /ensureTransport\('interrupted'\)/);

  assert.match(listenSource, /if \(!audioRendering\(\)\) \{[\s\S]*audioInterruption\.noteDroppedPlayback\(\)[\s\S]*return;/);
  assert.match(listenSource, /audioInterruption\.finish\(\)[\s\S]*recovery\.requiresLiveEdge[\s\S]*liveEdgeRecoveryRequired = true/);
  assert.match(listenSource, /resetPlaybackTemporalState\(\)/);
  assert.match(listenSource, /monitorPcmReceiver\.reset\(\)/);
  assert.match(listenSource, /playbackNode\?\.port\.postMessage\(\{ type: 'reset' \}\)/);
});

test('Listen uses playback and play-and-record AudioSession claims at user intent boundaries', () => {
  assert.match(listenSource, /claimPlaybackAudio\(true\);\n      const context = new AudioContext/);
  assert.match(listenSource, /userMuted = !userMuted;\n    claimPlaybackAudio\(!userMuted\);/);
  assert.match(listenSource, /publisherButton\.addEventListener\('click',[\s\S]*claimMicrophoneAudio\(true\)[\s\S]*\{ capture: true \}/);
  assert.match(listenSource, /relay-request-microphone'[\s\S]*claimMicrophoneAudio\(true\)[\s\S]*\{ capture: true \}/);
  assert.match(
    listenSource,
    /function restoreAfterMicBoundary[\s\S]*claimMicrophoneAudio\(false\)[\s\S]*restoreAfterMic\(phase\)/,
    'Mic AudioSession release must happen at the authoritative post-teardown Listen boundary',
  );
  assert.doesNotMatch(
    listenSource,
    /function restoreAfterMicBoundary[\s\S]*setTimeout\(/,
    'Mic AudioSession release must not depend on a guessed later task',
  );
  assert.match(appSource, /function finishMicrophoneSession[\s\S]*isCurrent: \(stoppedEpoch\) => publisherSessionEpoch === stoppedEpoch[\s\S]*dispatchRelayEvent\('relay-microphone-ended'/);
  assert.match(listenSource, /relay-microphone-ended'[\s\S]*restoreAfterMicBoundary\(\)/);
  assert.match(listenSource, /relay-microphone-start-failed'[\s\S]*restoreAfterMicBoundary\('mic-failed-resume'\)/);
});

test('Listen gives every recovered running context a fresh stuck-resume budget', () => {
  assert.match(listenSource, /let stalledResumeGestures = 0;/);
  assert.match(listenSource, /context\.state === 'running'[\s\S]*stalledResumeGestures = 0/);
  assert.match(listenSource, /if \(stalledResumeGestures >= 1\) \{\n        discardStuckAudioGraph\(\);/);
  assert.doesNotMatch(listenSource, /audioResumeGestures/);
});

test('Mic recovery exposes OS input mute to server liveness', () => {
  assert.match(appSource, /initialSequence: capturePacketSequence >>> 0/);
  assert.match(appSource, /track\?\.addEventListener\('mute'/);
  assert.match(appSource, /track\?\.addEventListener\('unmute'/);
  assert.match(appSource, /document\.addEventListener\('visibilitychange'/);
  assert.match(appSource, /window\.addEventListener\('pageshow', recoverPublisherAudio\)/);
  assert.match(appSource, /captureContext\.addEventListener\('statechange'/);
  assert.match(serverSource, /function micStreaming\(nowMs = performance\.now\(\)\)[\s\S]{0,160}micRuntime\.streaming\(nowMs\)/);
  assert.match(micRuntimeSource, /this\.currentUplinkHealth\?\.inputMuted !== true/);

  const parsed = parseAudioUplinkHealth({
    version: 1,
    captureGeneration: 7,
    capturedSamples: 1,
    inputGapSamples: 0,
    inputMuted: true,
    droppedSamples: { total: 0, disconnected: 0, congested: 0, packetTooLarge: 0 },
    controlReconnects: 0,
    transport: {
      path: 'websocket',
      maxPacketBytes: null,
      minWebTransportMaxPacketBytes: null,
      maxWebTransportMaxPacketBytes: null,
      webTransportAttempts: 0,
      webTransportConnections: 0,
      webTransportDemotions: 0,
      webTransportPacketsSubmitted: 0,
      webTransportCongestedRejects: 0,
      webTransportPacketTooLargeRejects: 0,
      webTransportSendFailures: 0,
      webSocketPacketsSent: 0,
      webSocketCongestedRejects: 0,
      webSocketDisconnectedRejects: 0,
      webSocketSendFailures: 0,
    },
  });
  assert.equal(parsed?.inputMuted, true);
});

/**
 * A backgrounded phone came back to a page still saying the singer was live
 * while no audio was leaving it. Two separate faults met there: the capture
 * context could not be restarted, and the headline kept asserting a room state
 * the page had lost the connection to observe.
 */
test('a lost connection stops the page claiming the singer is live', () => {
  const closeHandler = liveStatusSource.match(
    /addEventListener\('close', \(\) => \{[\s\S]*?\n {4}\}\);/,
  )?.[0] ?? '';
  assert.notEqual(closeHandler, '', 'live-status must handle its socket closing');
  assert.match(closeHandler, /title\.textContent =/);
});

test('the capture context is restarted from every state Safari reports', () => {
  // `interrupted` is the state a backgrounded iPhone reports, and checking only
  // for `suspended` skipped the commonest case entirely.
  assert.match(appSource, /import \{ shouldRequestAudioResume \}/);
  assert.match(appSource, /function resumePublisherAudioContext[\s\S]*shouldRequestAudioResume\(audioContext\.state\)/);
  // And nothing waits on it: that promise can be accepted and never settle.
  assert.doesNotMatch(appSource, /await audioContext\.resume\(\)/);
});
