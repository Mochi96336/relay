import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MicUplinkBacklog, type MicUplinkBacklogEdge } from '../src/mic-uplink-backlog.js';

const RATE = 48_000;
const PACKET = 480; // 10 ms
const samplesAt = (ms: number) => Math.round((ms * RATE) / 1000);

/**
 * A phone capturing in real time from 0 ms, with one health report a second
 * that reaches Relay `reportDelayMs` later. `arrivalMs(sentMs)` is when the
 * packet sent at `sentMs` reaches the mixer, or null when it never does.
 */
function run(
  seconds: number,
  arrivalMs: (sentMs: number) => number | null,
  { generation = 7, reportDelayMs = 30, backlog = new MicUplinkBacklog() } = {},
) {
  type Event =
    | { atMs: number; kind: 'packet'; endSample: number }
    | { atMs: number; kind: 'health'; capturedSamples: number };
  const events: Event[] = [];
  for (let sentMs = 10; sentMs <= seconds * 1000; sentMs += 10) {
    const at = arrivalMs(sentMs);
    if (at !== null) events.push({ atMs: at, kind: 'packet', endSample: samplesAt(sentMs) });
    if (sentMs % 1000 === 0) {
      events.push({ atMs: sentMs + reportDelayMs, kind: 'health', capturedSamples: samplesAt(sentMs) });
    }
  }
  events.sort((a, b) => a.atMs - b.atMs);

  const edges: (MicUplinkBacklogEdge & { atMs: number })[] = [];
  const backlogs: number[] = [];
  for (const event of events) {
    if (event.kind === 'packet') {
      backlog.noteArrived(generation, event.endSample);
      continue;
    }
    const edge = backlog.observeHealth({
      generation,
      capturedSamples: event.capturedSamples,
      sampleRate: RATE,
      atMs: event.atMs,
    });
    const status = backlog.status();
    if (status) backlogs.push(status.backlogMs);
    if (edge) edges.push({ ...edge, atMs: event.atMs });
  }
  return { backlog, edges, backlogs };
}

describe('Mic uplink backlog', () => {
  test('packets arriving on time keep the backlog at the network delay', () => {
    const { edges, backlogs } = run(30, (sentMs) => sentMs + 40);
    assert.deepEqual(edges, []);
    assert.ok(backlogs.every((ms) => ms >= 0 && ms <= 50), `backlogs ${backlogs.join(',')}`);
  });

  test('lost packets do not raise it, because the packets after them still arrive', () => {
    // Every other packet is lost for 20 s.
    const { edges, backlogs } = run(40, (sentMs) => (
      sentMs > 10_000 && sentMs <= 30_000 && (sentMs / 10) % 2 === 1 ? null : sentMs + 40
    ));
    assert.deepEqual(edges, []);
    assert.ok(Math.max(...backlogs) <= 50, `largest backlog ${Math.max(...backlogs)} ms`);
  });

  test('audio queued in order on a link carrying half of real time grows it, logged as one episode', () => {
    // Each 10 ms packet sent from 10 s to 30 s takes 20 ms to cross, so the
    // last of them arrives at 50 s, 20 s late. Later packets take 5 ms, so the
    // queue then drains at twice real time.
    let linkFreeAt = 0;
    const { edges, backlog } = run(80, (sentMs) => {
      const serviceMs = sentMs > 10_000 && sentMs <= 30_000 ? 20 : 5;
      linkFreeAt = Math.max(linkFreeAt, sentMs) + serviceMs;
      return linkFreeAt + 40;
    });

    const [start, ...rest] = edges;
    const end = rest.at(-1)!;
    const continues = rest.slice(0, -1);
    assert.equal(start.edge, 'start');
    assert.ok(start.backlogMs >= 400 && start.backlogMs < 1_000, `start at ${start.backlogMs} ms`);
    assert.ok(continues.length > 0 && continues.every((edge) => edge.edge === 'continue'));
    for (let index = 1; index < continues.length; index += 1) {
      assert.ok(
        continues[index].atMs - continues[index - 1].atMs >= 2_000,
        'an episode is repeated at most every 2 s',
      );
    }
    assert.equal(end.edge, 'end');
    assert.ok(end.backlogMs < 200);
    assert.ok(
      end.episodeMaxBacklogMs >= 19_500 && end.episodeMaxBacklogMs <= 20_500,
      `episode peaked at ${end.episodeMaxBacklogMs} ms`,
    );
    assert.ok(end.durationMs > 20_000, `episode lasted ${end.durationMs} ms`);
    assert.equal(backlog.status()?.maxBacklogMs, end.episodeMaxBacklogMs);
  });

  test('a health report that is itself late reads below zero and starts nothing', () => {
    const { edges, backlogs } = run(20, (sentMs) => sentMs + 40, { reportDelayMs: 600 });
    assert.deepEqual(edges, []);
    // The last report arrives after the capture's last packet.
    const whileStreaming = backlogs.slice(0, -1);
    assert.ok(whileStreaming.every((ms) => ms < 0), `backlogs ${backlogs.join(',')}`);
  });

  test('an older packet arriving late does not move the newest arrival back', () => {
    const backlog = new MicUplinkBacklog();
    backlog.noteArrived(7, samplesAt(1_000));
    backlog.noteArrived(7, samplesAt(400));
    backlog.observeHealth({ generation: 7, capturedSamples: samplesAt(1_050), sampleRate: RATE, atMs: 1_060 });
    assert.equal(backlog.status()?.backlogMs, 50);
  });

  test('a new capture says nothing until its first packet, and does not end the old episode', () => {
    const backlog = new MicUplinkBacklog();
    backlog.noteArrived(7, samplesAt(1_000));
    const start = backlog.observeHealth({ generation: 7, capturedSamples: samplesAt(3_000), sampleRate: RATE, atMs: 3_010 });
    assert.equal(start?.edge, 'start');

    assert.equal(
      backlog.observeHealth({ generation: 8, capturedSamples: samplesAt(100), sampleRate: RATE, atMs: 3_500 }),
      null,
    );
    assert.equal(backlog.status()?.generation, 7, 'a report without packets leaves the last reading alone');

    backlog.noteArrived(8, samplesAt(200));
    assert.equal(
      backlog.observeHealth({ generation: 8, capturedSamples: samplesAt(250), sampleRate: RATE, atMs: 4_000 }),
      null,
    );
    assert.deepEqual(backlog.status(), { generation: 8, backlogMs: 50, maxBacklogMs: 50 });
  });
});
