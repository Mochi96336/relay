import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';
import { playingRoomSong } from './support/client-commands.js';

function timelineStatusesSince(client: RelayClient, from: number) {
  return client.messages.slice(from).filter((message) => message.type === 'youtube-timeline-status').length;
}

test('the room timeline goes out once per telemetry packet, and the timer covers a quiet leader', async () => {
  const server = await startRelay();
  const clients: RelayClient[] = [];
  try {
    const publisher = await RelayClient.connectAs(server, 'singer', 'Singer');
    const observer = await RelayClient.connect(server);
    clients.push(publisher, observer);
    publisher.send({ type: 'register', role: 'publisher', sampleRate: 48_000 });
    await publisher.waitForType('registered');

    const songTelemetry = await playingRoomSong(publisher);
    await sleep(500);

    // A leader sampling faster than the timer: every refresh is already a
    // fresh snapshot, so the timer must not add copies of its own.
    const whilePlayingFrom = observer.messages.length;
    const packets = 10;
    for (let packet = 1; packet <= packets; packet += 1) {
      publisher.send(songTelemetry());
      await sleep(200);
    }
    const whilePlaying = timelineStatusesSince(observer, whilePlayingFrom);
    assert.ok(
      whilePlaying >= packets - 1 && whilePlaying <= packets + 1,
      `${packets} telemetry packets produced ${whilePlaying} timeline broadcasts`,
    );

    // A leader that goes quiet still leaves the room with a moving clock.
    const quietFrom = observer.messages.length;
    await sleep(1_000);
    assert.ok(
      timelineStatusesSince(observer, quietFrom) >= 3,
      'the 250 ms timer keeps the timeline going without telemetry',
    );
  } finally {
    for (const client of clients) client.close();
    await server.stop();
  }
});
