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


write_new('src/calibration-start-policy.ts', """import type { TakeLifecycle } from './take-session.js';

export type CalibrationStartMode = 'content' | 'boot-probe';
export type CalibrationStartBlockReason =
  | 'take-active'
  | 'calibration-active'
  | 'sources-not-connected'
  | 'sources-not-streaming'
  | 'phone-not-playing';

export type CalibrationStartFacts = {
  takeLifecycle: TakeLifecycle;
  calibrationActive: boolean;
  sessionActive: boolean;
  backingConnected: boolean;
  publisherControlConnected: boolean;
  backingStreaming: boolean;
  micStreaming: boolean;
  robotProbeTimingActive: boolean;
  timelineConnected: boolean;
  timelineState: number | null;
};

export type CalibrationStartDecision =
  | { ok: true; mode: CalibrationStartMode }
  | { ok: false; reason: CalibrationStartBlockReason };

/**
 * Owns the room-level prerequisites for starting timing calibration.
 *
 * Mic-owner authorization remains an actor boundary in the server/browser.
 * This policy owns only room facts. Robot probe calibration intentionally does
 * not require a playing phone timeline; content correlation does.
 */
export function decideCalibrationStart(
  facts: CalibrationStartFacts,
): CalibrationStartDecision {
  if (facts.takeLifecycle === 'recording' || facts.takeLifecycle === 'finalizing') {
    return { ok: false, reason: 'take-active' };
  }
  if (facts.calibrationActive) return { ok: false, reason: 'calibration-active' };
  if (!facts.sessionActive || !facts.backingConnected || !facts.publisherControlConnected) {
    return { ok: false, reason: 'sources-not-connected' };
  }
  if (!facts.backingStreaming || !facts.micStreaming) {
    return { ok: false, reason: 'sources-not-streaming' };
  }
  if (facts.robotProbeTimingActive) return { ok: true, mode: 'boot-probe' };
  if (!facts.timelineConnected || facts.timelineState !== 1) {
    return { ok: false, reason: 'phone-not-playing' };
  }
  return { ok: true, mode: 'content' };
}
""")

write_new('test/calibration-start-policy.test.ts', """import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideCalibrationStart,
  type CalibrationStartFacts,
} from '../src/calibration-start-policy.js';

const READY: CalibrationStartFacts = {
  takeLifecycle: 'idle',
  calibrationActive: false,
  sessionActive: true,
  backingConnected: true,
  publisherControlConnected: true,
  backingStreaming: true,
  micStreaming: true,
  robotProbeTimingActive: false,
  timelineConnected: true,
  timelineState: 1,
};

test('calibration start policy preserves runtime rejection precedence', () => {
  assert.deepEqual(
    decideCalibrationStart({
      ...READY,
      takeLifecycle: 'recording',
      calibrationActive: true,
      sessionActive: false,
    }),
    { ok: false, reason: 'take-active' },
  );
  assert.deepEqual(
    decideCalibrationStart({ ...READY, calibrationActive: true, sessionActive: false }),
    { ok: false, reason: 'calibration-active' },
  );
  assert.deepEqual(
    decideCalibrationStart({ ...READY, publisherControlConnected: false, micStreaming: false }),
    { ok: false, reason: 'sources-not-connected' },
  );
  assert.deepEqual(
    decideCalibrationStart({ ...READY, backingStreaming: false }),
    { ok: false, reason: 'sources-not-streaming' },
  );
});

test('Robot probe calibration does not invent a phone-timeline requirement', () => {
  assert.deepEqual(
    decideCalibrationStart({
      ...READY,
      robotProbeTimingActive: true,
      timelineConnected: false,
      timelineState: null,
    }),
    { ok: true, mode: 'boot-probe' },
  );
});

test('content calibration requires the phone timeline to be playing', () => {
  assert.deepEqual(
    decideCalibrationStart({ ...READY, timelineConnected: false, timelineState: null }),
    { ok: false, reason: 'phone-not-playing' },
  );
  assert.deepEqual(
    decideCalibrationStart({ ...READY, timelineState: 2 }),
    { ok: false, reason: 'phone-not-playing' },
  );
  assert.deepEqual(decideCalibrationStart(READY), { ok: true, mode: 'content' });
});
""")

