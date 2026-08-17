from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, found {count}: {old[:120]!r}')
    target.write_text(text.replace(old, new, 1))


# Process incarnation scopes monotonic client revisions to one server boot.
replace_once(
    'src/server.ts',
    "import { TakeController, type TakeSongSnapshot } from './take-controller.js';\n",
    "import { TakeController, type TakeSongSnapshot } from './take-controller.js';\nimport { SERVER_INCARNATION } from './server-incarnation.js';\n",
)
replace_once(
    'src/server.ts',
    "  return micMediaConnected()\n    && micFlowObserved()\n    && nowMs - lastMicFrameAt < STREAM_LIVE_MS;",
    "  return micMediaConnected()\n    && micFlowObserved()\n    && micUplinkHealth?.inputMuted !== true\n    && nowMs - lastMicFrameAt < STREAM_LIVE_MS;",
)
replace_once(
    'src/server.ts',
    "  return {\n    type: 'session-status',\n    ...snapshot,",
    "  return {\n    type: 'session-status',\n    serverIncarnation: SERVER_INCARNATION,\n    ...snapshot,",
)
replace_once(
    'src/server.ts',
    "function roomSongCommandStatusPayload(nowMs = performance.now()) {\n  return roomSongCommands.statusPayload(roomSongCommandRevision, nowMs);\n}",
    "function roomSongCommandStatusPayload(nowMs = performance.now()) {\n  return {\n    ...roomSongCommands.statusPayload(roomSongCommandRevision, nowMs),\n    serverIncarnation: SERVER_INCARNATION,\n  };\n}",
)

# A Take owns one timing basis from record start through finalization.
replace_once(
    'src/server.ts',
    "function syncAppliedCalibration() {\n  const active = session.alignment.calibratedMicLagMs;",
    "function syncAppliedCalibration() {\n  if (takeBlocksCalibration()) return false;\n  const active = session.alignment.calibratedMicLagMs;",
)
replace_once(
    'src/server.ts',
    "function maybeReapplyBootCalibration(nowMs: number) {\n",
    "function maybeReapplyBootCalibration(nowMs: number) {\n  if (takeBlocksCalibration()) return;\n",
)

# Publisher registration carries the capture's next packet frontier so a new
# Relay process does not assume a continuing capture restarted at sequence 0.
replace_once(
    'src/server.ts',
    "      const captureGeneration = validCaptureGeneration(payload.captureGeneration);\n      const audioPacketVersion = validAudioPacketVersion(payload.audioPacketVersion);",
    "      const captureGeneration = validCaptureGeneration(payload.captureGeneration);\n      const initialSequence = payload.initialSequence === undefined\n        ? undefined\n        : validCaptureGeneration(payload.initialSequence);\n      const audioPacketVersion = validAudioPacketVersion(payload.audioPacketVersion);",
)
replace_once(
    'src/server.ts',
    "      if (audioPacketVersion === 2 && captureGeneration === null) {\n        sendJson(socket, {\n          type: 'error',\n          message: 'AudioPacket v2 requires a capture generation in publisher registration.',\n        });\n        return;\n      }",
    "      if (audioPacketVersion === 2 && captureGeneration === null) {\n        sendJson(socket, {\n          type: 'error',\n          message: 'AudioPacket v2 requires a capture generation in publisher registration.',\n        });\n        return;\n      }\n      if (audioPacketVersion === 2 && initialSequence === null) {\n        sendJson(socket, {\n          type: 'error',\n          message: 'AudioPacket v2 initial sequence must be a uint32 when provided.',\n        });\n        return;\n      }",
)
replace_once(
    'src/server.ts',
    "              source: 'mic',\n              generation: captureGeneration!,\n              ...AUDIO_TRANSPORT_CONFIG,",
    "              source: 'mic',\n              generation: captureGeneration!,\n              initialSequence: initialSequence ?? undefined,\n              ...AUDIO_TRANSPORT_CONFIG,",
)

# Uplink health distinguishes OS-muted input from a healthy live microphone.
replace_once(
    'src/audio-uplink-health.ts',
    "  inputGapSamples: number;\n  droppedSamples:",
    "  inputGapSamples: number;\n  inputMuted: boolean;\n  droppedSamples:",
)
replace_once(
    'src/audio-uplink-health.ts',
    "    inputGapSamples,\n    droppedSamples:",
    "    inputGapSamples,\n    inputMuted: payload.inputMuted === true,\n    droppedSamples:",
)

