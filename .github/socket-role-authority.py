from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: {label}: expected one match, found {count}')
    target.write_text(text.replace(old, new, 1))


# A WebSocket may bind one transport purpose for its lifetime. Participant
# identity remains orthogonal: presence sockets can stay `unknown`, but media,
# playback and Source transports cannot silently morph into each other.
replace_once(
    'src/server.ts',
    "type ClientRole = 'publisher' | 'monitor' | 'backing' | 'unknown';",
    "type ClientRole = 'publisher' | 'monitor' | 'backing' | 'playback' | 'source-control' | 'unknown';",
    'extend transport purpose roles',
)

replace_once(
    'src/server.ts',
    """function broadcastJson(payload: unknown) {
  const message = JSON.stringify(payload);
  for (const client of wss.clients) {
    const socket = client as RelaySocket;
    if (socket.readyState === WebSocket.OPEN) socket.send(message);
  }
}

type ParticipantIdentityResult =
""",
    """function broadcastJson(payload: unknown) {
  const message = JSON.stringify(payload);
  for (const client of wss.clients) {
    const socket = client as RelaySocket;
    if (socket.readyState === WebSocket.OPEN) socket.send(message);
  }
}

type ClaimedClientRole = Exclude<ClientRole, 'unknown'>;

/**
 * A physical WebSocket has one transport purpose for its lifetime.
 *
 * Participant identity is deliberately separate, but once a socket becomes a
 * publisher/backing/playback/monitor/Source transport it may not morph into a
 * different transport while global authority pointers still reference it.
 * Reconnects get a new WebSocket instead.
 */
function canClaimSocketRole(socket: RelaySocket, requestedRole: ClaimedClientRole) {
  if (socket.role === 'unknown' || socket.role === requestedRole) return true;
  sendJson(socket, {
    type: 'role-conflict',
    currentRole: socket.role,
    requestedRole,
  });
  return false;
}

function commitSocketRole(socket: RelaySocket, requestedRole: ClaimedClientRole) {
  if (socket.role !== 'unknown' && socket.role !== requestedRole) {
    throw new Error(`Cannot change WebSocket role from ${socket.role} to ${requestedRole}.`);
  }
  socket.role = requestedRole;
}

type ParticipantIdentityResult =
""",
    'add one-way socket role helpers',
)

# Superseded transports are closing, not anonymous reusable sockets. Keeping
# their old role prevents a late message from reclaiming another purpose before
# close completes; global pointer equality already removes their authority.
replace_once(
    'src/server.ts',
    """  previous.replaced = true;
  previous.role = 'unknown';
  sendJson(previous, { type: 'error', message });
""",
    """  previous.replaced = true;
  sendJson(previous, { type: 'error', message });
""",
    'keep replaced transport role immutable',
)
replace_once(
    'src/server.ts',
    """  previous.replaced = true;
  previous.role = 'unknown';
  sendJson(previous, { type, message });
""",
    """  previous.replaced = true;
  sendJson(previous, { type, message });
""",
    'keep retired publisher role immutable',
)

# Modern playback is its own transport purpose. Legacy telemetry sent by the
# anonymous publisher remains on the explicit publisher compatibility path.
replace_once(
    'src/server.ts',
    """    if (payload.type === 'playback-hello') {
      if (!socket.participantId) return;
      const transportId = normalizePlaybackTransportId(payload.playbackTransportId);
""",
    """    if (payload.type === 'playback-hello') {
      if (!socket.participantId) return;
      if (!canClaimSocketRole(socket, 'playback')) return;
      const transportId = normalizePlaybackTransportId(payload.playbackTransportId);
""",
    'preflight playback role',
)
replace_once(
    'src/server.ts',
    """      if (!transportId || generation === null) {
        sendJson(socket, { type: 'error', message: 'Invalid playback transport identity.' });
        return;
      }

      socket.playbackParticipantId = socket.participantId;
""",
    """      if (!transportId || generation === null) {
        sendJson(socket, { type: 'error', message: 'Invalid playback transport identity.' });
        return;
      }

      commitSocketRole(socket, 'playback');
      socket.playbackParticipantId = socket.participantId;
""",
    'commit playback role after validation',
)

