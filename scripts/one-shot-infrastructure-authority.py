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
# Server: infrastructure is a separate authenticated socket class.
# ---------------------------------------------------------------------------
replace_once(
    'src/server.ts',
    "const relayKey = process.env.RELAY_KEY ?? null;\n",
    "const relayKey = process.env.RELAY_KEY ?? null;\n"
    "const rawInfrastructureKey = process.env.RELAY_INFRA_KEY?.trim() ?? '';\n"
    "if (rawInfrastructureKey && !/^[0-9a-f]{64}$/.test(rawInfrastructureKey)) {\n"
    "  throw new Error('RELAY_INFRA_KEY must be a 64-character lowercase hexadecimal secret.');\n"
    "}\n"
    "const infrastructureKey = rawInfrastructureKey || null;\n",
)

replace_once(
    'src/server.ts',
    "  telemetryRejectedReason?: string;\n};\n",
    "  telemetryRejectedReason?: string;\n"
    "  infrastructureAuthenticated?: boolean;\n};\n",
)

replace_once(
    'src/server.ts',
    "function sendJson(socket: WebSocket, payload: unknown) {\n"
    "  if (socket.readyState === WebSocket.OPEN) {\n"
    "    socket.send(JSON.stringify(payload));\n"
    "  }\n"
    "}\n",
    "function sendJson(socket: WebSocket, payload: unknown) {\n"
    "  if (socket.readyState === WebSocket.OPEN) {\n"
    "    socket.send(JSON.stringify(payload));\n"
    "  }\n"
    "}\n\n"
    "function legacyTestInfrastructureEnabled() {\n"
    "  return process.env.NODE_ENV === 'test'\n"
    "    && process.env.RELAY_TEST_LEGACY_INFRASTRUCTURE === '1';\n"
    "}\n\n"
    "function infrastructureAuthorized(socket: RelaySocket) {\n"
    "  return socket.infrastructureAuthenticated === true || legacyTestInfrastructureEnabled();\n"
    "}\n\n"
    "function rejectInfrastructure(socket: RelaySocket, message: string) {\n"
    "  sendJson(socket, { type: 'infrastructure-auth-rejected', message });\n"
    "  socket.close(1008, 'Infrastructure authentication required.');\n"
    "}\n",
)

replace_once(
    'src/server.ts',
    "function attachParticipantIdentity(\n"
    "  socket: RelaySocket,\n"
    "  identity: Extract<ParticipantIdentityResult, { kind: 'valid' }>,\n"
    ") {\n"
    "  if (socket.participantId) return socket.participantId === identity.participantId;\n",
    "function attachParticipantIdentity(\n"
    "  socket: RelaySocket,\n"
    "  identity: Extract<ParticipantIdentityResult, { kind: 'valid' }>,\n"
    ") {\n"
    "  if (socket.infrastructureAuthenticated === true) return false;\n"
    "  if (socket.participantId) return socket.participantId === identity.participantId;\n",
)

replace_once(
    'src/server.ts',
    "    if (payload.type === 'participant-authenticate') {\n"
    "      const authenticated = participantIdentityFromMessage(payload);\n"
    "      if (\n"
    "        authenticated.kind !== 'valid'\n"
    "        || (socket.participantId !== undefined && socket.participantId !== authenticated.participantId)\n"
    "      ) {\n",
    "    if (payload.type === 'infrastructure-authenticate') {\n"
    "      if (\n"
    "        socket.participantId !== undefined\n"
    "        || !infrastructureKey\n"
    "        || payload.key !== infrastructureKey\n"
    "      ) {\n"
    "        rejectInfrastructure(\n"
    "          socket,\n"
    "          'Infrastructure capability did not match this Relay deployment.',\n"
    "        );\n"
    "        return;\n"
    "      }\n"
    "      socket.infrastructureAuthenticated = true;\n"
    "      sendJson(socket, { type: 'infrastructure-authenticated' });\n"
    "      return;\n"
    "    }\n\n"
    "    if (payload.type === 'participant-authenticate') {\n"
    "      const authenticated = participantIdentityFromMessage(payload);\n"
    "      if (\n"
    "        authenticated.kind !== 'valid'\n"
    "        || socket.infrastructureAuthenticated === true\n"
    "        || (socket.participantId !== undefined && socket.participantId !== authenticated.participantId)\n"
    "      ) {\n",
)

