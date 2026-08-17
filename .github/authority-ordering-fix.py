from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


server_path = Path('src/server.ts')
server = server_path.read_text()

server = replace_once(
    server,
    """function applyMicOwnerEffects(
  effects: Parameters<typeof applyMicOwnerTransitionEffects>[0],
  nowMs = performance.now(),
) {
  return applyMicOwnerTransitionEffects(effects, {
    noteQualityEvent: (event) => takeController.noteQualityEvent(event),
    cancelRoomSongCommand: (reason) => cancelPendingRoomSongCommand(reason, nowMs),
    cancelSongHandoff: () => youtubeTimeline.cancelHandoff(),
    publishSongHandoffCancellation: () => {
      broadcastJson(youtubeTimeline.statusPayload(nowMs));
      broadcastJson(youtubeTimeline.roomStatusPayload(nowMs));
    },
    invalidateTiming: (reason) => invalidateMicTiming(reason),
    prepareSongHandoff: (participantId) => beginPreparedSongHandoff(participantId, nowMs),
  });
}""",
    """function applyMicOwnerEffects(
  effects: Parameters<typeof applyMicOwnerTransitionEffects>[0],
  nowMs = performance.now(),
  options: {
    afterQualityEvent?: () => void;
    beforeTimingInvalidation?: () => void;
    publishFullHandoffStatus?: boolean;
  } = {},
) {
  return applyMicOwnerTransitionEffects(effects, {
    noteQualityEvent: (event) => {
      takeController.noteQualityEvent(event);
      options.afterQualityEvent?.();
    },
    cancelRoomSongCommand: (reason) => cancelPendingRoomSongCommand(reason, nowMs),
    cancelSongHandoff: () => youtubeTimeline.cancelHandoff(),
    publishSongHandoffCancellation: () => {
      if (options.publishFullHandoffStatus !== false) {
        broadcastJson(youtubeTimeline.statusPayload(nowMs));
      }
      broadcastJson(youtubeTimeline.roomStatusPayload(nowMs));
    },
    invalidateTiming: (reason) => {
      options.beforeTimingInvalidation?.();
      invalidateMicTiming(reason);
    },
    prepareSongHandoff: (participantId) => beginPreparedSongHandoff(participantId, nowMs),
  });
}""",
    'preserve transport hooks in mic effects adapter',
)

server = replace_once(
    server,
    """  if (presenceSweep.releasedMicOwnerId && presenceSweep.micOwnerEffects) {
    cancelMicTransportGrace();
    clearMicMediaAuthority();
    applyMicOwnerEffects(presenceSweep.micOwnerEffects, nowMs);
  }""",
    """  if (presenceSweep.releasedMicOwnerId && presenceSweep.micOwnerEffects) {
    applyMicOwnerEffects(presenceSweep.micOwnerEffects, nowMs, {
      afterQualityEvent: () => {
        cancelMicTransportGrace();
        clearMicMediaAuthority();
      },
      publishFullHandoffStatus: false,
    });
  }""",
    'preserve presence-expiry side-effect ordering',
)

server = replace_once(
    server,
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
      applyMicOwnerEffects(result.effects);
      broadcastSessionStatus();
      sendJson(socket, { type: 'mic-released' });
      return;
    }""",
    """    if (payload.type === 'release-mic') {
      if (!socket.participantId) return;
      const result = participants.releaseMic(socket.participantId);
      if (!result.ok) return;

      let transportCleaned = false;
      const cleanReleasedMicTransport = () => {
        if (transportCleaned) return;
        transportCleaned = true;
        if (publisher?.participantId === socket.participantId) {
          revokePublisherTransport('You released the microphone.');
        } else if (micMediaOwnerId === socket.participantId) {
          clearMicMediaAuthority();
        }
      };
      applyMicOwnerEffects(result.effects, performance.now(), {
        afterQualityEvent: () => cancelMicTransportGrace(),
        beforeTimingInvalidation: cleanReleasedMicTransport,
      });
      // A successful explicit release always invalidates timing today. Keep this
      // fallback so transport cleanup remains adapter-owned even if that domain
      // effect is deliberately changed later.
      cleanReleasedMicTransport();
      broadcastSessionStatus();
      sendJson(socket, { type: 'mic-released' });
      return;
    }""",
    'preserve explicit-release side-effect ordering',
)

server_path.write_text(server)

contract_path = Path('test/webtransport-media-server.test.ts')
contract = contract_path.read_text()
contract = replace_once(
    contract,
    """  assert.match(
    server,
    /participants\\.releaseMic\\(expectedOwnerId\\)[\\s\\S]{0,500}clearMicMediaAuthority\\(\\)[\\s\\S]{0,500}takeController\\.noteQualityEvent\\('mic-owner-changed'\\)[\\s\\S]{0,500}cancelPendingRoomSongCommand\\('mic-owner-released'\\)/,
    'Mic transport-grace expiry must retire WebTransport authority without dropping Take/command semantics',
  );
  assert.match(
    server,
    /presenceSweep\\.releasedMicOwnerId[\\s\\S]{0,500}clearMicMediaAuthority\\(\\)[\\s\\S]{0,500}cancelPendingRoomSongCommand\\('mic-owner-released', nowMs\\)[\\s\\S]{0,500}youtubeTimeline\\.cancelHandoff\\(\\)/,
    'participant expiry must retire media authority and the old owner command/handoff epoch together',
  );""",
    """  assert.match(
    server,
    /participants\\.releaseMic\\(expectedOwnerId, 'transport-expired'\\)[\\s\\S]{0,500}clearMicMediaAuthority\\(\\)[\\s\\S]{0,500}applyMicOwnerEffects\\(released\\.effects\\)/,
    'Mic transport-grace expiry must retire WebTransport authority while applying canonical room effects',
  );
  assert.match(
    server,
    /presenceSweep\\.releasedMicOwnerId && presenceSweep\\.micOwnerEffects[\\s\\S]{0,800}applyMicOwnerEffects\\(presenceSweep\\.micOwnerEffects, nowMs, \\{[\\s\\S]{0,500}clearMicMediaAuthority\\(\\)[\\s\\S]{0,500}publishFullHandoffStatus: false/,
    'participant expiry must retire media authority inside the canonical effect epoch without adding a full Song-status broadcast',
  );""",
    'direct-media terminal-boundary contract',
)
contract_path.write_text(contract)
