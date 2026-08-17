from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


def write_new(path: str, content: str) -> None:
    target = Path(path)
    if target.exists():
        raise SystemExit(f'{path}: expected file to be absent')
    target.write_text(content)


write_new('src/take-start-policy.ts', """import type { TakeLifecycle } from './take-session.js';

export type TakeStartBlockReason =
  | 'mix-not-active'
  | 'timing-calibration-active'
  | 'take-not-ready'
  | 'take-active';

export type TakeStartFacts = {
  sessionActive: boolean;
  timingCalibrationActive: boolean;
  songLoaded: boolean;
  voiceOnlyMicReady: boolean;
  roomBlocked: boolean;
  takeLifecycle: TakeLifecycle;
};

export type TakeStartDecision =
  | { ok: true }
  | { ok: false; reason: TakeStartBlockReason };

/**
 * Owns the room-level decision for whether a new Take may start.
 *
 * Participant authentication and storage/writer failures stay outside this
 * policy. A voice-only room deliberately ignores unused Robot/backing health;
 * once a Song is loaded, blocked product health makes the room unrecordable.
 */
export function decideTakeStart(facts: TakeStartFacts): TakeStartDecision {
  if (!facts.sessionActive) return { ok: false, reason: 'mix-not-active' };
  if (facts.timingCalibrationActive) {
    return { ok: false, reason: 'timing-calibration-active' };
  }
  if (!facts.songLoaded && !facts.voiceOnlyMicReady) {
    return { ok: false, reason: 'take-not-ready' };
  }
  if (facts.songLoaded && facts.roomBlocked) {
    return { ok: false, reason: 'take-not-ready' };
  }
  if (facts.takeLifecycle === 'recording' || facts.takeLifecycle === 'finalizing') {
    return { ok: false, reason: 'take-active' };
  }
  return { ok: true };
}
""")

write_new('test/take-start-policy.test.ts', """import assert from 'node:assert/strict';
import test from 'node:test';

import { decideTakeStart, type TakeStartFacts } from '../src/take-start-policy.js';

const READY: TakeStartFacts = {
  sessionActive: true,
  timingCalibrationActive: false,
  songLoaded: true,
  voiceOnlyMicReady: false,
  roomBlocked: false,
  takeLifecycle: 'idle',
};

test('Take start policy preserves server rejection precedence', () => {
  assert.deepEqual(
    decideTakeStart({
      ...READY,
      sessionActive: false,
      timingCalibrationActive: true,
      roomBlocked: true,
      takeLifecycle: 'recording',
    }),
    { ok: false, reason: 'mix-not-active' },
  );
  assert.deepEqual(
    decideTakeStart({ ...READY, timingCalibrationActive: true, roomBlocked: true }),
    { ok: false, reason: 'timing-calibration-active' },
  );
});

test('a voice-only Take requires a live Mic but ignores unused Robot health', () => {
  assert.deepEqual(
    decideTakeStart({ ...READY, songLoaded: false, voiceOnlyMicReady: false, roomBlocked: true }),
    { ok: false, reason: 'take-not-ready' },
  );
  assert.deepEqual(
    decideTakeStart({ ...READY, songLoaded: false, voiceOnlyMicReady: true, roomBlocked: true }),
    { ok: true },
  );
});

test('a Song Take follows blocked product health even when the mix is still alive', () => {
  assert.deepEqual(
    decideTakeStart({ ...READY, roomBlocked: true }),
    { ok: false, reason: 'take-not-ready' },
  );
});

test('recording and finalizing are the only Take lifecycles that block another start', () => {
  assert.deepEqual(
    decideTakeStart({ ...READY, takeLifecycle: 'recording' }),
    { ok: false, reason: 'take-active' },
  );
  assert.deepEqual(
    decideTakeStart({ ...READY, takeLifecycle: 'finalizing' }),
    { ok: false, reason: 'take-active' },
  );
  assert.deepEqual(decideTakeStart({ ...READY, takeLifecycle: 'ready' }), { ok: true });
  assert.deepEqual(decideTakeStart({ ...READY, takeLifecycle: 'failed' }), { ok: true });
});
""")

