import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { AudioSession } from '../src/audio-session.js';
import { loadRelayConfig } from '../src/config.js';
import { MicLimiter } from '../src/mic-limiter.js';
import { MIC_LOW_CUT_HZ, MicLowCut } from '../src/mic-low-cut.js';
import { MicTrack } from '../src/mic-track.js';
import { readPcmRange } from '../src/pcm-timeline.js';
import { readSourceContract, variableInitializerCode } from './support/source-contract.js';

const RATE = 48_000;

function tone(hz: number, amplitude: number, count: number, rate = RATE, offset = 0) {
  const out = new Int16Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * hz * (i + offset)) / rate));
  }
  return out;
}

/** Amplitude of one frequency in a window, by projection: what that partial is heard at. */
function partialAmplitude(samples: ArrayLike<number>, hz: number, from: number, to: number, rate = RATE) {
  let re = 0;
  let im = 0;
  for (let i = from; i < to; i += 1) {
    const phase = (2 * Math.PI * hz * i) / rate;
    re += samples[i] * Math.cos(phase);
    im += samples[i] * Math.sin(phase);
  }
  return (2 / (to - from)) * Math.hypot(re, im);
}

const db = (ratio: number) => 20 * Math.log10(ratio);
const peak = (samples: ArrayLike<number>) => Array.from(samples).reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe('MicLowCut', () => {
  test('cuts breath and rumble, leaves the singing voice', () => {
    // Whole seconds, so each tone fits the projection window exactly.
    const responseAt = (hz: number) => {
      const input = tone(hz, 10_000, 2 * RATE);
      new MicLowCut(RATE).process(input, false);
      return db(partialAmplitude(input, hz, RATE, 2 * RATE) / 10_000);
    };
    assert.ok(responseAt(5) < -40, `5 Hz breath: ${responseAt(5).toFixed(1)} dB`);
    assert.ok(responseAt(20) < -23.5, `20 Hz: ${responseAt(20).toFixed(1)} dB`);
    assert.ok(Math.abs(responseAt(MIC_LOW_CUT_HZ) + 3) < 0.2, 'the corner is -3 dB');
    assert.ok(responseAt(160) > -0.3, `160 Hz: ${responseAt(160).toFixed(2)} dB`);
    assert.ok(responseAt(1_000) > -0.01, `1 kHz: ${responseAt(1_000).toFixed(3)} dB`);
  });

  test('a run filtered packet by packet equals the same run filtered at once', () => {
    const signal = new Int16Array(RATE / 2);
    for (let i = 0; i < signal.length; i += 1) {
      signal[i] = 3_000 + Math.round(9_000 * Math.sin((2 * Math.PI * 7 * i) / RATE)
        + 2_000 * Math.sin((2 * Math.PI * 440 * i) / RATE));
    }
    const whole = signal.slice();
    new MicLowCut(RATE).process(whole, false);

    const pieces = signal.slice();
    const filter = new MicLowCut(RATE);
    for (let start = 0, n = 0; start < pieces.length; start += 960, n += 1) {
      filter.process(pieces.subarray(start, start + 960), n > 0);
    }
    assert.deepEqual(pieces, whole);
  });

  test('a fresh run starts from silence even on a DC offset', () => {
    const filter = new MicLowCut(RATE);
    const offset = new Int16Array(960).fill(12_000);
    filter.process(offset, false);
    assert.ok(peak(offset) <= 1, `a capture that opens on DC must not step: ${peak(offset)}`);

    // The same edge inside a run is real signal, and passes.
    const step = new Int16Array(960).fill(-12_000);
    filter.process(step, true);
    assert.ok(step[0] < -20_000, `a step inside one run is heard: ${step[0]}`);
  });

  test('disabled leaves PCM untouched, and re-enabling starts a fresh run', () => {
    const filter = new MicLowCut(RATE);
    filter.setEnabled(false);
    const premixed = tone(40, 8_000, 960);
    const original = premixed.slice();
    filter.process(premixed, true);
    assert.deepEqual(premixed, original);

    filter.setEnabled(true);
    const resumed = new Int16Array(960).fill(9_000);
    filter.process(resumed, true);
    assert.ok(peak(resumed) <= 1, 'state from before the bypass never leaks into the next run');
  });

  test('ringing on a flat-topped full-scale input stays inside Int16', () => {
    const square = new Int16Array(RATE / 10);
    for (let i = 0; i < square.length; i += 1) square[i] = Math.floor(i / 120) % 2 ? -32_768 : 32_767;
    new MicLowCut(RATE).process(square, true);
    assert.ok(square.every((v) => v >= -32_768 && v <= 32_767));
    assert.ok(peak(square) === 32_768 || peak(square) === 32_767, 'overshoot is clamped, not wrapped');
  });

  test('breath no longer pulls the voice down through the limiter', () => {
    // 2026-11-12: a headset boom at +13 dB. Breath at -6 dBFS around 4 Hz,
    // a voice at -30 dBFS; the limiter reacted to the breath and the voice
    // sat under the song.
    const gain = 10 ** (13 / 20);
    const voiceHz = 300;
    const voiceAmplitude = 1_000;
    const count = 3 * RATE;
    const raw = new Int16Array(count);
    for (let i = 0; i < count; i += 1) {
      raw[i] = Math.round(16_000 * Math.sin((2 * Math.PI * 4 * i) / RATE)
        + voiceAmplitude * Math.sin((2 * Math.PI * voiceHz * i) / RATE));
    }
    const heard = (input: Int16Array) => {
      const limiter = new MicLimiter(RATE);
      const out = new Float64Array(count);
      let heavy = 0;
      for (let i = 0; i < count; i += 1) {
        const ahead = input[Math.min(count - 1, i + limiter.lookaheadSamples)];
        out[i] = limiter.apply((input[i] / 32768) * gain, (ahead / 32768) * gain);
        if (limiter.heavilyLimiting) heavy += 1;
      }
      const expected = (voiceAmplitude / 32768) * gain;
      return {
        heavyShare: heavy / count,
        voiceDb: db(partialAmplitude(out, voiceHz, RATE, 3 * RATE) / expected),
      };
    };

    const unfiltered = heard(raw);
    assert.ok(unfiltered.heavyShare > 0.5, `breath drives heavy limiting: ${unfiltered.heavyShare}`);
    assert.ok(unfiltered.voiceDb < -3, `and the voice loses ${unfiltered.voiceDb.toFixed(1)} dB`);

    const cut = raw.slice();
    new MicLowCut(RATE).process(cut, false);
    const filtered = heard(cut);
    assert.equal(filtered.heavyShare, 0);
    assert.ok(Math.abs(filtered.voiceDb) < 0.1, `the voice keeps its level: ${filtered.voiceDb.toFixed(2)} dB`);
  });
});

