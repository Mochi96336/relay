from pathlib import Path


def replace_once(path: str, old: str, new: str):
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, found {count}')
    target.write_text(text.replace(old, new, 1))


def patch_browser_ws(path: str):
    target = Path(path)
    text = target.read_text()
    marker = "const nickname = typeof window.relayNickname === 'string'"
    index = text.find(marker)
    if index < 0:
        raise SystemExit(f'{path}: nickname identity block not found')
    line_start = text.rfind('\n', 0, index) + 1
    indent = text[line_start:index]
    block_end_marker = f"{indent}  : '';"
    block_end = text.find(block_end_marker, index)
    if block_end < 0:
        raise SystemExit(f'{path}: nickname identity block end not found')
    insert_at = block_end + len(block_end_marker)
    capability_block = (
        f"\n{indent}const participantCapability = typeof window.relayParticipantCapability === 'string'\n"
        f"{indent}  ? window.relayParticipantCapability.trim()\n"
        f"{indent}  : '';"
    )
    text = text[:insert_at] + capability_block + text[insert_at:]

    old_condition = 'if (participantId && nickname) {'
    if text.count(old_condition) != 1:
        raise SystemExit(f'{path}: participant identity condition count={text.count(old_condition)}')
    text = text.replace(old_condition, 'if (nickname && participantCapability) {', 1)

    old_param = "params.set('participant', participantId);\n"
    if text.count(old_param) != 1:
        raise SystemExit(f'{path}: participant query count={text.count(old_param)}')
    text = text.replace(old_param, f"{indent}  params.set('cap', participantCapability);\n", 1)
    target.write_text(text)


Path('src/participant-capability.ts').write_text("""import { createHash } from 'node:crypto';

const CAPABILITY_PATTERN = /^[0-9a-f]{64}$/;
const BROWSER_PARTICIPANT_PATTERN = /^participant-v2-[0-9a-f]{32}$/;
const RETIRED_BROWSER_PARTICIPANT_PATTERN = /^participant-[0-9a-f]{32}$/;

export function normalizeParticipantCapability(value: unknown) {
  if (typeof value !== 'string') return null;
  const capability = value.trim();
  return CAPABILITY_PATTERN.test(capability) ? capability : null;
}

/**
 * Browser identity is a public pseudonym derived from the complete private
 * capability. The room may broadcast this ID without revealing a credential,
 * and Relay can reconstruct it after a process restart without an account DB.
 */
export function participantIdForCapability(value: unknown) {
  const capability = normalizeParticipantCapability(value);
  if (!capability) return null;
  const digest = createHash('sha256').update(capability, 'ascii').digest('hex');
  return `participant-v2-${digest.slice(0, 32)}`;
}

export function protectedBrowserParticipantId(participantId: string) {
  return BROWSER_PARTICIPANT_PATTERN.test(participantId)
    || RETIRED_BROWSER_PARTICIPANT_PATTERN.test(participantId);
}
""")

Path('test/participant-capability.test.ts').write_text("""import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  normalizeParticipantCapability,
  participantIdForCapability,
  protectedBrowserParticipantId,
} from '../src/participant-capability.js';

describe('participant capability', () => {
  test('derives the public browser id from the complete private capability', () => {
    const capability = 'ab'.repeat(32);
    const expected = `participant-v2-${createHash('sha256').update(capability, 'ascii').digest('hex').slice(0, 32)}`;
    assert.equal(normalizeParticipantCapability(capability), capability);
    assert.equal(participantIdForCapability(capability), expected);
    assert.equal(protectedBrowserParticipantId(expected), true);
  });

  test('changing only the private half changes the public identity', () => {
    const first = `${'ab'.repeat(16)}${'cd'.repeat(16)}`;
    const second = `${'ab'.repeat(16)}${'ef'.repeat(16)}`;
    assert.notEqual(participantIdForCapability(first), participantIdForCapability(second));
  });

  test('protects both current and retired browser-shaped ids from unauthenticated reuse', () => {
    assert.equal(protectedBrowserParticipantId(`participant-v2-${'ab'.repeat(16)}`), true);
    assert.equal(protectedBrowserParticipantId(`participant-${'ab'.repeat(16)}`), true);
    assert.equal(protectedBrowserParticipantId('participant-alice'), false);
  });

  test('rejects malformed capabilities', () => {
    assert.equal(normalizeParticipantCapability('AB'.repeat(32)), null);
    assert.equal(normalizeParticipantCapability('ab'.repeat(31)), null);
    assert.equal(normalizeParticipantCapability('not-a-secret'), null);
    assert.equal(participantIdForCapability(null), null);
  });

  test('human browser sockets send the capability rather than trusting a public participant id', () => {
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
      assert.match(source, /params\.set\('cap',/);
    }

    const server = readFileSync('src/server.ts', 'utf8');
    assert.match(server, /participantIdForCapability\(/);
    assert.match(server, /participant-auth-rejected/);
    assert.match(server, /participant-identified/);
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
    server_import + "import { normalizeParticipantCapability, participantIdForCapability, protectedBrowserParticipantId } from './participant-capability.js';\n",
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
    """type ParticipantIdentityResult =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'valid'; participantId: string; nickname: string; capabilityBacked: boolean };

