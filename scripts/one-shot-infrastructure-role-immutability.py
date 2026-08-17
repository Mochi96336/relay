from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f'missing patch anchor in {path}: {old[:120]!r}')
    if text.count(old) != 1:
        raise SystemExit(f'patch anchor is not unique in {path}: {old[:120]!r}')
    file.write_text(text.replace(old, new, 1))


# ---------------------------------------------------------------------------
# A physical WebSocket has one transport purpose for its lifetime.
# Participant and infrastructure authentication stay orthogonal to this role.
# ---------------------------------------------------------------------------
replace_once(
    'src/server.ts',
    "type ClientRole = 'publisher' | 'monitor' | 'backing' | 'unknown';\n",
    "type ClientRole = 'publisher' | 'monitor' | 'backing' | 'playback' | 'unknown';\n",
)

replace_once(
    'src/server.ts',
    "function rejectInfrastructure(socket: RelaySocket, message: string) {\n"
    "  sendJson(socket, { type: 'infrastructure-auth-rejected', message });\n"
    "  socket.close(1008, 'Infrastructure authentication required.');\n"
    "}\n",
    "function rejectInfrastructure(socket: RelaySocket, message: string) {\n"
    "  sendJson(socket, { type: 'infrastructure-auth-rejected', message });\n"
    "  socket.close(1008, 'Infrastructure authentication required.');\n"
    "}\n\n"
    "type ClaimedClientRole = Exclude<ClientRole, 'unknown'>;\n\n"
    "/**\n"
    " * A WebSocket may bind exactly one transport purpose. Authentication says\n"
    " * who may use a transport; this role says what that physical transport is.\n"
    " * Reconnects therefore get a new WebSocket instead of morphing an existing\n"
    " * media/control socket while global authority pointers still reference it.\n"
    " */\n"
    "function canClaimSocketRole(socket: RelaySocket, requestedRole: ClaimedClientRole) {\n"
    "  if (socket.role === 'unknown' || socket.role === requestedRole) return true;\n"
    "  sendJson(socket, {\n"
    "    type: 'role-conflict',\n"
    "    currentRole: socket.role,\n"
    "    requestedRole,\n"
    "  });\n"
    "  return false;\n"
    "}\n\n"
    "function commitSocketRole(socket: RelaySocket, requestedRole: ClaimedClientRole) {\n"
    "  if (socket.role !== 'unknown' && socket.role !== requestedRole) {\n"
    "    throw new Error(`Cannot change WebSocket role from ${socket.role} to ${requestedRole}.`);\n"
    "  }\n"
    "  socket.role = requestedRole;\n"
    "}\n",
)

# A replaced transport is closing, not newly anonymous. Pointer equality already
# removes its authority; retaining its role prevents late messages from
# reclaiming a different purpose before the close handshake completes.
replace_once(
    'src/server.ts',
    "  previous.replaced = true;\n  previous.role = 'unknown';\n  sendJson(previous, { type: 'error', message });\n",
    "  previous.replaced = true;\n  sendJson(previous, { type: 'error', message });\n",
)
replace_once(
    'src/server.ts',
    "  previous.replaced = true;\n  previous.role = 'unknown';\n  sendJson(previous, { type, message });\n",
    "  previous.replaced = true;\n  sendJson(previous, { type, message });\n",
)

# Playback is a participant-bound control transport. Validate its identity
# before committing the role so malformed hello messages do not pin the socket.
replace_once(
    'src/server.ts',
    "    if (payload.type === 'playback-hello') {\n"
    "      if (!socket.participantId) return;\n"
    "      const transportId = normalizePlaybackTransportId(payload.playbackTransportId);\n",
    "    if (payload.type === 'playback-hello') {\n"
    "      if (!socket.participantId) return;\n"
    "      if (!canClaimSocketRole(socket, 'playback')) return;\n"
    "      const transportId = normalizePlaybackTransportId(payload.playbackTransportId);\n",
)
replace_once(
    'src/server.ts',
    "      if (!transportId || generation === null) {\n"
    "        sendJson(socket, { type: 'error', message: 'Invalid playback transport identity.' });\n"
    "        return;\n"
    "      }\n\n"
    "      socket.playbackParticipantId = socket.participantId;\n",
    "      if (!transportId || generation === null) {\n"
    "        sendJson(socket, { type: 'error', message: 'Invalid playback transport identity.' });\n"
    "        return;\n"
    "      }\n\n"
    "      commitSocketRole(socket, 'playback');\n"
    "      socket.playbackParticipantId = socket.participantId;\n",
)

