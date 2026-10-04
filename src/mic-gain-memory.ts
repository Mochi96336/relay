/**
 * The Mic gain each participant last chose, so the gain follows the device.
 *
 * Raw capture level differs by 20 dB or more between phones, so one room-wide
 * gain is right only for the singer who last set it; every handoff otherwise
 * starts with somebody else's setting. A `participantId` is per-browser
 * identity (SESSION_MODEL.md), the closest thing Relay has to "this device".
 *
 * Held in memory for the server's lifetime only. A server restart forgets it,
 * and a device it does not know starts from the default.
 *
 * This owns no authority: `AudioSession` still holds the applied gain and the
 * set-mix command policy still decides who may change it.
 */

export type RememberedMicGain = {
  gainDb: number;
  /** False when the participant never set a gain and the default applies. */
  remembered: boolean;
};

export type MicGainMemoryOptions = {
  defaultGainDb: number;
  /** Oldest choices are forgotten past this many participants. */
  maxParticipants?: number;
};

export class MicGainMemory {
  readonly defaultGainDb: number;
  readonly maxParticipants: number;
  /** Insertion order is recency: `remember` moves a participant to the end. */
  private readonly gains = new Map<string, number>();

  constructor(options: MicGainMemoryOptions) {
    if (!Number.isFinite(options.defaultGainDb)) {
      throw new RangeError('defaultGainDb must be finite');
    }
    const maxParticipants = options.maxParticipants ?? 256;
    if (!Number.isInteger(maxParticipants) || maxParticipants < 1) {
      throw new RangeError('maxParticipants must be a positive integer');
    }
    this.defaultGainDb = options.defaultGainDb;
    this.maxParticipants = maxParticipants;
  }

  gainFor(participantId: string): RememberedMicGain {
    const gainDb = this.gains.get(participantId);
    return gainDb === undefined
      ? { gainDb: this.defaultGainDb, remembered: false }
      : { gainDb, remembered: true };
  }

  remember(participantId: string, gainDb: number) {
    if (!Number.isFinite(gainDb)) return;
    this.gains.delete(participantId);
    this.gains.set(participantId, gainDb);
    while (this.gains.size > this.maxParticipants) {
      const oldest = this.gains.keys().next().value!;
      this.gains.delete(oldest);
    }
  }
}
