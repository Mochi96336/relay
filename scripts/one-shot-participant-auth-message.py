from pathlib import Path
import re


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: {label}: expected one match, found {count}')
    target.write_text(text.replace(old, new, 1))


def regex_once(path: str, pattern: str, replacement: str, label: str) -> None:
    target = Path(path)
    text = target.read_text()
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE)
    if count != 1:
        raise SystemExit(f'{path}: {label}: expected one regex match, found {count}')
    target.write_text(updated)


def prepend_import(path: str) -> None:
    target = Path(path)
    text = target.read_text()
    line = "import { sendParticipantAuthentication } from './participant-auth.js';\n"
    if line in text:
        return
    target.write_text(line + text)


Path('public/participant-auth.js').write_text("""/**
 * Sends the private browser capability inside the established WebSocket rather
 * than in its request URL. Reverse proxies and tunnel access logs commonly
 * retain request URLs; application messages stay inside the upgraded channel.
 */
export function participantAuthenticationPayload() {
  const participantId = typeof window.relayParticipantId === 'string'
    ? window.relayParticipantId.trim()
    : '';
  const capability = typeof window.relayParticipantCapability === 'string'
    ? window.relayParticipantCapability.trim()
    : '';
  const nickname = typeof window.relayNickname === 'string'
    ? window.relayNickname.trim()
    : '';
  if (!participantId || !capability || !nickname) return null;
  return {
    type: 'participant-authenticate',
    participantId,
    capability,
    nickname,
  };
}

export function sendParticipantAuthentication(socket) {
  const payload = participantAuthenticationPayload();
  if (!payload || !socket || typeof socket.send !== 'function') return false;
  socket.send(JSON.stringify(payload));
  return true;
}
""")

# Server: browser authority is authenticated by the first application message.
replace_once(
    'src/server.ts',
    "import { participantCapabilityMatches } from './participant-capability.js';\n",
    "import { browserParticipantIdentity, participantCapabilityMatches } from './participant-capability.js';\n",
    'import browser identity classifier',
)

replace_once(
    'src/server.ts',
    """function participantIdentity(request: IncomingMessage): ParticipantIdentityResult {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const rawParticipantId = url.searchParams.get('participant');
  if (rawParticipantId === null) return { kind: 'none' };

  const participantId = normalizeParticipantId(rawParticipantId);
  if (!participantId || !participantCapabilityMatches(participantId, url.searchParams.get('cap'))) {
    return { kind: 'invalid' };
  }

  const nickname = normalizeNickname(url.searchParams.get('name')) ?? 'Guest';
  return { kind: 'valid', participantId, nickname };
}
""",
    """function participantIdentity(request: IncomingMessage): ParticipantIdentityResult {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const rawParticipantId = url.searchParams.get('participant');
  if (rawParticipantId === null) return { kind: 'none' };

  const participantId = normalizeParticipantId(rawParticipantId);
  // Browser participant capabilities are bearer secrets and must never ride in
  // the WebSocket request URL. Query identity remains only for explicit legacy
  // test fixtures, which cannot be enabled in production.
  if (
    !participantId
    || browserParticipantIdentity(participantId)
    || !participantCapabilityMatches(participantId, null)
  ) {
    return { kind: 'invalid' };
  }

  const nickname = normalizeNickname(url.searchParams.get('name')) ?? 'Guest';
  return { kind: 'valid', participantId, nickname };
}

function participantIdentityFromMessage(payload: Record<string, unknown>): ParticipantIdentityResult {
  const participantId = normalizeParticipantId(payload.participantId);
  if (
    !participantId
    || !browserParticipantIdentity(participantId)
    || !participantCapabilityMatches(participantId, payload.capability)
  ) {
    return { kind: 'invalid' };
  }
  const nickname = normalizeNickname(payload.nickname) ?? 'Guest';
  return { kind: 'valid', participantId, nickname };
}

function attachParticipantIdentity(
  socket: RelaySocket,
  identity: Extract<ParticipantIdentityResult, { kind: 'valid' }>,
) {
  if (socket.participantId) return socket.participantId === identity.participantId;
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
  return true;
}
""",
    'move browser capability authentication out of request URL',
)