# Publisher: reject a cross-role reuse before touching Mic ownership, but only
# commit the role after validation and lease acceptance. A malformed or busy
# publisher attempt therefore leaves an unknown socket reusable.
replace_once(
    'src/server.ts',
    "    if (payload.type === 'register' && payload.role === 'publisher') {\n"
    "      // A publisher is the microphone media authority. Browser clients must\n",
    "    if (payload.type === 'register' && payload.role === 'publisher') {\n"
    "      if (!canClaimSocketRole(socket, 'publisher')) return;\n"
    "      // A publisher is the microphone media authority. Browser clients must\n",
)
replace_once(
    'src/server.ts',
    "      let deferredOwnershipTimingReason: string | null = null;\n"
    "      let deferredHandoffParticipantId: string | null = null;\n",
    "      commitSocketRole(socket, 'publisher');\n\n"
    "      let deferredOwnershipTimingReason: string | null = null;\n"
    "      let deferredHandoffParticipantId: string | null = null;\n",
)
replace_once(
    'src/server.ts',
    "      socket.role = 'publisher';\n      socket.sampleRate = sampleRate;\n",
    "      socket.sampleRate = sampleRate;\n",
)

# Backing and Monitor get the same one-way role boundary after their existing
# infrastructure/participant authorization checks.
replace_once(
    'src/server.ts',
    "    if (payload.type === 'register' && payload.role === 'backing') {\n"
    "      if (!infrastructureAuthorized(socket)) {\n"
    "        rejectInfrastructure(socket, 'Authenticate Relay infrastructure before registering backing audio.');\n"
    "        return;\n"
    "      }\n"
    "      const sampleRate = validSampleRate(payload.sampleRate);\n",
    "    if (payload.type === 'register' && payload.role === 'backing') {\n"
    "      if (!infrastructureAuthorized(socket)) {\n"
    "        rejectInfrastructure(socket, 'Authenticate Relay infrastructure before registering backing audio.');\n"
    "        return;\n"
    "      }\n"
    "      if (!canClaimSocketRole(socket, 'backing')) return;\n"
    "      const sampleRate = validSampleRate(payload.sampleRate);\n",
)
replace_once(
    'src/server.ts',
    "      const previousBacking = backing;\n"
    "      if (previousBacking && previousBacking !== socket) {\n",
    "      commitSocketRole(socket, 'backing');\n"
    "      const previousBacking = backing;\n"
    "      if (previousBacking && previousBacking !== socket) {\n",
)
replace_once(
    'src/server.ts',
    "      socket.role = 'backing';\n      socket.sampleRate = sampleRate;\n",
    "      socket.sampleRate = sampleRate;\n",
)
replace_once(
    'src/server.ts',
    "    if (payload.type === 'register' && payload.role === 'monitor') {\n"
    "      if (!socket.participantId && !infrastructureAuthorized(socket)) {\n"
    "        rejectInfrastructure(socket, 'Monitor audio requires a Relay participant or infrastructure capability.');\n"
    "        return;\n"
    "      }\n"
    "      socket.role = 'monitor';\n",
    "    if (payload.type === 'register' && payload.role === 'monitor') {\n"
    "      if (!socket.participantId && !infrastructureAuthorized(socket)) {\n"
    "        rejectInfrastructure(socket, 'Monitor audio requires a Relay participant or infrastructure capability.');\n"
    "        return;\n"
    "      }\n"
    "      if (!canClaimSocketRole(socket, 'monitor')) return;\n"
    "      commitSocketRole(socket, 'monitor');\n",
)

