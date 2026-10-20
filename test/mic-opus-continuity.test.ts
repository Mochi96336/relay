import assert from 'node:assert/strict';
import test from 'node:test';
import { Decoder } from '@evan/opus';
import { createWebSocketAudioTransport } from '../src/audio-transport.js';
import { ChoirIngress } from '../src/choir-ingress.js';
import type { AudioPacket } from '../src/audio-packet.js';
import type { PcmFrame } from '../src/pcm-frame.js';
import { encodeMicOpus, micOpusEncoder, opusPacketBytes, quietVowelFrames } from './helpers/mic-opus.js';

function mainMic(packets: AudioPacket[]) {
  const transport = createWebSocketAudioTransport({ packetVersion: 2, receiver: {
    source: 'mic', generation: 7, initialSequence: packets[0]?.sequence,
    allowOpus: true, reorderWindowPackets: 4, reorderDeadlineMs: 40, maxForwardJumpPackets: 256,
  } });
  const frames = packets.flatMap((packet, i) => transport.receive(opusPacketBytes(packet), i * 20));
  frames.push(...transport.flush(packets.length * 20 + 100));
  return { frames, stats: transport.stats()! };
}

function secondaryMic() {
  const frames: PcmFrame[] = [];
  const socket = { role: 'unknown', participantId: 'B' };
  const ingress = new ChoirIngress(() => true, () => true);
  ingress.onAcceptedFrame = frame => frames.push(frame);
  assert.equal(ingress.bind(socket, 'B', 'transport-b', 48_000, 0, 3), true);
  return { frames, receive: (packet: AudioPacket) => ingress.interceptBinary(socket, opusPacketBytes(packet), 100) };
}

function assertNativeContinuity(packets: AudioPacket[], frames: PcmFrame[]) {
  const reference = new Decoder({ channels: 1, sample_rate: 48_000 });
  assert.equal(frames.length, packets.length);
  for (let i = 0; i < packets.length; i++) {
    const packet = packets[i];
    const expected = Buffer.from(reference.decode(packet.pcm))
      .subarray(Math.max(0, packet.opusDelaySamples! - packet.firstSampleIndex) * 2);
    assert.equal(frames[i].pcm.length, expected.length);
    let error = 0;
    for (let j = 0; j < expected.length; j += 2)
      error = Math.max(error, Math.abs(frames[i].pcm.readInt16LE(j) - expected.readInt16LE(j)));
    // Native and WASM libopus can round a final Int16 step differently.
    assert.ok(error <= 2, `frame ${i}: max sample error ${error} against uninterrupted native decoder`);
  }
}

for (const bitrate of [32_000, 64_000, 128_000]) {
  test(`a ${bitrate} bps capture hole before encoding does not advance either Mic decoder`, async () => {
    const packets = await encodeMicOpus(quietVowelFrames(70), { bitrate, skip: new Set([40, 41]) });
    const main = mainMic(packets);
    const b = secondaryMic();
    for (const packet of packets) assert.equal(b.receive(packet).intercepted, true);
    assertNativeContinuity(packets, main.frames);
    assert.deepEqual(b.frames, main.frames, 'A and B share codec state and placement semantics');
    assert.deepEqual(main.frames.map(f => f.firstSampleIndex), packets.map(p => Math.max(0, p.firstSampleIndex - p.opusDelaySamples!)));
  });
}

test('bitrate changes and capture skips share one continuous encoded stream', async () => {
  const encoder = await micOpusEncoder();
  let sequence = 0;
  const packets: AudioPacket[] = quietVowelFrames(90).flatMap((pcm, index) => {
    if (index === 40 || index === 41) return [];
    encoder.setBitrate([128_000, 64_000, 32_000][Math.floor(index / 15) % 3]);
    return [{ source: 'mic', generation: 7, sequence: sequence++, firstSampleIndex: index * 960,
      sampleCount: 960, opusDelaySamples: encoder.delaySamples, pcm: Buffer.from(encoder.encode(pcm)) }];
  });
  assertNativeContinuity(packets, mainMic(packets).frames);
});

test('a codec-rejected payload behaves like one lost encoded frame, with visible diagnostics', async () => {
  const packets = await encodeMicOpus(quietVowelFrames(70));
  const missing = mainMic(packets.filter((_, i) => i !== 40));
  const corrupt = mainMic(packets.map((p, i) => i === 40 ? { ...p, pcm: Buffer.from([255]) } : p));
  assert.deepEqual(corrupt.frames, missing.frames, 'a bad payload cannot reset the next good frame');
  assert.equal((corrupt.stats as any).opus.decodeFailures, 1);
});

for (const kind of ['sequence', 'overlap', 'late'] as const) {
  test(`a rejected B ${kind} packet cannot change later decoded sound`, async () => {
    const packets = await encodeMicOpus(quietVowelFrames(70));
    const clean = secondaryMic(), injected = secondaryMic();
    for (let i = 0; i < packets.length; i++) {
      if (i === 40) {
        const bad = kind === 'sequence' ? { ...packets[i], sequence: 4_000 }
          : kind === 'overlap' ? { ...packets[i], firstSampleIndex: packets[i - 1].firstSampleIndex }
            : { ...packets[i - 2], sequence: packets[i].sequence };
        const result = injected.receive(bad);
        assert.equal(result.intercepted && result.accepted, false);
      }
      clean.receive(packets[i]); injected.receive(packets[i]);
    }
    assert.deepEqual(injected.frames, clean.frames);
  });
}
