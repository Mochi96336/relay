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

type RoomSongCommand = { commandId: string; expectedRevision: number; action: string } & Record<string, unknown>;

/**
 * Sends one room-song command from the playback tab it targets, answers its
 * apply with `telemetry`, and waits until Relay completes it.
 */
export async function completeRoomSongCommand(
  client: RelayClient,
  command: RoomSongCommand,
  telemetry: Record<string, unknown>,
) {
  client.send({ type: 'room-song-command', ...command });
  await client.waitFor((message) => (
    message.type === 'room-song-command-apply' && message.commandId === command.commandId
  ));
  client.send(telemetry);
  await client.waitFor((message) => (
    message.type === 'room-song-command-complete' && message.commandId === command.commandId
  ));
}

/**
 * Loads and plays a room Song through the command path, the way the product
 * does. `client` must already be a registered playback tab (registerPlayback);
 * telemetry it sends afterwards has to keep pace with the wall clock, or the
 * command gate reads it as a seek.
 */
export async function playRoomSong(
  client: RelayClient,
  { videoId = 'dQw4w9WgXcQ', positionSeconds = 10, prefix = 'room-song', expectedRevision = 0 } = {},
) {
  const telemetry = (state: number, currentTime: number) => ({
    type: 'youtube-telemetry',
    videoId,
    state,
    currentTime,
    duration: 200,
    playbackRate: 1,
    bufferedFraction: 0.8,
  });
  await completeRoomSongCommand(
    client,
    { commandId: `${prefix}-load`, expectedRevision, action: 'load', videoId, positionSeconds },
    telemetry(5, positionSeconds),
  );
  await completeRoomSongCommand(
    client,
    { commandId: `${prefix}-play`, expectedRevision: expectedRevision + 1, action: 'play' },
    telemetry(1, positionSeconds + 0.05),
  );
}

/**
 * Registers `client` as a playback tab, plays a room Song from it, and returns
 * the telemetry that tab keeps reporting while the Song plays: its position
 * moves with the wall clock from the moment Relay completed the play.
 */
export async function playingRoomSong(
  client: RelayClient,
  { transportId = 'room-song-playback', positionSeconds = 42 } = {},
) {
  await registerPlayback(client, transportId);
  await playRoomSong(client, { positionSeconds });
  const playingSinceMs = Date.now();
  return () => ({
    type: 'youtube-telemetry',
    videoId: 'dQw4w9WgXcQ',
    state: 1,
    currentTime: positionSeconds + 0.05 + (Date.now() - playingSinceMs) / 1_000,
    duration: 200,
    playbackRate: 1,
    bufferedFraction: 0.8,
    networkRttMs: 40,
  });
}