Path('test/socket-role-authority.test.ts').write_text("""import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RelayClient,
  pulseTrain,
  sendPcmInChunks,
  sleep,
  startRelay,
  toInt16,
} from './helpers/harness.js';

const RATE = 48_000;
const INFRA_KEY = 'ab'.repeat(32);

function tone(seconds: number, gain = 0.6, seed = 5) {
  return toInt16(pulseTrain(Math.round(RATE * seconds), RATE, seed), gain);
}

async function waitForNewMessage(
  client: RelayClient,
  fromIndex: number,
  predicate: (message: Record<string, any>) => boolean,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = client.messages.slice(fromIndex).find(predicate);
    if (found) return found;
    await sleep(20);
  }
  throw new Error(
    `Timed out waiting for new message. Saw: ${client.messages.slice(fromIndex).map((m) => m.type).join(', ')}`,
  );
}

async function authenticateInfrastructure(client: RelayClient) {
  client.send({ type: 'infrastructure-authenticate', key: INFRA_KEY });
  await client.waitForType('infrastructure-authenticated');
}

test('a backing WebSocket cannot morph into a monitor and split readiness from PCM ingest', async () => {
  const server = await startRelay({
    RELAY_AUTO_CALIBRATE: '0',
    RELAY_HEARTBEAT_MS: '60000',
    RELAY_INFRA_KEY: INFRA_KEY,
    RELAY_TEST_LEGACY_INFRASTRUCTURE: '0',
  });
  try {
    const backing = await RelayClient.connect(server);
    await authenticateInfrastructure(backing);
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
    await backing.waitFor((message) => message.type === 'registered' && message.role === 'backing');

    const from = backing.messages.length;
    backing.send({ type: 'register', role: 'monitor' });
    const conflict = await waitForNewMessage(
      backing,
      from,
      (message) => message.type === 'role-conflict',
    );
    assert.equal(conflict.currentRole, 'backing');
    assert.equal(conflict.requestedRole, 'monitor');

    await sendPcmInChunks(backing, tone(0.35, 0.7));
    const status = await (await fetch(server.httpUrl('/statusz'))).json() as Record<string, any>;
    assert.equal(status.source.backingConnected, true);
    assert.equal(
      status.source.backingStreaming,
      true,
      'rejected role reuse must leave backing ingest and readiness on the same transport truth',
    );
    backing.close();
  } finally {
    await server.stop();
  }
});

test('a publisher WebSocket cannot become a monitor while the Mic pointer still references it', async () => {
  const server = await startRelay({ RELAY_AUTO_CALIBRATE: '0', RELAY_HEARTBEAT_MS: '60000' });
  try {
    const publisher = await RelayClient.connect(
      server,
      '?participant=participant-role-owner&name=RoleOwner',
    );
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await publisher.waitFor((message) => message.type === 'registered' && message.role === 'publisher');

    const from = publisher.messages.length;
    publisher.send({ type: 'register', role: 'monitor' });
    const conflict = await waitForNewMessage(
      publisher,
      from,
      (message) => message.type === 'role-conflict',
    );
    assert.equal(conflict.currentRole, 'publisher');
    assert.equal(conflict.requestedRole, 'monitor');

    await sendPcmInChunks(publisher, tone(0.35, 0.4));
    const status = await (await fetch(server.httpUrl('/statusz'))).json() as Record<string, any>;
    assert.equal(status.source.micConnected, true);
    assert.equal(status.source.micStreaming, true);
    publisher.close();
  } finally {
    await server.stop();
  }
});

test('a playback transport cannot be repurposed as a monitor', async () => {
  const server = await startRelay({ RELAY_AUTO_CALIBRATE: '0', RELAY_HEARTBEAT_MS: '60000' });
  try {
    const playback = await RelayClient.connect(
      server,
      '?participant=participant-playback-role&name=Playback',
    );
    playback.send({
      type: 'playback-hello',
      playbackTransportId: 'playback-role-test',
      playbackGeneration: 1,
    });
    await playback.waitForType('playback-registered');

    const from = playback.messages.length;
    playback.send({ type: 'register', role: 'monitor' });
    const conflict = await waitForNewMessage(
      playback,
      from,
      (message) => message.type === 'role-conflict',
    );
    assert.equal(conflict.currentRole, 'playback');
    assert.equal(conflict.requestedRole, 'monitor');
    playback.close();
  } finally {
    await server.stop();
  }
});

test('a rejected publisher attempt does not pin an otherwise reusable socket role', async () => {
  const server = await startRelay({ RELAY_AUTO_CALIBRATE: '0', RELAY_HEARTBEAT_MS: '60000' });
  try {
    const participant = await RelayClient.connect(
      server,
      '?participant=participant-invalid-role&name=Retry',
    );
    participant.send({ type: 'register', role: 'publisher', sampleRate: 3 });
    await participant.waitForType('error');

    participant.send({ type: 'register', role: 'monitor' });
    const registered = await participant.waitFor(
      (message) => message.type === 'registered' && message.role === 'monitor',
    );
    assert.equal(registered.role, 'monitor');
    participant.close();
  } finally {
    await server.stop();
  }
});
""")
