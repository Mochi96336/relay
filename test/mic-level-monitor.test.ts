import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MicLevelMonitor } from '../src/mic-level-monitor.js';

const RATE = 48_000;
const FRAME = 960;

/** The monitor keeps no gain of its own; this stands in for AudioSession's. */
class Room {
  gainDb: number;
  readonly level = new MicLevelMonitor({
    sampleRate: RATE,
    // 100 ms windows, so five 20 ms frames close one; thresholds scaled to match.
    windowMs: 100,
    hotHeavyLimitedMs: 10,
  });

  constructor(gainDb: number) {
    this.gainDb = gainDb;
  }

  get warning() {
    return this.level.warning;
  }

  setMicGainDb(nextDb: number) {
    const previousDb = this.gainDb;
    this.gainDb = nextDb;
    return this.level.noteMicGainChanged(previousDb, nextDb);
  }
}

function monitor(micGainDb = 24) {
  return new Room(micGainDb);
}

/** A raw capture whose peak is `dbfs`, before Relay gain. */
function peakAt(dbfs: number) {
  const samples = new Int16Array(FRAME);
  samples[0] = Math.round(0x8000 * 10 ** (dbfs / 20));
  return samples;
}

function runWindow(
  target: Room,
  {
    live = true,
    songPlaying = true,
    rawPeakDbfs = -40 as number | null,
    heavyLimitedMs = 0,
  } = {},
) {
  let changed = false;
  for (let frame = 0; frame < 5; frame += 1) {
    if (rawPeakDbfs !== null) target.level.observeReceived(peakAt(rawPeakDbfs));
    changed = target.level.observeFrame({
      micLive: live,
      frameSamples: FRAME,
      heavyLimitedSamples: frame === 0 ? Math.round((heavyLimitedMs * RATE) / 1000) : 0,
    }, () => ({ songPlaying, micGainDb: target.gainDb })) || changed;
  }
  return changed;
}

function runWindows(target: Room, count: number, options: Parameters<typeof runWindow>[1] = {}) {
  for (let i = 0; i < count; i += 1) runWindow(target, options);
}

describe('MicLevelMonitor too loud', () => {
  it('rises after three hot windows of five, not on one loud phrase', () => {
    const level = monitor();
    runWindow(level, { heavyLimitedMs: 20 });
    runWindows(level, 3);
    runWindow(level, { heavyLimitedMs: 20 });
    assert.equal(level.warning, null, 'two hot windows in five');

    const changed = runWindow(level, { heavyLimitedMs: 20 });
    assert.equal(changed, false, 'the first hot window has left the five-window history');
    assert.equal(runWindow(level, { heavyLimitedMs: 20 }), true);
    assert.equal(level.warning, 'too-loud');
  });

  it('ignores light limiting however long it lasts', () => {
    const level = monitor();
    runWindows(level, 10, { heavyLimitedMs: 9 });
    assert.equal(level.warning, null);
  });

  it('clears after ten cool windows in a row', () => {
    const level = monitor();
    runWindows(level, 3, { heavyLimitedMs: 20 });
    assert.equal(level.warning, 'too-loud');

    runWindows(level, 9);
    runWindow(level, { heavyLimitedMs: 20 });
    runWindows(level, 9);
    assert.equal(level.warning, 'too-loud', 'a hot window restarts the cool run');
    assert.deepEqual(
      [level.level.status().calmWindows, level.level.status().calmWindowsNeeded],
      [9, 10],
      'diagnostics can say how close the warning is to clearing',
    );
    assert.equal(runWindow(level), true);
    assert.equal(level.warning, null);
  });

  it('clears as soon as the gain is lowered, and not when it is raised', () => {
    const level = monitor(30);
    runWindows(level, 3, { heavyLimitedMs: 20 });
    assert.equal(level.setMicGainDb(32), false);
    assert.equal(level.warning, 'too-loud');

    assert.equal(level.setMicGainDb(24), true);
    assert.equal(level.warning, null);
    runWindows(level, 2, { heavyLimitedMs: 20 });
    assert.equal(level.warning, null, 'history measured at the old gain was discarded');
  });
});