# Publisher ownership must not mutate before a role conflict is rejected, but a
# malformed/busy publisher attempt must not pin an otherwise-unclaimed socket.
replace_once(
    'src/server.ts',
    """    if (payload.type === 'register' && payload.role === 'publisher') {
      // A publisher is the microphone media authority. Browser clients must
""",
    """    if (payload.type === 'register' && payload.role === 'publisher') {
      if (!canClaimSocketRole(socket, 'publisher')) return;
      // A publisher is the microphone media authority. Browser clients must
""",
    'preflight publisher role',
)
replace_once(
    'src/server.ts',
    """      const previousPublisher = publisher;
      const sameParticipantReplacement = Boolean(
""",
    """      commitSocketRole(socket, 'publisher');
      const previousPublisher = publisher;
      const sameParticipantReplacement = Boolean(
""",
    'commit publisher role after lease acceptance',
)
replace_once(
    'src/server.ts',
    """      socket.role = 'publisher';
      socket.sampleRate = sampleRate;
""",
    """      socket.sampleRate = sampleRate;
""",
    'remove handwritten publisher role mutation',
)

replace_once(
    'src/server.ts',
    """    if (payload.type === 'register' && payload.role === 'backing') {
      const sampleRate = validSampleRate(payload.sampleRate);
""",
    """    if (payload.type === 'register' && payload.role === 'backing') {
      if (!canClaimSocketRole(socket, 'backing')) return;
      const sampleRate = validSampleRate(payload.sampleRate);
""",
    'preflight backing role',
)
replace_once(
    'src/server.ts',
    """      const previousBacking = backing;
      if (previousBacking && previousBacking !== socket) {
""",
    """      commitSocketRole(socket, 'backing');
      const previousBacking = backing;
      if (previousBacking && previousBacking !== socket) {
""",
    'commit backing role after validation',
)
replace_once(
    'src/server.ts',
    """      socket.role = 'backing';
      socket.sampleRate = sampleRate;
""",
    """      socket.sampleRate = sampleRate;
""",
    'remove handwritten backing role mutation',
)

replace_once(
    'src/server.ts',
    """    if (payload.type === 'register' && payload.role === 'monitor') {
      socket.role = 'monitor';
      sendJson(socket, { type: 'registered', role: 'monitor' });
""",
    """    if (payload.type === 'register' && payload.role === 'monitor') {
      if (!canClaimSocketRole(socket, 'monitor')) return;
      commitSocketRole(socket, 'monitor');
      sendJson(socket, { type: 'registered', role: 'monitor' });
""",
    'make monitor role a one-way claim',
)

# The visible Source page gets an explicit transport purpose. Robot source is
# the same control transport plus a singleton active-Robot lease.
replace_once(
    'src/server.ts',
    """    if (payload.type === 'robot-source-hello') {
      if (activeRobotSource === socket) return;

      const previous = activeRobotSource;
""",
    """    if (payload.type === 'source-control-hello') {
      if (!canClaimSocketRole(socket, 'source-control')) return;
      commitSocketRole(socket, 'source-control');
      sendJson(socket, { type: 'source-control-registered' });
      return;
    }

    if (payload.type === 'robot-source-hello') {
      if (!canClaimSocketRole(socket, 'source-control')) return;
      commitSocketRole(socket, 'source-control');
      if (activeRobotSource === socket) return;

      const previous = activeRobotSource;
""",
    'claim Source control role',
)

replace_once(
    'src/server.ts',
    """    if (payload.type === 'source-seeked') {
      // `isRobotSource` is intentionally tri-state here: undefined means this
      // socket was never a Robot source, while true/false means it has entered
      // the Robot source lifecycle. Replacement clears the active flag to
      // false, but must not restore seek authority to that old socket.
      if (socket.isRobotSource !== undefined && socket !== activeRobotSource) return;
      sourceGeneration += 1;
""",
    """    if (payload.type === 'source-seeked') {
      // A seek invalidates room timing evidence, so it belongs only to the
      // Source control transport. While a Robot route exists, only its active
      // singleton may announce that discontinuity; a desktop Source socket or
      // a superseded Robot cannot erase the active Robot delta.
      if (socket.role !== 'source-control') return;
      if (activeRobotSource && socket !== activeRobotSource) return;
      if (socket.isRobotSource !== undefined && socket !== activeRobotSource) return;
      sourceGeneration += 1;
""",
    'fence source seek authority',
)

replace_once(
    'public/source.js',
    """    if (ROBOT_MODE) send({ type: 'robot-source-hello' });
    send({ type: 'youtube-timeline-request' });
""",
    """    send({ type: 'source-control-hello' });
    if (ROBOT_MODE) send({ type: 'robot-source-hello' });
    send({ type: 'youtube-timeline-request' });
""",
    'announce Source control purpose',
)

