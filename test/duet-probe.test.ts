import assert from 'node:assert/strict';
import test from 'node:test';

import { generateProbeReference } from '../src/calibration-probe.js';
import { DuetProbe, type ProbeLegTimeline } from '../src/duet-probe.js';

const RATE = 48_000;
const LEAD_MS = 300;

/** A timeline in session samples (1 ms = 48 samples), with notes at each of `chimesAtMs`. */
function timeline(chimesAtMs: number[], generation: number | null, totalMs = 6_000) {
  const pcm = new Int16Array((totalMs * RATE) / 1000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(i * 0.37) * 60);
  const reference = generateProbeReference(RATE);
  for (const atMs of chimesAtMs) {
    const at = Math.round((atMs * RATE) / 1000);
    for (let i = 0; i < reference.length; i++) pcm[at + i] += reference[i] * 2;
  }
  const state = { generation, total: pcm.length };
  const view: ProbeLegTimeline = {
    totalSamples: () => state.total,
    generation: () => state.generation,
    read: (start, count) => pcm.slice(start, start + count),
    evidence: () => ({ gapSamples: 0, frontierMissingSamples: 0 }),
  };
  return { view, state };
}

function fixture({
  bChimesAtMs = [] as number[], robotChimesAtMs = [] as number[],
  backingLatencyMs = 40 as number | null, robotAvailable = true,
} = {}) {
  const b = timeline(bChimesAtMs, 7);
  const robot = timeline(robotChimesAtMs, null);
  const sentB: number[] = [];
  const sentRobot: number[] = [];
  const kept = { backingLatencyMs };
  const probe = new DuetProbe({
    sampleRate: RATE, leadMs: LEAD_MS, searchMarginMs: 1_200, minCorrelation: 0.35,
    replyTimeoutMs: 4_000, analysisTimeoutMs: 6_000,
    sessionSampleAt: (ms) => (ms * RATE) / 1000,
    secondary: b.view, backing: robot.view,
    backingLatencyMs: () => kept.backingLatencyMs,
    onBackingMeasured: (ms) => { kept.backingLatencyMs = ms; },
    robotAvailable: () => robotAvailable,
    sendSecondary: ({ requestId }) => { sentB.push(requestId); return true; },
    sendRobot: ({ requestId }) => { sentRobot.push(requestId); return true; },
  });
  return { probe, sentB, sentRobot, b, kept };
}

test("B's Mic path is where its notes land after the moment they were due", () => {
  // Sent at 0, answered at 100 ms: due at 50 + 300 = 350 ms. B's path is 120 ms.
  const f = fixture({ bChimesAtMs: [470] });
  assert.equal(f.probe.begin('b:7', 0), true);
  assert.equal(f.probe.silencing, true);
  assert.equal(f.sentRobot.length, 0, 'a kept Robot leg is reused');
  assert.equal(f.probe.played({ requestId: f.sentB[0], generation: 7 }, 100), true);
  assert.equal(f.probe.state, 'analyzing');
  f.probe.tick(200);
  assert.equal(f.probe.state, 'measured', JSON.stringify(f.probe.status()));
  assert.ok(Math.abs(f.probe.micLatencyMs! - 120) < 3, `${f.probe.micLatencyMs}`);
  assert.equal(f.probe.silencing, false);
  // The boot calibration's formula: Mic path − backing path + player offset.
  assert.ok(Math.abs(f.probe.advanceMs(10, 1)! - 90) < 3);
});

test('with no Robot leg yet, the Robot plays first and its path is kept for the room', () => {
  // Robot asked at 0, answered at 100 (due 350), its notes land at 410: 60 ms.
  // B is asked as the Robot's leg completes (150), answered at 300
  // (due 150 + 75 + 300 = 525), its notes land at 675: 150 ms.
  const f = fixture({ backingLatencyMs: null, robotChimesAtMs: [410], bChimesAtMs: [675] });
  f.probe.begin('b:7', 0);
  assert.equal(f.probe.state, 'robot');
  assert.equal(f.probe.silencing, false, "B is not held silent for the Robot's notes");
  assert.equal(f.probe.ownsRobotRequest(f.sentRobot[0]), true);
  assert.equal(f.probe.ownsRobotRequest(1), false, "the boot probe's own ids are not ours");
  f.probe.robotPlayed({ requestId: f.sentRobot[0] }, 100);
  f.probe.tick(150);
  assert.ok(Math.abs(f.kept.backingLatencyMs! - 60) < 3, `${f.kept.backingLatencyMs}`);
  assert.equal(f.probe.state, 'requested', "then B's own notes");
  f.probe.played({ requestId: f.sentB[0], generation: 7 }, 300);
  f.probe.tick(400);
  assert.equal(f.probe.state, 'measured', JSON.stringify(f.probe.status()));
  assert.ok(Math.abs(f.probe.advanceMs(0, 1)! - 90) < 4);
});

test('no Robot leg and no Robot: fails at once instead of waiting', () => {
  const f = fixture({ backingLatencyMs: null, robotAvailable: false });
  f.probe.begin('b:7', 0);
  assert.equal(f.probe.state, 'failed');
  assert.match(f.probe.failureReason!, /no Robot/);
});

test('once per B capture automatically; B may ask again', () => {
  const f = fixture({ bChimesAtMs: [470] });
  f.probe.begin('b:7', 0);
  assert.equal(f.probe.begin('b:7', 50), false);
  assert.equal(f.probe.realign('b:7', 60), false, 'not while one is running');
  f.probe.played({ requestId: f.sentB[0], generation: 7 }, 100);
  f.probe.tick(200);
  assert.equal(f.probe.realign('b:7', 300), true);
  assert.equal(f.sentB.length, 2);
  assert.equal(f.probe.micLatencyMs, null, 'a new measurement replaces the old one');
});

test('notes B never heard (headphones) fail once and release B', () => {
  const f = fixture();
  f.probe.begin('b:7', 0);
  f.probe.played({ requestId: f.sentB[0], generation: 7 }, 100);
  f.probe.tick(200);
  assert.equal(f.probe.state, 'failed');
  assert.match(f.probe.failureReason!, /not heard/);
  assert.equal(f.probe.silencing, false);
  assert.equal(f.probe.advanceMs(0, 1), null);
});

test('a stale reply, a silent page and a changed capture all end the probe', () => {
  const stale = fixture({ bChimesAtMs: [470] });
  stale.probe.begin('b:7', 0);
  assert.equal(stale.probe.played({ requestId: 99, generation: 7 }, 100), false);
  stale.probe.tick(5_000);
  assert.equal(stale.probe.state, 'failed');
  assert.match(stale.probe.failureReason!, /did not answer/);

  const changed = fixture({ bChimesAtMs: [470] });
  changed.probe.begin('b:7', 0);
  changed.probe.played({ requestId: changed.sentB[0], generation: 7 }, 100);
  changed.b.state.generation = 8;
  changed.probe.tick(200);
  assert.match(changed.probe.failureReason!, /capture changed/);

  const waiting = fixture({ bChimesAtMs: [470] });
  waiting.b.state.total = 1_000;
  waiting.probe.begin('b:7', 0);
  waiting.probe.played({ requestId: waiting.sentB[0], generation: 7 }, 100);
  waiting.probe.tick(200);
  assert.equal(waiting.probe.state, 'analyzing', 'waits for B audio to arrive');
  waiting.probe.tick(7_000);
  assert.equal(waiting.probe.state, 'failed');
});
