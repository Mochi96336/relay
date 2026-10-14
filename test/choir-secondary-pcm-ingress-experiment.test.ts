import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { encodePcmFrame, FRAME_HEADER_BYTES } from '../src/pcm-frame.js';
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
  return encodePcmFrame(generation, start,
    Buffer.from(new Int16Array(samples).fill(2_000).buffer));
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
    assert.equal(f.ingress.bindVerifiedSecondary(socket, B, 48_000, 10), true);
    assert.equal(f.ingress.bindVerifiedSecondary(socket, B, 48_000, 11), false);
    assert.deepEqual(f.ingress.interceptBinary(socket, raw, 20),
      { intercepted: true, accepted: true, reason: 'accepted' });
    assert.equal(f.accepted.length, 1);
    assert.equal(f.accepted[0].ticket.participantId, 'B');
    assert.equal(f.accepted[0].generation, 7);
    assert.equal(f.ingress.disconnect(socket, 30), true);
    assert.equal(f.ingress.disconnect(socket, 31), false);
    assert.deepEqual(f.ingress.interceptBinary(socket, raw, 32), { intercepted: false });
    assert.deepEqual(f.disconnected, [B]);
  });

  test('malformed, unpositioned, oversized and restarted frames are intercepted but never applied', () => {
    const f = fixture();
    const socket: Socket = { participantId: 'B', role: 'unknown', open: true };
    assert.equal(f.ingress.bindVerifiedSecondary(socket, B, 48_000, 0), true);
    const accepted = bytes();
    assert.equal(boundResult(f.ingress.interceptBinary(socket, accepted, 10)).accepted, true);
    const malformed: Buffer[] = [
      Buffer.from(new Int16Array(960).buffer), // no RL metadata
      bytes(7, 0, 0), // empty capture
      bytes(7, 0, 9_601), // >200ms at 48k
      bytes(7, Number.NaN), // invalid time position
      bytes(7, 0, 960).subarray(0, FRAME_HEADER_BYTES + 3), // uneven PCM
    ];
    const wrongFlags = Buffer.from(accepted);
    wrongFlags.writeUInt8(1, 3);
    malformed.push(wrongFlags);
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
});
