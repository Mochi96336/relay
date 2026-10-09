import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { AudioSession } from '../src/audio-session.js';
import { MicUplinkBacklog } from '../src/mic-uplink-backlog.js';

const RATE = 48_000;
const PACKET = 480; // 10 ms, as the phone sends
const CALIBRATED_MS = 50;

function packet(firstSampleIndex: number) {
  const pcm = Buffer.alloc(PACKET * 2);
  for (let i = 0; i < PACKET; i += 1) {
    const n = firstSampleIndex + i;
    pcm.writeInt16LE(Math.round(8_000 * Math.sin((2 * Math.PI * 220 * n) / RATE)), i * 2);
  }
  return { generation: 7, firstSampleIndex, pcm };
}

type Second = { atS: number; appliedMs: number; headroomMs: number; starvedFrames: number };

/**
 * How the mixer learns what is in transit: `exact` tells it once a second from
 * the true capture position, as from a report on a path that never lags;
 * `none` never tells it; `lagMs` sends a report every second that reaches
 * Relay `lagMs(sentMs)` later, in order, and the mixer is told every tick from
 * MicUplinkBacklog's estimate, as the server does.
 */
type Reports = 'exact' | 'none' | { lagMs: (sentMs: number) => number };

/** A phone capturing in real time whose packets reach the mixer at `arrivalMs(sentMs)`. */
function run(
  seconds: number,
  arrivalMs: (sentMs: number) => number,
  { reports = 'exact' as Reports } = {},
) {
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: 20,
    prebufferMs: 400,
    backingGain: 0.65,
    retentionMs: 3_000,
  });
  session.start(0);
  session.setMicExpected(true);
  session.setAlignment({ calibratedMicLagMs: CALIBRATED_MS });

  const inFlight: { at: number; index: number }[] = [];
  const backlog = new MicUplinkBacklog();
  const reportsInFlight: { at: number; captured: number }[] = [];
  let next = 0;
  let newestArrivedEnd = 0;
  let starved = 0;
  const perSecond: Second[] = [];
  for (let nowMs = 0; nowMs <= seconds * 1_000; nowMs += 5) {
    while (((next + PACKET) / RATE) * 1_000 <= nowMs) {
      inFlight.push({ at: arrivalMs(((next + PACKET) / RATE) * 1_000), index: next });
      next += PACKET;
    }
    inFlight.sort((a, b) => a.at - b.at);
    while (inFlight.length > 0 && inFlight[0].at <= nowMs) {
      const { at, index } = inFlight.shift()!;
      session.ingestMic(packet(index), RATE, at);
      newestArrivedEnd = Math.max(newestArrivedEnd, index + PACKET);
      backlog.noteArrived(7, index + PACKET);
    }
    if (reports === 'exact' && nowMs % 1_000 === 0 && newestArrivedEnd > 0) {
      const capturedSamples = Math.floor((nowMs * RATE) / 1_000);
      session.noteMicTransitBacklog(7, ((capturedSamples - newestArrivedEnd) / RATE) * 1_000);
    }
    if (typeof reports === 'object') {
      if (nowMs > 0 && nowMs % 1_000 === 0) {
        const at = Math.max(reportsInFlight.at(-1)?.at ?? 0, nowMs + reports.lagMs(nowMs));
        reportsInFlight.push({ at, captured: Math.floor((nowMs * RATE) / 1_000) });
      }
      while (reportsInFlight.length > 0 && reportsInFlight[0].at <= nowMs) {
        const { at, captured } = reportsInFlight.shift()!;
        backlog.observeHealth({ generation: 7, capturedSamples: captured, sampleRate: RATE, atMs: at });
      }
      const transit = backlog.estimate(nowMs);
      if (transit) session.noteMicTransitBacklog(transit.generation, transit.backlogMs);
    }
    session.drain((_frame, evidence) => {
      if (evidence.micStarvedSamples > 0 || evidence.micGapSamples > 0) starved += 1;
    }, nowMs);
    if (nowMs % 1_000 === 0) {
      perSecond.push({
        atS: nowMs / 1_000,
        appliedMs: Math.round(session.appliedMicAdvanceMs),
        headroomMs: Math.round(session.liveMicHeadroomMs ?? Number.NaN),
        starvedFrames: starved,
      });
      starved = 0;
    }
  }
  return perSecond;
}

