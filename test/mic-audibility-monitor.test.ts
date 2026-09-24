import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MicAudibilityMonitor, type MicAudibilityResult } from '../src/mic-audibility-monitor.js';

const RATE = 48_000;
const FRAME = 960;

function monitor() {
  return new MicAudibilityMonitor({ sampleRate: RATE, windowMs: 100, repeatEveryWindows: 2 });
}

function voice(length = FRAME) {
  const samples = new Int16Array(length);
  for (let i = 0; i < length; i += 1) samples[i] = Math.round(3000 * Math.sin(i / 7));
  return samples;
}

/** Five 20 ms frames close one 100 ms window. */
function runWindow(
  target: MicAudibilityMonitor,
  {
    live = true,
    received = () => voice(),
    missing = () => 0,
  }: {
    live?: boolean;
    received?: (frame: number) => Int16Array | null;
    missing?: (frame: number) => number;
  } = {},
): MicAudibilityResult {
  let result: MicAudibilityResult | null = null;
  for (let frame = 0; frame < 5; frame += 1) {
    const samples = received(frame);
    if (samples) target.observeReceived(samples);
    result = target.observeFrame({
      micLive: live,
      frameSamples: FRAME,
      micGapSamples: missing(frame),
      micStarvedSamples: 0,
    }) ?? result;
  }
  assert.ok(result, 'five frames close a 100 ms window');
  return result;
}

describe('MicAudibilityMonitor', () => {
  it('stays quiet for a live Mic that delivers and plays real voice', () => {
    const target = monitor();
    const result = runWindow(target);
    assert.equal(result.eligible, true);
    assert.deepEqual(result.suspect, []);
    assert.deepEqual(result.events, []);
    assert.equal(result.window.receivedFraction, 1);
    assert.ok(result.window.receivedRmsDbfs !== null && result.window.receivedRmsDbfs > -30);
  });

  it('flags intermittent mix gaps that never form a consecutive unplayable run', () => {
    const target = monitor();
    // Every other frame is fully missing: micPlayable's consecutive-run rule
    // never fires, yet 40% of the vocal is gone.
    const result = runWindow(target, { missing: (frame) => (frame % 2 === 1 ? FRAME : 0) });
    assert.deepEqual(result.suspect, ['mix-unplayable']);
    assert.equal(result.window.missingFraction, 0.4);
    assert.deepEqual(result.events, [
      { edge: 'start', kind: 'mix-unplayable', windows: 1, durationMs: 100 },
    ]);
  });

  it('flags a live Mic whose received PCM is all digital zero', () => {
    const target = monitor();
    const result = runWindow(target, { received: () => new Int16Array(FRAME) });
    assert.deepEqual(result.suspect, ['digital-silence']);
    assert.equal(result.window.receivedRmsDbfs, -120);
  });

  it('flags uplink loss when received PCM covers too little of the window', () => {
    const target = monitor();
    const result = runWindow(target, { received: (frame) => (frame < 3 ? voice() : null) });
    assert.deepEqual(result.suspect, ['uplink-underfed']);
    assert.equal(result.window.receivedFraction, 0.6);
  });

  it('ignores windows the room did not call live for their whole length', () => {
    const target = monitor();
    const result = runWindow(target, { live: false, received: () => null });
    assert.equal(result.eligible, false);
    assert.deepEqual(result.suspect, []);
    assert.deepEqual(result.events, []);
  });

  it('reports start, periodic continue and end edges for one episode', () => {
    const target = monitor();
    const silent = { received: () => new Int16Array(FRAME) };
    const edges = [
      runWindow(target, silent),
      runWindow(target, silent),
      runWindow(target, silent),
      runWindow(target),
    ].map((result) => result.events.map((event) => `${event.edge}:${event.windows}`));
    assert.deepEqual(edges, [['start:1'], [], ['continue:3'], ['end:3']]);
  });

  it('ends an open episode when the Mic stops being live', () => {
    const target = monitor();
    runWindow(target, { received: () => new Int16Array(FRAME) });
    const result = runWindow(target, { live: false });
    assert.deepEqual(result.events, [
      { edge: 'end', kind: 'digital-silence', windows: 1, durationMs: 100 },
    ]);
  });
});
