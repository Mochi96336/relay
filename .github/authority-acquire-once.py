from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


path = Path('src/server.ts')
server = path.read_text()

server = replace_once(
    server,
    """  options: {
    afterQualityEvent?: () => void;
    beforeTimingInvalidation?: () => void;
    publishFullHandoffStatus?: boolean;
  } = {},""",
    """  options: {
    afterQualityEvent?: () => void;
    beforeTimingInvalidation?: () => void;
    publishFullHandoffStatus?: boolean;
    invalidateTiming?: (reason: string) => void;
    prepareSongHandoff?: (participantId: string) => void;
  } = {},""",
    'extend mic effect adapter hooks',
)

server = replace_once(
    server,
    """    invalidateTiming: (reason) => {
      options.beforeTimingInvalidation?.();
      invalidateMicTiming(reason);
    },
    prepareSongHandoff: (participantId) => beginPreparedSongHandoff(participantId, nowMs),""",
    """    invalidateTiming: (reason) => {
      options.beforeTimingInvalidation?.();
      if (options.invalidateTiming) options.invalidateTiming(reason);
      else invalidateMicTiming(reason);
    },
    prepareSongHandoff: (participantId) => {
      if (options.prepareSongHandoff) options.prepareSongHandoff(participantId);
      else beginPreparedSongHandoff(participantId, nowMs);
    },""",
    'defer lifecycle-sensitive mic effects',
)

server = replace_once(
    server,
    """      let ownershipChanged = false;
      let previousOwnerId: string | null = participants.micOwnerId;
      if (socket.participantId) {
        const ownership = hasTakeoverExpectation
          ? participants.takeoverMic(socket.participantId, expectedOwnerId)
          : participants.acquireMic(socket.participantId);
        if (!ownership.ok) {
          if (ownership.reason === 'busy') {
            sendJson(socket, {
              type: 'mic-busy',
              owner: participantPayload(ownership.ownerId),
              revision: participants.revision,
            });
          } else {
            sendJson(socket, {
              type: 'mic-takeover-rejected',
              reason: ownership.reason,
              owner: participantPayload(ownership.ownerId),
              revision: participants.revision,
            });
          }
          sendJson(socket, sessionStatusPayload());
          return;
        }
        ownershipChanged = ownership.changed;
        previousOwnerId = ownership.previousOwnerId;
      } else if (participants.micOwnerId !== null) {
        sendJson(socket, { type: 'error', message: 'Microphone is owned by an active Relay participant.' });
        return;
      }

      if (ownershipChanged) {
        cancelPendingRoomSongCommand('mic-owner-changed');
        takeController.noteQualityEvent('mic-owner-changed');
      }
""",
    """      let ownershipEffects: Parameters<typeof applyMicOwnerTransitionEffects>[0] | null = null;
      let previousOwnerId: string | null = participants.micOwnerId;
      if (socket.participantId) {
        const ownership = hasTakeoverExpectation
          ? participants.takeoverMic(socket.participantId, expectedOwnerId)
          : participants.acquireMic(socket.participantId);
        if (!ownership.ok) {
          if (ownership.reason === 'busy') {
            sendJson(socket, {
              type: 'mic-busy',
              owner: participantPayload(ownership.ownerId),
              revision: participants.revision,
            });
          } else {
            sendJson(socket, {
              type: 'mic-takeover-rejected',
              reason: ownership.reason,
              owner: participantPayload(ownership.ownerId),
              revision: participants.revision,
            });
          }
          sendJson(socket, sessionStatusPayload());
          return;
        }
        ownershipEffects = ownership.effects;
        previousOwnerId = ownership.previousOwnerId;
      } else if (participants.micOwnerId !== null) {
        sendJson(socket, { type: 'error', message: 'Microphone is owned by an active Relay participant.' });
        return;
      }

      let deferredOwnershipTimingReason: string | null = null;
      let deferredHandoffParticipantId: string | null = null;
      if (ownershipEffects) {
        applyMicOwnerEffects(ownershipEffects, performance.now(), {
          invalidateTiming: (reason) => {
            deferredOwnershipTimingReason = reason;
          },
          prepareSongHandoff: (participantId) => {
            deferredHandoffParticipantId = participantId;
          },
        });
      }
""",
    'wire publisher ownership effects',
)

server = replace_once(
    server,
    """      if (ownershipChanged || (sameParticipantReplacement && !sameCapture)) {
        invalidateMicTiming(
          ownershipChanged
            ? 'Microphone ownership changed.'
            : 'Microphone capture changed.',
        );
      }
""",
    """      if (deferredOwnershipTimingReason) {
        invalidateMicTiming(deferredOwnershipTimingReason);
      } else if (sameParticipantReplacement && !sameCapture) {
        invalidateMicTiming('Microphone capture changed.');
      }
""",
    'preserve timing invalidation lifecycle point',
)

server = replace_once(
    server,
    """      if (socket.participantId) {
        broadcastSessionStatus();
        if (ownershipChanged) beginPreparedSongHandoff(socket.participantId);
      }
""",
    """      if (socket.participantId) {
        broadcastSessionStatus();
        if (deferredHandoffParticipantId) beginPreparedSongHandoff(deferredHandoffParticipantId);
      }
""",
    'preserve handoff lifecycle point',
)

path.write_text(server)
