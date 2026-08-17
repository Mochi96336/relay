import assert from 'node:assert/strict';
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