# Listen consumes the authoritative mixed stream rate, never applies >1 local
# gain, and resumes the existing graph after mobile suspension.
replace_once(
    'public/listen.js',
    "    // A curved local volume control preserves useful headroom for quiet phone\n    // speakers without exposing the old engineering dB control in Live UI.\n    return ((percent / 100) ** 1.5) * 8;",
    "    // Keep local playback at or below unity. The server mix is already\n    // full-scale limited; multiplying it again here would create phone-only clipping.\n    return (percent / 100) ** 1.5;",
)
replace_once(
    'public/listen.js',
    "      sourceSampleRate = Number(message.sampleRate ?? message.mixSampleRate) || MIX_SAMPLE_RATE;",
    "      sourceSampleRate = Number(message.mixSampleRate ?? message.sampleRate) || MIX_SAMPLE_RATE;",
)
replace_once(
    'public/listen.js',
    "  async function ensureAudioGraph() {\n    if (audioContext && playbackNode && gainNode) {\n      if (audioContext.state === 'suspended') await audioContext.resume();\n      return;\n    }",
    "  async function resumeAudioGraph() {\n    if (!audioContext || audioContext.state !== 'suspended') return;\n    try {\n      await audioContext.resume();\n    } catch (error) {\n      console.warn('Listen AudioContext resume failed', error);\n    }\n  }\n\n  function recoverAudioGraph() {\n    if (effectiveMuted() || !audioContext) return;\n    void resumeAudioGraph().then(() => reconcile());\n  }\n\n  async function ensureAudioGraph() {\n    if (audioContext && playbackNode && gainNode) {\n      await resumeAudioGraph();\n      return;\n    }",
)
replace_once(
    'public/listen.js',
    "      const context = new AudioContext({ latencyHint: 'interactive' });\n      audioContext = context;\n      // Consume",
    "      const context = new AudioContext({ latencyHint: 'interactive' });\n      audioContext = context;\n      context.addEventListener('statechange', () => {\n        if (audioContext !== context || context.state !== 'suspended' || effectiveMuted()) return;\n        void resumeAudioGraph();\n      });\n      // Consume",
)
replace_once(
    'public/listen.js',
    "    if (transportEnabled) {\n      render(copy);",
    "    if (audioContext.state === 'suspended') void resumeAudioGraph();\n    if (transportEnabled) {\n      render(copy);",
)
replace_once(
    'public/listen.js',
    "  window.addEventListener('beforeunload', () => {",
    "  document.addEventListener('visibilitychange', () => {\n    if (document.visibilityState === 'visible') recoverAudioGraph();\n  });\n  window.addEventListener('pageshow', recoverAudioGraph);\n\n  window.addEventListener('beforeunload', () => {",
)

