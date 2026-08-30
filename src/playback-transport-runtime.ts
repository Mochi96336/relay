import type { PlaybackIdentity } from './song-session.js';

type PlaybackTransportSocket = {
  playbackParticipantId?: string;
  playbackTransportId?: string;
  playbackGeneration?: number;
  playbackMicIntentAtMs?: number;
};

type PlaybackTransportRuntimeOptions<Socket> = {
  clients(): Iterable<Socket>;
  isOpen(socket: Socket): boolean;
  send(socket: Socket, payload: unknown): void;
  micIntentMs: number;
};

function sameIdentity(a: PlaybackIdentity, b: PlaybackIdentity) {
  return a.participantId === b.participantId
    && a.transportId === b.transportId
    && a.generation === b.generation;
}

export class PlaybackTransportRuntime<Socket extends PlaybackTransportSocket> {
  constructor(private readonly options: PlaybackTransportRuntimeOptions<Socket>) {
    if (!Number.isFinite(options.micIntentMs) || options.micIntentMs <= 0) {
      throw new Error('Playback transport micIntentMs must be positive.');
    }
  }

  identity(socket: Socket): PlaybackIdentity | null {
    if (
      !socket.playbackParticipantId
      || !socket.playbackTransportId
      || socket.playbackGeneration === undefined
    ) return null;
    return {
      participantId: socket.playbackParticipantId,
      transportId: socket.playbackTransportId,
      generation: socket.playbackGeneration,
    };
  }

  register(socket: Socket, identity: PlaybackIdentity) {
    socket.playbackParticipantId = identity.participantId;
    socket.playbackTransportId = identity.transportId;
    socket.playbackGeneration = identity.generation;
    return identity;
  }

  noteMicIntent(socket: Socket, nowMs: number) {
    if (!this.identity(socket)) return false;
    socket.playbackMicIntentAtMs = nowMs;
    return true;
  }

  send(identity: PlaybackIdentity, payload: unknown) {
    let sent = 0;
    for (const socket of this.options.clients()) {
      const candidate = this.identity(socket);
      if (
        this.options.isOpen(socket)
        && candidate
        && sameIdentity(candidate, identity)
      ) {
        this.options.send(socket, payload);
        sent += 1;
      }
    }
    return sent;
  }

  connected(identity: PlaybackIdentity) {
    for (const socket of this.options.clients()) {
      if (!this.options.isOpen(socket)) continue;
      const candidate = this.identity(socket);
      if (candidate && sameIdentity(candidate, identity)) return true;
    }
    return false;
  }

  selectHandoffTarget(participantId: string, nowMs: number) {
    const candidates: Array<{ identity: PlaybackIdentity; intentAtMs: number }> = [];
    for (const socket of this.options.clients()) {
      const identity = this.identity(socket);
      if (
        !this.options.isOpen(socket)
        || !identity
        || identity.participantId !== participantId
      ) continue;
      candidates.push({
        identity,
        intentAtMs: socket.playbackMicIntentAtMs ?? -Infinity,
      });
    }

    const intended = candidates
      .filter((candidate) => nowMs - candidate.intentAtMs <= this.options.micIntentMs)
      .sort((a, b) => b.intentAtMs - a.intentAtMs);
    if (intended.length > 0) return intended[0].identity;

    // The caller invokes this only after a Mic ownership action. With no recent
    // intent, a single transport is unambiguous; multiple tabs must not be guessed.
    return candidates.length === 1 ? candidates[0].identity : null;
  }
}
