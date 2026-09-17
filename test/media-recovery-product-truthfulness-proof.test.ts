import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProductViewModel } from '../src/product-view-model.js';
import { buildReadiness, type ReadinessInput } from '../src/readiness.js';

const moduleUrl = new URL('../public/mic-media-path-recovery.js', import.meta.url);

const VOICE_ONLY: ReadinessInput = {
  routeMode: 'idle',
  backingConnected: false,
  backingStreaming: false,
  backingSampleRate: null,
  backingIsRobot: false,
  micConnected: true,
  micStreaming: true,
  micFlowObserved: true,
  robotSourceConnected: false,
  sessionActive: true,
  timelineConnected: false,
  timelineState: null,
  playerOffsetMs: null,
  playerOffsetFresh: false,
  calibrationState: 'idle',
  calibrationValid: false,
  calibrationStale: false,
  calibrationKind: 'none',
  probeCorrelation: { mic: null, backing: null },
  bootCalibration: null,
};

test('terminal media under-delivery can remain product-live when sparse PCM keeps server freshness alive', async () => {
  const { MicMediaPathRecovery } = await import(moduleUrl.href);
  const recovery = new MicMediaPathRecovery({
    staleObservations: 3,
    minPacketCoverage: 0.5,
    minPacketWindow: 8,
  });

  let capturedSamples = 480;
  let acceptedFrameSerial = 1;
  let senderSubmittedPackets = 0;
  let serverReceivedPacketSerial = 0;

  const observe = ({
    path,
    serverMediaPath,
    socketEpoch,
    advance = true,
  }: {
    path: 'webtransport' | 'websocket';
    serverMediaPath: 'webtransport' | 'websocket';
    socketEpoch: number;
    advance?: boolean;
  }) => {
    if (advance) {
      capturedSamples += 14_400;
      acceptedFrameSerial += 1;
      senderSubmittedPackets += 30;
      serverReceivedPacketSerial += 10;
    }
    return recovery.observe({
      captureGeneration: 7,
      capturedSamples,
      serverAcceptedFrameSerial: acceptedFrameSerial,
      senderSubmittedPackets,
      senderFailedPackets: 0,
      serverReceivedPacketSerial,
      serverMediaPath,
      path,
      socketEpoch,
      eligible: true,
    });
  };

  assert.equal(
    observe({
      path: 'webtransport',
      serverMediaPath: 'webtransport',
      socketEpoch: 1,
      advance: false,
    }).reason,
    'baseline',
  );

  let decision;
  for (let index = 0; index < 3; index += 1) {
    decision = observe({
      path: 'webtransport',
      serverMediaPath: 'webtransport',
      socketEpoch: 1,
    });
  }
  assert.equal(decision?.action, 'demote-webtransport');
  assert.equal(decision?.packetCoverage, 1 / 3);

  decision = observe({
    path: 'websocket',
    serverMediaPath: 'websocket',
    socketEpoch: 1,
  });
  assert.equal(decision.reason, 'server-websocket-rebaseline');

  for (let index = 0; index < 3; index += 1) {
    decision = observe({
      path: 'websocket',
      serverMediaPath: 'websocket',
      socketEpoch: 1,
    });
  }
  assert.equal(decision?.action, 'replace-websocket');
  assert.equal(decision?.webSocketReplacementUsed, true);

  decision = observe({
    path: 'websocket',
    serverMediaPath: 'websocket',
    socketEpoch: 2,
  });
  assert.equal(decision.reason, 'socket-rebaseline');

  for (let index = 0; index < 3; index += 1) {
    decision = observe({
      path: 'websocket',
      serverMediaPath: 'websocket',
      socketEpoch: 2,
    });
  }
  assert.equal(decision?.action, 'degraded-latched');
  assert.equal(decision?.degraded, true);
  assert.equal(decision?.packetCoverage, 1 / 3);

  // Every low-coverage observation above still advanced the server's semantic
  // accepted-frame serial. MicRuntime would therefore continue renewing
  // lastFrameAt and can legitimately report streaming=true even while the
  // browser has exhausted bounded media recovery.
  assert.ok(acceptedFrameSerial > 1);

  const status = buildProductViewModel({
    readiness: buildReadiness(VOICE_ONLY),
    micMediaRecoveryDegraded: decision?.degraded === true,
    participantCount: 1,
    micOwnerId: 'participant-a',
    micOwnerNickname: 'A',
    roomSong: {
      videoId: null,
      connected: false,
      clockAgeMs: 0,
      state: null,
      handoffState: 'idle',
    },
    take: {
      lifecycle: 'idle',
      takeId: null,
      qualityVerdict: null,
    },
    timing: {
      timingMode: 'network-estimate',
      calibrationState: 'idle',
      calibrationStale: false,
      alignmentClamped: false,
      requiresRobotPlayerDelta: false,
      robotDeltaFresh: false,
    },
  });

  assert.equal(status.lifecycle, 'live');
  assert.equal(status.room.mic.state, 'live', 'server flow freshness remains the Mic state authority');
  assert.equal(status.health, 'degraded');
  assert.equal(status.attention?.code, 'mic-audio-stalled');
  assert.equal(status.actions.canStartTake, false);
  assert.equal(status.actions.startTakeBlockedReason, 'mic-audio-stalled');
  assert.equal(
    status.issues.some((issue) => issue.code === 'mic-audio-stalled'),
    true,
    'terminal browser media recovery must be composed into product truthfulness',
  );
});
