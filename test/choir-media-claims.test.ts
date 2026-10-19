import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChoirMediaClaims } from '../src/choir-media-claims.js';

type Socket = { participantId?: string; role: string; open: boolean };
const socketFor = (participantId?: string, role = 'unknown'): Socket => ({ participantId, role, open: true });

function fixture() {
  const joinSocket = socketFor('B');
  let allowed = true;
  let bindOk = true;
  const bound: Array<{ participantId: string; transportId: string; rate: number; version: number }> = [];
  const tickets = new ChoirMediaClaims(
    { bind: (_socket, participantId, transportId, rate, _now, version) => {
      if (!bindOk) return false;
      bound.push({ participantId, transportId, rate, version: version ?? 2 });
      return true;
    } },
    socket => (socket as Socket).open,
    socket => allowed && socket === joinSocket,
  );
  return {
    tickets, joinSocket, bound,
    setAllowed: (v: boolean) => { allowed = v; },
    setBindOk: (v: boolean) => { bindOk = v; },
  };
}

test("B's join socket gets one claim, which only a separate media socket of B's redeems, once", () => {
  const f = fixture();
  assert.equal(f.tickets.issue(socketFor('B'), 0), null, 'another tab of B is not the join socket');
  const claim = f.tickets.issue(f.joinSocket, 0)!;
  assert.match(claim.claimToken, /^[0-9a-f]{64}$/);
  assert.equal(claim.expiresInMs, 15_000);
  assert.equal(f.tickets.redeem(f.joinSocket, claim.claimToken, 48_000, 2, 1), null,
    'the join socket cannot be its own media socket');
  assert.equal(f.tickets.pendingCount, 0, 'a presented token is burnt, even when refused');

  const second = f.tickets.issue(f.joinSocket, 2)!;
  const media = socketFor('B');
  const granted = f.tickets.redeem(media, second.claimToken, 48_000, 3, 3);
  assert.match(granted?.transportId ?? '', /^[0-9a-f-]{36}$/, 'the server names the transport');
  assert.deepEqual(f.bound, [{ participantId: 'B', transportId: granted!.transportId, rate: 48_000, version: 3 }]);
  assert.equal(f.tickets.redeem(socketFor('B'), second.claimToken, 48_000, 2, 4), null, 'single use');
});

test('a claim is refused to anyone else, after its lifetime, or once the join ends', () => {
  const f = fixture();
  const forOther = f.tickets.issue(f.joinSocket, 0)!;
  assert.equal(f.tickets.redeem(socketFor('C'), forOther.claimToken, 48_000, 2, 1), null, 'another participant');
  const forPublisher = f.tickets.issue(f.joinSocket, 2)!;
  assert.equal(f.tickets.redeem(socketFor('B', 'publisher'), forPublisher.claimToken, 48_000, 2, 3), null,
    'a main Mic socket');

  const late = f.tickets.issue(f.joinSocket, 10)!;
  assert.equal(f.tickets.redeem(socketFor('B'), late.claimToken, 48_000, 2, 10 + 15_000), null, 'expired');

  const ended = f.tickets.issue(f.joinSocket, 20_000)!;
  f.setAllowed(false);
  assert.equal(f.tickets.sweep(20_001), 1);
  assert.equal(f.tickets.redeem(socketFor('B'), ended.claimToken, 48_000, 2, 20_002), null);
  assert.equal(f.tickets.issue(f.joinSocket, 20_003), null, 'no claim without a join');
  assert.equal(f.bound.length, 0);
});

test('a newer claim supersedes the old one, and closing the join socket revokes it', () => {
  const f = fixture();
  const old = f.tickets.issue(f.joinSocket, 0)!;
  const fresh = f.tickets.issue(f.joinSocket, 1)!;
  assert.equal(f.tickets.pendingCount, 1);
  assert.equal(f.tickets.redeem(socketFor('B'), old.claimToken, 48_000, 2, 2), null);
  assert.equal(f.tickets.disconnected(f.joinSocket), 1);
  assert.equal(f.tickets.redeem(socketFor('B'), fresh.claimToken, 48_000, 2, 3), null);
});

test('only PCM v2 at a sane rate or Opus v3 at 48 kHz is taken, and a refused bind grants nothing', () => {
  const f = fixture();
  for (const [rate, version] of [[44_100, 3], [4_000, 2], [400_000, 2]] as const) {
    const claim = f.tickets.issue(f.joinSocket, 0)!;
    assert.equal(f.tickets.redeem(socketFor('B'), claim.claimToken, rate, version, 1), null, `${rate}/${version}`);
  }
  f.setBindOk(false);
  const claim = f.tickets.issue(f.joinSocket, 2)!;
  assert.equal(f.tickets.redeem(socketFor('B'), claim.claimToken, 44_100, 2, 3), null);
});