replace_once(
    'src/server.ts',
    "    if (payload.type === 'source-seeked') {\n"
    "      // `isRobotSource` is intentionally tri-state here: undefined means this\n",
    "    if (payload.type === 'source-seeked') {\n"
    "      if (!infrastructureAuthorized(socket)) {\n"
    "        rejectInfrastructure(socket, 'Authenticate the active Source before reporting a seek.');\n"
    "        return;\n"
    "      }\n"
    "      // `isRobotSource` is intentionally tri-state here: undefined means this\n",
)

replace_once(
    'src/server.ts',
    "    if (payload.type === 'register' && payload.role === 'backing') {\n"
    "      const sampleRate = validSampleRate(payload.sampleRate);\n",
    "    if (payload.type === 'register' && payload.role === 'backing') {\n"
    "      if (!infrastructureAuthorized(socket)) {\n"
    "        rejectInfrastructure(socket, 'Authenticate Relay infrastructure before registering backing audio.');\n"
    "        return;\n"
    "      }\n"
    "      const sampleRate = validSampleRate(payload.sampleRate);\n",
)

replace_once(
    'src/server.ts',
    "    if (payload.type === 'register' && payload.role === 'monitor') {\n"
    "      socket.role = 'monitor';\n",
    "    if (payload.type === 'register' && payload.role === 'monitor') {\n"
    "      if (!socket.participantId && !infrastructureAuthorized(socket)) {\n"
    "        rejectInfrastructure(socket, 'Monitor audio requires a Relay participant or infrastructure capability.');\n"
    "        return;\n"
    "      }\n"
    "      socket.role = 'monitor';\n",
)

replace_once(
    'src/server.ts',
    "    if (payload.type === 'robot-source-hello') {\n"
    "      if (activeRobotSource === socket) return;\n",
    "    if (payload.type === 'robot-source-hello') {\n"
    "      if (!infrastructureAuthorized(socket)) {\n"
    "        rejectInfrastructure(socket, 'Authenticate Relay infrastructure before becoming the Robot source.');\n"
    "        return;\n"
    "      }\n"
    "      if (activeRobotSource === socket) return;\n",
)

# ---------------------------------------------------------------------------
# Test harness: old fixture clients stay available only under an explicit test gate.
# ---------------------------------------------------------------------------
replace_once(
    'test/helpers/harness.ts',
    "        RELAY_TEST_LEGACY_PARTICIPANTS: '1',\n"
    "        ...env,\n",
    "        RELAY_TEST_LEGACY_PARTICIPANTS: '1',\n"
    "        RELAY_TEST_LEGACY_INFRASTRUCTURE: '1',\n"
    "        ...env,\n",
)

# ---------------------------------------------------------------------------
# Node backing bridge: authenticate first, register only after server ack.
# ---------------------------------------------------------------------------
replace_once(
    'src/backing-stdin.ts',
    "const ROBOT_BACKING = process.env.RELAY_BACKING_ROBOT === '1';\n",
    "const ROBOT_BACKING = process.env.RELAY_BACKING_ROBOT === '1';\n"
    "const INFRASTRUCTURE_KEY = process.env.RELAY_INFRA_KEY?.trim() ?? '';\n",
)

replace_once(
    'src/backing-stdin.ts',
    "if (process.argv.includes('--help')) {\n"
    "  process.stdout.write(`Relay robot backing source\\n\\nReads raw mono signed 16-bit little-endian PCM from stdin and forwards it\\nto Relay as the normal framed \\\"backing\\\" source.\\n\\nEnvironment:\\n  RELAY_URL                         WebSocket URL (default ws://127.0.0.1:3000/ws)\\n  RELAY_KEY                         optional shared Relay key\\n",
    "if (process.argv.includes('--help')) {\n"
    "  process.stdout.write(`Relay robot backing source\\n\\nReads raw mono signed 16-bit little-endian PCM from stdin and forwards it\\nto Relay as the normal framed \\\"backing\\\" source.\\n\\nEnvironment:\\n  RELAY_URL                         WebSocket URL (default ws://127.0.0.1:3000/ws)\\n  RELAY_KEY                         optional shared Relay key\\n  RELAY_INFRA_KEY                   64-hex infrastructure capability (required)\\n",
)

