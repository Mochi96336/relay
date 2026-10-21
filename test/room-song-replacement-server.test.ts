import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { participantIdFor, RelayClient, startRelay, waitForNewMessage } from './helpers/harness.js';
import { micPublisher, playRoomSong, registerPlayback } from './support/client-commands.js';
import { youtubeTelemetry } from './support/youtube-telemetry.js';

const VIDEO = 'dQw4w9WgXcQ';
const NEXT = 'M7lc1UVf-VE';
const A = participantIdFor('A');
const B = participantIdFor('B');

async function setup(t: TestContext) {
  const server = await startRelay({ RELAY_AUTO_CALIBRATE: '0' });
  t.after(() => server.stop());
  const a = await RelayClient.connectAs(server, 'A');
  await registerPlayback(a, 'playback-replacement-a');
  const aMic = await micPublisher(server, 'A');
  await playRoomSong(a, { positionSeconds: 199.8, prefix: 'replacement' });
  const b = await RelayClient.connectAs(server, 'B');
  await registerPlayback(b, 'playback-replacement-b');
  t.after(() => { a.close(); b.close(); aMic.close(); });
  const acquire = async () => {
    b.send({ type: 'playback-mic-intent' });
    await b.waitForType('playback-mic-intent-registered');
    const bMic = await micPublisher(server, 'B', A);
    t.after(() => bMic.close());
    return b.waitForType('song-handoff-prepare');
  };
  return { a, b, acquire };
}

const report = (state: number, currentTime: number, videoId = VIDEO) => ({
  type: 'youtube-telemetry', ...youtubeTelemetry({ state, currentTime, videoId }),
});

test('Mic owner can replace a stuck handoff; rejection and replay cannot disturb authority', async t => {
  const { a, b, acquire } = await setup(t);
  const plan = await acquire();
  const load = { type: 'room-song-command', action: 'load', videoId: NEXT, positionSeconds: 0 };
  a.send({ ...load, commandId: 'outsider-load', expectedRevision: 2 });
  assert.equal((await a.waitFor(m => m.type === 'room-song-command-rejected' && m.commandId === 'outsider-load')).reason, 'handoff-active');
  b.send({ ...load, commandId: 'stale-load', expectedRevision: 1 });
  assert.equal((await b.waitFor(m => m.type === 'room-song-command-rejected' && m.commandId === 'stale-load')).reason, 'stale-revision');
  assert.equal(b.messages.some(m => m.type === 'song-handoff-cancelled'), false);

  const from = b.messages.length;
  b.send({ ...load, commandId: 'new-owner-load', expectedRevision: 2 });
  await b.waitFor(m => m.type === 'room-song-command-apply' && m.commandId === 'new-owner-load');
  const events = b.messages.slice(from);
  assert.ok(events.findIndex(m => m.type === 'song-handoff-cancelled') < events.findIndex(m => m.type === 'room-song-command-apply'));
  assert.ok(events.some(m => m.type === 'song-handoff-cancelled'));
  b.send({ type: 'song-handoff-ready', handoffId: plan.handoffId });
  b.send(report(5, 0, NEXT));
  await b.waitFor(m => m.type === 'room-song-command-complete' && m.commandId === 'new-owner-load');
  const changed = await waitForNewMessage(b, from, m => m.type === 'youtube-timeline-status' && m.videoId === NEXT);
  assert.equal(changed.playbackLeaderParticipantId, B);
  assert.equal(changed.handoffState, 'idle');
  assert.equal(b.messages.slice(from).some(m => m.type === 'song-handoff-commit'), false);

  const after = b.messages.length;
  b.send({ ...load, commandId: 'new-owner-load', expectedRevision: 2 });
  await waitForNewMessage(b, after, m => m.type === 'room-song-command-accepted' && m.duplicate === true);
  assert.equal(b.messages.slice(after).some(m => m.type === 'room-song-command-apply'), false);
});

test('ended-song handoff preserves ENDED through cued polling, then replays on an authorized Play', async t => {
  const { a, b, acquire } = await setup(t);
  const endFrom = a.messages.length;
  a.send(report(0, 200));
  await waitForNewMessage(a, endFrom, m => m.type === 'youtube-timeline-status' && m.state === 0);
  const plan = await acquire();
  assert.equal(plan.state, 5);
  assert.equal(plan.serverTime, 0);
  b.send({ type: 'song-handoff-ready', handoffId: plan.handoffId });
  await b.waitForType('song-handoff-commit');
  b.send(report(5, 0));
  await b.waitForType('song-handoff-complete');
  const from = b.messages.length;
  b.send(report(5, 0));
  const parked = await waitForNewMessage(b, from, m => m.type === 'youtube-timeline-status' && m.playbackLeaderParticipantId === B);
  assert.equal(parked.state, 0);
  assert.equal(parked.serverTime, 200);
  assert.equal(parked.playbackParked, true);
  b.send({ type: 'room-song-command', commandId: 'failed-replay', expectedRevision: 2, action: 'play' });
  await b.waitFor(m => m.type === 'room-song-command-apply' && m.commandId === 'failed-replay');
  b.send({ type: 'room-song-command-failed', commandId: 'failed-replay', reason: 'autoplay-blocked' });
  await b.waitFor(m => m.type === 'room-song-command-failed-ack' && m.commandId === 'failed-replay');
  const retryFrom = b.messages.length;
  b.send(report(5, 0));
  const retained = await waitForNewMessage(b, retryFrom, m => m.type === 'youtube-timeline-status' && m.playbackParked === true);
  assert.equal(retained.state, 0);
  assert.equal(retained.serverTime, 200);
  b.send({ type: 'room-song-command', commandId: 'replay-ended', expectedRevision: 3, action: 'play' });
  const apply = await b.waitFor(m => m.type === 'room-song-command-apply' && m.commandId === 'replay-ended');
  assert.equal(apply.desired.positionSeconds, 0);
  assert.equal(apply.desired.mustApplyPosition, true);
  b.send(report(1, 0.05));
  await b.waitFor(m => m.type === 'room-song-command-complete' && m.commandId === 'replay-ended');
});

for (const phase of ['preparing', 'committing']) {
  test(`natural completion during ${phase} transfers a dormant controller`, async t => {
    const { a, b, acquire } = await setup(t);
    const initial = await acquire();
    assert.equal(initial.state, 1);
    if (phase === 'committing') {
      b.send({ type: 'song-handoff-ready', handoffId: initial.handoffId });
      await b.waitForType('song-handoff-commit');
    }
    const from = b.messages.length;
    a.send(report(0, 200));
    const type = phase === 'committing' ? 'song-handoff-commit' : 'song-handoff-prepare';
    const refresh = await waitForNewMessage(b, from, m => m.type === type && m.state === 5);
    assert.equal(refresh.handoffId, initial.handoffId);
    assert.equal(refresh.serverTime, 0);
    if (phase === 'preparing') {
      b.send({ type: 'song-handoff-ready', handoffId: initial.handoffId });
      await waitForNewMessage(b, from, m => m.type === 'song-handoff-commit' && m.state === 5);
    }
    b.send(report(5, 0));
    await b.waitForType('song-handoff-complete');
    const completed = await waitForNewMessage(b, from, m => m.type === 'youtube-timeline-status' && m.playbackLeaderParticipantId === B);
    assert.equal(completed.state, 0);
    assert.equal(completed.serverTime, 200);
  });
}
