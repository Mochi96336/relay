from pathlib import Path


def replace_once(path: str, old: str, new: str):
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, found {count}')
    target.write_text(text.replace(old, new, 1))


Path('src/participant-capability.ts').write_text("""import { timingSafeEqual } from 'node:crypto';

const CAPABILITY_PATTERN = /^[0-9a-f]{64}$/;

export function normalizeParticipantCapability(value: unknown) {
  if (typeof value !== 'string') return null;
  const capability = value.trim();
  return CAPABILITY_PATTERN.test(capability) ? capability : null;
}

/**
 * Process-local proof that multiple sockets claiming one public participant ID
 * actually came from the same browser identity.
 *
 * Participant IDs remain safe to broadcast for presence/UI. The capability is
 * never included in room snapshots; the first authenticated socket pins it for
 * this Relay process and later sockets must present exactly the same value.
 */
export class ParticipantCapabilityRegistry {
  private readonly capabilities = new Map<string, string>();

  claim(participantId: string, value: unknown) {
    const capability = normalizeParticipantCapability(value);
    if (!capability) return false;

    const current = this.capabilities.get(participantId);
    if (current === undefined) {
      this.capabilities.set(participantId, capability);
      return true;
    }

    return timingSafeEqual(Buffer.from(current), Buffer.from(capability));
  }
}
""")

Path('test/participant-capability.test.ts').write_text("""import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  ParticipantCapabilityRegistry,
  normalizeParticipantCapability,
} from '../src/participant-capability.js';

describe('participant capability', () => {
  test('accepts only a 256-bit lowercase hex capability', () => {
    const capability = 'ab'.repeat(32);
    assert.equal(normalizeParticipantCapability(capability), capability);
    assert.equal(normalizeParticipantCapability('AB'.repeat(32)), null);
    assert.equal(normalizeParticipantCapability('ab'.repeat(31)), null);
    assert.equal(normalizeParticipantCapability('not-a-secret'), null);
  });

  test('pins the first capability for a participant and rejects impersonation', () => {
    const registry = new ParticipantCapabilityRegistry();
    const alice = '01'.repeat(32);
    const attacker = '02'.repeat(32);

    assert.equal(registry.claim('participant-alice', alice), true);
    assert.equal(registry.claim('participant-alice', alice), true);
    assert.equal(registry.claim('participant-alice', attacker), false);
    assert.equal(registry.claim('participant-bob', attacker), true);
  });

  test('human browser sockets carry the private capability with the public identity', () => {
    for (const path of [
      'public/presence.js',
      'public/app.js',
      'public/listen.js',
      'public/live-status.js',
      'public/system-details.js',
      'public/recorder.js',
      'public/youtube-sync.js',
    ]) {
      const source = readFileSync(path, 'utf8');
      assert.match(source, /relayParticipantCapability/);
      assert.match(source, /params\\.set\\('cap',/);
    }

    const server = readFileSync('src/server.ts', 'utf8');
    assert.match(server, /participantCapabilities\\.claim\\(/);
    assert.match(server, /normalizeParticipantCapability\\(/);
  });
});
""")

server_import = """import {
  ParticipantSession,
  normalizeNickname,
  normalizeParticipantId,
} from './participant-session.js';
"""
replace_once(
    'src/server.ts',
    server_import,
    server_import + "import { ParticipantCapabilityRegistry, normalizeParticipantCapability } from './participant-capability.js';\n",
)
replace_once(
    'src/server.ts',
    "const participants = new ParticipantSession(PARTICIPANT_GRACE_MS);\nconst youtubeTimeline = new SongSession();",
    "const participants = new ParticipantSession(PARTICIPANT_GRACE_MS);\nconst participantCapabilities = new ParticipantCapabilityRegistry();\nconst youtubeTimeline = new SongSession();",
)
replace_once(
    'src/server.ts',
    """function participantIdentity(request: IncomingMessage) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const participantId = normalizeParticipantId(url.searchParams.get('participant'));
  if (!participantId) return null;

  const nickname = normalizeNickname(url.searchParams.get('name')) ?? 'Guest';
  return { participantId, nickname };
}
""",
    """function participantIdentity(request: IncomingMessage) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const participantId = normalizeParticipantId(url.searchParams.get('participant'));
  const capability = normalizeParticipantCapability(url.searchParams.get('cap'));
  if (!participantId || !capability) return null;

  const nickname = normalizeNickname(url.searchParams.get('name')) ?? 'Guest';
  return { participantId, nickname, capability };
}
""",
)
replace_once(
    'src/server.ts',
    """  const identity = participantIdentity(request);
  if (identity) {
    participantConnectionSequence += 1;
    socket.participantId = identity.participantId;
    socket.participantConnectionId = `connection-${participantConnectionSequence}`;
    const changed = participants.attach({
      connectionId: socket.participantConnectionId,
      participantId: identity.participantId,
      nickname: identity.nickname,
      nowMs: Date.now(),
    });
    if (changed) broadcastSessionStatus();
    else sendJson(socket, sessionStatusPayload());
  }
""",
    """  const identity = participantIdentity(request);
  if (identity) {
    if (!participantCapabilities.claim(identity.participantId, identity.capability)) {
      sendJson(socket, {
        type: 'participant-auth-rejected',
        message: 'This participant identity belongs to another browser capability.',
      });
      socket.close(1008, 'Participant capability mismatch.');
      return;
    }

    participantConnectionSequence += 1;
    socket.participantId = identity.participantId;
    socket.participantConnectionId = `connection-${participantConnectionSequence}`;
    const changed = participants.attach({
      connectionId: socket.participantConnectionId,
      participantId: identity.participantId,
      nickname: identity.nickname,
      nowMs: Date.now(),
    });
    if (changed) broadcastSessionStatus();
    else sendJson(socket, sessionStatusPayload());
  }
""",
)