replace_once(
    'src/backing-stdin.ts',
    "  process.exit(0);\n}\n\nconst generation = randomBytes(4).readUInt32LE(0);\n",
    "  process.exit(0);\n}\n\n"
    "if (!/^[0-9a-f]{64}$/.test(INFRASTRUCTURE_KEY)) {\n"
    "  throw new Error('RELAY_INFRA_KEY must be set to a 64-character lowercase hexadecimal secret.');\n"
    "}\n\n"
    "const generation = randomBytes(4).readUInt32LE(0);\n",
)

replace_once(
    'src/backing-stdin.ts',
    "  next.on('open', () => {\n"
    "    if (socket !== next) return;\n"
    "    next.send(JSON.stringify({\n"
    "      type: 'register',\n"
    "      role: 'backing',\n"
    "      sampleRate: SAMPLE_RATE,\n"
    "      robot: ROBOT_BACKING,\n"
    "    }));\n"
    "  });\n",
    "  next.on('open', () => {\n"
    "    if (socket !== next) return;\n"
    "    next.send(JSON.stringify({\n"
    "      type: 'infrastructure-authenticate',\n"
    "      key: INFRASTRUCTURE_KEY,\n"
    "    }));\n"
    "  });\n",
)

replace_once(
    'src/backing-stdin.ts',
    "    if (message.type === 'registered' && message.role === 'backing') {\n",
    "    if (message.type === 'infrastructure-authenticated') {\n"
    "      next.send(JSON.stringify({\n"
    "        type: 'register',\n"
    "        role: 'backing',\n"
    "        sampleRate: SAMPLE_RATE,\n"
    "        robot: ROBOT_BACKING,\n"
    "      }));\n"
    "      return;\n"
    "    }\n\n"
    "    if (message.type === 'infrastructure-auth-rejected') {\n"
    "      log(`Relay infrastructure authentication failed: ${String(message.message ?? 'unknown error')}`);\n"
    "      reportState if False else None\n"
    "      return;\n"
    "    }\n\n"
    "    if (message.type === 'registered' && message.role === 'backing') {\n",
)

# Remove the deliberately impossible Python-looking sentinel emitted above; it
# makes the replacement anchor obvious while keeping the resulting TS simple.
replace_once(
    'src/backing-stdin.ts',
    "      reportState if False else None\n",
    "",
)

# ---------------------------------------------------------------------------
# Browser Source: capability lives in the URL fragment, never the request URL.
# ---------------------------------------------------------------------------
replace_once(
    'public/source.js',
    "const ROBOT_MODE = new URLSearchParams(location.search).get('robot') === '1';\n",
    "const ROBOT_MODE = new URLSearchParams(location.search).get('robot') === '1';\n"
    "const INFRASTRUCTURE_KEY = new URLSearchParams(location.hash.slice(1)).get('infra') ?? '';\n",
)

replace_once(
    'public/source.js',
    "    if (ROBOT_MODE) send({ type: 'robot-source-hello' });\n"
    "    send({ type: 'youtube-timeline-request' });\n",
    "    if (INFRASTRUCTURE_KEY) {\n"
    "      send({ type: 'infrastructure-authenticate', key: INFRASTRUCTURE_KEY });\n"
    "    } else if (ROBOT_MODE) {\n"
    "      timingStatus.textContent = 'Robot Source 缺少 RELAY_INFRA_KEY；不會取得來源控制權。';\n"
    "    }\n"
    "    send({ type: 'youtube-timeline-request' });\n",
)

replace_once(
    'public/source.js',
    "    if (message.type === 'robot-source-replaced') {\n",
    "    if (message.type === 'infrastructure-authenticated') {\n"
    "      if (ROBOT_MODE) send({ type: 'robot-source-hello' });\n"
    "      return;\n"
    "    }\n\n"
    "    if (message.type === 'infrastructure-auth-rejected') {\n"
    "      timingStatus.textContent = message.message ?? 'Infrastructure authentication failed.';\n"
    "      return;\n"
    "    }\n\n"
    "    if (message.type === 'robot-source-replaced') {\n",
)

