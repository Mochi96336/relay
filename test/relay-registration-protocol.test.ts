import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayRegistrationProtocol } from '../src/relay-registration-protocol.js';

test('registration protocol selects known roles and leaves authority to handlers', () => {
  const calls: Array<{ role: string; socket: string; payload: Record<string, unknown> }> = [];
  const protocol = createRelayRegistrationProtocol<string>({
    publisher: (socket, payload) => calls.push({ role: 'publisher', socket, payload }),
    backing: (socket, payload) => calls.push({ role: 'backing', socket, payload }),
    monitor: (socket, payload) => calls.push({ role: 'monitor', socket, payload }),
  });

  assert.equal(protocol.dispatch('publisher-socket', { type: 'register', role: 'publisher', sampleRate: 48_000 }), true);
  assert.equal(protocol.dispatch('backing-socket', { type: 'register', role: 'backing', robot: true }), true);
  assert.equal(protocol.dispatch('monitor-socket', { type: 'register', role: 'monitor', monitorPacketVersion: 1 }), true);

  assert.deepEqual(calls.map(({ role, socket }) => ({ role, socket })), [
    { role: 'publisher', socket: 'publisher-socket' },
    { role: 'backing', socket: 'backing-socket' },
    { role: 'monitor', socket: 'monitor-socket' },
  ]);
  assert.equal(calls[0]?.payload.sampleRate, 48_000);
  assert.equal(calls[1]?.payload.robot, true);
  assert.equal(calls[2]?.payload.monitorPacketVersion, 1);
});

test('registration protocol ignores non-registration and unknown registration roles', () => {
  let called = false;
  const protocol = createRelayRegistrationProtocol<string>({
    publisher: () => { called = true; },
    backing: () => { called = true; },
    monitor: () => { called = true; },
  });

  assert.equal(protocol.dispatch('socket', { type: 'status' }), false);
  assert.equal(protocol.dispatch('socket', { type: 'register', role: 'unknown' }), false);
  assert.equal(protocol.dispatch('socket', { type: 'register' }), false);
  assert.equal(called, false);
});