product_path = Path('src/product-view-model.ts')
product = product_path.read_text()
product = replace_once(
    product,
    "import { decideTakeStart, type TakeStartBlockReason } from './take-start-policy.js';\n",
    """import { decideTakeStart, type TakeStartBlockReason } from './take-start-policy.js';
import {
  decideCalibrationStart,
  type CalibrationStartBlockReason,
  type CalibrationStartMode,
} from './calibration-start-policy.js';
""",
    'import calibration start policy',
)
product = replace_once(
    product,
    """  micOwnerId: string | null;
  micOwnerNickname: string | null;
  roomSong: ProductRoomSongInput;
""",
    """  micOwnerId: string | null;
  micOwnerNickname: string | null;
  /** Manual calibration needs the publisher control socket, not only Mic media. */
  publisherControlConnected?: boolean;
  roomSong: ProductRoomSongInput;
""",
    'add publisher control fact',
)
product = replace_once(
    product,
    """    requiresRobotPlayerDelta: boolean;
    robotDeltaFresh: boolean;
""",
    """    requiresRobotPlayerDelta: boolean;
    /** Whether manual calibration should use the Robot boot-probe path. */
    robotProbeTimingActive?: boolean;
    robotDeltaFresh: boolean;
""",
    'add calibration mode fact',
)
product = replace_once(
    product,
    """    canStartTake: boolean;
    startTakeBlockedReason: TakeStartBlockReason | null;
    canStopTake: boolean;
""",
    """    canStartTake: boolean;
    startTakeBlockedReason: TakeStartBlockReason | null;
    canStopTake: boolean;
    canStartCalibration: boolean;
    startCalibrationBlockedReason: CalibrationStartBlockReason | null;
    startCalibrationMode: CalibrationStartMode | null;
""",
    'expose calibration action decision',
)
product = replace_once(
    product,
    """  const startTake = decideTakeStart({
    sessionActive: input.readiness.components.session.active,
    timingCalibrationActive: calibrationActive(input),
    songLoaded: input.roomSong.videoId !== null,
    voiceOnlyMicReady: mic === 'live',
    roomBlocked: health === 'blocked',
    takeLifecycle: input.take.lifecycle,
  });

  return {
""",
    """  const startTake = decideTakeStart({
    sessionActive: input.readiness.components.session.active,
    timingCalibrationActive: calibrationActive(input),
    songLoaded: input.roomSong.videoId !== null,
    voiceOnlyMicReady: mic === 'live',
    roomBlocked: health === 'blocked',
    takeLifecycle: input.take.lifecycle,
  });
  const startCalibration = decideCalibrationStart({
    takeLifecycle: input.take.lifecycle,
    calibrationActive: calibrationActive(input),
    sessionActive: input.readiness.components.session.active,
    backingConnected: input.readiness.components.backing.connected,
    publisherControlConnected: input.publisherControlConnected === true,
    backingStreaming: input.readiness.components.backing.streaming,
    micStreaming: input.readiness.components.mic.streaming,
    robotProbeTimingActive: input.timing.robotProbeTimingActive === true,
    timelineConnected: input.readiness.components.player.timelineConnected,
    timelineState: input.readiness.components.player.state,
  });

  return {
""",
    'derive canonical calibration start decision',
)
product = replace_once(
    product,
    """      canStartTake: startTake.ok,
      startTakeBlockedReason: startTake.ok ? null : startTake.reason,
      canStopTake: input.take.lifecycle === 'recording',
""",
    """      canStartTake: startTake.ok,
      startTakeBlockedReason: startTake.ok ? null : startTake.reason,
      canStopTake: input.take.lifecycle === 'recording',
      canStartCalibration: startCalibration.ok,
      startCalibrationBlockedReason: startCalibration.ok ? null : startCalibration.reason,
      startCalibrationMode: startCalibration.ok ? startCalibration.mode : null,
""",
    'publish calibration action decision',
)
product_path.write_text(product)

