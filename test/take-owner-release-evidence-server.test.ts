import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RelayClient, sleep, startRelay, type RelayServer } from './helpers/harness.js';

const RATE = 48_000;
const VIDEO = 'dQw4w9WgXcQ';
const FAST = {
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_PROBE: '0',
  RELAY_HEARTBEAT_MS: '60000',
  RELAY_LIVE_PREBUFFER_MS: '40',
};

function participantQuery(participantId: string, name: string) {
  const params = new URLSearchParams({ participant: participantId, name });
  return `?${params.toString()}`;
}

async function establishRoomSong(client: RelayClient, transportId: string) {
  client.send({ type: 'playback-hello', playbackTransportId: transportId, playbackGeneration: 1 });
  await client.waitFor((message) => (
    message.type === 'playback-registered'
    && message.playbackTransportId === transportId
  ));
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
  client.send({
    type: 'youtube-telemetry',
    videoId: VIDEO,
    state: 5,
    currentTime: 0,
    duration: 200,
    playbackRate: 1,
    bufferedFraction: 0.8,
  });
  await client.waitFor((message) => (
    message.type === 'room-song-command-complete'
    && message.commandId === `load-${transportId}`
  ));
}

async function startBacking(server: RelayServer) {
  const backing = await RelayClient.connect(server);
  backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
  await backing.waitFor((message) => message.type === 'registered' && message.role === 'backing');
  return backing;
}

async function registerMic(server: RelayServer, participantId: string, name: string) {
  const mic = await RelayClient.connect(server, participantQuery(participantId, name));
  mic.send({ type: 'register', role: 'publisher', sampleRate: RATE, captureGeneration: 1 });
  await mic.waitFor((message) => message.type === 'registered' && message.role === 'publisher');
  return mic;
}

async function startTake(control: RelayClient) {
  control.send({ type: 'start-take' });
  const accepted = await control.waitFor((message) => (
    message.type === 'take-command-accepted' && message.command === 'start'
  ));
  const takeId = String(accepted.takeId);
  await control.waitFor((message) => (
    message.type === 'take-status'
    && message.lifecycle === 'recording'
    && message.take?.takeId === takeId
  ));
  return takeId;
}

async function stopAndRead(control: RelayClient, takeId: string) {
  control.send({ type: 'stop-take', takeId });
  return control.waitFor((message) => (
    message.type === 'take-status'
    && message.lifecycle === 'ready'
    && message.take?.takeId === takeId
  ));
}

async function waitForNewMessage(
  client: RelayClient,
  startIndex: number,
  predicate: (message: Record<string, any>) => boolean,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = client.messages.slice(startIndex).find(predicate);
    if (found) return found;
    await sleep(10);
  }
  throw new Error(
    `Timed out after ${timeoutMs} ms waiting for a new message. `
    + `Saw after index ${startIndex}: ${client.messages.slice(startIndex).map((message) => message.type).join(', ')}`,
  );
}

async function room(server: RelayServer, controllerId = 'participant-a') {
  const control = await RelayClient.connect(server, participantQuery(controllerId, 'Controller'));
  await establishRoomSong(control, `owner-release-${controllerId}`);
  const backing = await startBacking(server);
  return { control, backing };
}

test('explicit Mic release is one ownership transition and does not split the active Take', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-release-explicit-'));
  const server = await startRelay({ ...FAST, RELAY_TAKE_DIR: directory });
  try {
    const { control, backing } = await room(server);
    const mic = await registerMic(server, 'participant-a', 'Mic A');
    const takeId = await startTake(control);

    control.send({ type: 'release-mic' });
    await control.waitFor((message) => message.type === 'mic-released');
    await sleep(80);

    control.send({ type: 'take-status-request' });
    const stillRecording = await control.waitFor((message) => (
      message.type === 'take-status'
      && message.lifecycle === 'recording'
      && message.take?.takeId === takeId
    ));
    assert.equal(stillRecording.take.endedAtMs, null);

    const ready = await stopAndRead(control, takeId);
    assert.equal(ready.take.quality.evidence.events['mic-owner-changed'], 1);

    mic.close();
    backing.close();
    control.close();
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Mic transport grace release records ownership change while participant presence remains online', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-release-transport-'));
  const server = await startRelay({
    ...FAST,
    RELAY_TAKE_DIR: directory,
    RELAY_MIC_TRANSPORT_GRACE_MS: '80',
    RELAY_PARTICIPANT_GRACE_MS: '1000',
  });
  try {
    const { control, backing } = await room(server);
    const mic = await registerMic(server, 'participant-a', 'Mic A');
    const takeId = await startTake(control);

    const releaseStart = control.messages.length;
    mic.close();
    const released = await waitForNewMessage(control, releaseStart, (message) => (
      message.type === 'session-status'
      && message.micOwnerId === null
    ), 2_000);
    assert.equal(released.participants.some((participant: { id: string }) => participant.id === 'participant-a'), true);

    const ready = await stopAndRead(control, takeId);
    assert.equal(ready.take.quality.evidence.events['mic-owner-changed'], 1);
    assert.equal(ready.take.quality.evidence.events['mic-transport-disconnected'], 1);

    backing.close();
    control.close();
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('participant presence expiry records ownership change before the longer Mic transport grace', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-release-presence-'));
  const server = await startRelay({
    ...FAST,
    RELAY_TAKE_DIR: directory,
    RELAY_MIC_TRANSPORT_GRACE_MS: '1000',
    RELAY_PARTICIPANT_GRACE_MS: '80',
  });
  try {
    const { control: observer, backing } = await room(server, 'participant-b');
    const mic = await registerMic(server, 'participant-a', 'Mic A');
    const takeId = await startTake(observer);

    const releaseStart = observer.messages.length;
    mic.close();
    const released = await waitForNewMessage(observer, releaseStart, (message) => (
      message.type === 'session-status'
      && message.micOwnerId === null
    ), 2_000);
    assert.equal(released.participants.some((participant: { id: string }) => participant.id === 'participant-a'), false);

    const ready = await stopAndRead(observer, takeId);
    assert.equal(ready.take.quality.evidence.events['mic-owner-changed'], 1);
    assert.equal(ready.take.quality.evidence.events['mic-transport-disconnected'], 1);

    backing.close();
    observer.close();
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
