from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: {label}: expected one match, found {count}')
    target.write_text(text.replace(old, new, 1))


replace_once(
    'src/participant-capability.ts',
    """function legacyTestParticipantIdentityEnabled() {\n  return process.env.NODE_ENV === 'test'\n    && process.env.RELAY_TEST_LEGACY_PARTICIPANTS === '1';\n}\n""",
    """export function legacyTestParticipantIdentityEnabled() {\n  return process.env.NODE_ENV === 'test'\n    && process.env.RELAY_TEST_LEGACY_PARTICIPANTS === '1';\n}\n""",
    'expose explicit test-only legacy identity gate',
)

replace_once(
    'src/server.ts',
    """import { browserParticipantIdentity, participantCapabilityMatches } from './participant-capability.js';\n""",
    """import {\n  browserParticipantIdentity,\n  legacyTestParticipantIdentityEnabled,\n  participantCapabilityMatches,\n} from './participant-capability.js';\n""",
    'import test-only legacy identity gate',
)

replace_once(
    'src/server.ts',
    """    if (payload.type === 'register' && payload.role === 'publisher') {\n      const sampleRate = validSampleRate(payload.sampleRate);\n""",
    """    if (payload.type === 'register' && payload.role === 'publisher') {\n      // A publisher is the microphone media authority. Browser clients must\n      // authenticate that authority before registration; anonymous publishers\n      // remain available only to the explicitly enabled legacy test harness.\n      if (!socket.participantId && !legacyTestParticipantIdentityEnabled()) {\n        sendJson(socket, {\n          type: 'participant-auth-rejected',\n          message: 'Authenticate this Relay participant before registering the microphone.',\n        });\n        socket.close(1008, 'Participant authentication required.');\n        return;\n      }\n\n      const sampleRate = validSampleRate(payload.sampleRate);\n""",
    'require server-attached participant identity before publisher authority',
)

replace_once(
    'public/listen.js',
    """  function handleMessage(message) {\n    if (message.type === 'source-status') {\n      sourceSampleRate = Number(message.mixSampleRate ?? message.sampleRate) || MIX_SAMPLE_RATE;\n    }\n  }\n""",
    """  function handleMessage(message) {\n    if (message.type === 'session-status') {\n      // The monitor socket already receives authoritative room state. Consume it\n      // directly so feedback protection does not depend on the Presence socket\n      // being healthy in this tab.\n      applyRoomSessionStatus(message);\n      return;\n    }\n    if (message.type === 'source-status') {\n      sourceSampleRate = Number(message.mixSampleRate ?? message.sampleRate) || MIX_SAMPLE_RATE;\n    }\n  }\n""",
    'consume room Mic ownership on the Listen monitor socket',
)

Path('test/mic-boundary-hardening-server.test.ts').write_text("""import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { participantIdForCapability } from '../src/participant-capability.js';
import { RelayClient, sleep, startRelay } from './helpers/harness.js';

const RATE = 48_000;
const FAST = {
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_PROBE: '0',
  RELAY_HEARTBEAT_MS: '60000',
  RELAY_MIC_TRANSPORT_GRACE_MS: '500',
};

function pcm(ms = 40) {
  return Buffer.alloc(Math.round((RATE * ms) / 1000) * 2);
}

async function waitForNewMessage(
  client: RelayClient,
  startIndex: number,
  predicate: (message: Record<string, any>) => boolean,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = client.messages.slice(startIndex).find(predicate);
    if (found) return found;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for fresh message; saw ${client.messages.slice(startIndex).map((message) => message.type).join(', ')}`);
}

async function requestProduct(
  client: RelayClient,
  predicate: (message: Record<string, any>) => boolean,
) {
  const start = client.messages.length;
  client.send({ type: 'product-status-request' });
  return waitForNewMessage(
    client,
    start,
    (message) => message.type === 'product-status' && predicate(message),
  );
}

test('Listen consumes authoritative session status on its own monitor socket', () => {
  const source = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');
  assert.match(
    source,
    /function handleMessage\(message\) \{[\s\S]{0,500}message\.type === 'session-status'[\s\S]{0,300}applyRoomSessionStatus\(message\)/,
    'same-participant feedback mute must survive an independent Presence socket outage',
  );
});

test('production rejects microphone registration before participant authentication', async () => {
  const server = await startRelay({
    ...FAST,
    NODE_ENV: 'production',
    RELAY_TEST_LEGACY_PARTICIPANTS: '0',
  });
  try {
    const anonymous = await RelayClient.connect(server);
    anonymous.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    const rejected = await anonymous.waitForType('participant-auth-rejected');
    assert.match(String(rejected.message), /Authenticate this Relay participant/);
    await sleep(30);
    assert.equal(anonymous.latest('registered'), undefined);

    const capability = 'ab'.repeat(32);
    const participantId = participantIdForCapability(capability);
    assert.ok(participantId);

    const authenticated = await RelayClient.connect(server);
    authenticated.send({
      type: 'participant-authenticate',
      participantId,
      capability,
      nickname: 'Singer',
    });
    await authenticated.waitForType('participant-authenticated');
    authenticated.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    const registered = await authenticated.waitForType('registered');
    assert.equal(registered.role, 'publisher');
    authenticated.close();
  } finally {
    await server.stop();
  }
});

test('a connected Mic that never sends its first frame times out and recovers on real PCM', async () => {
  const server = await startRelay({
    ...FAST,
    RELAY_MIC_FIRST_FRAME_TIMEOUT_MS: '120',
  });
  try {
    const observer = await RelayClient.connect(server, '?participant=observer-first-frame&name=Observer');
    const singer = await RelayClient.connect(server, '?participant=singer-first-frame&name=Singer');
    singer.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await singer.waitForType('registered');

    const starting = await requestProduct(
      observer,
      (message) => message.room?.mic?.ownerId === 'singer-first-frame',
    );
    assert.equal(starting.room.mic.state, 'starting');
    assert.equal(starting.health, 'healthy');

    await sleep(180);
    const timedOut = await requestProduct(
      observer,
      (message) => message.room?.mic?.state === 'interrupted',
    );
    assert.equal(timedOut.health, 'degraded');
    assert.equal(timedOut.attention?.code, 'mic-audio-stalled');

    const statusResponse = await fetch(server.httpUrl('/statusz'));
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json() as any;
    assert.equal(status.ok, false);
    assert.equal(status.state, 'fault');
    assert.ok(status.faults.some((fault: string) => /first audio frame/.test(fault)));

    singer.sendPcm(pcm());
    await sleep(40);
    const recovered = await requestProduct(
      observer,
      (message) => message.room?.mic?.state === 'live',
    );
    assert.equal(recovered.health, 'healthy');
    assert.equal(recovered.attention, null);

    observer.close();
    singer.close();
  } finally {
    await server.stop();
  }
});
""")