product_path = Path('src/product-view-model.ts')
product = product_path.read_text()
product = replace_once(
    product,
    "import type { TakeLifecycle } from './take-session.js';\n",
    "import type { TakeLifecycle } from './take-session.js';\nimport { decideTakeStart, type TakeStartBlockReason } from './take-start-policy.js';\n",
    'import Take start policy',
)
product = replace_once(
    product,
    """    timingMode: 'network-estimate' | 'acoustic-calibration';
    calibrationState: string;
    calibrationStale: boolean;
""",
    """    timingMode: 'network-estimate' | 'acoustic-calibration';
    calibrationState: string;
    /** Explicitly includes boot-probe activity that CalibrationSession alone cannot represent. */
    calibrationActive?: boolean;
    calibrationStale: boolean;
""",
    'add calibration activity fact',
)
product = replace_once(
    product,
    """  actions: {
    canStartTake: boolean;
    canStopTake: boolean;
  };
""",
    """  actions: {
    canStartTake: boolean;
    startTakeBlockedReason: TakeStartBlockReason | null;
    canStopTake: boolean;
  };
""",
    'expose Take start reason',
)
product = replace_once(
    product,
    """function micState(input: ProductViewModelInput): RoomMicState {
""",
    """function calibrationActive(input: ProductViewModelInput) {
  return input.timing.calibrationActive === true
    || input.timing.calibrationState === 'collecting';
}

function micState(input: ProductViewModelInput): RoomMicState {
""",
    'add calibration activity helper',
)
product = replace_once(
    product,
    """    input.roomSong.handoffState !== 'idle'
    || (songLoaded && input.timing.calibrationState === 'collecting')
""",
    """    input.roomSong.handoffState !== 'idle'
    || (songLoaded && calibrationActive(input))
""",
    'use canonical calibration activity for lifecycle',
)
product = replace_once(
    product,
    "  if (input.timing.calibrationState === 'collecting') return 'calibrating';\n",
    "  if (calibrationActive(input)) return 'calibrating';\n",
    'use canonical calibration activity for timing',
)
product = replace_once(
    product,
    """  const mic = micState(input);

  return {
""",
    """  const mic = micState(input);
  const startTake = decideTakeStart({
    sessionActive: input.readiness.components.session.active,
    timingCalibrationActive: calibrationActive(input),
    songLoaded: input.roomSong.videoId !== null,
    voiceOnlyMicReady: mic === 'live',
    roomBlocked: health === 'blocked',
    takeLifecycle: input.take.lifecycle,
  });

  return {
""",
    'derive canonical Take start decision',
)
product = replace_once(
    product,
    """    actions: {
      canStartTake: input.readiness.components.session.active
        && (
          input.roomSong.videoId === null
            ? mic === 'live'
            : health !== 'blocked'
        )
        && input.take.lifecycle !== 'recording'
        && input.take.lifecycle !== 'finalizing',
      canStopTake: input.take.lifecycle === 'recording',
    },
""",
    """    actions: {
      canStartTake: startTake.ok,
      startTakeBlockedReason: startTake.ok ? null : startTake.reason,
      canStopTake: input.take.lifecycle === 'recording',
    },
""",
    'wire ProductStatus Take start policy',
)
product_path.write_text(product)