server_path = Path('src/server.ts')
server = server_path.read_text()
server = replace_once(
    server,
    """    micOwnerId: participantSnapshot.micOwnerId,
    micOwnerNickname: micOwner?.nickname ?? null,
    roomSong: {
""",
    """    micOwnerId: participantSnapshot.micOwnerId,
    micOwnerNickname: micOwner?.nickname ?? null,
    publisherControlConnected: publisher?.readyState === WebSocket.OPEN,
    roomSong: {
""",
    'publish publisher control connectivity',
)
server = replace_once(
    server,
    """      requiresRobotPlayerDelta: robotProbeTimingActive(),
      robotDeltaFresh: robotDeltaIsFresh(nowMs),
""",
    """      requiresRobotPlayerDelta: robotProbeTimingActive(),
      robotProbeTimingActive: robotProbeTimingActive(),
      robotDeltaFresh: robotDeltaIsFresh(nowMs),
""",
    'publish calibration mode fact',
)
server = replace_once(
    server,
    """    if (payload.type === 'start-timing-calibration') {
      if (!requireMicOwnerCommand(socket, 'start-timing-calibration')) return;
      const nowMs = performance.now();
      if (takeBlocksCalibration()) {
        sendJson(socket, {
          type: 'calibration-command-rejected',
          reason: 'take-active',
        });
        return;
      }
      if (timingCalibrationInProgress(nowMs)) {
        sendJson(socket, timingCalibrationStatusPayload());
        return;
      }
      if (
        !session.active
        || backing?.readyState !== WebSocket.OPEN
        || publisher?.readyState !== WebSocket.OPEN
      ) {
        calibration.fail('Connect both phone Microphone and Desktop Source before calibration.');
        return;
      }

      const silent = silentSides(nowMs);
      if (silent.length > 0) {
        calibration.fail(
          `No audio arriving from the ${silent.join(' or ')}. `
          + 'Restart the backing source: on a development desktop the source page was probably reloaded, which drops the tab capture.',
        );
        return;
      }

      if (robotProbeTimingActive()) {
        restartBootCalibration(nowMs, false);
        return;
      }

      const timeline = currentTimelineStatus(nowMs);
      if (!timeline.connected || Number(timeline.state) !== 1) {
        calibration.fail('Play YouTube on the phone before calibration.');
        return;
      }
      calibrationWasAutomatic = false;
      calibrationKind = 'content';
      calibration.start(nowMs);
      broadcastJson(timingCalibrationStatusPayload());
      return;
    }
""",
    """    if (payload.type === 'start-timing-calibration') {
      if (!requireMicOwnerCommand(socket, 'start-timing-calibration')) return;
      const nowMs = performance.now();
      const calibrationAction = productStatusPayload(nowMs).actions;
      if (!calibrationAction.canStartCalibration) {
        switch (calibrationAction.startCalibrationBlockedReason) {
          case 'take-active':
            sendJson(socket, {
              type: 'calibration-command-rejected',
              reason: 'take-active',
            });
            return;
          case 'calibration-active':
            sendJson(socket, timingCalibrationStatusPayload());
            return;
          case 'sources-not-connected':
            calibration.fail('Connect both phone Microphone and Desktop Source before calibration.');
            return;
          case 'sources-not-streaming': {
            const silent = silentSides(nowMs);
            calibration.fail(
              `No audio arriving from the ${silent.join(' or ')}. `
              + 'Restart the backing source: on a development desktop the source page was probably reloaded, which drops the tab capture.',
            );
            return;
          }
          case 'phone-not-playing':
            calibration.fail('Play YouTube on the phone before calibration.');
            return;
        }
        return;
      }

      if (calibrationAction.startCalibrationMode === 'boot-probe') {
        restartBootCalibration(nowMs, false);
        return;
      }

      calibrationWasAutomatic = false;
      calibrationKind = 'content';
      calibration.start(nowMs);
      broadcastJson(timingCalibrationStatusPayload());
      return;
    }
""",
    'consume ProductStatus calibration authority',
)
server_path.write_text(server)

app_path = Path('public/app.js')
app = app_path.read_text()
app = replace_once(
    app,
    """let latestCalibration = null;
let roomSongAvailable = null;
let pendingPublisherTakeoverOwnerId = null;
""",
    """let latestCalibration = null;
let roomSongAvailable = null;
let roomCanStartCalibration = null;
let pendingPublisherTakeoverOwnerId = null;
""",
    'track canonical calibration action',
)
app = replace_once(
    app,
    """  calibrateButton.disabled = !publisherActive
    || !liveMixActive
    || roomSongAvailable !== true
    || collecting
    || probeActive;
""",
    """  calibrateButton.disabled = !publisherActive
    || roomSongAvailable !== true
    || roomCanStartCalibration !== true;
""",
    'use canonical calibration button authority',
)
app = replace_once(
    app,
    """window.addEventListener('relay-product-status', (event) => {
  const videoId = event.detail?.room?.song?.videoId;
  roomSongAvailable = typeof videoId === 'string' && videoId.length > 0;
  updateCalibrateButton();
});
""",
    """window.addEventListener('relay-product-status', (event) => {
  const videoId = event.detail?.room?.song?.videoId;
  roomSongAvailable = typeof videoId === 'string' && videoId.length > 0;
  roomCanStartCalibration = event.detail?.actions?.canStartCalibration === true;
  updateCalibrateButton();
});
""",
    'consume ProductStatus calibration action',
)
app_path.write_text(app)