# ---------------------------------------------------------------------------
# Chrome offscreen backing: read the same fragment from the captured source tab.
# ---------------------------------------------------------------------------
replace_once(
    'chrome-tab-audio-probe/offscreen.js',
    "function relayWsUrl(pageUrl) {\n"
    "  const url = new URL(pageUrl);\n"
    "  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';\n"
    "  const key = url.searchParams.get('key');\n"
    "  const query = key ? `?key=${encodeURIComponent(key)}` : '';\n"
    "  return `${protocol}//${url.host}/ws${query}`;\n"
    "}\n",
    "function relayWsUrl(pageUrl) {\n"
    "  const url = new URL(pageUrl);\n"
    "  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';\n"
    "  const key = url.searchParams.get('key');\n"
    "  const query = key ? `?key=${encodeURIComponent(key)}` : '';\n"
    "  return `${protocol}//${url.host}/ws${query}`;\n"
    "}\n\n"
    "function relayInfrastructureKey(pageUrl) {\n"
    "  const url = new URL(pageUrl);\n"
    "  return new URLSearchParams(url.hash.slice(1)).get('infra') ?? '';\n"
    "}\n",
)

replace_once(
    'chrome-tab-audio-probe/offscreen.js',
    "  socket.addEventListener('open', () => {\n"
    "    if (relaySocket !== socket || !audioContext) return;\n"
    "    socket.send(JSON.stringify({\n"
    "      type: 'register',\n"
    "      role: 'backing',\n"
    "      sampleRate: audioContext.sampleRate,\n"
    "    }));\n"
    "  });\n",
    "  socket.addEventListener('open', () => {\n"
    "    if (relaySocket !== socket || !audioContext) return;\n"
    "    const infrastructureKey = relayInfrastructureKey(relayPageUrl);\n"
    "    if (!/^[0-9a-f]{64}$/.test(infrastructureKey)) {\n"
    "      console.error('Relay source page is missing a valid #infra= capability.');\n"
    "      reportState('error');\n"
    "      socket.close();\n"
    "      return;\n"
    "    }\n"
    "    socket.send(JSON.stringify({\n"
    "      type: 'infrastructure-authenticate',\n"
    "      key: infrastructureKey,\n"
    "    }));\n"
    "  });\n",
)

replace_once(
    'chrome-tab-audio-probe/offscreen.js',
    "    if (message.type === 'registered' && message.role === 'backing') {\n",
    "    if (message.type === 'infrastructure-authenticated') {\n"
    "      socket.send(JSON.stringify({\n"
    "        type: 'register',\n"
    "        role: 'backing',\n"
    "        sampleRate: audioContext.sampleRate,\n"
    "      }));\n"
    "      return;\n"
    "    }\n\n"
    "    if (message.type === 'infrastructure-auth-rejected') {\n"
    "      console.error('Relay rejected infrastructure capability:', message.message);\n"
    "      reportState('error');\n"
    "      return;\n"
    "    }\n\n"
    "    if (message.type === 'registered' && message.role === 'backing') {\n",
)

# ---------------------------------------------------------------------------
# Robot launcher: same env file feeds both server and route; browser gets a
# fragment so the secret is not sent in the HTTP request or access logs.
# ---------------------------------------------------------------------------
replace_once(
    'scripts/robot-source.sh',
    "[[ \"$CAPTURE_LATENCY_MS\" =~ ^[0-9]+$ ]] && ((10#$CAPTURE_LATENCY_MS >= 5 && 10#$CAPTURE_LATENCY_MS <= 2000)) \\\n  || die \"RELAY_BACKING_CAPTURE_LATENCY_MS must be an integer from 5 to 2000\"\n",
    "[[ \"$CAPTURE_LATENCY_MS\" =~ ^[0-9]+$ ]] && ((10#$CAPTURE_LATENCY_MS >= 5 && 10#$CAPTURE_LATENCY_MS <= 2000)) \\\n  || die \"RELAY_BACKING_CAPTURE_LATENCY_MS must be an integer from 5 to 2000\"\n"
    "[[ \"${RELAY_INFRA_KEY:-}\" =~ ^[0-9a-f]{64}$ ]] \\\n  || die \"RELAY_INFRA_KEY must be a 64-character lowercase hexadecimal secret\"\n",
)

replace_once(
    'scripts/robot-source.sh',
    "if [[ -n \"${RELAY_KEY:-}\" ]]; then\n"
    "  encoded_key=\"$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' \"$RELAY_KEY\")\"\n"
    "  source_url+=\"&key=$encoded_key\"\n"
    "fi\n",
    "if [[ -n \"${RELAY_KEY:-}\" ]]; then\n"
    "  encoded_key=\"$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' \"$RELAY_KEY\")\"\n"
    "  source_url+=\"&key=$encoded_key\"\n"
    "fi\n"
    "encoded_infra_key=\"$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' \"$RELAY_INFRA_KEY\")\"\n"
    "source_url+=\"#infra=$encoded_infra_key\"\n",
)

