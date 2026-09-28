import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, startRelay } from './helpers/harness.js';

function negotiated(client: RelayClient) {
  return String((client as unknown as { socket: { extensions: string } }).socket.extensions);
}

test('only a socket that asks negotiates status compression, and only when Relay enables it', async () => {
  for (const enabled of [true, false]) {
    const server = await startRelay({ RELAY_STATUS_DEFLATE: enabled ? '1' : '0' });
    const clients: RelayClient[] = [];
    try {
      // The ws client offers permessage-deflate on every connection, as browsers do.
      const asking = await RelayClient.connect(server, '?compress=1');
      const plain = await RelayClient.connect(server);
      clients.push(asking, plain);

      assert.equal(
        negotiated(asking).includes('permessage-deflate'),
        enabled,
        `a socket that asks is compressed only when Relay enables it (enabled=${enabled})`,
      );
      assert.equal(negotiated(plain), '', 'a socket that does not ask is never compressed');

      for (const client of clients) {
        client.send({ type: 'source-status-request' });
        const status = await client.waitForType('source-status');
        assert.equal(status.type, 'source-status', 'status still arrives intact');
      }
    } finally {
      for (const client of clients) client.close();
      await server.stop();
    }
  }
});