replace_once(
    'public/presence.js',
    """  const PARTICIPANT_ID_KEY = 'relay.participantId.v1';
  const NICKNAME_KEY = 'relay.nickname.v1';
""",
    """  const PARTICIPANT_ID_KEY = 'relay.participantId.v1';
  const PARTICIPANT_CAPABILITY_KEY = 'relay.participantCapability.v1';
  const NICKNAME_KEY = 'relay.nickname.v1';
""",
)
replace_once(
    'public/presence.js',
    """  function randomParticipantId() {
    const random = new Uint32Array(4);
    crypto.getRandomValues(random);
    return `participant-${Array.from(random, (value) => value.toString(16).padStart(8, '0')).join('')}`;
  }

  function storedIdentity() {
""",
    """  function randomParticipantId() {
    const random = new Uint32Array(4);
    crypto.getRandomValues(random);
    return `participant-${Array.from(random, (value) => value.toString(16).padStart(8, '0')).join('')}`;
  }

  function randomParticipantCapability() {
    const random = new Uint8Array(32);
    crypto.getRandomValues(random);
    return Array.from(random, (value) => value.toString(16).padStart(2, '0')).join('');
  }

  function storedIdentity() {
""",
)
replace_once(
    'public/presence.js',
    """    let nickname = normalizeNickname(localStorage.getItem(NICKNAME_KEY));
    if (!nickname) {
      nickname = randomNickname();
      localStorage.setItem(NICKNAME_KEY, nickname);
    }
    return { participantId, nickname };
  }

  let { participantId, nickname } = storedIdentity();
""",
    """    let participantCapability = localStorage.getItem(PARTICIPANT_CAPABILITY_KEY);
    if (!participantCapability || !/^[0-9a-f]{64}$/.test(participantCapability)) {
      participantCapability = randomParticipantCapability();
      localStorage.setItem(PARTICIPANT_CAPABILITY_KEY, participantCapability);
    }

    let nickname = normalizeNickname(localStorage.getItem(NICKNAME_KEY));
    if (!nickname) {
      nickname = randomNickname();
      localStorage.setItem(NICKNAME_KEY, nickname);
    }
    return { participantId, participantCapability, nickname };
  }

  let { participantId, participantCapability, nickname } = storedIdentity();
""",
)
replace_once(
    'public/presence.js',
    """  window.relayParticipantId = participantId;
  window.relayNickname = nickname;
""",
    """  window.relayParticipantId = participantId;
  window.relayParticipantCapability = participantCapability;
  window.relayNickname = nickname;
""",
)
replace_once(
    'public/presence.js',
    """    params.set('participant', participantId);
    params.set('name', nickname);
""",
    """    params.set('participant', participantId);
    params.set('cap', participantCapability);
    params.set('name', nickname);
""",
)

shared_old = """    const nickname = typeof window.relayNickname === 'string'
      ? window.relayNickname.trim()
      : '';
    if (participantId && nickname) {
      params.set('participant', participantId);
      params.set('name', nickname);
    }
"""
shared_new = """    const nickname = typeof window.relayNickname === 'string'
      ? window.relayNickname.trim()
      : '';
    const participantCapability = typeof window.relayParticipantCapability === 'string'
      ? window.relayParticipantCapability.trim()
      : '';
    if (participantId && nickname && participantCapability) {
      params.set('participant', participantId);
      params.set('cap', participantCapability);
      params.set('name', nickname);
    }
"""
for path in [
    'public/app.js',
    'public/listen.js',
    'public/live-status.js',
    'public/system-details.js',
    'public/youtube-sync.js',
]:
    replace_once(path, shared_old, shared_new)

replace_once(
    'public/recorder.js',
    """  const participantId = typeof window.relayParticipantId === 'string'
    ? window.relayParticipantId
    : '';
  if (!participantId) return null;
""",
    """  const participantId = typeof window.relayParticipantId === 'string'
    ? window.relayParticipantId
    : '';
  const participantCapability = typeof window.relayParticipantCapability === 'string'
    ? window.relayParticipantCapability
    : '';
  if (!participantId || !participantCapability) return null;
""",
)
replace_once(
    'public/recorder.js',
    """  params.set('participant', participantId);
  params.set('name', typeof window.relayNickname === 'string' ? window.relayNickname : 'Guest');
""",
    """  params.set('participant', participantId);
  params.set('cap', participantCapability);
  params.set('name', typeof window.relayNickname === 'string' ? window.relayNickname : 'Guest');
""",
)
