import { RelayClient, sleep, type RelayServer, toInt16 } from '../helpers/harness.js';
import { playRoomSong, registerPlayback } from './client-commands.js';

const RATE = 48_000;

/**
 * A Relay room with a Robot backing, a Mic publisher that also plays the room
 * Song, the Robot control and a monitor.
 */
export type RobotRoom = {
  backing: RelayClient;
  publisher: RelayClient;
  robot: RelayClient;
  monitor: RelayClient;
  close: () => void;
};

export async function robotRoom(server: RelayServer): Promise<RobotRoom> {
  const backing = await RelayClient.connectInfrastructure(server);
  backing.send({ type: 'register', role: 'backing', sampleRate: RATE, robot: true });
  await backing.waitForType('registered');

  const publisher = await RelayClient.connectAs(server, 'singer', 'Singer');
  publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
  await publisher.waitForType('registered');

  const robot = await RelayClient.connectInfrastructure(server);
  robot.send({ type: 'robot-source-hello' });

  const monitor = await RelayClient.connectAs(server, 'listener', 'Listener');
  monitor.send({ type: 'register', role: 'monitor' });
  await monitor.waitForType('registered');

  await registerPlayback(publisher, 'robot-room-playback');
  await playRoomSong(publisher, { positionSeconds: 42 });

  return {
    backing,
    publisher,
    robot,
    monitor,
    close() {
      monitor.close();
      robot.close();
      publisher.close();
      backing.close();
    },
  };
}

export function backingBoundaryRequestCount(backing: RelayClient) {
  return backing.messages.filter((message) => message.type === 'backing-sample-boundary-request').length;
}

export async function waitForTimingStatus(
  monitor: RelayClient,
  predicate: (status: Record<string, any>) => boolean,
  timeoutMs: number,
  from = monitor.messages.length,
) {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, any> | undefined;
  while (Date.now() < deadline) {
    monitor.send({ type: 'timing-calibration-status-request' });
    await sleep(50);
    const statuses = monitor.messages
      .slice(from)
      .filter((message) => message.type === 'timing-calibration-status');
    last = statuses.at(-1) ?? last;
    const match = statuses.find(predicate);
    if (match) return match;
  }
  throw new Error(`Timed out waiting for timing status. Last=${JSON.stringify(last ?? null)}`);
}

/**
 * The first offset rides the Robot's own socket, so Relay can read half a
 * second or more of the Backing and Mic sockets' PCM before it. Content
 * evidence only counts once that mapping exists: sent any earlier, 7 s of
 * audio can come up one frame short of a 6 s calibration window, and nothing
 * arrives afterwards to finish it.
 */
export async function waitForRobotMapping(monitor: RelayClient) {
  await waitForTimingStatus(monitor, (status) => status.robotDeltaFresh === true, 2_000);
}

/** Answers the next backing sample boundary request after `previousCount`, as the Robot does. */
export async function acknowledgeNextBackingBoundary(backing: RelayClient, previousCount: number) {
  const deadline = Date.now() + 2_000;
  let request: Record<string, any> | undefined;
  while (!request && Date.now() < deadline) {
    request = backing.messages
      .filter((message) => message.type === 'backing-sample-boundary-request')[previousCount];
    if (!request) await sleep(10);
  }
  if (!request) throw new Error('Relay never requested a fresh backing sample boundary.');

  backing.send({
    type: 'backing-sample-boundary',
    requestId: request.requestId,
    generation: backing.generationId,
    firstSampleIndex: backing.cursor,
  });
  await sleep(20);
}

const FRAME_SAMPLES = Math.round(RATE * 0.02);

/**
 * The backing of a Robot whose path lags the Mic by `pathLagMs` (plus each
 * call's `deltaMs`): makeBackingFrame cuts the master where the Robot is
 * playing it, and sendRange streams it beside the Mic in 20 ms frames.
 */
export function laggedBacking(pathLagMs: number) {
  function makeBackingFrame(
    master: Float64Array,
    startSample: number,
    endSample: number,
    deltaMs: number,
  ) {
    const advanceSamples = Math.round((RATE * (pathLagMs + deltaMs)) / 1_000);
    return toInt16(
      master.subarray(startSample + advanceSamples, endSample + advanceSamples),
      0.9,
    );
  }

  async function sendRange(
    room: RobotRoom,
    mic: Buffer,
    master: Float64Array,
    startSample: number,
    endSample: number,
    deltaMs: number,
  ) {
    let frames = 0;
    for (let start = startSample; start < endSample; start += FRAME_SAMPLES) {
      const end = Math.min(endSample, start + FRAME_SAMPLES);
      room.backing.sendPcm(makeBackingFrame(master, start, end, deltaMs));
      room.publisher.sendPcm(mic.subarray(start * 2, end * 2));
      frames += 1;
      if (frames % 25 === 0) await sleep(0);
    }
  }

  return { makeBackingFrame, sendRange };
}
