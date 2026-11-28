import assert from 'node:assert/strict';
import test from 'node:test';

import { AudioSession, type MixFrameStems } from '../src/audio-session.js';

const RATE = 48_000;
const FRAME_SAMPLES = 960;
const SECONDS = 4;

function tone(firstSample: number, hz: number, dbfs: number) {
  const amplitude = 10 ** (dbfs / 20) * 32767;
  const buffer = Buffer.alloc(FRAME_SAMPLES * 2);
  for (let i = 0; i < FRAME_SAMPLES; i += 1) {
    buffer.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * hz * (firstSample + i)) / RATE)), i * 2);
  }
  return { generation: 1, firstSampleIndex: firstSample, pcm: buffer };
}

function room() {
  const session = new AudioSession({
    sampleRate: RATE, frameMs: 20, prebufferMs: 0, backingGain: 0.65, retentionMs: 5_000,
  });
  session.setMicGainDb(0);
  session.setMicExpected(true);
  session.setBackingExpected(true);
  session.start(0);
  for (let first = 0; first < RATE * SECONDS; first += FRAME_SAMPLES) {
    session.ingestMic(tone(first, 440, -12), RATE, 0);
    session.ingestBacking(tone(first, 997, -20), RATE, 0);
  }
  const frames: { frame: Buffer; stems: MixFrameStems }[] = [];
  for (let ms = 0; ms < (SECONDS - 0.2) * 1000; ms += 20) {
    session.drain((frame, _evidence, _position, stems) => frames.push({ frame, stems }), ms, 1);
  }
  return { session, frames };
}

test('the voice and song stems add up to the mixed frame once both sources are in', () => {
  const { frames } = room();
  assert.ok(frames.length > 150);
  // Past the duck ramp and the join-safety crossfade.
  for (const { frame, stems } of frames.slice(50)) {
    for (let i = 0; i < FRAME_SAMPLES; i += 1) {
      const sum = stems.voice.readInt16LE(i * 2) + stems.backing.readInt16LE(i * 2);
      assert.ok(Math.abs(sum - frame.readInt16LE(i * 2)) <= 1, `sample ${i}`);
    }
  }
  assert.ok(frames.slice(50).some(({ stems }) => stems.voice.readInt16LE(200) !== 0), 'the voice is in its stem');
  assert.ok(frames.slice(50).some(({ stems }) => stems.backing.readInt16LE(200) !== 0), 'the song is in its stem');
});

test('mix loudness reads the song as delivered and as it sits under the voice', () => {
  const { session } = room();
  const loudness = session.mixLoudness();
  const source = loudness.backingSource.shortTermLufs!;
  const backing = loudness.backing.shortTermLufs!;
  assert.ok(Math.abs(source - -23.01) < 0.1, `a -20 dBFS 997 Hz song reads -23 LUFS as delivered (${source})`);
  // 0.65 song gain and the two-source summing headroom: the -7.5 dB it sits under.
  assert.ok(Math.abs(backing - source - -7.5) < 0.2, `the song sits 7.5 dB under its source (${backing - source})`);
  assert.notEqual(loudness.voice.shortTermLufs, null);
  assert.notEqual(loudness.mix.shortTermLufs, null);
});
