from pathlib import Path

server_path = Path('src/server.ts')
text = server_path.read_text()


def replace_exact(label: str, old: str, new: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    text = text.replace(old, new, 1)
    print(f'patched server: {label}')


replace_exact(
    'mic transition application imports',
    "import { CalibrationSession, type CalibrationContext } from './calibration-session.js';\nimport { buildRelayObservationStatusV1 } from './observation-status.js';",
    "import { CalibrationSession, type CalibrationContext } from './calibration-session.js';\nimport { applyMicOwnerTransitionEffects } from './mic-owner-transition-application.js';\nimport type { MicOwnerTransitionEffects } from './mic-owner-transition.js';\nimport { buildRelayObservationStatusV1 } from './observation-status.js';",
)

replace_exact(
    'remote status import',
    "import { buildReadiness } from './readiness.js';\nimport {\n  ParticipantSession,",
    "import { buildReadiness } from './readiness.js';\nimport { deriveRemoteStatusHealth } from './remote-status.js';\nimport {\n  ParticipantSession,",
)

replace_exact(
    'transport grace expiry effects',
    """    const released = participants.releaseMic(expectedOwnerId);
    if (!released.ok) return;
    clearMicMediaAuthority();
    takeController.noteQualityEvent('mic-owner-changed');
    cancelPendingRoomSongCommand('mic-owner-released');
    invalidateMicTiming('Microphone transport did not reconnect before its grace period expired.');
    broadcastSessionStatus();""",
    """    const released = participants.releaseMic(expectedOwnerId, 'transport-expired');
    if (!released.ok) return;
    clearMicMediaAuthority();
    applyRoomMicOwnerEffects(released.effects);
    broadcastSessionStatus();""",
)

handoff_block = """function beginPreparedSongHandoff(participantId: string, nowMs = performance.now()) {
  const target = selectPlaybackHandoffTarget(participantId, nowMs);
  if (!target) return false;
  const plan = youtubeTimeline.beginHandoff(target, participants.micOwnerId, nowMs);
  if (!plan) return false;
  sendHandoffPlan('song-handoff-prepare', plan);
  broadcastJson(youtubeTimeline.statusPayload(nowMs));
  broadcastJson(youtubeTimeline.roomStatusPayload(nowMs));
  return true;
}
"""

replace_exact(
    'mic transition application adapter',
    handoff_block,
    handoff_block + """
function applyRoomMicOwnerEffects(
  effects: MicOwnerTransitionEffects,
  nowMs = performance.now(),
  publishFullHandoffStatus = true,
) {
  return applyMicOwnerTransitionEffects(effects, {
    noteQualityEvent(event) {
      takeController.noteQualityEvent(event);
    },
    cancelRoomSongCommand(reason) {
      cancelPendingRoomSongCommand(reason, nowMs);
    },
    cancelSongHandoff() {
      return youtubeTimeline.cancelHandoff();
    },
    publishSongHandoffCancellation() {
      if (publishFullHandoffStatus) broadcastJson(youtubeTimeline.statusPayload(nowMs));
      broadcastJson(youtubeTimeline.roomStatusPayload(nowMs));
    },
    invalidateTiming(reason) {
      invalidateMicTiming(reason);
    },
    prepareSongHandoff(participantId) {
      beginPreparedSongHandoff(participantId, nowMs);
    },
  });
}
""",
)

replace_exact(
    'remote status facts',
    """  const readiness = readinessPayload(nowMs);
  const components = readiness.components;
  const backingConnected = components.backing.connected;
  const micConnected = components.mic.connected;
  const backingStreaming = components.backing.streaming;
  const micStreaming = components.mic.streaming;
  const micFlowSeen = components.mic.flowObserved;
  const routeMode = components.route.mode;
  const robotRoute = routeMode === 'robot';
  const robotSourceConnected = components.robotSource.connected;
  const deltaFresh = components.player.offsetFresh;
""",
    """  const readiness = readinessPayload(nowMs);
  const components = readiness.components;
  const health = deriveRemoteStatusHealth(readiness);
  const backingConnected = components.backing.connected;
  const micConnected = components.mic.connected;
  const backingStreaming = components.backing.streaming;
  const micStreaming = components.mic.streaming;
  const robotRoute = components.route.mode === 'robot';
  const robotSourceConnected = components.robotSource.connected;
  const deltaFresh = components.player.offsetFresh;
""",
)

replace_exact(
    'remote status inline health policy',
    """  const faults: string[] = [];
  if (backingConnected && !backingStreaming) faults.push('backing source is connected but no longer sending audio');
  // \"No longer\" is a claim about a stream that once existed. A microphone that
  // has been taken but has not produced its first frame yet is starting, not
  // failing - the phone is still resolving permission, opening the capture and
  // filling its first buffers. Reporting that as a fault told an operator the
  // opposite of what was happening, and it is the ordinary state of every take
  // for its first moments. `flowObserved` is what separates the two, and the
  // product view already draws that line: `starting` before the first frame,
  // `interrupted` after one stops arriving.
  if (micConnected && micFlowSeen && !micStreaming) {
    faults.push('microphone is connected but no longer sending audio');
  }
  if (routeMode !== 'idle' && !backingConnected) {
    faults.push(`${routeMode} route has no backing source`);
  }
  if (robotRoute && !robotSourceConnected) faults.push('robot route has no source page');

  const warnings: string[] = [];
  if (robotRoute && robotSourceConnected && !deltaFresh) {
    warnings.push('robot player delta is stale; alignment fell back to the network estimate');
  }
  if (components.calibration.stale) warnings.push('timing calibration no longer matches the current capture');

  const idle = !backingConnected && !micConnected && !robotSourceConnected;
  const state = faults.length > 0 ? 'fault'
    : idle ? 'idle'
      : warnings.length > 0 ? 'degraded'
        : 'live';

""",
    '',
)

replace_exact(
    'remote status projected health',
    """    ok: faults.length === 0,
    state,
    faults,
    warnings,""",
    """    ok: health.ok,
    state: health.state,
    faults: health.faults,
    warnings: health.warnings,""",
)

replace_exact(
    'presence expiry effects',
    """  const presenceSweep = participants.sweep(Date.now());
  if (presenceSweep.releasedMicOwnerId) {
    takeController.noteQualityEvent('mic-owner-changed');
    cancelMicTransportGrace();
    clearMicMediaAuthority();
    cancelPendingRoomSongCommand('mic-owner-released', nowMs);
    if (youtubeTimeline.cancelHandoff()) broadcastJson(youtubeTimeline.roomStatusPayload(nowMs));
    invalidateMicTiming('Microphone owner left the Relay session.');
  }
  if (presenceSweep.changed) broadcastSessionStatus();""",
    """  const presenceSweep = participants.sweep(Date.now());
  if (presenceSweep.micOwnerEffects) {
    cancelMicTransportGrace();
    clearMicMediaAuthority();
    applyRoomMicOwnerEffects(presenceSweep.micOwnerEffects, nowMs, false);
  }
  if (presenceSweep.changed) broadcastSessionStatus();""",
)

replace_exact(
    'explicit release effects',
    """    if (payload.type === 'release-mic') {
      if (!socket.participantId) return;
      const result = participants.releaseMic(socket.participantId);
      if (!result.ok) return;

      takeController.noteQualityEvent('mic-owner-changed');
      cancelMicTransportGrace();
      cancelPendingRoomSongCommand('mic-owner-released');
      if (youtubeTimeline.cancelHandoff()) {
        broadcastJson(youtubeTimeline.statusPayload());
        broadcastJson(youtubeTimeline.roomStatusPayload());
      }
      if (publisher?.participantId === socket.participantId) {
        revokePublisherTransport('You released the microphone.');
      } else if (micMediaOwnerId === socket.participantId) {
        clearMicMediaAuthority();
      }
      invalidateMicTiming('Microphone was released.');
      broadcastSessionStatus();
      sendJson(socket, { type: 'mic-released' });
      return;
    }""",
    """    if (payload.type === 'release-mic') {
      if (!socket.participantId) return;
      const result = participants.releaseMic(socket.participantId);
      if (!result.ok) return;

      cancelMicTransportGrace();
      if (publisher?.participantId === socket.participantId) {
        revokePublisherTransport('You released the microphone.');
      } else if (micMediaOwnerId === socket.participantId) {
        clearMicMediaAuthority();
      }
      applyRoomMicOwnerEffects(result.effects);
      broadcastSessionStatus();
      sendJson(socket, { type: 'mic-released' });
      return;
    }""",
)

server_path.write_text(text)
print('server Mic authority/status wiring complete')
