import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { createOpusEncoder } from '../public/mic-opus-worker.js';
import { encodePcmFrame } from '../src/pcm-frame.js';
import { AUDIO_PACKET_HEADER_BYTES } from '../src/audio-packet.js';
import { encodeAudioPacket } from '../src/audio-packet.js';
import {
  ChoirSecondaryPcmIngressExperiment,
  type ChoirIngressResult,
} from '../src/choir-secondary-pcm-ingress-experiment.js';
import type { ChoirFreshCaptureTicket } from '../src/choir-fresh-room-handshake-experiment.js';

type Socket = { participantId?: string; role: string; open: boolean };
const A: ChoirFreshCaptureTicket = Object.freeze({
  roomEpoch: 1, songEpoch: 1, mediaEpoch: 1,
  participantId: 'A', seat: 'primary', transportId: 'socket-A',
});
const B: ChoirFreshCaptureTicket = Object.freeze({
  roomEpoch: 1, songEpoch: 1, mediaEpoch: 2,
  participantId: 'B', seat: 'secondary', transportId: 'socket-B',
});
function bytes(generation = 7, start = 0, samples = 960): Buffer {
  return v2(Math.floor(start / 960) >>> 0, start, samples, generation);
}
function boundResult(result: ChoirIngressResult) {
  if (!result.intercepted) throw new Error('Expected a Choir-bound socket');
  return result;
}
function socketFor(participantId?: string, role = 'unknown'): Socket {
  return { participantId, role, open: true };
}
function fixture() {
  const accepted: Array<{ticket: ChoirFreshCaptureTicket; generation: number | null; at: number}> = [];
  const disconnected: ChoirFreshCaptureTicket[] = [];
  let roomEpoch = 1;
  const ingress = new ChoirSecondaryPcmIngressExperiment({
    mayAcceptVerifiedTicket(ticket) {
      return ticket.roomEpoch === roomEpoch && ticket.seat === 'secondary'
        && ticket.participantId === 'B' && ticket.transportId === 'socket-B'
        && ticket.mediaEpoch === 2;
    },
    receiveVerifiedMic(ticket, frame, _rate, nowMs) {
      if (ticket.roomEpoch !== roomEpoch) return false;
      accepted.push({ ticket, generation: frame.generation, at: nowMs });
      return true;
    },
    disconnectVerifiedSinger(ticket) {
      if (ticket.roomEpoch !== roomEpoch) return false;
      disconnected.push(ticket);
      return true;
    },
  }, socket => (socket as Socket).open);
  return { ingress, accepted, disconnected, revoke: () => { roomEpoch++; } };
}

function v2(sequence: number, firstSampleIndex: number, sampleCount = 960,
  generation = 7, source: 'mic' | 'backing' = 'mic') {
  return encodeAudioPacket({
    source, generation, sequence, firstSampleIndex,
    pcm: Buffer.from(new Int16Array(sampleCount).fill(2_000).buffer),
  });
}

