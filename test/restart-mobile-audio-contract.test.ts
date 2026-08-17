import assert from 'node:assert/strict';
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
