import { RelayClient, startRelay, waitForNewMessage } from '../helpers/harness.js';
import { registerPlayback } from './client-commands.js';

export const sampleSongVideoId = 'dQw4w9WgXcQ';
const videoId = sampleSongVideoId;

/**
 * A room with a phone that holds the Mic and plays the song, a Robot backing
 * capture and a Robot source: everything the sample/song fallback listens to.
 */
export async function joinSampleSongRoom(server: Awaited<ReturnType<typeof startRelay>>, clients: RelayClient[]) {
  const phone = await RelayClient.connectAs(server, 'sample-song-phone', 'Phone'); clients.push(phone);
  phone.send({ type: 'register', role: 'publisher', sampleRate: 48000, captureGeneration: 1 });
  await phone.waitForType('registered');
  await registerPlayback(phone, 'sample-song-player');
  const telemetry = (state: number, time: number, captureAnchor?: unknown) => phone.send({
    type: 'youtube-telemetry', videoId, state, currentTime: time, duration: 200, playbackRate: 1,
    playbackTransportId: 'sample-song-player', playbackGeneration: 1, networkRttMs: 40, captureAnchor,
  });
  phone.send({ type: 'room-song-command', commandId: 'sample-load', expectedRevision: 0, action: 'load', videoId, positionSeconds: 0 });
  await phone.waitFor(m => m.type === 'room-song-command-apply' && m.commandId === 'sample-load');
  telemetry(5, 0);
  await phone.waitFor(m => m.type === 'room-song-command-complete' && m.commandId === 'sample-load');
  phone.send({ type: 'room-song-command', commandId: 'sample-play', expectedRevision: 1, action: 'play' });
  await phone.waitFor(m => m.type === 'room-song-command-apply' && m.commandId === 'sample-play');
  telemetry(1, 0);
  await phone.waitFor(m => m.type === 'room-song-command-complete' && m.commandId === 'sample-play');
  const backing = await RelayClient.connectInfrastructure(server); clients.push(backing);
  backing.send({ type: 'register', role: 'backing', sampleRate: 48000, robot: true });
  await backing.waitForType('registered');
  const robot = await RelayClient.connectInfrastructure(server); clients.push(robot);
  robot.send({ type: 'robot-source-hello' });
  async function status() {
    const from = phone.messages.length;
    phone.send({ type: 'timing-calibration-status-request' });
    return waitForNewMessage(phone, from, m => m.type === 'timing-calibration-status');
  }
  return { phone, backing, robot, telemetry, status };
}
