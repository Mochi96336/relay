import assert from 'node:assert/strict';
import test from 'node:test';

import { InfrastructureCapabilityRuntime } from '../src/infrastructure-capability-runtime.js';

type Socket = {
  participantId?: string;
  infrastructureAuthenticated?: boolean;
};

const KEY = 'ab'.repeat(32);

test('fails closed when no deployment infrastructure key is configured', () => {
  const runtime = new InfrastructureCapabilityRuntime<Socket>({ key: null });
  const socket: Socket = {};

  assert.equal(runtime.authenticate(socket, KEY), false);
  assert.equal(runtime.authenticated(socket), false);
  assert.equal(runtime.authorized(socket), false);
});

test('wrong capability does not authenticate the socket', () => {
  const runtime = new InfrastructureCapabilityRuntime<Socket>({ key: KEY });
  const socket: Socket = {};

  assert.equal(runtime.authenticate(socket, 'cd'.repeat(32)), false);
  assert.equal(runtime.authenticated(socket), false);
});

test('matching capability authenticates and authorizes the socket', () => {
  const runtime = new InfrastructureCapabilityRuntime<Socket>({ key: KEY });
  const socket: Socket = {};

  assert.equal(runtime.authenticate(socket, KEY), true);
  assert.equal(runtime.authenticated(socket), true);
  assert.equal(runtime.authorized(socket), true);
});

test('participant identity and infrastructure capability are mutually exclusive', () => {
  const runtime = new InfrastructureCapabilityRuntime<Socket>({ key: KEY });
  const participant: Socket = { participantId: 'participant-a' };

  assert.equal(runtime.authenticate(participant, KEY), false);
  assert.equal(runtime.authenticated(participant), false);
});

test('legacy test authorization does not mint real infrastructure authentication', () => {
  const runtime = new InfrastructureCapabilityRuntime<Socket>({
    key: KEY,
    legacyAuthorized: true,
  });
  const socket: Socket = {};

  assert.equal(runtime.authorized(socket), true);
  assert.equal(runtime.authenticated(socket), false);
});