/**
 * From 20 s to 30 s the uplink carries half of real time and queues the rest
 * in order, as on 2026-10-09 at 19:42 when about 5.8 s built up. Afterwards it
 * carries twice real time, so the 5 s queue has drained by about 40 s.
 */
function halfThroughputQueue() {
  let linkFreeAt = 0;
  return (sentMs: number) => {
    const startsAt = Math.max(linkFreeAt, sentMs);
    linkFreeAt = startsAt + (startsAt > 20_000 && startsAt <= 30_000 ? 20 : 5);
    return linkFreeAt + 40;
  };
}

describe('Mic audio still in transit', () => {
  test('is not waited for: the voice stays on the song and comes back on time once live audio arrives', () => {
    const seconds = run(90, halfThroughputQueue());
    const during = seconds.filter(({ atS }) => atS > 20 && atS <= 40);
    const worstDuring = Math.min(...during.map(({ appliedMs }) => appliedMs));
    assert.ok(
      worstDuring >= CALIBRATED_MS - 500,
      `the read head was held ${CALIBRATED_MS - worstDuring} ms behind the song while audio queued`,
    );

    // Arrivals catch up with live capture once the queue has drained.
    const recovered = seconds.filter(({ atS }) => atS >= 42);
    for (const second of recovered) {
      assert.ok(
        Math.abs(second.appliedMs - CALIBRATED_MS) <= 10,
        `at ${second.atS} s the voice was read ${CALIBRATED_MS - second.appliedMs} ms off the song`,
      );
      assert.equal(second.starvedFrames, 0, `at ${second.atS} s the voice still had holes`);
      assert.ok(second.headroomMs > 0);
    }
  });

  test('without transit reports, delayed audio that catches up is given back at once, not over minutes', () => {
    // The WebSocket path: health shares the queued socket, so nothing says
    // the audio is in transit and the read head is held back as before.
    const seconds = run(90, halfThroughputQueue(), { reports: 'none' });
    const held = Math.min(...seconds.filter(({ atS }) => atS <= 40).map(({ appliedMs }) => appliedMs));
    assert.ok(held < CALIBRATED_MS - 1_000, `expected the old hold while queued, saw ${held} ms`);
    for (const second of seconds.filter(({ atS }) => atS >= 42)) {
      assert.ok(
        Math.abs(second.appliedMs - CALIBRATED_MS) <= 10,
        `at ${second.atS} s the voice was still read ${CALIBRATED_MS - second.appliedMs} ms behind`,
      );
    }
  });
  test('reports that lag seconds behind on their own path do not hide it', () => {
    // As on 2026-10-09 at 21:08-21:09: while the audio queues, the reports lag
    // 3 s too, so the latest report says little is in transit.
    const lagging = { lagMs: (sentMs: number) => (sentMs > 20_000 && sentMs <= 40_000 ? 3_000 : 30) };
    const seconds = run(90, halfThroughputQueue(), { reports: lagging });
    const during = seconds.filter(({ atS }) => atS > 20 && atS <= 40);
    const worstDuring = Math.min(...during.map(({ appliedMs }) => appliedMs));
    assert.ok(
      worstDuring >= CALIBRATED_MS - 500,
      `the read head was held ${CALIBRATED_MS - worstDuring} ms behind the song while audio queued`,
    );
    for (const second of seconds.filter(({ atS }) => atS >= 46)) {
      assert.ok(
        Math.abs(second.appliedMs - CALIBRATED_MS) <= 10,
        `at ${second.atS} s the voice was read ${CALIBRATED_MS - second.appliedMs} ms off the song`,
      );
      assert.equal(second.starvedFrames, 0, `at ${second.atS} s the voice still had holes`);
    }
  });
});