# ---------------------------------------------------------------------------
# Deployment docs.
# ---------------------------------------------------------------------------
replace_once(
    'ROBOT_DEPLOYMENT.md',
    "The port is not part of that contract. Relay defaults to `3000`; use another port when the host already reserves it.\n",
    "The port is not part of that contract. Relay defaults to `3000`; use another port when the host already reserves it.\n\n"
    "Robot/backing authority is protected by a separate `RELAY_INFRA_KEY`, not by the human participant capability and not by the shared outer `RELAY_KEY`. Generate one 256-bit value once (for example `openssl rand -hex 32`) and put it in `~/.config/relay/robot.env` so both checked-in user units inherit the same secret:\n\n"
    "```bash\nRELAY_INFRA_KEY=<64 lowercase hex characters>\n```\n\n"
    "The launcher passes this key to `source.html` in the URL **fragment** (`#infra=...`), which browsers do not send in HTTP requests or access logs. The backing bridge sends the same capability only after the WebSocket upgrade.\n",
)

replace_once(
    'ROBOT_DEPLOYMENT.md',
    "The backing bridge continues to accept `RELAY_URL`, `RELAY_KEY`, `RELAY_BACKING_SAMPLE_RATE`, and `RELAY_BACKING_FRAME_MS`; see `npm run backing:stdin -- --help`. ",
    "The backing bridge requires `RELAY_INFRA_KEY` and continues to accept `RELAY_URL`, `RELAY_KEY`, `RELAY_BACKING_SAMPLE_RATE`, and `RELAY_BACKING_FRAME_MS`; see `npm run backing:stdin -- --help`. ",
)