describe('isolated Choir secondary WebSocket PCM admission', () => {
  test('only server-bound authenticated secondary may reach experimental Mic sink', () => {
    const f = fixture();
    const socket: Socket = { participantId: 'B', role: 'unknown', open: true };
    const raw = bytes();
    assert.deepEqual(f.ingress.interceptBinary(socket, raw, 10), { intercepted: false },
      'default state preserves the existing N=1 route');
    assert.equal(f.ingress.bindVerifiedSecondary(socket, A, 48_000, 10), false,
      'a primary cannot silently claim a second Mic transport');
    assert.equal(f.ingress.bindVerifiedSecondary(socketFor('A'),
      B, 48_000, 10), false, 'auth identity must match the ticket singer');
    assert.equal(f.ingress.bindVerifiedSecondary(socketFor(),
      B, 48_000, 10), false, 'anonymous transport has no Choir media authority');
    assert.equal(f.ingress.bindVerifiedSecondary(socketFor('B', 'publisher'),
      B, 48_000, 10), false, 'production publisher role cannot double-register as Choir');
    assert.equal(f.ingress.codec, null, 'no codec to report before B binds');
    assert.equal(f.ingress.bindVerifiedSecondary(socket, B, 48_000, 10), true);
    assert.equal(f.ingress.codec, 'pcm');
    assert.equal(f.ingress.bindVerifiedSecondary(socket, B, 48_000, 11), false);
    assert.equal(f.ingress.bindVerifiedSecondary(socketFor('B'), B, 48_000, 12), false,
      'same B ticket may not be claimed by two physical WebSockets');
    assert.deepEqual(f.ingress.interceptBinary(socket, raw, 20),
      { intercepted: true, accepted: true, reason: 'accepted' });
    assert.equal(f.accepted.length, 1);
    assert.equal(f.accepted[0].ticket.participantId, 'B');
    assert.equal(f.accepted[0].generation, 7);
    assert.equal(f.ingress.disconnect(socket, 30), true);
    assert.equal(f.ingress.disconnect(socket, 31), false);
    assert.deepEqual(f.ingress.interceptBinary(socket, raw, 32), { intercepted: false });
    assert.deepEqual(f.disconnected, [B]);
    assert.equal(f.ingress.codec, null, 'a departed B leaves no codec behind');
  });

  test('malformed, unpositioned, oversized and restarted frames are intercepted but never applied', () => {
    const f = fixture();
    const socket: Socket = { participantId: 'B', role: 'unknown', open: true };
    assert.equal(f.ingress.bindVerifiedSecondary(socket, B, 48_000, 0), true);
    const accepted = bytes();
    assert.equal(boundResult(f.ingress.interceptBinary(socket, accepted, 10)).accepted, true);
    const emptyCount = Buffer.from(bytes());
    emptyCount.writeUInt32LE(0, 12);
    const invalidCursor = Buffer.from(bytes());
    invalidCursor.writeDoubleLE(Number.NaN, 16);
    const malformed: Buffer[] = [
      Buffer.from(new Int16Array(960).buffer), // no RL metadata
      emptyCount, // zero source samples
      bytes(7, 0, 9_601), // >200ms at 48k
      invalidCursor, // invalid native time position
      bytes(7, 0, 960).subarray(0, AUDIO_PACKET_HEADER_BYTES + 3), // uneven PCM
    ];
    const wrongSource = Buffer.from(accepted);
    wrongSource.writeUInt8(3, 3);
    malformed.push(wrongSource);
    const wrongMagic = Buffer.from(accepted);
    wrongMagic.writeUInt16LE(0x9876, 0);
    malformed.push(wrongMagic);
    for (const packet of malformed) {
      const result = boundResult(f.ingress.interceptBinary(socket, packet, 20));
      assert.equal(result.accepted, false);
    }
    assert.deepEqual(f.ingress.interceptBinary(socket, bytes(8, 960), 25), {
      intercepted: true, accepted: false, reason: 'capture-restarted',
    }, 'a new device capture needs new singer Media Epoch, not a silent generation alias');
    assert.equal(f.accepted.length, 1);
    assert.equal(boundResult(f.ingress.interceptBinary(socket, bytes(7, 960), 26)).accepted, true,
      'a refused capture restart cannot poison previously valid source generation');
  });

  test('old room and changed socket identity cannot leak PCM into N=1 or next Choir room', () => {
    const f = fixture();
    const socket: Socket = { participantId: 'B', role: 'unknown', open: true };
    assert.equal(f.ingress.bindVerifiedSecondary(socket, B, 48_000, 0), true);
    assert.equal(boundResult(f.ingress.interceptBinary(socket, bytes(), 10)).accepted, true);
    f.revoke();
    assert.equal(f.ingress.sweepStale(19), 1,
      'a retired room frees active ownership without touching the old physical socket');
    assert.equal(f.ingress.isAttached(socket), true,
      'old socket still must intercept all late binary frames until it closes');
    assert.deepEqual(f.ingress.interceptBinary(socket, bytes(7, 960), 20), {
      intercepted: true, accepted: false, reason: 'stale-authority',
    });
    socket.participantId = 'A';
    assert.deepEqual(f.ingress.interceptBinary(socket, bytes(7, 1920), 30), {
      intercepted: true, accepted: false, reason: 'socket-identity-changed',
    });
    socket.participantId = 'B';
    socket.role = 'publisher';
    assert.equal(boundResult(f.ingress.interceptBinary(socket, bytes(7, 2880), 31)).accepted, false);
    socket.role = 'unknown';
    socket.open = false;
    assert.equal(boundResult(f.ingress.interceptBinary(socket, bytes(7, 3840), 32)).accepted, false);
    assert.equal(f.ingress.disconnect(socket, 33), false,
      'a retired Choir room cannot revoke a new singer by closing an old socket');
    assert.equal(f.accepted.length, 1);
  });

  test('sustained oversized or high-rate secondary traffic is bounded per socket', () => {
    const f = fixture();
    const socket: Socket = { participantId: 'B', role: 'unknown', open: true };
    assert.equal(f.ingress.bindVerifiedSecondary(socket, B, 48_000, 0), true);
    assert.equal(boundResult(f.ingress.interceptBinary(socket, Buffer.alloc(77_000), 1)).reason,
      'too-large');
    for (let i = 0; i < 150; i++) {
      assert.equal(boundResult(f.ingress.interceptBinary(socket, bytes(7, i * 960), 10)).accepted, true);
    }
    assert.deepEqual(f.ingress.interceptBinary(socket, bytes(7, 150 * 960), 10), {
      intercepted: true, accepted: false, reason: 'rate-limited',
    });
    assert.equal(boundResult(f.ingress.interceptBinary(socket, bytes(7, 151 * 960), 1_020)).accepted, true);
    assert.equal(f.accepted.length, 151);
  });
  test('AudioPacket v2 from authenticated secondary never downgrades to v1 or accepts backing/v3', () => {
    const f = fixture();
    const socket = socketFor('B');
    assert.equal(f.ingress.bindVerifiedSecondary(socket, B, 48_000, 0), true);
    assert.deepEqual(f.ingress.interceptBinary(socket, v2(0, 0), 10), {
      intercepted: true, accepted: true, reason: 'accepted',
    });
    assert.deepEqual(f.ingress.interceptBinary(socket, encodePcmFrame(
      7, 960, Buffer.from(new Int16Array(960).buffer),
    ), 20), {
      intercepted: true, accepted: false, reason: 'malformed-frame',
    }, 'a legacy v1 RL header cannot enter the v2-only transport');
    assert.deepEqual(f.ingress.interceptBinary(socket, v2(1, 960, 960, 7, 'backing'), 30), {
      intercepted: true, accepted: false, reason: 'malformed-frame',
    }, 'the secondary Mic cannot spoof Robot PCM');
    const v3 = Buffer.from(v2(1, 960));
    v3.writeUInt8(3, 2);
    assert.deepEqual(f.ingress.interceptBinary(socket, v3, 40), {
      intercepted: true, accepted: false, reason: 'malformed-frame',
    }, 'a socket registered for PCM v2 never takes Opus v3');
    const mismatchedCount = Buffer.from(v2(1, 960));
    mismatchedCount.writeUInt32LE(970, 12);
    assert.deepEqual(f.ingress.interceptBinary(socket, mismatchedCount, 50), {
      intercepted: true, accepted: false, reason: 'malformed-frame',
    });
    assert.deepEqual(f.ingress.interceptBinary(socket, v2(1, 960), 60), {
      intercepted: true, accepted: true, reason: 'accepted',
    });
    assert.equal(f.accepted.length, 2);
  });

  test('v2 sequence deduplicates retransmissions, allows bounded reordering and uint32 wrap', () => {
    const f = fixture();
    const socket = socketFor('B');
    assert.equal(f.ingress.bindVerifiedSecondary(socket, B, 48_000, 0), true);
    for (const [seq, first] of [
      [0xffff_fffe, 0], [0, 1920], [0xffff_ffff, 960], [1, 2880],
    ]) {
      assert.deepEqual(f.ingress.interceptBinary(socket, v2(seq, first), 10), {
        intercepted: true, accepted: true, reason: 'accepted',
      });
    }
    assert.deepEqual(f.ingress.interceptBinary(socket, v2(0xffff_ffff, 960), 11), {
      intercepted: true, accepted: false, reason: 'duplicate-packet',
    }, 'the same retransmitted sequence cannot be ingested twice');
    assert.deepEqual(f.ingress.interceptBinary(socket, v2(2, 2880), 12), {
      intercepted: true, accepted: false, reason: 'sample-overlap',
    }, 'different packet IDs cannot overwrite an existing acoustic window');
    assert.deepEqual(f.ingress.interceptBinary(socket, v2(4_000, 3840), 13), {
      intercepted: true, accepted: false, reason: 'sequence-out-of-window',
    }, 'a sender cannot jump arbitrarily far into sequence space');
    assert.deepEqual(f.ingress.interceptBinary(socket, v2(2, 3840), 14), {
      intercepted: true, accepted: true, reason: 'accepted',
    }, 'rejected duplicate/overlap must not poison sequence advancement');
    assert.equal(f.accepted.length, 5);
  });

  test('v2 bounded recent replay window evicts old sample claims without accepting old sequences', () => {
    const f = fixture();
    const socket = socketFor('B');
    assert.equal(f.ingress.bindVerifiedSecondary(socket, B, 48_000, 0), true);
    for (let seq = 0; seq <= 129; seq++) {
      // Keep packet rate below 150/s while advancing an ordinary sequence.
      assert.equal(boundResult(f.ingress.interceptBinary(
        socket, v2(seq, seq * 960), seq * 20 + 1,
      )).accepted, true);
    }
    assert.equal(boundResult(f.ingress.interceptBinary(socket, v2(0, 0), 2_600))
      .reason, 'sequence-out-of-window');
    assert.equal(boundResult(f.ingress.interceptBinary(socket, v2(130, 130 * 960), 2_620))
      .accepted, true);
    assert.equal(f.accepted.length, 131);
  });

  test('an Opus v3 socket is decoded to PCM at its own sample positions, and takes nothing else', async () => {
    const f = fixture();
    const frames: Array<{ firstSampleIndex: number; pcm: Buffer }> = [];
    f.ingress.onAcceptedFrame = (frame) => { frames.push(frame); };
    assert.equal(f.ingress.bindVerifiedSecondary(socketFor('B'), B, 44_100, 0, 3), false,
      'Opus v3 is 20 ms frames at 48 kHz only');
    const socket = socketFor('B');
    assert.equal(f.ingress.bindVerifiedSecondary(socket, B, 48_000, 0, 3), true);
    assert.equal(f.ingress.codec, 'opus');

    // The page's own encoder (mic-opus-worker.js), framed as mic-opus-trial.js does.
    const encoder = createOpusEncoder(
      await readFile(new URL('../node_modules/@evan/opus/wasm/opus.wasm', import.meta.url)), 128_000);
    const opus = (sequence: number) => {
      const tone = new Int16Array(960);
      for (let i = 0; i < 960; i++) tone[i] = Math.round(8_000 * Math.sin(2 * Math.PI * 440 * (sequence * 960 + i) / 48_000));
      const payload = Buffer.from(encoder.encode(tone.buffer));
      const packet = Buffer.alloc(28 + payload.length);
      v2(sequence, sequence * 960).copy(packet, 0, 0, AUDIO_PACKET_HEADER_BYTES);
      packet.writeUInt8(3, 2);
      packet.writeUInt16LE(encoder.delaySamples, 24);
      payload.copy(packet, 28);
      return packet;
    };
    const delay = encoder.delaySamples;
    for (let sequence = 0; sequence < 3; sequence++) {
      assert.deepEqual(f.ingress.interceptBinary(socket, opus(sequence), 10 + sequence),
        { intercepted: true, accepted: true, reason: 'accepted' });
    }
    assert.equal(frames[0].firstSampleIndex, 0);
    assert.equal(frames[0].pcm.length / 2, 960 - delay, "the encoder's look-ahead is taken off the start");
    assert.equal(frames[1].firstSampleIndex, 960 - delay, 'contiguous after the first');
    assert.equal(frames[2].firstSampleIndex, 2 * 960 - delay);
    const rms = Math.sqrt(new Int16Array(frames[2].pcm.buffer, frames[2].pcm.byteOffset, 960)
      .reduce((sum, v) => sum + v * v, 0) / 960);
    assert.ok(rms > 4_000, `decoded audio, not silence (rms ${rms.toFixed(0)})`);

    assert.deepEqual(f.ingress.interceptBinary(socket, v2(3, 3 * 960), 20), {
      intercepted: true, accepted: false, reason: 'malformed-frame',
    }, 'a socket registered for Opus never takes PCM v2');
    assert.deepEqual(f.ingress.interceptBinary(socket, opus(2), 21), {
      intercepted: true, accepted: false, reason: 'duplicate-packet',
    }, 'a duplicate is refused before it reaches the decoder');
    assert.deepEqual(f.ingress.interceptBinary(socket, opus(3), 22),
      { intercepted: true, accepted: true, reason: 'accepted' });
    assert.equal(frames.length, 4);
  });
});
