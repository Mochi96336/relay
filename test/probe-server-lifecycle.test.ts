import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';

const RATE = 48_000;
const FRAME = Buffer.alloc(Math.round(RATE * 0.02) * 2);

const PROBE_FAST = {
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_PROBE: '1',
  RELAY_CALIBRATION_PROBE_RETRY_MS: '100',
  RELAY_CALIBRATION_PROBE_REPLY_TIMEOUT_MS: '100',
  RELAY_CALIBRATION_PROBE_MAX_ATTEMPTS: '2',
  RELAY_CALIBRATION_PROBE_SEARCH_MARGIN_MS: '200',
  RELAY_CALIBRATION_PROBE_ANALYSIS_TIMEOUT_MS: '1500',
  RELAY_CALIBRATION_PROBE_MIN_CORRELATION: '0',
};

async function robotSession(server: Awaited<ReturnType<typeof startRelay>>) {
  const backing = await RelayClient.connectBacking(server, { robot: true });

  const publisher = await RelayClient.connectAs(server, 'probe-singer', 'Singer');
  publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
  await publisher.waitForType('registered');

  const robot = await RelayClient.connectInfrastructure(server);
  robot.send({ type: 'robot-source-hello' });

  const monitor = await RelayClient.connectMonitor(server);

  const keepFlowing = setInterval(() => {
    backing.sendPcm(FRAME);
    publisher.sendPcm(FRAME);
  }, 50);
  backing.sendPcm(FRAME);
  publisher.sendPcm(FRAME);

  return {
    backing,
    publisher,
    robot,
    monitor,
    close() {
      clearInterval(keepFlowing);
      backing.close();
      publisher.close();
      robot.close();
      monitor.close();
    },
  };
}

