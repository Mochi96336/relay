import assert from 'node:assert/strict';
import test from 'node:test';

import { generateProbeReference } from '../src/calibration-probe.js';
import {
  RelayClient,
  pulseTrain,
  sendPcmInChunks,
  startRelay,
  toInt16,
  waitForNewMessage,
} from './helpers/harness.js';

/**
 * The Mic lag a Robot room uses while no calibration applies (server
 * fallbackMicLagMs): the path difference the Mic device measured before, or
 * the room-wide default, plus the Robot player's offset from the room timeline.
 */

const RATE = 48_000;
const PLAYING_TELEMETRY = {
  type: 'youtube-telemetry',
  videoId: 'dQw4w9WgXcQ',
  state: 1,
  currentTime: 42,
  duration: 200,
  playbackRate: 1,
  networkRttMs: 40,
};

const ROOM = {
  RELAY_LIVE_PREBUFFER_MS: '200',
  RELAY_HEARTBEAT_MS: '60000',
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_PROBE_RETRY_MS: '100',
  RELAY_CALIBRATION_PROBE_LEAD_MS: '20',
  RELAY_CALIBRATION_PROBE_SEARCH_MARGIN_MS: '1200',
  RELAY_CALIBRATION_PROBE_MIN_CORRELATION: '0.5',
  RELAY_CALIBRATION_PROBE_ANALYSIS_TIMEOUT_MS: '5000',
  RELAY_TIMING_FALLBACK_PATH_DIFFERENCE_MS: '40',
};

function tone(seconds: number, gain = 0.6, seed = 5) {
  return toInt16(pulseTrain(Math.round(RATE * seconds), RATE, seed), gain);
}

function probeAudio(leadMs: number, tailMs = 1_800) {
  const reference = generateProbeReference(RATE);
  const probe = Buffer.alloc(reference.length * 2);
  for (let i = 0; i < reference.length; i += 1) probe.writeInt16LE(reference[i], i * 2);
  return Buffer.concat([
    Buffer.alloc(Math.round((RATE * leadMs) / 1000) * 2),
    probe,
    Buffer.alloc(Math.round((RATE * tailMs) / 1000) * 2),
  ]);
}

async function robotRoom(server: Awaited<ReturnType<typeof startRelay>>) {
  const backing = await RelayClient.connect(server);
  backing.send({ type: 'register', role: 'backing', sampleRate: RATE, robot: true });
  await backing.waitForType('registered');
  const publisher = await RelayClient.connect(server, '?participant=singer-fallback&name=Singer');
  publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
  await publisher.waitForType('registered');
  const monitor = await RelayClient.connect(server);
  monitor.send({ type: 'register', role: 'monitor' });
  await monitor.waitForType('registered');
  const robot = await RelayClient.connect(server);
  robot.send({ type: 'robot-source-hello' });
  return {
    backing,
    publisher,
    monitor,
    robot,
    close() {
      for (const client of [backing, publisher, monitor, robot]) client.close();
    },
  };
}

function heartbeat(robot: RelayClient, offsetMs: number) {
  robot.send({ type: 'robot-player-offset', offsetMs });
  return setInterval(() => robot.send({ type: 'robot-player-offset', offsetMs }), 200);
}

test('with no calibration the voice is placed by the Robot player offset plus a typical path', async () => {
  const server = await startRelay({ ...ROOM, RELAY_CALIBRATION_PROBE: '0' });
  const room = await robotRoom(server);
  let beat: ReturnType<typeof setInterval> | null = null;
  try {
    await Promise.all([
      sendPcmInChunks(room.backing, tone(0.6, 0.8)),
      sendPcmInChunks(room.publisher, tone(0.6, 0.4)),
    ]);
    const from = room.monitor.messages.length;
    room.publisher.send(PLAYING_TELEMETRY);
    // The Robot plays 300 ms behind the room timeline.
    beat = heartbeat(room.robot, -300);

    const status = await waitForNewMessage(room.monitor, from, (m) => (
      m.type === 'source-status' && Math.round(Number(m.micFallbackLagMs)) === -260
    ), 5_000);
    assert.equal(status.timingMode, 'network-estimate');
    assert.equal(Math.round(Number(status.requestedMicAdvanceMs)), -260,
      'the mixer reads the voice by the estimate while nothing is measured');
  } finally {
    if (beat) clearInterval(beat);
    room.close();
    await server.stop();
  }
});

test('a device that measured its path before falls back to that path, not the default', async () => {
  const server = await startRelay({ ...ROOM, RELAY_CALIBRATION_PROBE: '1' });
  const room = await robotRoom(server);
  let beat: ReturnType<typeof setInterval> | null = null;
  try {
    await Promise.all([
      sendPcmInChunks(room.backing, tone(0.8, 0.8)),
      sendPcmInChunks(room.publisher, tone(0.8, 0.4)),
    ]);
    const micRequest = await room.publisher.waitFor(
      (m) => m.type === 'play-calibration-probe' && m.target === 'mic',
      5_000,
    );
    room.publisher.send({
      type: 'calibration-probe-played',
      target: 'mic',
      requestId: micRequest.requestId,
      generation: room.publisher.generationId,
    });
    // A Mic path well clear of the 40 ms default.
    await sendPcmInChunks(room.publisher, probeAudio(260));
    const backingRequest = await room.robot.waitFor(
      (m) => m.type === 'play-calibration-probe' && m.target === 'backing',
      5_000,
    );
    room.robot.send({ type: 'calibration-probe-played', target: 'backing', requestId: backingRequest.requestId });
    await sendPcmInChunks(room.backing, probeAudio(20));

    const booted = await room.monitor.waitFor(
      (m) => m.type === 'timing-calibration-status'
        && m.calibrationKind === 'boot-probe'
        && m.state === 'complete'
        && m.bootCalibration !== null,
      8_000,
    );
    const measuredMs = Number(booted.bootCalibration.micLatencyMs) - Number(booted.bootCalibration.backingLatencyMs);
    assert.ok(measuredMs > 150, `the fixture must measure a path well clear of the default, measured ${measuredMs} ms`);
    beat = heartbeat(room.robot, 0);

    // A new capture retires that measurement; its own probe goes unanswered,
    // as one the phone could not hear would.
    const from = room.monitor.messages.length;
    room.publisher.newCaptureSession();
    await sendPcmInChunks(room.publisher, tone(0.4, 0.4));
    const fallback = await waitForNewMessage(room.monitor, from, (m) => (
      m.type === 'source-status'
      && m.timingMode === 'network-estimate'
      && Math.abs(Number(m.micFallbackLagMs) - measuredMs) < 1
    ), 5_000);
    assert.equal(Math.round(Number(fallback.requestedMicAdvanceMs)), Math.round(measuredMs));
  } finally {
    if (beat) clearInterval(beat);
    room.close();
    await server.stop();
  }
});
