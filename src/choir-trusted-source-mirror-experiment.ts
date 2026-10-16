import type { PcmFrame } from './pcm-frame.js';
import type { ChoirFreshCaptureTicket } from './choir-fresh-room-handshake-experiment.js';
import type { ChoirRoomRestartCoordinatorExperiment } from './choir-room-restart-coordinator-experiment.js';

type ProducerSocket = object;

/**
 * A server-owned, bounded reference mirror for the existing verified N=1
 * primary PCM and Robot backing. It DOES NOT decode a second wire protocol,
 * buffer PCM, mix audio, produce output, or mint A/B media authority.
 *
 * The only audio admission here happens after the live production path has
 * accepted a positioned native PCM frame and its own Media Epoch has been
 * checked. The Choir room owns the separate bounded 7s Content histories.
 */
export class ChoirTrustedSourceMirrorExperiment {
  private binding: {
    primaryTicket: ChoirFreshCaptureTicket;
    primarySocket: ProducerSocket;
    primaryGeneration: number;
    primaryRate: number;
    robotBackingSocket: ProducerSocket;
    robotBackingGeneration: number;
    robotControlGeneration: number;
    robotRate: number;
  } | null = null;

  constructor(
    private readonly room: Pick<ChoirRoomRestartCoordinatorExperiment,
      'mayAcceptVerifiedTicket' | 'receiveVerifiedMic' | 'receiveTrustedRobot'
      | 'retireFailedPrimaryAdmission'>,
    private readonly current: () => {
      primarySocket: ProducerSocket | null;
      primaryOwnerId: string | null;
      primaryGeneration: number | null;
      primaryRate: number | null;
      robotBackingSocket: ProducerSocket | null;
      robotBackingGeneration: number | null;
      robotControlGeneration: number | null;
      robotRate: number | null;
      robotIsAuthoritative: boolean;
    },
  ) {}

  /**
   * One room = one exact N=1 primary publisher and one Robot backing source.
   * This binding comes only from the server's successful A room admission.
   * Any change requires an explicit new Room Epoch; no fallback to whatever
   * socket happens to be active next.
   */
  bindPrimary(ticket: ChoirFreshCaptureTicket, nowMs: number): boolean {
    const state = this.current();
    if (this.binding
      || ticket.seat !== 'primary'
      || !this.room.mayAcceptVerifiedTicket(ticket, nowMs)
      || !state.primarySocket || state.primaryOwnerId !== ticket.participantId
      || !state.robotBackingSocket || !state.robotIsAuthoritative
      || !Number.isSafeInteger(state.primaryGeneration)
      || state.primaryGeneration === null || state.primaryGeneration < 0
      || !Number.isSafeInteger(state.robotBackingGeneration)
      || state.robotBackingGeneration === null || state.robotBackingGeneration < 0
      || !Number.isSafeInteger(state.robotControlGeneration)
      || state.robotControlGeneration === null || state.robotControlGeneration < 0
      || !Number.isInteger(state.primaryRate) || state.primaryRate === null
      || state.primaryRate < 8_000 || state.primaryRate > 192_000
      || !Number.isInteger(state.robotRate) || state.robotRate === null
      || state.robotRate < 8_000 || state.robotRate > 192_000) return false;
    this.binding = {
      primaryTicket: ticket, primarySocket: state.primarySocket,
      primaryGeneration: state.primaryGeneration, primaryRate: state.primaryRate,
      robotBackingSocket: state.robotBackingSocket,
      robotBackingGeneration: state.robotBackingGeneration,
      robotControlGeneration: state.robotControlGeneration,
      robotRate: state.robotRate,
    };
    return true;
  }

  private exactSourceNow(): boolean {
    const b = this.binding;
    if (!b) return false;
    const s = this.current();
    return s.primarySocket === b.primarySocket
      && s.primaryOwnerId === b.primaryTicket.participantId
      && s.primaryGeneration === b.primaryGeneration
      && s.primaryRate === b.primaryRate
      && s.robotBackingSocket === b.robotBackingSocket
      && s.robotBackingGeneration === b.robotBackingGeneration
      && s.robotControlGeneration === b.robotControlGeneration
      && s.robotRate === b.robotRate
      && s.robotIsAuthoritative;
  }

  private retire(nowMs: number): false {
    const b = this.binding;
    this.binding = null;
    if (b) this.room.retireFailedPrimaryAdmission(nowMs);
    return false;
  }

  /** No retained input PCM: only an already-accepted production Mic frame. */
  mirrorPrimary(frame: PcmFrame, nativeFrameMirroringSafe: boolean, nowMs: number): boolean {
    const b = this.binding;
    if (!b) return false;
    if (!this.exactSourceNow()
      || !this.room.mayAcceptVerifiedTicket(b.primaryTicket, nowMs)
      || frame.generation !== b.primaryGeneration)
      return this.retire(nowMs);
    if (nativeFrameMirroringSafe !== true
      || frame.firstSampleIndex === null
      || !Number.isSafeInteger(frame.firstSampleIndex)
      || !Buffer.isBuffer(frame.pcm)) return false;
    return this.room.receiveVerifiedMic(
      b.primaryTicket, frame, b.primaryRate, nowMs,
    );
  }

  /**
   * Robot frames may enter only AFTER the real production backing session
   * accepted them. SongSession/Robot authority and exact native generation
   * are re-checked by the coordinator again before canonical ingestion.
   */
  mirrorRobot(frame: PcmFrame, nativeFrameMirroringSafe: boolean, nowMs: number): boolean {
    const b = this.binding;
    if (!b) return false;
    if (!this.exactSourceNow()
      || !this.room.mayAcceptVerifiedTicket(b.primaryTicket, nowMs)
      || frame.generation !== b.robotBackingGeneration)
      return this.retire(nowMs);
    if (nativeFrameMirroringSafe !== true
      || frame.firstSampleIndex === null
      || !Number.isSafeInteger(frame.firstSampleIndex)
      || !Buffer.isBuffer(frame.pcm)) return false;
    return this.room.receiveTrustedRobot(
      b.primaryTicket.roomEpoch, b.primaryTicket.songEpoch,
      frame, b.robotRate, nowMs,
    );
  }

  /** The coordinator has retired this exact Room Epoch, even if no new PCM arrives. */
  revokeRoom(roomEpoch: number): boolean {
    if (this.binding?.primaryTicket.roomEpoch !== roomEpoch) return false;
    this.binding = null;
    return true;
  }

  /** Native source capture/control changed: never combine old PCM history. */
  sourceDiscontinuity(nowMs: number): boolean {
    if (!this.binding) return false;
    this.retire(nowMs);
    return true;
  }

  get roomEpoch(): number | null {
    return this.binding?.primaryTicket.roomEpoch ?? null;
  }
}
