import assert from 'node:assert/strict';
import test from 'node:test';

import { generateProbeReference } from '../src/calibration-probe.js';
import { DuetProbe } from '../src/duet-probe.js';

const RATE = 48_000;
const LEAD_MS = 300;

/** B's timeline in session samples (1 ms = 48 samples), with the notes where `chimeAtMs` says. */
function fixture({ chimeAtMs = null as number | null, totalMs = 3_000, generation = 7 } = {}) {
  const timeline = new Int16Array((totalMs * RATE) / 1000);
  for (let i = 0; i < timeline.length; i++) timeline[i] = Math.round(Math.sin(i * 0.37) * 60);
  if (chimeAtMs !== null) {
    const reference = generateProbeReference(RATE);
    const at = Math.round((chimeAtMs * RATE) / 1000);
    for (let i = 0; i < reference.length; i++) timeline[at + i] += reference[i] * 2;
  }
  const sent: Array<{ requestId: number; leadMs: number }> = [];
  const state = { generation: generation as number | null, total: timeline.length };
  const probe = new DuetProbe({
    sampleRate: RATE, leadMs: LEAD_MS, searchMarginMs: 1_200, minCorrelation: 0.35,
    replyTimeoutMs: 4_000, analysisTimeoutMs: 6_000,
    send: (request) => { sent.push(request); return true; },
    sessionSampleAt: (ms) => (ms * RATE) / 1000,
    totalSamples: () => state.total,
    generation: () => state.generation,
    read: (start, count) => timeline.slice(start, start + count),
    evidence: () => ({ gapSamples: 0, frontierMissingSamples: 0 }),
  });
  return { probe, sent, state };
}

test("B's Mic path is where its notes land after the moment they were due", () => {
  // Sent at 0, answered at 100 ms: due at 50 + 300 = 350 ms. B's path is 120 ms.
  const f = fixture({ chimeAtMs: 470 });
  assert.equal(f.probe.begin('b:7', 0), true);
  assert.equal(f.probe.silencing, true);
  assert.deepEqual(f.sent, [{ requestId: 1, leadMs: LEAD_MS }]);
  assert.equal(f.probe.played({ requestId: 1, generation: 7 }, 100), true);
  f.probe.tick(200);
  assert.equal(f.probe.state, 'measured', JSON.stringify(f.probe.status()));
  assert.ok(Math.abs(f.probe.micLatencyMs! - 120) < 3, `${f.probe.micLatencyMs}`);
  assert.equal(f.probe.silencing, false);
  // The boot calibration's formula: Mic path − backing path + player offset.
  assert.ok(Math.abs(f.probe.advanceMs(40, 10, 1)! - 90) < 3);
  assert.equal(f.probe.advanceMs(null, 0, 1), null, 'no backing path yet');
});

test('once per B capture; a new capture is probed again', () => {
  const f = fixture({ chimeAtMs: 470 });
  f.probe.begin('b:7', 0);
  assert.equal(f.probe.begin('b:7', 50), false);
  assert.equal(f.sent.length, 1);
  assert.equal(f.probe.begin('b:8', 60), true);
  assert.equal(f.sent.length, 2);
});

test('notes B never heard (headphones) fail once and release B', () => {
  const f = fixture();
  f.probe.begin('b:7', 0);
  f.probe.played({ requestId: 1, generation: 7 }, 100);
  f.probe.tick(200);
  assert.equal(f.probe.state, 'failed');
  assert.match(f.probe.failureReason!, /not heard/);
  assert.equal(f.probe.silencing, false);
  assert.equal(f.probe.advanceMs(40, 0, 1), null);
});

test('a stale reply, a silent page and a changed capture all end the probe', () => {
  const stale = fixture({ chimeAtMs: 470 });
  stale.probe.begin('b:7', 0);
  assert.equal(stale.probe.played({ requestId: 99, generation: 7 }, 100), false);
  stale.probe.tick(5_000);
  assert.equal(stale.probe.state, 'failed');
  assert.match(stale.probe.failureReason!, /did not answer/);

  const changed = fixture({ chimeAtMs: 470 });
  changed.probe.begin('b:7', 0);
  changed.probe.played({ requestId: 1, generation: 7 }, 100);
  changed.state.generation = 8;
  changed.probe.tick(200);
  assert.match(changed.probe.failureReason!, /capture changed/);

  const waiting = fixture({ chimeAtMs: 470 });
  waiting.state.total = 1_000;
  waiting.probe.begin('b:7', 0);
  waiting.probe.played({ requestId: 1, generation: 7 }, 100);
  waiting.probe.tick(200);
  assert.equal(waiting.probe.state, 'analyzing', 'waits for B audio to arrive');
  waiting.probe.tick(7_000);
  assert.equal(waiting.probe.state, 'failed');
});
