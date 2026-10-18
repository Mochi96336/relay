import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { Decoder } from '@evan/opus';
import { createOpusEncoder } from '../public/mic-opus-worker.js';
import { OpusMicDecoder } from '../src/opus-mic-decoder.js';

const FRAME = 960;

/**
 * A sung "ah" at a quiet raw Mic level (peak about -42 dBFS, before the Mic
 * gain lifts it), encoded by the page's own encoder as the page frames it.
 */
async function quietVowel(frames: number) {
  const encoder = createOpusEncoder(
    await readFile(new URL('../node_modules/@evan/opus/wasm/opus.wasm', import.meta.url)), 128_000);
  const pcm = new Int16Array(frames * FRAME);
  let phase = 0;
  for (let i = 0; i < pcm.length; i++) {
    phase += (2 * Math.PI * 262 * (1 + 0.012 * Math.sin((2 * Math.PI * 5.5 * i) / 48_000))) / 48_000;
    let v = 0;
    for (let h = 1; h * 262 < 8_000; h++) v += ((1 + 4 * Math.exp(-(((h * 262 - 700) / 150) ** 2))) / h) * Math.sin(h * phase);
    pcm[i] = Math.round(v * 90);
  }
  return Array.from({ length: frames }, (_, f) =>
    Buffer.from(encoder.encode(pcm.buffer.slice(f * FRAME * 2, (f + 1) * FRAME * 2))));
}

const peak = (pcm: Buffer) => {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
  return samples.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
};

test('a lost packet is concealed inside the decoder: no pop where a reset overshoots', async () => {
  const packets = await quietVowel(80);
  const LOST = 40;
  const clean = new OpusMicDecoder();
  const cleanPeaks = packets.map((p, f) => peak(clean.decodeAt(f * FRAME, p)));

  // What the transports did before: reset at the hole.
  const reset = new Decoder({ channels: 1, sample_rate: 48_000 });
  const resetPeaks: number[] = [];
  packets.forEach((p, f) => {
    if (f === LOST) return;
    if (f === LOST + 1) reset.reset();
    resetPeaks[f] = peak(Buffer.from(reset.decode(p)));
  });

  const concealing = new OpusMicDecoder();
  const concealedPeaks: number[] = [];
  packets.forEach((p, f) => { if (f !== LOST) concealedPeaks[f] = peak(concealing.decodeAt(f * FRAME, p)); });

  const after = (peaks: number[]) => Math.max(...peaks.slice(LOST + 1, LOST + 6));
  const reference = Math.max(...cleanPeaks.slice(LOST + 1, LOST + 6));
  assert.ok(after(resetPeaks) > reference * 1.25,
    `the old reset overshoots after the hole (${after(resetPeaks)} vs ${reference}); if not, this test no longer proves anything`);
  assert.ok(after(concealedPeaks) <= reference * 1.05,
    `concealment does not (${after(concealedPeaks)} vs ${reference})`);
  // Before the hole it is the same decoder as any other.
  assert.deepEqual(concealedPeaks.slice(0, LOST), cleanPeaks.slice(0, LOST));
});

test('a long hole, an overlap and a mid-stream start all still decode whole frames', async () => {
  const packets = await quietVowel(120);
  const decoder = new OpusMicDecoder();
  assert.equal(decoder.decodeAt(10 * FRAME, packets[10]).byteLength, FRAME * 2, 'first packet need not be at 0');
  assert.equal(decoder.decodeAt(100 * FRAME, packets[100]).byteLength, FRAME * 2, 'a hole longer than the concealment cap');
  assert.equal(decoder.decodeAt(99 * FRAME, packets[99]).byteLength, FRAME * 2, 'going back starts over');
  assert.equal(decoder.decodeAt(100 * FRAME + 480, packets[101]).byteLength, FRAME * 2, 'a partial-frame jump starts over');
  assert.throws(() => decoder.decodeAt(102 * FRAME, new Uint8Array(0)), /Invalid Opus packet size/);
});
