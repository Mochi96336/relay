import assert from 'node:assert/strict';
import test from 'node:test';
import { RelayClient, sleep, startRelay, waitForNewMessage } from './helpers/harness.js';
import { registerPlayback } from './support/client-commands.js';

const videoId = 'dQw4w9WgXcQ';

/**
 * The real protocol end to end: a playback page whose reports carry their
 * sample time, one of them 200 ms old when it arrives. What the Robot follows
 * (`youtubeTime` in the timeline status) must not fall behind by that.
 */
async function lateReportDip(env: Record<string, string>) {
  const server = await startRelay({
    RELAY_AUTO_CALIBRATE: '0', RELAY_CALIBRATION_PROBE: '0', RELAY_CALIBRATION_VALIDATION: '0', ...env });
  const clients: RelayClient[] = [];
  try {
    const phone = await RelayClient.connectAs(server, 'travel-time-phone', 'Phone'); clients.push(phone);
    phone.send({ type: 'register', role: 'publisher', sampleRate: 48000, captureGeneration: 1 });
    await phone.waitForType('registered');
    await registerPlayback(phone, 'travel-time-player');
    const startedAt = performance.now();
    // The page's clock, an arbitrary distance from this process's.
    const pageNow = () => performance.now() - startedAt + 777_000;
    const report = (state: number, currentTime: number, ageMs = 0) => phone.send({
      type: 'youtube-telemetry', videoId, state, currentTime, duration: 200, playbackRate: 1,
      playbackTransportId: 'travel-time-player', playbackGeneration: 1, networkRttMs: 2,
      sampledAtPerformanceMs: pageNow() - ageMs,
    });
    phone.send({ type: 'room-song-command', commandId: 'travel-load', expectedRevision: 0, action: 'load', videoId, positionSeconds: 0 });
    await phone.waitFor(m => m.type === 'room-song-command-apply' && m.commandId === 'travel-load');
    report(5, 0);
    await phone.waitFor(m => m.type === 'room-song-command-complete' && m.commandId === 'travel-load');
    phone.send({ type: 'room-song-command', commandId: 'travel-play', expectedRevision: 1, action: 'play' });
    await phone.waitFor(m => m.type === 'room-song-command-apply' && m.commandId === 'travel-play');
    const playStartedAt = performance.now();
    const position = () => (performance.now() - playStartedAt) / 1000;
    report(1, 0);
    await phone.waitFor(m => m.type === 'room-song-command-complete' && m.commandId === 'travel-play');
    for (let i = 0; i < 12; i++) { await sleep(250); report(1, position()); }
    // A report that spent 200 ms on the way: the position it carries is 200 ms old.
    await sleep(250);
    const from = phone.messages.length;
    report(1, position() - .2, 200);
    const status = await waitForNewMessage(phone, from, m => m.type === 'youtube-timeline-status' && m.state === 1);
    return (Number(status.youtubeTime) - position()) * 1000;
  } finally {
    for (const c of clients) c.close();
    await server.stop();
  }
}

test('a playback report that arrives late does not pull the Robot\'s target back', async () => {
  const dip = await lateReportDip({});
  assert.ok(Math.abs(dip) < 60, `the target moved by ${dip.toFixed(0)} ms`);
});

test('with RELAY_SONG_REPORT_TRAVEL_TIME=0 the same report pulls it back by its delay, as before', async () => {
  const dip = await lateReportDip({ RELAY_SONG_REPORT_TRAVEL_TIME: '0' });
  assert.ok(dip < -140 && dip > -260, `the target moved by ${dip.toFixed(0)} ms`);
});