async function waitForProbeCount(client: RelayClient, target: 'mic' | 'backing', count: number, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probes = client.messages.filter(
      (message) => message.type === 'play-calibration-probe' && message.target === target,
    );
    if (probes.length >= count) return probes;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${count} ${target} probes`);
}

test('accepted probe separates publisher preparation from network transit in its actual analysis target', async () => {
  const takeDirectory = await mkdtemp(path.join(os.tmpdir(), 'relay-probe-lifecycle-'));
  const server = await startRelay({ ...PROBE_FAST, RELAY_TAKE_DIR: takeDirectory,
    RELAY_CALIBRATION_PROBE_REPLY_TIMEOUT_MS: '1000' });
  const clients = await robotSession(server);
  try {
    const probe = (await waitForProbeCount(clients.publisher, 'mic', 1))[0];
    await sleep(150);
    clients.publisher.send({ type: 'calibration-probe-played', target: 'mic',
      requestId: probe.requestId, generation: clients.publisher.generationId,
      timingDiagnostics: { processingMs: 120, schedulingDelayMs: 100 } });
    const status = await clients.monitor.waitFor(m => m.type === 'timing-calibration-status'
      && m.bootProbeTimingEvidence?.mic?.requestId === probe.requestId, 2000);
    const evidence = status.bootProbeTimingEvidence.mic;
    assert.equal(evidence.schedule.method, 'processing-separated');
    assert.equal(evidence.schedule.transportOneWayMs, (evidence.roundTripMs - 120) / 2);
    const legacyTarget = evidence.serverReceivedAtMs - evidence.roundTripMs / 2 + probe.leadMs;
    assert.ok(Math.abs(evidence.schedule.targetAtMs - legacyTarget - 40) < .001);
  } finally {
    clients.close();
    await server.stop();
    await rm(takeDirectory, { recursive: true, force: true });
  }
});

test('probe acknowledgement retries stop at the configured limit and block Take while active', async () => {
  const takeDirectory = await mkdtemp(path.join(os.tmpdir(), 'relay-probe-lifecycle-'));
  const server = await startRelay({ ...PROBE_FAST, RELAY_TAKE_DIR: takeDirectory });
  const clients = await robotSession(server);
  try {
    const first = (await waitForProbeCount(clients.publisher, 'mic', 1))[0];
    assert.equal(first.target, 'mic');

    clients.publisher.send({ type: 'start-take' });
    const takeRejected = await clients.publisher.waitFor(
      (message) => message.type === 'take-command-rejected'
        && message.reason === 'timing-calibration-active',
      2_000,
    );
    assert.equal(takeRejected.reason, 'timing-calibration-active');

    const probes = await waitForProbeCount(clients.publisher, 'mic', 2);
    assert.notEqual(probes[0].requestId, probes[1].requestId);

    const failed = await clients.monitor.waitFor(
      (message) => message.type === 'timing-calibration-status'
        && message.state === 'failed'
        && message.probePhase === 'failed',
      3_000,
    );
    assert.equal(failed.probeActive, false);
    assert.equal(failed.probeAttempts.mic, 2);
    assert.equal(failed.probeMaxAttempts, 2);
    assert.match(failed.probeError, /Microphone timing probe failed after 2 attempts/);

    const countAtFailure = clients.publisher.messages.filter(
      (message) => message.type === 'play-calibration-probe' && message.target === 'mic',
    ).length;
    await sleep(700);
    const countAfterWait = clients.publisher.messages.filter(
      (message) => message.type === 'play-calibration-probe' && message.target === 'mic',
    ).length;
    assert.equal(countAfterWait, countAtFailure, 'terminal probe failure must not beep again automatically');
  } finally {
    clients.close();
    await server.stop();
    await rm(takeDirectory, { recursive: true, force: true });
  }
});

test('stale or wrong-generation acknowledgements cannot cancel the newer Mic probe request', async () => {
  const takeDirectory = await mkdtemp(path.join(os.tmpdir(), 'relay-probe-lifecycle-'));
  const server = await startRelay({
    RELAY_TAKE_DIR: takeDirectory,
    ...PROBE_FAST,
    RELAY_CALIBRATION_PROBE_MAX_ATTEMPTS: '3',
    // This test isolates request ownership, so leave enough wall-clock room to
    // observe an accidental re-arm without racing request #2's own deadline.
    RELAY_CALIBRATION_PROBE_REPLY_TIMEOUT_MS: '500',
  });
  const clients = await robotSession(server);
  try {
    const first = (await waitForProbeCount(clients.publisher, 'mic', 1))[0];
    const probes = await waitForProbeCount(clients.publisher, 'mic', 2);
    const second = probes[1];
    const generation = clients.publisher.generationId;

    clients.publisher.send({
      type: 'calibration-probe-played',
      target: 'mic',
      requestId: first.requestId,
      generation,
    });
    await sleep(20);

    // Even with the current request id, a reply from a different capture must
    // not consume the request. The real phone reports captureGeneration from
    // its live AudioWorklet state rather than echoing the play request.
    clients.publisher.send({
      type: 'calibration-probe-played',
      target: 'mic',
      requestId: second.requestId,
      generation: generation + 1,
    });

    // Both invalid acknowledgements must leave request #2 authoritative. With
    // a third attempt available, consuming either one would make the scheduler
    // emit #3 after the 100 ms retry. Stay inside #2's widened 500 ms deadline
    // so detector/timeline analysis is completely out of scope here.
    await sleep(150);
    const probesAfterInvalidReplies = clients.publisher.messages.filter(
      (message) => message.type === 'play-calibration-probe' && message.target === 'mic',
    );
    assert.equal(
      probesAfterInvalidReplies.length,
      2,
      'stale or wrong-generation acknowledgement must not consume the current request',
    );

    clients.publisher.send({
      type: 'calibration-probe-played',
      target: 'mic',
      requestId: second.requestId,
      generation,
    });
  } finally {
    clients.close();
    await server.stop();
    await rm(takeDirectory, { recursive: true, force: true });
  }
});

test('a singer who also plays the song has the Mic probe timed on their page clock', async () => {
  const { registerPlayback } = await import('./support/client-commands.js');
  const takeDirectory = await mkdtemp(path.join(os.tmpdir(), 'relay-probe-lifecycle-'));
  const server = await startRelay({ ...PROBE_FAST, RELAY_TAKE_DIR: takeDirectory,
    RELAY_CALIBRATION_PROBE_REPLY_TIMEOUT_MS: '6000' });
  const clients = await robotSession(server);
  const singer = clients.publisher;
  const videoId = 'dQw4w9WgXcQ';
  // The page's clock, an arbitrary distance from the server's.
  const startedAt = performance.now();
  const pageNow = () => performance.now() - startedAt + 4_321_000;
  let reports: NodeJS.Timeout | null = null;
  try {
    const probe = (await waitForProbeCount(singer, 'mic', 1))[0];
    const pageReceivedAtMs = pageNow();
    await registerPlayback(singer, 'probe-clock-player');
    const report = (state: number, currentTime: number) => singer.send({
      type: 'youtube-telemetry', videoId, state, currentTime, duration: 200, playbackRate: 1,
      playbackTransportId: 'probe-clock-player', playbackGeneration: 1, networkRttMs: 2,
      sampledAtPerformanceMs: pageNow(),
    });
    singer.send({ type: 'room-song-command', commandId: 'probe-clock-load', expectedRevision: 0, action: 'load', videoId, positionSeconds: 0 });
    await singer.waitFor(m => m.type === 'room-song-command-apply' && m.commandId === 'probe-clock-load');
    report(5, 0);
    await singer.waitFor(m => m.type === 'room-song-command-complete' && m.commandId === 'probe-clock-load');
    singer.send({ type: 'room-song-command', commandId: 'probe-clock-play', expectedRevision: 1, action: 'play' });
    await singer.waitFor(m => m.type === 'room-song-command-apply' && m.commandId === 'probe-clock-play');
    const playStartedAt = performance.now();
    report(1, 0);
    await singer.waitFor(m => m.type === 'room-song-command-complete' && m.commandId === 'probe-clock-play');
    reports = setInterval(() => report(1, (performance.now() - playStartedAt) / 1000), 250);
    // Two seconds of reports tell the room clock how this page's clock sits against its own.
    await sleep(2_600);
    // The page prepared for most of that time, scheduled the probe 4 ms before
    // acknowledging, and the reply then waits 300 ms on the way: an uneven
    // exchange, which the old estimate would have split down the middle.
    const acknowledgedAtMs = pageNow();
    const processingMs = acknowledgedAtMs - pageReceivedAtMs;
    await sleep(300);
    const repliedAt = performance.now();
    singer.send({ type: 'calibration-probe-played', target: 'mic',
      requestId: probe.requestId, generation: singer.generationId,
      timingDiagnostics: { processingMs, schedulingDelayMs: processingMs - 4, acknowledgedAtMs } });
    const status = await clients.monitor.waitFor(m => m.type === 'timing-calibration-status'
      && m.bootProbeTimingEvidence?.mic?.requestId === probe.requestId, 3000);
    const evidence = status.bootProbeTimingEvidence.mic;
    assert.equal(evidence.schedule.method, 'page-clock', JSON.stringify(evidence.schedule));
    // Scheduled 4 ms before the acknowledgement, which was 300 ms before the reply arrived.
    const scheduledAtServerMs = evidence.serverReceivedAtMs - (performance.now() - repliedAt) - 300 - 4;
    const placedLateMs = evidence.schedule.targetAtMs - probe.leadMs - scheduledAtServerMs;
    assert.ok(Math.abs(placedLateMs) < 40, `placed ${placedLateMs.toFixed(0)} ms from where the page scheduled it`);
    // Half the round trip would have put it about 150 ms late.
    const assumed = evidence.serverReceivedAtMs - (evidence.roundTripMs - processingMs) / 2 - 4;
    assert.ok(assumed - scheduledAtServerMs > 100, `the old estimate: ${(assumed - scheduledAtServerMs).toFixed(0)} ms late`);
  } finally {
    if (reports) clearInterval(reports);
    clients.close();
    await server.stop();
    await rm(takeDirectory, { recursive: true, force: true });
  }
});