# Mic capture recovery mirrors Listen and publishes track mute state.
replace_once(
    'public/app.js',
    "let captureInputGapSamples = 0;\nlet publisherControlConnections = 0;",
    "let captureInputGapSamples = 0;\nlet captureInputMuted = false;\nlet publisherControlConnections = 0;",
)
replace_once(
    'public/app.js',
    "    inputGapSamples: captureInputGapSamples,\n    droppedSamples:",
    "    inputGapSamples: captureInputGapSamples,\n    inputMuted: captureInputMuted,\n    droppedSamples:",
)
replace_once(
    'public/app.js',
    "    captureGeneration: captureGeneration >>> 0,\n    audioPacketVersion: AUDIO_PACKET_VERSION,",
    "    captureGeneration: captureGeneration >>> 0,\n    initialSequence: capturePacketSequence >>> 0,\n    audioPacketVersion: AUDIO_PACKET_VERSION,",
)
replace_once(
    'public/app.js',
    "function canKeepPublishing() {\n  return publisherActive && Boolean(mediaStream) && Boolean(audioContext);\n}\n\nfunction schedulePublisherReconnect()",
    "function canKeepPublishing() {\n  return publisherActive && Boolean(mediaStream) && Boolean(audioContext);\n}\n\nasync function resumePublisherAudioContext() {\n  if (!publisherActive || !audioContext || audioContext.state !== 'suspended') return;\n  try {\n    await audioContext.resume();\n  } catch (error) {\n    console.warn('Microphone AudioContext resume failed', error);\n  }\n}\n\nfunction recoverPublisherAudio() {\n  if (!publisherActive) return;\n  void resumePublisherAudioContext();\n}\n\nfunction schedulePublisherReconnect()",
)
replace_once(
    'public/app.js',
    "  audioContext = new AudioContext({ latencyHint: 'interactive' });\n  await audioContext.audioWorklet.addModule('/capture-worklet.js');",
    "  audioContext = new AudioContext({ latencyHint: 'interactive' });\n  const captureContext = audioContext;\n  captureContext.addEventListener('statechange', () => {\n    if (!publisherActive || audioContext !== captureContext || captureContext.state !== 'suspended') return;\n    void resumePublisherAudioContext();\n  });\n  await audioContext.audioWorklet.addModule('/capture-worklet.js');",
)
replace_once(
    'public/app.js',
    "  captureInputGapSamples = 0;\n  uplinkDroppedSamples = 0;",
    "  captureInputGapSamples = 0;\n  captureInputMuted = false;\n  uplinkDroppedSamples = 0;",
)
replace_once(
    'public/app.js',
    "  const [track] = mediaStream.getAudioTracks();\n  track?.addEventListener('ended', () => {",
    "  const [track] = mediaStream.getAudioTracks();\n  captureInputMuted = track?.muted === true;\n  track?.addEventListener('mute', () => {\n    if (!publisherActive) return;\n    captureInputMuted = true;\n    sendAudioUplinkHealth();\n    setStatus('Microphone interrupted', 'The phone muted the microphone input; trying to recover it.');\n    void resumePublisherAudioContext();\n  });\n  track?.addEventListener('unmute', () => {\n    if (!publisherActive) return;\n    captureInputMuted = false;\n    sendAudioUplinkHealth();\n    setStatus('Microphone is live', 'Microphone input recovered.');\n    void resumePublisherAudioContext();\n  });\n  track?.addEventListener('ended', () => {",
)
replace_once(
    'public/app.js',
    "  captureInputGapSamples = 0;\n  publisherControlConnections = 0;\n  publisherButton.disabled = false;",
    "  captureInputGapSamples = 0;\n  captureInputMuted = false;\n  publisherControlConnections = 0;\n  publisherButton.disabled = false;",
)
replace_once(
    'public/app.js',
    "window.addEventListener('relay-release-microphone', () => {",
    "document.addEventListener('visibilitychange', () => {\n  if (document.visibilityState === 'visible') recoverPublisherAudio();\n});\nwindow.addEventListener('pageshow', recoverPublisherAudio);\n\nwindow.addEventListener('relay-release-microphone', () => {",
)

Path('test/restart-mobile-audio-contract.test.ts').write_text(r'''import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AudioPacketReceiver } from '../src/audio-packet-receiver.js';
import { encodeAudioPacket } from '../src/audio-packet.js';
import { parseAudioUplinkHealth } from '../src/audio-uplink-health.js';
import { RelayClient, startRelay } from './helpers/harness.js';

const serverSource = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const listenSource = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');
const presenceSource = readFileSync(new URL('../public/presence.js', import.meta.url), 'utf8');
const youtubeSyncSource = readFileSync(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');

test('server process incarnation scopes Presence and room Song revisions', async () => {
  assert.match(serverSource, /import \{ SERVER_INCARNATION \} from '\.\/server-incarnation\.js'/);
  assert.match(serverSource, /type: 'session-status',[\s\S]*serverIncarnation: SERVER_INCARNATION/);
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
  assert.match(listenSource, /async function resumeAudioGraph/);
  assert.match(listenSource, /addEventListener\('statechange'/);
  assert.match(listenSource, /document\.addEventListener\('visibilitychange'/);
  assert.match(listenSource, /window\.addEventListener\('pageshow', recoverAudioGraph\)/);
});

test('Mic recovery exposes OS input mute to server liveness', () => {
  assert.match(appSource, /initialSequence: capturePacketSequence >>> 0/);
  assert.match(appSource, /track\?\.addEventListener\('mute'/);
  assert.match(appSource, /track\?\.addEventListener\('unmute'/);
  assert.match(appSource, /document\.addEventListener\('visibilitychange'/);
  assert.match(appSource, /window\.addEventListener\('pageshow', recoverPublisherAudio\)/);
  assert.match(appSource, /captureContext\.addEventListener\('statechange'/);
  assert.match(serverSource, /micUplinkHealth\?\.inputMuted !== true/);

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
''')