replace_once(
    'src/server.ts',
    """  if (identity.kind === 'valid') {
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
    """  if (identity.kind === 'valid') attachParticipantIdentity(socket, identity);
""",
    'reuse participant attachment for legacy test query identity',
)

replace_once(
    'src/server.ts',
    """    if (!message || typeof message !== 'object') return;
    const payload = message as Record<string, unknown>;

    if (payload.type === 'clock-ping') {
""",
    """    if (!message || typeof message !== 'object') return;
    const payload = message as Record<string, unknown>;

    if (payload.type === 'participant-authenticate') {
      const authenticated = participantIdentityFromMessage(payload);
      if (
        authenticated.kind !== 'valid'
        || (socket.participantId !== undefined && socket.participantId !== authenticated.participantId)
      ) {
        sendJson(socket, {
          type: 'participant-auth-rejected',
          message: 'Participant identity did not match its private browser capability. Reload Relay.',
        });
        socket.close(1008, 'Participant capability mismatch.');
        return;
      }
      attachParticipantIdentity(socket, authenticated);
      sendJson(socket, {
        type: 'participant-authenticated',
        participantId: authenticated.participantId,
      });
      return;
    }

    if (payload.type === 'clock-ping') {
""",
    'authenticate browser participant before authority-bearing messages',
)

# Human browser WebSocket URLs now carry only deployment key material; private
# participant capability is the first ordered application message.
for path in [
    'public/app.js',
    'public/listen.js',
    'public/live-status.js',
    'public/system-details.js',
    'public/youtube-sync.js',
]:
    prepend_import(path)
    regex_once(
        path,
        r"\n\s*const participantId = typeof window\.relayParticipantId === 'string'[\s\S]*?params\.set\('name', nickname\);\n\s*}\n",
        "\n",
        'remove participant capability from websocket query',
    )

prepend_import('public/presence.js')
replace_once(
    'public/presence.js',
    """    if (key) params.set('key', key);
    params.set('participant', participantId);
    params.set('cap', participantCapability);
    params.set('name', nickname);
    return `${protocol}//${location.host}/ws?${params.toString()}`;
""",
    """    if (key) params.set('key', key);
    const query = params.toString();
    return `${protocol}//${location.host}/ws${query ? `?${query}` : ''}`;
""",
    'remove Presence capability from websocket URL',
)

prepend_import('public/recorder.js')
replace_once(
    'public/recorder.js',
    """function wsUrl() {
  const participantId = typeof window.relayParticipantId === 'string'
    ? window.relayParticipantId
    : '';
  const participantCapability = typeof window.relayParticipantCapability === 'string'
    ? window.relayParticipantCapability
    : '';
  if (!participantId || !participantCapability) return null;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const source = new URLSearchParams(location.search);
  const params = new URLSearchParams();
  const key = source.get('key');
  if (key) params.set('key', key);
  params.set('participant', participantId);
  params.set('cap', participantCapability);
  params.set('name', typeof window.relayNickname === 'string' ? window.relayNickname : 'Guest');
  return `${protocol}//${location.host}/ws?${params.toString()}`;
}
""",
    """function wsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const source = new URLSearchParams(location.search);
  const params = new URLSearchParams();
  const key = source.get('key');
  if (key) params.set('key', key);
  const query = params.toString();
  return `${protocol}//${location.host}/ws${query ? `?${query}` : ''}`;
}
""",
    'remove recorder capability from websocket URL',
)

# Send authentication first on every human socket. WebSocket preserves message
# order, so subsequent registration/status/command traffic cannot overtake it.
replace_once(
    'public/app.js',
    """    ws.addEventListener('open', () => resolve(ws), { once: true });
""",
    """    ws.addEventListener('open', () => {
      sendParticipantAuthentication(ws);
      resolve(ws);
    }, { once: true });
""",
    'authenticate publisher/control socket on open',
)
replace_once(
    'public/presence.js',
    """    next.send(JSON.stringify({ type: 'session-status-request' }));
    sendPendingRename();
""",
    """    sendParticipantAuthentication(next);
    next.send(JSON.stringify({ type: 'session-status-request' }));
    sendPendingRename();
""",
    'authenticate Presence before status/rename',
)
replace_once(
    'public/listen.js',
    """    socket = next;
    playbackNode.port.postMessage({ type: 'reset' });
    next.send(JSON.stringify({ type: 'register', role: 'monitor' }));
""",
    """    socket = next;
    playbackNode.port.postMessage({ type: 'reset' });
    sendParticipantAuthentication(next);
    next.send(JSON.stringify({ type: 'register', role: 'monitor' }));
""",
    'authenticate Listen before monitor registration',
)
replace_once(
    'public/live-status.js',
    """    next.send(JSON.stringify({ type: 'product-status-request' }));
""",
    """    sendParticipantAuthentication(next);
    next.send(JSON.stringify({ type: 'product-status-request' }));
""",
    'authenticate live status socket before request',
)
replace_once(
    'public/system-details.js',
    """      diagnosticsState.textContent = 'Connected';
      requestDiagnostics(socket);
""",
    """      diagnosticsState.textContent = 'Connected';
      sendParticipantAuthentication(socket);
      requestDiagnostics(socket);
""",
    'authenticate diagnostics socket before requests',
)
replace_once(
    'public/recorder.js',
    """  next.send(JSON.stringify({ type: 'take-status-request' }));
  render();
""",
    """  sendParticipantAuthentication(next);
  next.send(JSON.stringify({ type: 'take-status-request' }));
  render();
""",
    'authenticate Take socket before status/commands',
)
replace_once(
    'public/youtube-sync.js',
    """    if (socket !== next) return;
    recentRttMs.length = 0;
""",
    """    if (socket !== next) return;
    sendParticipantAuthentication(next);
    recentRttMs.length = 0;
""",
    'authenticate playback socket before playback hello',
)

# Browser/source contracts pin the secret transport boundary.
replace_once(
    'test/participant-capability.test.ts',
    """  test('human browser sockets carry the private capability with the public identity', () => {
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
      assert.match(source, /relayIdentityReady/);
      assert.match(source, /params\\.set\\('cap',/);
    }

    const server = readFileSync('src/server.ts', 'utf8');
    assert.match(server, /participantCapabilityMatches\\(/);
    assert.match(server, /participant-auth-rejected/);
  });
""",
    """  test('human browser sockets authenticate inside the upgraded channel, never in the URL', () => {
    const helper = readFileSync('public/participant-auth.js', 'utf8');
    assert.match(helper, /relayParticipantCapability/);
    assert.match(helper, /participant-authenticate/);

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
      assert.match(source, /relayIdentityReady/);
      assert.match(source, /sendParticipantAuthentication/);
      assert.doesNotMatch(source, /params\\.set\\('cap',/);
    }

    const server = readFileSync('src/server.ts', 'utf8');
    assert.match(server, /payload\\.type === 'participant-authenticate'/);
    assert.match(server, /participantCapabilityMatches\\(participantId, payload\\.capability\\)/);
    assert.match(server, /participant-auth-rejected/);
  });
""",
    'pin capability transport inside websocket messages',
)

replace_once(
    'test/participant-server.test.ts',
    """import WebSocket from 'ws';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';
""",
    """import WebSocket from 'ws';

import { participantIdForCapability } from '../src/participant-capability.js';
import { RelayClient, sleep, startRelay } from './helpers/harness.js';
""",
    'import browser participant derivation for real auth test',
)

replace_once(
    'test/participant-server.test.ts',
    """  test('production websocket identities cannot bypass capability binding with a legacy-shaped id', async () => {
""",
    """  test('production browser identity authenticates in the first websocket message, not the request URL', async () => {
    const server = await startRelay({
      ...FAST,
      NODE_ENV: 'production',
      RELAY_TEST_LEGACY_PARTICIPANTS: '1',
    });
    try {
      const capability = 'ab'.repeat(32);
      const participantId = participantIdForCapability(capability);
      assert.ok(participantId);

      const browser = await RelayClient.connect(server);
      browser.send({
        type: 'participant-authenticate',
        participantId,
        capability,
        nickname: 'Alice',
      });
      const authenticated = await browser.waitForType('participant-authenticated');
      assert.equal(authenticated.participantId, participantId);
      const status = await browser.waitFor((message) => (
        message.type === 'session-status'
        && message.participants?.some((participant: any) => participant.id === participantId)
      ));
      assert.equal(status.participants.find((participant: any) => participant.id === participantId)?.nickname, 'Alice');
      browser.close();

      const leakedQuery = new URLSearchParams({
        participant: participantId,
        cap: capability,
        name: 'Alice',
      });
      const leaked = await RelayClient.connect(server, `?${leakedQuery.toString()}`);
      const rejected = await leaked.waitForType('participant-auth-rejected');
      assert.match(rejected.message, /capability/i);
      leaked.close();
    } finally {
      await server.stop();
    }
  });

  test('production websocket identities cannot bypass capability binding with a legacy-shaped id', async () => {
""",
    'exercise message auth and reject capability-bearing request URL',
)