Path('test/socket-role-authority.test.ts').write_text("""import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const sourceJs = readFileSync(new URL('../public/source.js', import.meta.url), 'utf8');

function tone(seconds: number, gain = 0.6, seed = 5) {
  return toInt16(pulseTrain(Math.round(RATE * seconds), RATE, seed), gain);
}

async function freshStatus(server: Awaited<ReturnType<typeof startRelay>>) {
  const response = await fetch(server.httpUrl('/statusz'));
  return response.json() as Promise<Record<string, any>>;
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
  throw new Error(`Timed out waiting for new message; saw ${client.messages.slice(fromIndex).map((m) => m.type).join(', ')}`);
}

test('a backing WebSocket cannot morph into a monitor and silently stop ingesting PCM', async () => {
  const server = await startRelay({ RELAY_AUTO_CALIBRATE: '0', RELAY_HEARTBEAT_MS: '60000' });
  try {
    const transport = await RelayClient.connect(server);
    transport.send({ type: 'register', role: 'backing', sampleRate: RATE });
    await transport.waitFor((message) => message.type === 'registered' && message.role === 'backing');

    const from = transport.messages.length;
    transport.send({ type: 'register', role: 'monitor' });
    const conflict = await waitForNewMessage(
      transport,
      from,
      (message) => message.type === 'role-conflict',
    );
    assert.equal(conflict.currentRole, 'backing');
    assert.equal(conflict.requestedRole, 'monitor');

    await sendPcmInChunks(transport, tone(0.35, 0.7));
    const status = await freshStatus(server);
    assert.equal(status.source.backingConnected, true);
    assert.equal(status.source.backingStreaming, true, 'rejected role change must not split ingest from readiness');

    transport.close();
  } finally {
    await server.stop();
  }
});

test('playback transport purpose cannot be reused as a monitor', async () => {
  const server = await startRelay({ RELAY_AUTO_CALIBRATE: '0', RELAY_HEARTBEAT_MS: '60000' });
  try {
    const playback = await RelayClient.connect(server, '?participant=participant-playback&name=Playback');
    playback.send({
      type: 'playback-hello',
      playbackTransportId: 'playback-role-test',
      playbackGeneration: 1,
    });
    await playback.waitForType('playback-registered');

    const from = playback.messages.length;
    playback.send({ type: 'register', role: 'monitor' });
    const conflict = await waitForNewMessage(playback, from, (message) => message.type === 'role-conflict');
    assert.equal(conflict.currentRole, 'playback');
    assert.equal(conflict.requestedRole, 'monitor');
    playback.close();
  } finally {
    await server.stop();
  }
});

test('source-seeked requires an explicit Source control transport', async () => {
  const server = await startRelay({ RELAY_AUTO_CALIBRATE: '0', RELAY_HEARTBEAT_MS: '60000' });
  try {
    const robot = await RelayClient.connect(server);
    robot.send({ type: 'robot-source-hello' });
    robot.send({ type: 'robot-player-offset', offsetMs: 37 });
    await sleep(40);

    const observer = await RelayClient.connect(server);
    observer.send({ type: 'register', role: 'monitor' });
    await observer.waitFor((message) => message.type === 'registered' && message.role === 'monitor');
    observer.send({ type: 'source-seeked' });
    await sleep(40);
    observer.send({ type: 'timing-calibration-status-request' });
    const untouched = await observer.waitFor(
      (message) => message.type === 'timing-calibration-status' && Math.round(message.robotPlayerOffsetMs) === 37,
    );
    assert.equal(Math.round(untouched.robotPlayerOffsetMs), 37);

    const desktopSource = await RelayClient.connect(server);
    desktopSource.send({ type: 'source-control-hello' });
    await desktopSource.waitForType('source-control-registered');
    desktopSource.send({ type: 'source-seeked' });
    await sleep(40);
    observer.send({ type: 'timing-calibration-status-request' });
    const stillRobot = await observer.waitFor(
      (message) => message.type === 'timing-calibration-status' && Math.round(message.robotPlayerOffsetMs) === 37,
    );
    assert.equal(Math.round(stillRobot.robotPlayerOffsetMs), 37, 'desktop Source must not override an active Robot source');

    robot.send({ type: 'source-seeked' });
    await sleep(40);
    observer.send({ type: 'timing-calibration-status-request' });
    const cleared = await observer.waitFor(
      (message) => message.type === 'timing-calibration-status' && message.robotPlayerOffsetMs === null,
    );
    assert.equal(cleared.robotPlayerOffsetMs, null);

    desktopSource.close();
    observer.close();
    robot.close();
  } finally {
    await server.stop();
  }
});

test('Source page claims its control purpose before announcing Robot authority', () => {
  assert.match(
    sourceJs,
    /send\(\{ type: 'source-control-hello' \}\);\s*if \(ROBOT_MODE\) send\(\{ type: 'robot-source-hello' \}\)/,
  );
});
""")