server_path = Path('src/server.ts')
server = server_path.read_text()
server = replace_once(
    server,
    """      timingMode: alignment.calibratedMicLagMs === null ? 'network-estimate' : 'acoustic-calibration',
      calibrationState: String(calibrationStatus.state ?? 'idle'),
      calibrationStale: calibrationIsStale(),
""",
    """      timingMode: alignment.calibratedMicLagMs === null ? 'network-estimate' : 'acoustic-calibration',
      calibrationState: String(calibrationStatus.state ?? 'idle'),
      calibrationActive: timingCalibrationInProgress(nowMs),
      calibrationStale: calibrationIsStale(),
""",
    'publish full calibration activity to ProductView',
)
server = replace_once(
    server,
    """      if (!session.active) {
        rejectTakeCommand(socket, 'start', 'mix-not-active');
        return;
      }
      const nowMs = performance.now();
      if (timingCalibrationInProgress(nowMs)) {
        rejectTakeCommand(socket, 'start', 'timing-calibration-active');
        return;
      }
      const song = takeSongSnapshot(nowMs);
      const currentMicStreaming = micStreaming(nowMs);
      if (song.videoId === null && !currentMicStreaming) {
        rejectTakeCommand(socket, 'start', 'take-not-ready');
        return;
      }

      const result = takeController.start(socket.participantId, song);
""",
    """      const nowMs = performance.now();
      const productStatus = productStatusPayload(nowMs);
      if (!productStatus.actions.canStartTake) {
        rejectTakeCommand(
          socket,
          'start',
          productStatus.actions.startTakeBlockedReason ?? 'take-not-ready',
        );
        return;
      }
      const song = takeSongSnapshot(nowMs);

      const result = takeController.start(socket.participantId, song);
""",
    'consume ProductStatus Take start authority',
)
server_path.write_text(server)

product_actions_path = Path('test/product-actions.test.ts')
product_actions = product_actions_path.read_text()
product_actions = replace_once(
    product_actions,
    """function model(readinessInput: ReadinessInput, takeLifecycle: 'idle' | 'recording' = 'idle') {
""",
    """function model(
  readinessInput: ReadinessInput,
  takeLifecycle: 'idle' | 'recording' = 'idle',
  calibrationActive = false,
) {
""",
    'extend Product action fixture',
)
product_actions = replace_once(
    product_actions,
    """      timingMode: 'acoustic-calibration',
      calibrationState: 'complete',
      calibrationStale: false,
""",
    """      timingMode: 'acoustic-calibration',
      calibrationState: 'complete',
      calibrationActive,
      calibrationStale: false,
""",
    'pass calibration activity fixture',
)
product_actions = replace_once(
    product_actions,
    """  assert.equal(status.actions.canStartTake, false);
});

test('an active Take remains stoppable even if Robot health becomes blocked', () => {
""",
    """  assert.equal(status.actions.canStartTake, false);
  assert.equal(status.actions.startTakeBlockedReason, 'take-not-ready');
});

test('active calibration disables Start Take even though calibration is normal preparation', () => {
  const status = model(READY, 'idle', true);

  assert.equal(status.lifecycle, 'preparing');
  assert.equal(status.health, 'healthy');
  assert.equal(status.actions.canStartTake, false);
  assert.equal(status.actions.startTakeBlockedReason, 'timing-calibration-active');
});

test('an active Take remains stoppable even if Robot health becomes blocked', () => {
""",
    'characterize Product action authority',
)
product_actions_path.write_text(product_actions)

take_server_path = Path('test/take-server.test.ts')
take_server = take_server_path.read_text()
take_server = replace_once(
    take_server,
    """test('Take commands require participant identity, recordable room audio, and the current Take id', async () => {
""",
    """test('Start Take follows blocked product health while a Song route has no audio flow', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-health-gate-'));
  const server = await startRelay({ ...FAST, RELAY_TAKE_DIR: directory });
  try {
    const control = await RelayClient.connect(server, participantQuery('participant-a', 'A'));
    await establishRoomSong(control, 'health-gate-playback-a');
    const backing = await startBacking(server);

    control.send({ type: 'product-status-request' });
    const product = await control.waitFor((message) => (
      message.type === 'product-status'
      && message.health === 'blocked'
      && message.attention?.code === 'audio-unavailable'
    ));
    assert.equal(product.actions.canStartTake, false);
    assert.equal(product.actions.startTakeBlockedReason, 'take-not-ready');

    control.send({ type: 'start-take' });
    const rejected = await control.waitFor((message) => (
      message.type === 'take-command-rejected'
      && message.command === 'start'
    ));
    assert.equal(rejected.reason, 'take-not-ready');

    backing.close();
    control.close();
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Take commands require participant identity, recordable room audio, and the current Take id', async () => {
""",
    'add server Product action gate regression',
)
take_server_path.write_text(take_server)