describe('MicLevelMonitor too quiet', () => {
  it('rises after fifteen windows whose post-gain peak stays under -30 dBFS', () => {
    const level = monitor(0);
    runWindows(level, 14, { rawPeakDbfs: -50 });
    assert.equal(level.warning, null);
    assert.equal(runWindow(level, { rawPeakDbfs: -50 }), true);
    assert.equal(level.warning, 'too-quiet');
  });

  it('judges the peak after gain', () => {
    const level = monitor(24);
    runWindows(level, 20, { rawPeakDbfs: -50 });
    assert.equal(level.warning, null, '-50 + 24 = -26 dBFS is audible');
  });

  it('holds between -30 and -24 dBFS and clears once a peak reaches -24', () => {
    const level = monitor(0);
    runWindows(level, 15, { rawPeakDbfs: -50 });
    runWindow(level, { rawPeakDbfs: -26 });
    assert.equal(level.warning, 'too-quiet');
    assert.equal(runWindow(level, { rawPeakDbfs: -23.5 }), true);
    assert.equal(level.warning, null);
  });

  it('re-judges the same history when the gain changes', () => {
    const level = monitor(0);
    runWindows(level, 15, { rawPeakDbfs: -50 });
    assert.equal(level.warning, 'too-quiet');

    assert.equal(level.setMicGainDb(10), false, '-40 is still under the clear line');
    assert.equal(level.setMicGainDb(26), true, '-24 clears without waiting for a new window');
    assert.equal(level.warning, null);

    assert.equal(level.setMicGainDb(0), true, 'the same fifteen quiet windows at 0 dB again');
    assert.equal(level.warning, 'too-quiet');
  });

  it('only counts time the song is playing', () => {
    const level = monitor(0);
    runWindows(level, 14, { rawPeakDbfs: -50 });
    assert.equal(runWindow(level, { rawPeakDbfs: -50, songPlaying: false }), false);
    runWindows(level, 14, { rawPeakDbfs: -50 });
    assert.equal(level.warning, null, 'a pause restarts the run');

    runWindow(level, { rawPeakDbfs: -50 });
    assert.equal(level.warning, 'too-quiet');
    assert.equal(runWindow(level, { rawPeakDbfs: -50, songPlaying: false }), true);
    assert.equal(level.warning, null, 'nothing to be heard over once the song stops');
  });

  it('does not count a window where no Mic PCM arrived', () => {
    const level = monitor(0);
    runWindows(level, 14, { rawPeakDbfs: -50 });
    runWindow(level, { rawPeakDbfs: null });
    runWindows(level, 14, { rawPeakDbfs: -50 });
    assert.equal(level.warning, null);
  });
});

describe('MicLevelMonitor lifecycle', () => {
  it('starts over after a window the Mic was not live for', () => {
    const level = monitor(0);
    runWindows(level, 3, { heavyLimitedMs: 20 });
    assert.equal(level.warning, 'too-loud');
    assert.equal(runWindow(level, { live: false }), true);
    assert.equal(level.warning, null);

    runWindows(level, 14, { rawPeakDbfs: -50 });
    runWindow(level, { live: false, rawPeakDbfs: -50 });
    runWindows(level, 14, { rawPeakDbfs: -50 });
    assert.equal(level.warning, null);
  });

  it('reports too loud over too quiet and forgets both on reset', () => {
    const level = monitor(0);
    runWindows(level, 15, { rawPeakDbfs: -50, heavyLimitedMs: 20 });
    assert.equal(level.warning, 'too-loud');

    level.level.reset();
    assert.equal(level.warning, null);
    assert.equal(level.level.status().quietRunWindows, 0);
  });
});
