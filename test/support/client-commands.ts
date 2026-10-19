import { type RelayClient, waitForNewMessage } from '../helpers/harness.js';

/** Registers `client` as a playback tab and waits until Relay confirms it. */
export async function registerPlayback(client: RelayClient, transportId: string, generation = 1) {
  client.send({
    type: 'playback-hello',
    playbackTransportId: transportId,
    playbackGeneration: generation,
  });
  await client.waitFor((message) => (
    message.type === 'playback-registered'
    && message.playbackTransportId === transportId
    && message.playbackGeneration === generation
  ));
}

/** Asks for product status and waits for one that satisfies `predicate`. */
export async function requestProductStatus(
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
