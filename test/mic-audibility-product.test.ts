import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MicAudibilityMonitor } from '../src/mic-audibility-monitor.js';
import { buildProductIssues, type ProductIssueFacts } from '../src/product-issues.js';

const LIVE_MIC: ProductIssueFacts = {
  routeMode: 'robot',
  backing: { connected: true, streaming: true, robot: true },
  robotSourceConnected: true,
  songClockSeverity: null,
  mic: { ownerId: 'participant-a', state: 'live' },
  takeLifecycle: 'idle',
  performanceActive: true,
  timingState: 'aligned',
};

describe('sustained Mic audibility loss in product state', () => {
  test('a live Mic whose audio is not reaching the mix is no longer shown as healthy', () => {
    const issues = buildProductIssues({
      ...LIVE_MIC,
      mic: { ...LIVE_MIC.mic, audibilityDegraded: true },
    });
    assert.deepEqual(issues, [{
      code: 'mic-audio-stalled',
      scope: 'mic',
      severity: 'warning',
      cause: 'mic-audio-intermittent',
      affects: ['voice', 'recording'],
      recovery: 'retry-mic',
    }]);
  });

  test('the browser recovery verdict keeps precedence and is not reported twice', () => {
    const issues = buildProductIssues({
      ...LIVE_MIC,
      mic: { ...LIVE_MIC.mic, mediaRecoveryDegraded: true, audibilityDegraded: true },
    });
    assert.deepEqual(issues.map((issue) => issue.cause), ['mic-audio-stalled']);
  });

  test('a Mic that is not live owns its own state', () => {
    for (const state of ['free', 'starting', 'reconnecting'] as const) {
      const issues = buildProductIssues({
        ...LIVE_MIC,
        mic: { ownerId: 'participant-a', state, audibilityDegraded: true },
      });
      assert.ok(!issues.some((issue) => issue.cause === 'mic-audio-intermittent'), state);
    }
  });
});

describe('MicAudibilityMonitor degraded hysteresis', () => {
  const RATE = 48_000;
  const FRAME = 960;

  function window(
    monitor: MicAudibilityMonitor,
    { live = true, silent = false, holes = false } = {},
  ) {
    // 100 ms windows: five 20 ms frames.
    for (let frame = 0; frame < 5; frame += 1) {
      const samples = new Int16Array(FRAME);
      if (!silent) samples.fill(1_000);
      monitor.observeReceived(samples);
      monitor.observeFrame({
        micLive: live,
        frameSamples: FRAME,
        // Every other frame read a hole: intermittent loss.
        micGapSamples: holes && frame % 2 === 1 ? FRAME : 0,
        micStarvedSamples: 0,
      });
    }
    return monitor.degraded;
  }

  test('rises after consecutive suspect windows and falls only after consecutive clean ones', () => {
    const monitor = new MicAudibilityMonitor({ sampleRate: RATE, windowMs: 100 });
    assert.equal(window(monitor, { holes: true }), false, 'one bad window is not a verdict');
    assert.equal(window(monitor, { holes: true }), true);
    assert.equal(window(monitor), true, 'one good window does not clear it');
    assert.equal(window(monitor, { holes: true }), true);
    assert.equal(window(monitor), true);
    assert.equal(window(monitor), true);
    assert.equal(window(monitor), false, 'three clean windows in a row do');
    assert.equal(monitor.status().degraded, false);
  });

  test('clears as soon as the room stops calling the Mic live', () => {
    const monitor = new MicAudibilityMonitor({ sampleRate: RATE, windowMs: 100 });
    window(monitor, { holes: true });
    assert.equal(window(monitor, { holes: true }), true);
    assert.equal(window(monitor, { live: false }), false);
  });

  test('digital silence alone needs a longer run, so a gated pause is not a verdict', () => {
    const monitor = new MicAudibilityMonitor({ sampleRate: RATE, windowMs: 100 });
    for (let run = 0; run < 4; run += 1) {
      assert.equal(window(monitor, { silent: true }), false, `window ${run + 1}`);
    }
    // A headset gate reopening when the singer resumes restarts the count.
    window(monitor);
    for (let run = 0; run < 4; run += 1) window(monitor, { silent: true });
    assert.equal(monitor.degraded, false);
    assert.equal(window(monitor, { silent: true }), true, 'a capture that stays at exact zero is surfaced');
  });

  test('reset forgets a verdict at a capture boundary', () => {
    const monitor = new MicAudibilityMonitor({ sampleRate: RATE, windowMs: 100 });
    window(monitor, { holes: true });
    window(monitor, { holes: true });
    assert.equal(monitor.degraded, true);
    monitor.reset();
    assert.equal(monitor.degraded, false);
    assert.equal(window(monitor, { holes: true }), false, 'the next capture starts its own count');
  });
});
