import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { TimingWindowCollector } from '../src/timing-window-collector.js';

const RATE = 48_000;
const WINDOW = RATE * 6;
const MS = RATE / 1_000;

const filled = (samples: number, value: number) => new Int16Array(samples).fill(value);

describe('TimingWindowCollector', () => {
  test('requires a positive window and enough buffer capacity', () => {
    assert.throws(() => new TimingWindowCollector(0), /positive integer/);
    assert.throws(() => new TimingWindowCollector(WINDOW, WINDOW - 1), /at least one complete window/);
  });

  test('does not become ready until both sides cover a complete shared window', () => {
    const collector = new TimingWindowCollector(WINDOW);
    collector.observeMic(filled(WINDOW, 1), 0);
    collector.observeBacking(filled(WINDOW / 2, 2), 0);

    assert.equal(collector.ready, false);
    assert.ok(Math.abs(collector.progress - 0.5) < 0.001);
    assert.equal(collector.takeReadyWindow(), null);

    collector.observeBacking(filled(WINDOW / 2, 2), WINDOW / 2);
    assert.equal(collector.ready, true);
    assert.equal(collector.progress, 1);
  });

  test('starts where both sides actually have audio', () => {
    const collector = new TimingWindowCollector(WINDOW, WINDOW * 3);
    const late = 3_000 * MS;

    collector.observeBacking(filled(WINDOW * 2, 500), 0);
    collector.observeMic(filled(WINDOW, 1_000), late);

    const window = collector.takeReadyWindow();
    assert.ok(window);
    assert.equal(window.originSample, late);
    assert.equal(window.endSample, late + WINDOW);
    assert.equal(window.mic[0], 1_000);
    assert.equal(window.backing[0], 500);
    assert.equal(window.micGapSamples, 0);
    assert.equal(window.backingGapSamples, 0);
  });

  test('preserves a dropped frame as a hole instead of shifting later audio', () => {
    const collector = new TimingWindowCollector(WINDOW);
    const half = WINDOW / 2;
    const gap = 100 * MS;

    collector.observeBacking(filled(WINDOW, 500), 0);
    collector.observeMic(filled(half, 1_000), 0);
    collector.observeMic(filled(half, 2_000), half + gap);

    const window = collector.takeReadyWindow();
    assert.ok(window);
    assert.equal(window.mic[half - 1], 1_000);
    assert.equal(window.mic[half], 0);
    assert.equal(window.mic[half + gap], 2_000);
    assert.equal(window.micGapSamples, gap);
    assert.equal(window.backingGapSamples, 0);
  });

  test('retains already-buffered suffix audio for the next independent window', () => {
    const collector = new TimingWindowCollector(WINDOW, WINDOW * 3);

    collector.observeBacking(filled(WINDOW * 2, 500), 0);
    collector.observeMic(filled(WINDOW * 2, 1_000), 0);

    const first = collector.takeReadyWindow();
    assert.ok(first);
    assert.equal(first.originSample, 0);
    assert.equal(first.endSample, WINDOW);
    assert.equal(collector.ready, true, 'the second full window was already buffered');

    const second = collector.takeReadyWindow();
    assert.ok(second);
    assert.equal(second.originSample, WINDOW);
    assert.equal(second.endSample, WINDOW * 2);
    assert.equal(second.mic[0], 1_000);
    assert.equal(second.backing[0], 500);
    assert.equal(collector.ready, false);
  });

  test('reports each side span for timeout diagnostics', () => {
    const collector = new TimingWindowCollector(WINDOW);
    collector.observeMic(filled(2_000 * MS, 1), 1_000 * MS);
    collector.observeBacking(filled(4_000 * MS, 1), 500 * MS);

    assert.equal(collector.micSpanSamples, 2_000 * MS);
    assert.equal(collector.backingSpanSamples, 4_000 * MS);
  });

  test('ignores chunks that start beyond the configured fast-side buffer horizon', () => {
    const collector = new TimingWindowCollector(WINDOW, WINDOW * 2);
    collector.observeMic(filled(20 * MS, 1), 0);
    collector.observeMic(filled(20 * MS, 2), WINDOW * 2);

    assert.equal(collector.micSpanSamples, 20 * MS);
  });
});
