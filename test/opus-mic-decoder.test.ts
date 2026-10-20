import assert from 'node:assert/strict';
import test from 'node:test';

import { Decoder, Encoder } from '@evan/opus';
import { OpusMicDecoder } from '../src/opus-mic-decoder.js';
import { encodeMicOpus, quietVowelFrames } from './helpers/mic-opus.js';

const FRAME = 960;

const peak = (pcm: Buffer) => {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
  return samples.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
};

test('a lost packet is concealed inside the decoder: no pop where a reset overshoots', async () => {
  const packets = await encodeMicOpus(quietVowelFrames(80));
  const LOST = 40;
  const clean = new OpusMicDecoder();
  const cleanPeaks = packets.map(p => peak(clean.decode(p)!.pcm));

  // What the transports did before: reset at the hole.
  const reset = new Decoder({ channels: 1, sample_rate: 48_000 });
  const resetPeaks: number[] = [];
  packets.forEach((p, f) => {
    if (f === LOST) return;
    if (f === LOST + 1) reset.reset();
    resetPeaks[f] = peak(Buffer.from(reset.decode(p.pcm)));
  });

  const concealing = new OpusMicDecoder();
  const concealedPeaks: number[] = [];
  packets.forEach((p, f) => { if (f !== LOST) concealedPeaks[f] = peak(concealing.decode(p)!.pcm); });

  const after = (peaks: number[]) => Math.max(...peaks.slice(LOST + 1, LOST + 6));
  const reference = Math.max(...cleanPeaks.slice(LOST + 1, LOST + 6));
  assert.ok(after(resetPeaks) > reference * 1.25,
    `the old reset overshoots after the hole (${after(resetPeaks)} vs ${reference}); if not, this test no longer proves anything`);
  assert.ok(after(concealedPeaks) <= reference * 1.05,
    `concealment does not (${after(concealedPeaks)} vs ${reference})`);
  // Before the hole it is the same decoder as any other.
  assert.deepEqual(concealedPeaks.slice(0, LOST), cleanPeaks.slice(0, LOST));
});

test('a long hole is bounded; a late packet cannot rewind a decoder that joined mid-stream', async () => {
  const packets = await encodeMicOpus(quietVowelFrames(120));
  const decoder = new OpusMicDecoder();
  assert.equal(decoder.decode(packets[10])!.pcm.byteLength, FRAME * 2, 'first packet need not be at 0');
  assert.equal(decoder.decode(packets[100])!.pcm.byteLength, FRAME * 2);
  assert.equal(decoder.stats().concealedPackets, 50, 'a long hole has bounded codec work');
  assert.equal(decoder.decode(packets[99]), null, 'a late packet leaves state untouched');
  assert.equal(decoder.decode(packets[101])!.pcm.byteLength, FRAME * 2);
});

test('encoded loss across uint32 wrap advances once per missing packet', async () => {
  const packets = await encodeMicOpus(quietVowelFrames(6), { firstSequence: 0xffff_fffe });
  const decoder = new OpusMicDecoder();
  for (const i of [0, 2, 3, 5]) assert.ok(decoder.decode(packets[i]));
  assert.equal(decoder.stats().concealedPackets, 2);
  assert.equal(decoder.decode(packets[3]), null);
});

test('a wrong-duration packet rolls back codec state before concealing its lost slot', async () => {
  const packets = await encodeMicOpus(quietVowelFrames(60));
  const shortEncoder = new Encoder({ sample_rate: 48_000, channels: 1, application: 'audio' });
  const short = Buffer.from(shortEncoder.encode(Buffer.alloc(480 * 2)));
  const damaged = new OpusMicDecoder(), loss = new OpusMicDecoder();
  for (let i = 0; i < packets.length; i++) {
    if (i === 40) {
      assert.equal(damaged.decode({ ...packets[i], pcm: short }), null);
    } else assert.deepEqual(damaged.decode(packets[i]), loss.decode(packets[i]));
  }
  assert.deepEqual(damaged.stats(), { decodedPackets: 59, concealedPackets: 1, decodeFailures: 1 });
});
