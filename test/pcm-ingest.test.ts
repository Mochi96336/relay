import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ingestPcmTimeline } from '../src/pcm-ingest.js';
import { emptyPcmTimeline, readPcmRange, readPcmEvidence } from '../src/pcm-timeline.js';
import type { PcmFrame } from '../src/pcm-frame.js';

const RATE = 48_000;

function frame(generation: number | null, firstSampleIndex: number | null,
  count = 960, value = 12_000): PcmFrame {
  return {
    generation,
    firstSampleIndex,
    pcm: Buffer.from(new Int16Array(count).fill(value).buffer),
  };
}

describe('shared canonical PCM ingestion without room or singer coupling', () => {

  test('experimental mirror excludes partially clipped and clock-trimmed native PCM', () => {
    const timeline = emptyPcmTimeline();
    const ingest = (packet: PcmFrame) => ingestPcmTimeline({
      timeline, frame: packet, sourceRate: RATE, mixRate: RATE,
      roomSampleNow: () => 960, sourceRateDefinesCapture: true,
      auditNativeMirroring: true,
    });
    assert.equal(ingest(frame(4, 0)).nativeFrameMirroringSafe, true);
    const partial = ingest(frame(4, 480, 960, 23_000));
    assert.equal(partial.samples.length, 480, 'production retains only the new tail');
    assert.equal(partial.nativeFrameMirroringSafe, false,
      'Choir cannot mirror the rejected first 480 native samples');
    assert.equal(ingest(frame(4, 0)).nativeFrameMirroringSafe, undefined);
    assert.equal(ingest(frame(4, 1_440)).nativeFrameMirroringSafe, true,
      'a later complete packet remains mirrorable');

    const trimmed = ingestPcmTimeline({
      timeline: emptyPcmTimeline(), frame: frame(5, 0),
      sourceRate: RATE, mixRate: RATE, roomSampleNow: () => 960,
      auditNativeMirroring: true,
      trimSourcePacket: ({ samples }) => samples.slice(1),
    });
    assert.equal(trimmed.nativeFrameMirroringSafe, false,
      'a changed PCM span is not an exact native admission');
  });

  test('native mirror acceptance handles 44.1 kHz phase without assuming output counts', () => {
    const timeline = emptyPcmTimeline();
    for (const index of [0, 441, 882]) {
      const pcm = new Int16Array(441).fill(2_000);
      const proof = ingestPcmTimeline({
        timeline, frame: { generation: 10, firstSampleIndex: index, pcm: Buffer.from(pcm.buffer) },
        sourceRate: 44_100, mixRate: RATE, roomSampleNow: () => index * RATE / 44_100 + 480,
        auditNativeMirroring: true,
      });
      assert.equal(proof.nativeFrameMirroringSafe, true,
        'complete native source should not require native==mix sample counts');
    }
  });

  test('positioned gaps remain silent; late overlapping packets never replay at now', () => {
    const timeline = emptyPcmTimeline();
    let clock = 960;
    let replaced = 0;
    const ingest = (packet: PcmFrame) => ingestPcmTimeline({
      timeline, frame: packet, sourceRate: RATE, mixRate: RATE,
      roomSampleNow: () => clock,
      sourceRateDefinesCapture: true,
      onCaptureClockChanged: () => { replaced++; },
    });
    assert.deepEqual(
      [ingest(frame(1, 0)).start, ingest(frame(1, 960)).start],
      [0, 960],
    );
    clock = 3840;
    const afterLoss = ingest(frame(1, 2880, 960, -4_000));
    assert.equal(afterLoss.start, 2880);
    assert.equal(timeline.gapSamples, 960);
    assert.equal(readPcmEvidence(timeline, 1920, 960).gapSamples, 960);
    assert.ok(readPcmRange(timeline, 1920, 960).every(v => v === 0));
    assert.equal(timeline.totalSamples, 3840);
    const late = ingest(frame(1, 960, 960, 24_000));
    assert.equal(late.samples.length, 0);
    assert.equal(timeline.totalSamples, 3840);
    assert.equal(readPcmRange(timeline, 2880, 10)[0], -4_000);
    assert.equal(replaced, 1, 'only the first capture registers');
  });

  test('capture generation restart reanchors against lazy room clock', () => {
    const timeline = emptyPcmTimeline();
    let now = 960;
    let clockCalls = 0;
    let captureRestarts = 0;
    const ingest = (f: PcmFrame) => ingestPcmTimeline({
      timeline, frame: f, sourceRate: RATE, mixRate: RATE,
      roomSampleNow: () => { clockCalls++; return now; },
      sourceRateDefinesCapture: true,
      onCaptureClockChanged: () => { captureRestarts++; },
    });
    const first = ingest(frame(1, 0));
    assert.equal(first.captureRestarted, false);
    assert.equal(first.start, 0);
    assert.equal(clockCalls, 1);
    now = 10_000;
    const changed = ingest(frame(2, 0));
    assert.equal(changed.captureRestarted, true);
    assert.equal(changed.start, 9_040);
    assert.equal(timeline.originOffset, 9_040);
    assert.equal(captureRestarts, 2);
    assert.equal(timeline.generation, 2);
    assert.equal(clockCalls, 2);
    assert.equal(timeline.chunks[0].start, 0, 'retired capture PCM not moved');
    assert.equal(timeline.chunks[1].start, 9_040);
  });

  test('44.1 kHz positioned streaming resampler carries its fractional phase', () => {
    const timeline = emptyPcmTimeline();
    const pcm441 = (first: number) => {
      const samples = new Int16Array(441);
      for (let i = 0; i < 441; i++) {
        samples[i] = Math.round(6_000 * Math.sin(2 * Math.PI * 230 * (first + i) / 44_100));
      }
      return { generation: 7, firstSampleIndex: first, pcm: Buffer.from(samples.buffer) };
    };
    const first = ingestPcmTimeline({
      timeline, frame: pcm441(0), sourceRate: 44_100, mixRate: RATE,
      roomSampleNow: () => 480,
    });
    assert.equal(first.start, 0);
    const second = ingestPcmTimeline({
      timeline, frame: pcm441(441), sourceRate: 44_100, mixRate: RATE,
      roomSampleNow: () => 960,
    });
    assert.equal(second.captureRestarted, false);
    assert.equal(timeline.sourceFrontier, 882);
    assert.equal(timeline.gapSamples, 0);
    assert.ok(timeline.totalSamples >= 958 && timeline.totalSamples <= 961,
      'phase-correct continuous 20 ms source frames stay on a 48k timeline');
    assert.equal(timeline.resampleTail.length, 3);
    assert.notEqual(timeline.resampleNextTargetSample, null);
  });

  test('Backing-only clock correction cannot change a separately ingested Mic', () => {
    const mic = emptyPcmTimeline();
    const backing = emptyPcmTimeline();
    const roomSampleNow = (n: number) => () => n;
    ingestPcmTimeline({
      timeline: mic, frame: frame(3, 0),
      sourceRate: RATE, mixRate: RATE, roomSampleNow: roomSampleNow(960),
    });
    ingestPcmTimeline({
      timeline: backing, frame: frame(8, 0),
      sourceRate: RATE, mixRate: RATE, roomSampleNow: roomSampleNow(960),
      trackSourceClock: true,
    });
    const initialMicFrontier = mic.totalSamples;
    ingestPcmTimeline({
      timeline: backing, frame: frame(8, 960),
      sourceRate: RATE, mixRate: RATE, roomSampleNow: roomSampleNow(200_000),
      trackSourceClock: true,
    });
    assert.equal(backing.clockCorrectionSamples, 1);
    assert.equal(mic.clockCorrectionSamples, 0);
    assert.equal(mic.totalSamples, initialMicFrontier);
    assert.equal(mic.originOffset, 0);
    assert.equal(backing.totalSamples, 1921);
  });

  test('headerless packets disable streaming interpolation evidence', () => {
    const timeline = emptyPcmTimeline();
    ingestPcmTimeline({
      timeline, frame: frame(9, 0), sourceRate: RATE, mixRate: RATE,
      roomSampleNow: () => 960,
    });
    const headerless = ingestPcmTimeline({
      timeline, frame: frame(null, null, 960, -2_000),
      sourceRate: RATE, mixRate: RATE, roomSampleNow: () => 1920,
    });
    assert.equal(headerless.start, 960);
    assert.equal(timeline.unheadered, true);
    assert.equal(timeline.resampleNextTargetSample, null);
    assert.deepEqual(timeline.resampleTail, []);
    assert.equal(readPcmEvidence(timeline, 960, 960).unheaderedSamples, 960);
  });
});
