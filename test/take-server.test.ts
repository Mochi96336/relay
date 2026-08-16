import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RelayClient, sleep, startRelay, type RelayServer } from './helpers/harness.js';

const RATE = 48_000;
const FRAME_SAMPLES = 960;
const VIDEO = 'dQw4w9WgXcQ';
const FAST = {
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_PROBE: '0',
  RELAY_HEARTBEAT_MS: '60000',
  RELAY_LIVE_PREBUFFER_MS: '40',
};

function participantQuery(participantId: string, name: string, key?: string) {
  const params = new URLSearchParams();
  if (key) params.set('key', key);
  params.set('participant', participantId);
  params.set('name', name);
  return `?${params.toString()}`;
}

function backingQuery(key?: string) {
  return key ? `?key=${encodeURIComponent(key)}` : '';
}

function telemetry(currentTime: number, state = 5) {
  return {
    type: 'youtube-telemetry',
    videoId: VIDEO,
    state,
    currentTime,
    duration: 200,
    playbackRate: 1,
    bufferedFraction: 0.8,
  };
}

function pcmFrame(value: number) {
  const frame = Buffer.alloc(FRAME_SAMPLES * 2);
  for (let i = 0; i < FRAME_SAMPLES; i += 1) frame.writeInt16LE(value, i * 2);
  return frame;
}

async function playback(client: RelayClient, transportId: string) {
  client.send({ type: 'playback-hello', playbackTransportId: transportId, playbackGeneration: 1 });
  await client.waitFor((message) => (
    message.type === 'playback-registered'
    && message.playbackTransportId === transportId
  ));
}

async function establishRoomSong(client: RelayClient, transportId: string) {
  await playback(client, transportId);
  client.send({
    type: 'room-song-command',
    commandId: `load-${transportId}`,
    expectedRevision: 0,
    action: 'load',
    videoId: VIDEO,
    positionSeconds: 0,
  });
  await client.waitFor((message) => (
    message.type === 'room-song-command-accepted'
    && message.commandId === `load-${transportId}`
  ));
  await client.waitFor((message) => (
    message.type === 'room-song-command-apply'
    && message.commandId === `load-${transportId}`
  ));
  client.send(telemetry(0));
  await client.waitFor((message) => (
    message.type === 'room-song-command-complete'
    && message.commandId === `load-${transportId}`
  ));
}

async function startBacking(server: RelayServer, key?: string) {
  const backing = await RelayClient.connect(server, backingQuery(key));
  backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
  await backing.waitFor((message) => message.type === 'registered' && message.role === 'backing');
  return backing;
}

function feedBacking(backing: RelayClient, frames = 30, value = 10_000) {
  const frame = pcmFrame(value);
  for (let i = 0; i < frames; i += 1) backing.sendPcm(frame);
}

function feedMic(mic: RelayClient, frames = 30, value = 4_000) {
  const frame = pcmFrame(value);
  for (let i = 0; i < frames; i += 1) mic.sendPcm(frame);
}

async function waitReady(client: RelayClient, takeId: string) {
  return client.waitFor((message) => (
    message.type === 'take-status'
    && message.lifecycle === 'ready'
    && message.take?.takeId === takeId
  ));
}

function assertWav(bytes: Buffer) {
  assert.ok(bytes.byteLength > 44, 'Take artifact must contain PCM after the WAV header');
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(bytes.toString('ascii', 12, 16), 'fmt ');
  assert.equal(bytes.readUInt16LE(20), 1, 'WAV must be PCM');
  assert.equal(bytes.readUInt16LE(22), 1, 'Take must be mono');
  assert.equal(bytes.readUInt32LE(24), RATE);
  assert.equal(bytes.readUInt16LE(34), 16);
  assert.equal(bytes.toString('ascii', 36, 40), 'data');
  assert.equal(bytes.readUInt32LE(40), bytes.byteLength - 44);
  let peak = 0;
  for (let offset = 44; offset + 1 < bytes.byteLength; offset += 2) {
    peak = Math.max(peak, Math.abs(bytes.readInt16LE(offset)));
  }
  assert.ok(peak > 100, 'server Take should contain the authoritative non-silent mix');
}