const trackConfig = {
  sampleRate: RATE, prebufferMs: 400, retentionMs: 3_000,
  frameMs: 20, frameSamples: 960,
  sourceEdgeFadeSamples: 96, safetyMs: 200, slewFraction: .01,
  readHeadCrossfadeMs: 5,
};

function capture(track: MicTrack, generation: number, first: number, pcm: Int16Array, sourceRate = RATE, now = 0) {
  return track.ingestCapture({
    frame: { generation, firstSampleIndex: first, pcm: Buffer.from(pcm.slice().buffer) },
    sourceRate, running: true, roomSampleNow: () => now,
  });
}

describe('MicTrack low cut', () => {
  test('without a corner the track places PCM exactly as it arrived', () => {
    const track = new MicTrack(trackConfig);
    assert.equal(track.lowCut, null);
    capture(track, 1, 0, new Int16Array(960).fill(12_000));
    assert.ok(readPcmRange(track.timeline, 0, 960).every((v) => v === 12_000));
  });

  test('every singer gets a filter of their own', () => {
    const a = new MicTrack({ ...trackConfig, lowCutHz: MIC_LOW_CUT_HZ });
    const b = new MicTrack({ ...trackConfig, lowCutHz: MIC_LOW_CUT_HZ });
    assert.ok(a.lowCut && b.lowCut);
    assert.notStrictEqual(a.lowCut, b.lowCut);
  });

  test('contiguous packets form one run, across the 44.1 kHz resampler prefix too', () => {
    const sourceRate = 44_100;
    const packet = 882;
    const raw = new MicTrack(trackConfig);
    const cut = new MicTrack({ ...trackConfig, lowCutHz: MIC_LOW_CUT_HZ });
    for (let n = 0; n < 25; n += 1) {
      const pcm = new Int16Array(packet);
      for (let i = 0; i < packet; i += 1) {
        const t = (n * packet + i) / sourceRate;
        pcm[i] = Math.round(4_000 + 8_000 * Math.sin(2 * Math.PI * 6 * t) + 3_000 * Math.sin(2 * Math.PI * 523 * t));
      }
      capture(raw, 1, n * packet, pcm, sourceRate);
      capture(cut, 1, n * packet, pcm, sourceRate);
    }
    assert.ok(raw.timeline.chunks.length > 1);
    assert.equal(cut.timeline.totalSamples, raw.timeline.totalSamples);
    const expected = readPcmRange(raw.timeline, 0, raw.timeline.totalSamples);
    new MicLowCut(RATE).process(expected, false);
    assert.deepEqual(readPcmRange(cut.timeline, 0, cut.timeline.totalSamples), expected);
  });

  test('a transport hole or a new capture starts a fresh run', () => {
    // Silence, then DC. Inside one run that edge rings through the filter;
    // after a hole or a restart it is the opening of a new run, and must not.
    const silence = new Int16Array(960);
    const dc = new Int16Array(960).fill(12_000);

    const contiguous = new MicTrack({ ...trackConfig, lowCutHz: MIC_LOW_CUT_HZ });
    capture(contiguous, 1, 0, silence);
    capture(contiguous, 1, 960, dc);
    assert.ok(peak(readPcmRange(contiguous.timeline, 960, 960)) > 5_000, 'one run carries its state');

    const hole = new MicTrack({ ...trackConfig, lowCutHz: MIC_LOW_CUT_HZ });
    capture(hole, 1, 0, silence);
    capture(hole, 1, 1_920, dc);
    assert.ok(hole.timeline.gapSamples > 0);
    assert.ok(peak(readPcmRange(hole.timeline, 1_920, 960)) <= 1);

    const restarted = new MicTrack({ ...trackConfig, lowCutHz: MIC_LOW_CUT_HZ });
    capture(restarted, 1, 0, silence, RATE, 960);
    const result = capture(restarted, 2, 0, dc, RATE, 3_840);
    assert.equal(result.captureRestarted, true);
    assert.ok(peak(readPcmRange(restarted.timeline, result.start, 960)) <= 1);
  });

  test('raw-input clipping is still judged on the packet as it arrived', () => {
    const track = new MicTrack({ ...trackConfig, lowCutHz: MIC_LOW_CUT_HZ });
    const railed = tone(200, 20_000, 960);
    railed.fill(32_767, 100, 140);
    capture(track, 1, 0, railed);
    assert.equal(track.clipping.empty, false);
    assert.ok(peak(readPcmRange(track.timeline, 100, 40)) < 32_767, 'the placed PCM is the filtered voice');
  });
});