product_actions_path = Path('test/product-actions.test.ts')
product_actions = product_actions_path.read_text()
product_actions = replace_once(
    product_actions,
    """    micOwnerId: 'participant-alice',
    micOwnerNickname: 'Alice',
    roomSong: {
""",
    """    micOwnerId: 'participant-alice',
    micOwnerNickname: 'Alice',
    publisherControlConnected: true,
    roomSong: {
""",
    'add ProductStatus publisher control fixture',
)
product_actions = replace_once(
    product_actions,
    """      requiresRobotPlayerDelta: true,
      robotDeltaFresh: true,
""",
    """      requiresRobotPlayerDelta: true,
      robotProbeTimingActive: true,
      robotDeltaFresh: true,
""",
    'add ProductStatus calibration mode fixture',
)
product_actions = replace_once(
    product_actions,
    """  assert.equal(status.actions.canStartTake, false);
  assert.equal(status.actions.startTakeBlockedReason, 'timing-calibration-active');
});
""",
    """  assert.equal(status.actions.canStartTake, false);
  assert.equal(status.actions.startTakeBlockedReason, 'timing-calibration-active');
  assert.equal(status.actions.canStartCalibration, false);
  assert.equal(status.actions.startCalibrationBlockedReason, 'calibration-active');
});
""",
    'characterize active calibration action',
)
product_actions = replace_once(
    product_actions,
    """  assert.equal(status.actions.canStartTake, false);
  assert.equal(status.actions.canStopTake, true);
});
""",
    """  assert.equal(status.actions.canStartTake, false);
  assert.equal(status.actions.canStopTake, true);
  assert.equal(status.actions.canStartCalibration, false);
  assert.equal(status.actions.startCalibrationBlockedReason, 'take-active');
});

test('healthy Robot room exposes boot-probe calibration as the canonical action mode', () => {
  const status = model(READY);

  assert.equal(status.actions.canStartCalibration, true);
  assert.equal(status.actions.startCalibrationBlockedReason, null);
  assert.equal(status.actions.startCalibrationMode, 'boot-probe');
});
""",
    'characterize Take and Robot calibration actions',
)
product_actions_path.write_text(product_actions)

adjust_path = Path('test/adjust-ui-contract.test.ts')
adjust = adjust_path.read_text()
if "Calibration enablement follows ProductStatus action authority" in adjust:
    raise SystemExit('adjust calibration authority test already exists')
adjust += """

test('Calibration enablement follows ProductStatus action authority', () => {
  assert.equal(app.includes('let roomCanStartCalibration = null;'), true);
  assert.equal(
    app.includes('roomCanStartCalibration = event.detail?.actions?.canStartCalibration === true;'),
    true,
  );

  const updateBlock = app.match(/function updateCalibrateButton\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const disabled = updateBlock.match(/calibrateButton\.disabled = ([\s\S]*?);/)?.[1] ?? '';
  assert.notEqual(disabled, '');
  assert.equal(disabled.includes('publisherActive'), true);
  assert.equal(disabled.includes('roomSongAvailable'), true);
  assert.equal(disabled.includes('roomCanStartCalibration'), true);
  assert.equal(disabled.includes('liveMixActive'), false);
  assert.equal(disabled.includes('collecting'), false);
  assert.equal(disabled.includes('probeActive'), false);
});
"""
adjust_path.write_text(adjust)

take_server_path = Path('test/take-server.test.ts')
take_server = take_server_path.read_text()
take_server = replace_once(
    take_server,
    """    control.send({ type: 'start-take' });
    const start = await control.waitFor((message) => message.type === 'take-command-accepted' && message.command === 'start');
    const takeId = String(start.takeId);

    control.send({ type: 'stop-take', takeId: 'older-take' });
""",
    """    control.send({ type: 'start-take' });
    const start = await control.waitFor((message) => message.type === 'take-command-accepted' && message.command === 'start');
    const takeId = String(start.takeId);

    control.send({ type: 'product-status-request' });
    const recordingProduct = await control.waitFor((message) => (
      message.type === 'product-status'
      && message.take?.takeId === takeId
      && message.take?.lifecycle === 'recording'
    ));
    assert.equal(recordingProduct.actions.canStartCalibration, false);
    assert.equal(recordingProduct.actions.startCalibrationBlockedReason, 'take-active');

    control.send({ type: 'start-timing-calibration' });
    const calibrationRejected = await control.waitFor((message) => (
      message.type === 'calibration-command-rejected'
      && message.reason === 'take-active'
    ));
    assert.equal(calibrationRejected.reason, 'take-active');

    control.send({ type: 'stop-take', takeId: 'older-take' });
""",
    'prove Take/calibration action authority at server boundary',
)
take_server_path.write_text(take_server)