function participantIdentity(request: IncomingMessage): ParticipantIdentityResult {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const rawCapability = url.searchParams.get('cap');
  if (rawCapability !== null) {
    const capability = normalizeParticipantCapability(rawCapability);
    const participantId = participantIdForCapability(capability);
    if (!participantId) return { kind: 'invalid' };
    const nickname = normalizeNickname(url.searchParams.get('name')) ?? 'Guest';
    return { kind: 'valid', participantId, nickname, capabilityBacked: true };
  }

  const rawParticipantId = url.searchParams.get('participant');
  if (rawParticipantId === null) return { kind: 'none' };
  const participantId = normalizeParticipantId(rawParticipantId);
  if (!participantId || protectedBrowserParticipantId(participantId)) {
    return { kind: 'invalid' };
  }

  const nickname = normalizeNickname(url.searchParams.get('name')) ?? 'Guest';
  return { kind: 'valid', participantId, nickname, capabilityBacked: false };
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
  if (identity.kind === 'invalid') {
    sendJson(socket, {
      type: 'participant-auth-rejected',
      message: 'Participant identity could not be verified. Reload Relay.',
    });
    socket.close(1008, 'Participant capability mismatch.');
    return;
  }
  if (identity.kind === 'valid') {
    participantConnectionSequence += 1;
    socket.participantId = identity.participantId;
    socket.participantConnectionId = `connection-${participantConnectionSequence}`;
    if (identity.capabilityBacked) {
      sendJson(socket, { type: 'participant-identified', participantId: identity.participantId });
    }
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
    let participantId = localStorage.getItem(PARTICIPANT_ID_KEY);
    if (!participantId || !/^[A-Za-z0-9_-]{8,128}$/.test(participantId)) {
      participantId = randomParticipantId();
      localStorage.setItem(PARTICIPANT_ID_KEY, participantId);
    }

    let nickname = normalizeNickname(localStorage.getItem(NICKNAME_KEY));
""",
    """  function randomParticipantCapability() {
    const random = new Uint8Array(32);
    crypto.getRandomValues(random);
    return Array.from(random, (value) => value.toString(16).padStart(2, '0')).join('');
  }

  function storedIdentity() {
    let participantCapability = localStorage.getItem(PARTICIPANT_CAPABILITY_KEY);
    if (!participantCapability || !/^[0-9a-f]{64}$/.test(participantCapability)) {
      participantCapability = randomParticipantCapability();
      localStorage.setItem(PARTICIPANT_CAPABILITY_KEY, participantCapability);
    }

    const storedParticipantId = localStorage.getItem(PARTICIPANT_ID_KEY);
    const participantId = storedParticipantId && /^participant-v2-[0-9a-f]{32}$/.test(storedParticipantId)
      ? storedParticipantId
      : null;

    let nickname = normalizeNickname(localStorage.getItem(NICKNAME_KEY));
""",
)
replace_once(
    'public/presence.js',
    """    return { participantId, nickname };
  }

  let { participantId, nickname } = storedIdentity();
""",
    """    return { participantId, participantCapability, nickname };
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
    """    params.set('cap', participantCapability);
    params.set('name', nickname);
""",
)
replace_once(
    'public/presence.js',
    """  function handleMessage(message) {
    if (message.type !== 'session-status') return;
""",
    """  function handleMessage(message) {
    if (message.type === 'participant-identified') {
      const identified = typeof message.participantId === 'string' && /^participant-v2-[0-9a-f]{32}$/.test(message.participantId)
        ? message.participantId
        : null;
      if (identified) {
        participantId = identified;
        window.relayParticipantId = identified;
        localStorage.setItem(PARTICIPANT_ID_KEY, identified);
      }
      return;
    }
    if (message.type !== 'session-status') return;
""",
)

for path in [
    'public/app.js',
    'public/listen.js',
    'public/live-status.js',
    'public/system-details.js',
    'public/youtube-sync.js',
]:
    patch_browser_ws(path)

replace_once(
    'public/recorder.js',
    """  const participantId = typeof window.relayParticipantId === 'string'
    ? window.relayParticipantId
    : '';
  if (!participantId) return null;
""",
    """  const participantCapability = typeof window.relayParticipantCapability === 'string'
    ? window.relayParticipantCapability
    : '';
  if (!participantCapability) return null;
""",
)
replace_once(
    'public/recorder.js',
    """  params.set('participant', participantId);
  params.set('name', typeof window.relayNickname === 'string' ? window.relayNickname : 'Guest');
""",
    """  params.set('cap', participantCapability);
  params.set('name', typeof window.relayNickname === 'string' ? window.relayNickname : 'Guest');
""",
)