test('Relay records the authoritative mixed PCM directly into an authenticated WAV artifact', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-server-'));
  const key = 'take-secret';
  const server = await startRelay({ ...FAST, RELAY_KEY: key, RELAY_TAKE_DIR: directory });
  try {
    const control = await RelayClient.connect(server, participantQuery('participant-a', 'A', key));
    await establishRoomSong(control, 'take-playback-a');
    const backing = await startBacking(server, key);

    control.send({ type: 'start-take' });
    const accepted = await control.waitFor((message) => (
      message.type === 'take-command-accepted' && message.command === 'start'
    ));
    const takeId = String(accepted.takeId);
    const recording = await control.waitFor((message) => (
      message.type === 'take-status'
      && message.lifecycle === 'recording'
      && message.take?.takeId === takeId
    ));
    assert.equal(recording.take.startedByParticipantId, 'participant-a');
    assert.equal(recording.take.song.videoId, VIDEO);
    assert.equal(recording.take.quality, null, 'quality is sealed when the recording stops');

    feedBacking(backing, 40);
    await sleep(260);

    control.send({ type: 'stop-take', takeId });
    await control.waitFor((message) => (
      message.type === 'take-command-accepted'
      && message.command === 'stop'
      && message.takeId === takeId
    ));
    const ready = await waitReady(control, takeId);
    assert.equal(ready.take.stopReason, 'user');
    assert.equal(ready.take.startedByParticipantId, 'participant-a');
    assert.equal(ready.take.stoppedByParticipantId, 'participant-a');
    assert.equal(ready.take.artifact.mimeType, 'audio/wav');
    assert.equal(ready.take.artifact.sampleRate, RATE);
    assert.equal(ready.take.artifact.channels, 1);
    assert.equal(ready.take.artifact.bitsPerSample, 16);
    assert.ok(ready.take.artifact.durationMs > 0);
    assert.equal(ready.take.quality.policyVersion, 'take-quality-v1');
    assert.equal(
      ready.take.quality.evidence.recordedSamples,
      ready.take.artifact.sampleCount,
      'quality must describe exactly the samples published in this WAV',
    );
    assert.equal(
      ready.take.quality.evidence.recordedDurationMs,
      ready.take.artifact.durationMs,
    );
    assert.ok(
      ['review', 'degraded'].includes(ready.take.quality.verdict),
      'this synthetic backing-only Take should expose missing-mic/timing evidence',
    );

    const unauthorized = await fetch(server.httpUrl(ready.take.artifact.url));
    assert.equal(unauthorized.status, 401, 'RELAY_KEY must also protect Take artifacts');

    const authorized = await fetch(`${server.httpUrl(ready.take.artifact.url)}?key=${encodeURIComponent(key)}`);
    assert.equal(authorized.status, 200);
    assert.match(authorized.headers.get('content-type') ?? '', /audio\/wav/);
    assert.match(authorized.headers.get('cache-control') ?? '', /private/);
    assertWav(Buffer.from(await authorized.arrayBuffer()));

    backing.close();
    control.close();
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a Take survives Mic takeover and can be stopped by the new participant without splitting', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-takeover-'));
  const server = await startRelay({ ...FAST, RELAY_TAKE_DIR: directory });
  try {
    const a = await RelayClient.connect(server, participantQuery('participant-a', 'A'));
    await playback(a, 'takeover-playback-a');
    a.send({ type: 'register', role: 'publisher', sampleRate: RATE, captureGeneration: 1 });
    await a.waitFor((message) => message.type === 'registered' && message.role === 'publisher');

    a.send({
      type: 'room-song-command',
      commandId: 'takeover-load',
      expectedRevision: 0,
      action: 'load',
      videoId: VIDEO,
      positionSeconds: 0,
    });
    await a.waitFor((message) => message.type === 'room-song-command-accepted' && message.commandId === 'takeover-load');
    await a.waitFor((message) => message.type === 'room-song-command-apply' && message.commandId === 'takeover-load');
    a.send(telemetry(0));
    await a.waitFor((message) => message.type === 'room-song-command-complete' && message.commandId === 'takeover-load');

    const backing = await startBacking(server);
    a.send({ type: 'start-take' });
    const start = await a.waitFor((message) => message.type === 'take-command-accepted' && message.command === 'start');
    const takeId = String(start.takeId);
    await a.waitFor((message) => message.type === 'take-status' && message.lifecycle === 'recording' && message.take?.takeId === takeId);
    feedBacking(backing, 20, 8_000);

    const b = await RelayClient.connect(server, participantQuery('participant-b', 'B'));
    b.send({
      type: 'register',
      role: 'publisher',
      sampleRate: RATE,
      captureGeneration: 1,
      takeoverExpectedOwnerId: 'participant-a',
    });
    await b.waitFor((message) => message.type === 'registered' && message.role === 'publisher');

    b.send({ type: 'take-status-request' });
    const afterTakeover = await b.waitFor((message) => (
      message.type === 'take-status'
      && message.lifecycle === 'recording'
      && message.take?.takeId === takeId
    ));
    assert.equal(afterTakeover.take.startedByParticipantId, 'participant-a');
    assert.equal(afterTakeover.take.endedAtMs, null);

    feedBacking(backing, 20, 12_000);
    await sleep(220);
    b.send({ type: 'stop-take', takeId });
    const ready = await waitReady(b, takeId);
    assert.equal(ready.take.startedByParticipantId, 'participant-a');
    assert.equal(ready.take.stoppedByParticipantId, 'participant-b');
    assert.equal(ready.take.takeId, takeId);
    assert.equal(ready.take.quality.evidence.events['mic-owner-changed'], 1);

    b.close();
    backing.close();
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Take keeps recording after the controller socket disconnects and another participant can finish it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-controller-'));
  const server = await startRelay({ ...FAST, RELAY_TAKE_DIR: directory });
  try {
    const a = await RelayClient.connect(server, participantQuery('participant-a', 'A'));
    await establishRoomSong(a, 'controller-playback-a');
    const backing = await startBacking(server);

    a.send({ type: 'start-take' });
    const start = await a.waitFor((message) => message.type === 'take-command-accepted' && message.command === 'start');
    const takeId = String(start.takeId);
    await a.waitFor((message) => message.type === 'take-status' && message.lifecycle === 'recording' && message.take?.takeId === takeId);
    a.close();

    feedBacking(backing, 30, 9_000);
    await sleep(220);

    const b = await RelayClient.connect(server, participantQuery('participant-b', 'B'));
    b.send({ type: 'take-status-request' });
    await b.waitFor((message) => message.type === 'take-status' && message.lifecycle === 'recording' && message.take?.takeId === takeId);
    b.send({ type: 'stop-take', takeId });
    const ready = await waitReady(b, takeId);
    assert.equal(ready.take.stoppedByParticipantId, 'participant-b');

    b.close();
    backing.close();
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a sustained backing outage is attached to the Take and degrades the final quality verdict', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-quality-outage-'));
  const server = await startRelay({
    ...FAST,
    RELAY_TAKE_DIR: directory,
    RELAY_BACKING_GRACE_MS: '1200',
  });
  try {
    const control = await RelayClient.connect(server, participantQuery('participant-a', 'A'));
    await playback(control, 'quality-playback-a');
    control.send({ type: 'register', role: 'publisher', sampleRate: RATE, captureGeneration: 1 });
    await control.waitFor((message) => message.type === 'registered' && message.role === 'publisher');

    control.send({
      type: 'room-song-command',
      commandId: 'quality-load',
      expectedRevision: 0,
      action: 'load',
      videoId: VIDEO,
      positionSeconds: 0,
    });
    await control.waitFor((message) => message.type === 'room-song-command-accepted' && message.commandId === 'quality-load');
    await control.waitFor((message) => message.type === 'room-song-command-apply' && message.commandId === 'quality-load');
    control.send(telemetry(0));
    await control.waitFor((message) => message.type === 'room-song-command-complete' && message.commandId === 'quality-load');

    let backing = await startBacking(server);
    feedMic(control, 60);
    // Keep only a small real-audio frontier. Exact Take evidence must not count
    // wall-clock disconnect time while already-buffered backing is still what
    // the WAV actually receives.
    feedBacking(backing, 10);
    await sleep(80);

    control.send({ type: 'start-take' });
    const start = await control.waitFor((message) => message.type === 'take-command-accepted' && message.command === 'start');
    const takeId = String(start.takeId);
    await control.waitFor((message) => message.type === 'take-status' && message.lifecycle === 'recording' && message.take?.takeId === takeId);

    feedMic(control, 80);
    // Let the small backing frontier drain before disconnecting so the next
    // emitted frames genuinely contain missing backing rather than buffered
    // pre-outage audio.
    await sleep(160);
    backing.close();
    await sleep(340);

    backing = await startBacking(server);
    feedBacking(backing, 40, 12_000);
    feedMic(control, 40, 5_000);
    await sleep(100);

    control.send({ type: 'stop-take', takeId });
    const ready = await waitReady(control, takeId);
    assert.equal(ready.take.quality.verdict, 'degraded');
    assert.ok(ready.take.quality.evidence.backingUnavailableMs >= 250);
    assert.equal(ready.take.quality.evidence.events['backing-transport-disconnected'], 1);
    assert.equal(ready.take.quality.evidence.events['backing-transport-connected'], 1);
    assert.equal(
      ready.take.quality.issues.some((issue: { code: string; severity: string }) => (
        issue.code === 'backing-unavailable' && issue.severity === 'critical'
      )),
      true,
    );

    backing.close();
    control.close();
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('ending the authoritative live mix auto-finalizes the active Take instead of leaving fake recording state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-mix-end-'));
  const server = await startRelay({
    ...FAST,
    RELAY_TAKE_DIR: directory,
    RELAY_BACKING_GRACE_MS: '100',
  });
  try {
    const control = await RelayClient.connect(server, participantQuery('participant-a', 'A'));
    await establishRoomSong(control, 'mix-end-playback-a');
    const backing = await startBacking(server);

    control.send({ type: 'start-take' });
    const start = await control.waitFor((message) => message.type === 'take-command-accepted' && message.command === 'start');
    const takeId = String(start.takeId);
    feedBacking(backing, 20, 11_000);
    await sleep(180);

    backing.close();
    const ready = await waitReady(control, takeId);
    assert.equal(ready.take.stopReason, 'mix-ended');
    assert.equal(ready.take.stoppedByParticipantId, null);
    assert.ok(ready.take.artifact.durationMs > 0);
    assert.ok(ready.take.quality, 'auto-finalized Takes keep their quality evidence');

    control.close();
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Take commands require participant identity, an active mix, a song, and the current Take id', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-reject-'));
  const server = await startRelay({ ...FAST, RELAY_TAKE_DIR: directory });
  try {
    const anonymous = await RelayClient.connect(server);
    anonymous.send({ type: 'start-take' });
    assert.equal((await anonymous.waitForType('take-command-rejected')).reason, 'participant-required');

    const control = await RelayClient.connect(server, participantQuery('participant-a', 'A'));
    control.send({ type: 'start-take' });
    assert.equal((await control.waitForType('take-command-rejected')).reason, 'mix-not-active');

    const backing = await startBacking(server);
    control.send({ type: 'start-take' });
    const noSong = await control.waitFor((message) => (
      message.type === 'take-command-rejected'
      && message.command === 'start'
      && message.reason === 'song-required'
    ));
    assert.equal(noSong.reason, 'song-required');

    await establishRoomSong(control, 'reject-playback-a');
    control.send({ type: 'start-take' });
    const start = await control.waitFor((message) => message.type === 'take-command-accepted' && message.command === 'start');
    const takeId = String(start.takeId);

    control.send({ type: 'stop-take', takeId: 'older-take' });
    const stale = await control.waitFor((message) => message.type === 'take-command-rejected' && message.command === 'stop');
    assert.equal(stale.reason, 'stale-take');

    control.send({ type: 'stop-take', takeId });
    await waitReady(control, takeId);

    backing.close();
    control.close();
    anonymous.close();
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});