# ---------------------------------------------------------------------------
# Production regressions.
# ---------------------------------------------------------------------------
Path('test/infrastructure-authority.test.ts').write_text(r'''import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { participantIdForCapability } from '../src/participant-capability.js';
import { RelayClient, sleep, startRelay } from './helpers/harness.js';

const INFRA_KEY = 'cd'.repeat(32);
const OTHER_INFRA_KEY = 'ef'.repeat(32);

async function authenticateInfrastructure(client: RelayClient, key = INFRA_KEY) {
  client.send({ type: 'infrastructure-authenticate', key });
  return client.waitForType('infrastructure-authenticated');
}

async function productionRelay() {
  return startRelay({
    NODE_ENV: 'production',
    RELAY_TEST_LEGACY_INFRASTRUCTURE: '1',
    RELAY_TEST_LEGACY_PARTICIPANTS: '1',
    RELAY_INFRA_KEY: INFRA_KEY,
    RELAY_AUTO_CALIBRATE: '0',
    RELAY_CALIBRATION_PROBE: '0',
    RELAY_HEARTBEAT_MS: '60000',
  });
}

test('production infrastructure roles fail closed before infrastructure authentication', async () => {
  const relay = await productionRelay();
  try {
    for (const payload of [
      { type: 'register', role: 'backing', sampleRate: 48_000 },
      { type: 'register', role: 'monitor' },
      { type: 'robot-source-hello' },
      { type: 'source-seeked' },
    ]) {
      const client = await RelayClient.connect(relay);
      client.send(payload);
      const rejected = await client.waitForType('infrastructure-auth-rejected');
      assert.match(String(rejected.message), /authenticate|requires|capability/i);
      client.close();
    }
  } finally {
    await relay.stop();
  }
});

test('a human participant cannot promote its socket into backing authority', async () => {
  const relay = await productionRelay();
  try {
    const capability = 'ab'.repeat(32);
    const participantId = participantIdForCapability(capability);
    assert.ok(participantId);

    const participant = await RelayClient.connect(relay);
    participant.send({
      type: 'participant-authenticate',
      participantId,
      capability,
      nickname: 'Alice',
    });
    await participant.waitForType('participant-authenticated');

    participant.send({ type: 'register', role: 'monitor' });
    const monitor = await participant.waitForType('registered');
    assert.equal(monitor.role, 'monitor');

    participant.send({ type: 'register', role: 'backing', sampleRate: 48_000 });
    const rejected = await participant.waitForType('infrastructure-auth-rejected');
    assert.match(String(rejected.message), /infrastructure/i);
    participant.close();
  } finally {
    await relay.stop();
  }
});

test('the infrastructure capability authenticates backing and Robot source after upgrade', async () => {
  const relay = await productionRelay();
  try {
    const backing = await RelayClient.connect(relay);
    await authenticateInfrastructure(backing);
    backing.send({ type: 'register', role: 'backing', sampleRate: 48_000, robot: true });
    const registered = await backing.waitForType('registered');
    assert.equal(registered.role, 'backing');
    assert.equal(registered.robot, true);

    const robot = await RelayClient.connect(relay);
    await authenticateInfrastructure(robot);
    robot.send({ type: 'robot-source-hello' });
    robot.send({ type: 'robot-player-offset', offsetMs: 35 });

    const observer = await RelayClient.connect(relay);
    await authenticateInfrastructure(observer);
    observer.send({ type: 'register', role: 'monitor' });
    await observer.waitForType('registered');
    observer.send({ type: 'timing-calibration-status-request' });
    const status = await observer.waitForType('timing-calibration-status');
    assert.equal(Math.round(status.robotPlayerOffsetMs), 35);

    backing.close();
    robot.close();
    observer.close();
  } finally {
    await relay.stop();
  }
});

test('an anonymous socket cannot clear timing evidence with source-seeked', async () => {
  const relay = await productionRelay();
  try {
    const robot = await RelayClient.connect(relay);
    await authenticateInfrastructure(robot);
    robot.send({ type: 'robot-source-hello' });
    robot.send({ type: 'robot-player-offset', offsetMs: 35 });
    await sleep(30);

    const attacker = await RelayClient.connect(relay);
    attacker.send({ type: 'source-seeked' });
    await attacker.waitForType('infrastructure-auth-rejected');

    const observer = await RelayClient.connect(relay);
    await authenticateInfrastructure(observer);
    observer.send({ type: 'register', role: 'monitor' });
    await observer.waitForType('registered');
    observer.send({ type: 'timing-calibration-status-request' });
    const status = await observer.waitForType('timing-calibration-status');
    assert.equal(Math.round(status.robotPlayerOffsetMs), 35);

    attacker.close();
    robot.close();
    observer.close();
  } finally {
    await relay.stop();
  }
});

test('wrong infrastructure capability cannot replace an authenticated backing source', async () => {
  const relay = await productionRelay();
  try {
    const backing = await RelayClient.connect(relay);
    await authenticateInfrastructure(backing);
    backing.send({ type: 'register', role: 'backing', sampleRate: 48_000 });
    await backing.waitForType('registered');

    const attacker = await RelayClient.connect(relay);
    attacker.send({ type: 'infrastructure-authenticate', key: OTHER_INFRA_KEY });
    await attacker.waitForType('infrastructure-auth-rejected');

    backing.sendPcm(Buffer.alloc(960 * 2));
    await sleep(30);
    const observer = await RelayClient.connect(relay);
    await authenticateInfrastructure(observer);
    observer.send({ type: 'register', role: 'monitor' });
    await observer.waitForType('registered');
    observer.send({ type: 'source-status-request' });
    const source = await observer.waitForType('source-status');
    assert.equal(source.connected, true);

    attacker.close();
    backing.close();
    observer.close();
  } finally {
    await relay.stop();
  }
});

test('browser and launcher infrastructure capabilities stay out of request URLs', () => {
  const source = readFileSync('public/source.js', 'utf8');
  const offscreen = readFileSync('chrome-tab-audio-probe/offscreen.js', 'utf8');
  const launcher = readFileSync('scripts/robot-source.sh', 'utf8');
  const backing = readFileSync('src/backing-stdin.ts', 'utf8');

  assert.match(source, /location\.hash/);
  assert.match(source, /infrastructure-authenticate/);
  assert.doesNotMatch(source, /searchParams\.set\(['"]infra/);
  assert.match(offscreen, /url\.hash/);
  assert.match(offscreen, /infrastructure-authenticate/);
  assert.match(launcher, /#infra=/);
  assert.match(backing, /RELAY_INFRA_KEY/);
  assert.match(backing, /infrastructure-authenticated/);
});
''')