describe('AudioSession low cut', () => {
  test('a premixed capture keeps the song bass; the next ordinary capture is cut', () => {
    const session = new AudioSession({
      sampleRate: RATE, frameMs: 20, prebufferMs: 400,
      backingGain: .65, retentionMs: 3_000, micLowCutHz: MIC_LOW_CUT_HZ,
    });
    session.start(0);
    session.setMicExpected(true);
    const bass = tone(45, 10_000, 1_920);

    session.setMicPremixed(true);
    session.ingestMic({ generation: 1, firstSampleIndex: 0, pcm: Buffer.from(bass.slice().buffer) }, RATE, 0);
    assert.deepEqual(session.readMic(0, 1_920), bass);

    session.setMicPremixed(false);
    session.ingestMic({ generation: 2, firstSampleIndex: 0, pcm: Buffer.from(bass.slice().buffer) }, RATE, 100);
    const ordinary = session.readMic(session.micTotalSamples - 1_920, 1_920);
    assert.ok(
      partialAmplitude(ordinary, 45, 960, 1_920) < 0.5 * 10_000,
      'a 45 Hz partial in a voice capture is cut',
    );
  });

  test('the live room turns the low cut on, at a corner the operator can move', () => {
    const server = readSourceContract('src/server.ts');
    assert.match(variableInitializerCode(server, 'session'), /\bmicLowCutHz:\s*relayConfig\.micLowCutHz\b/);
    assert.equal(loadRelayConfig({}).micLowCutHz, MIC_LOW_CUT_HZ);
    assert.equal(loadRelayConfig({ RELAY_MIC_LOW_CUT_HZ: '60' }).micLowCutHz, 60);
    assert.equal(loadRelayConfig({ RELAY_MIC_LOW_CUT_HZ: '0' }).micLowCutHz, 0);
    assert.throws(() => loadRelayConfig({ RELAY_MIC_LOW_CUT_HZ: '-1' }), /RELAY_MIC_LOW_CUT_HZ/);

    const off = new MicTrack({ ...trackConfig, lowCutHz: 0 });
    assert.equal(off.lowCut, null, '0 places Mic PCM as it arrived');
  });
});
