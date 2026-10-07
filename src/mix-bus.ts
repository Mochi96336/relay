/**
 * How the song takes a voice in, and lets it go, without a step.
 *
 * The song gain and its steady summing headroom both follow whether a
 * microphone is expected. Switched instantly that is a step of several dB in
 * the middle of a song - plainly audible, and a worse fault than the level it
 * corrects - so both ramp over SONG_DUCK_RAMP_MS. Registration often leads
 * real PCM, but correctness must not depend on that race: the join crossfade
 * owns any audio that arrives before the ramp settles.
 */
const SONG_DUCK_RAMP_MS = 150;
/**
 * A Mic can become audible before the slower musical duck has established
 * two-source headroom. Crossfade from the existing song-only bus into the
 * already-safe two-source bus instead of asking the final hard clamp to absorb
 * that semantic join.
 */
const SOURCE_JOIN_SAFETY_CROSSFADE_MS = 10;

/**
 * Worst-case linear sum of a limited voice plus the song at `songGain`. A
 * fixed attenuation preserves their relative balance and introduces no
 * attack/release artefacts.
 *
 * Only worth paying when both sources are actually present: it is headroom for
 * a sum, and a room with one source has nothing to sum. Charging it to a song
 * playing on its own made the song quieter to leave room for a voice that was
 * not there.
 */
function sumHeadroomGain(voiceCeiling: number, songGain: number) {
  const maximumLinearSum = voiceCeiling + Math.abs(songGain);
  return maximumLinearSum > 1 ? 1 / maximumLinearSum : 1;
}

export type BusSource = 'mic' | 'backing';

export type MixBusOptions = {
  sampleRate: number;
  backingGain: number;
  /** The most the limited voice can contribute to the sum, linear. */
  voiceCeiling: number;
};

/**
 * Which sources own the summing bus - the song alone, the voice alone, or
 * both - and how the mix moves between them.
 *
 * Expectation is transport and product intent, not proof that a source has
 * stopped reaching the bus. Two-source ownership is held until the departing
 * source has completed its own audible fade to silence.
 */
export class MixBus {
  private readonly backingGain: number;
  private readonly backingSumHeadroomGain: number;
  private readonly voiceCeiling: number;
  private readonly duckStep: number;
  private readonly joinSafetyStep: number;
  private readonly sources = {
    mic: { expected: false, releaseHeld: false },
    backing: { expected: false, releaseHeld: false },
  };
  /** 0 while the song has the room to itself, 1 once it is out of a voice's way. */
  private duck = 0;
  /**
   * A source joining an already-audible peer is not merely a slow gain change.
   * Until the normal duck reaches its steady state, crossfade from the
   * previously audible single-source bus into a mathematically safe two-source
   * bus. Track which source joined so the old endpoint is unambiguous.
   */
  private joinSafetyPending: BusSource | null = null;
  private joinSafetyActiveValue: BusSource | null = null;
  private joinSafetyBlend = 0;

  constructor(options: MixBusOptions) {
    this.backingGain = options.backingGain;
    this.voiceCeiling = options.voiceCeiling;
    this.backingSumHeadroomGain = sumHeadroomGain(options.voiceCeiling, options.backingGain);
    this.duckStep = 1 / Math.max(
      1,
      Math.round((SONG_DUCK_RAMP_MS / 1000) * options.sampleRate),
    );
    this.joinSafetyStep = 1 / Math.max(
      1,
      Math.round((SOURCE_JOIN_SAFETY_CROSSFADE_MS / 1000) * options.sampleRate),
    );
  }

  get micExpected() {
    return this.sources.mic.expected;
  }

  get backingExpected() {
    return this.sources.backing.expected;
  }

  /** Whether a departed Mic still owns the bus until its retained audio has played out. */
  get micReleaseHeld() {
    return this.sources.mic.releaseHeld;
  }

  get backingReleaseHeld() {
    return this.sources.backing.releaseHeld;
  }

  get joinSafetyActive() {
    return this.joinSafetyActiveValue;
  }

  /** A new mix epoch starts from what the room currently is, not from wherever a ramp stopped. */
  reset() {
    this.duck = this.sources.backing.expected && this.sources.mic.expected ? 1 : 0;
    this.joinSafetyPending = null;
    this.joinSafetyActiveValue = null;
    this.joinSafetyBlend = 0;
    this.sources.mic.releaseHeld = false;
    this.sources.backing.releaseHeld = false;
  }

  /**
   * Whether a source is meant to be streaming. Starvation is only meaningful
   * for a source that is supposed to be there; an absent phone is not a fault.
   */
  setMicExpected(expected: boolean, running: boolean) {
    this.setExpected('mic', expected, running);
  }

  setBackingExpected(expected: boolean, running: boolean) {
    this.setExpected('backing', expected, running);
  }

  private setExpected(source: BusSource, expected: boolean, running: boolean) {
    const state = this.sources[source];
    const peer = this.sources[source === 'mic' ? 'backing' : 'mic'];
    const changed = expected !== state.expected;
    const joiningPeer = Boolean(
      changed && expected && running
      && (peer.expected || peer.releaseHeld) && !state.releaseHeld
    );
    state.expected = expected;

    if (changed && !expected && running) {
      // Transport intent cannot release retained/fading PCM. The timeline
      // owner completes this hold once the audible tail has actually ended.
      state.releaseHeld = true;
      if (this.joinSafetyPending === source) this.joinSafetyPending = null;
    } else if (changed && expected) {
      // Rejoining a held source continues the existing audible bus.
      state.releaseHeld = false;
      if (joiningPeer && this.joinSafetyActiveValue === null) {
        // Arm at registration; begin the crossing only when its PCM is real.
        this.joinSafetyPending = source;
        this.joinSafetyBlend = 0;
      }
    }
  }

  /**
   * Where the duck is heading for a frame. The song gain and the summing
   * headroom both exist to leave space for a voice, so both are worth paying
   * only when both sources can be there.
   */
  duckTarget() {
    return this.twoSourceOwnership ? 1 : 0;
  }

  /** Ramped per sample: several dB arriving in one sample is a click. */
  advanceDuck(target: number) {
    if (this.duck < target) {
      this.duck = Math.min(target, this.duck + this.duckStep);
    } else if (this.duck > target) {
      this.duck = Math.max(target, this.duck - this.duckStep);
    }
  }

  get songGain() {
    return 1 + this.duck * (this.backingGain - 1);
  }

  get headroomGain() {
    return 1 + this.duck * (this.backingSumHeadroomGain - 1);
  }

  /** Whether both sources own the bus at this sample, counting release holds. */
  get twoSourceOwnership() {
    return Boolean(
      (this.sources.mic.expected || this.sources.mic.releaseHeld)
      && (this.sources.backing.expected || this.sources.backing.releaseHeld)
    );
  }

  /**
   * The joining source enters through the crossfade as soon as it is real.
   * Waiting for its peer too let it play through the ordinary sum whenever the
   * peer happened to be missing at that moment; the crossfade then started
   * from the peer alone and cut the source already heard. With the peer
   * missing, the zero-blend endpoint is silence.
   */
  private startJoinIfReal(micAudibleMissing: boolean, backingSourceMissing: boolean, twoSourceOwnership: boolean) {
    const joiningSourceReal = this.joinSafetyPending === 'mic'
      ? !micAudibleMissing
      : !backingSourceMissing;
    if (
      this.joinSafetyPending !== null
      && this.joinSafetyActiveValue === null
      && twoSourceOwnership
      && joiningSourceReal
    ) {
      this.joinSafetyActiveValue = this.joinSafetyPending;
      this.joinSafetyPending = null;
      this.joinSafetyBlend = 0;
    }
  }

  /** The departed Mic has run out: silent at the output and read past everything it retained. */
  releaseMicHold() {
    this.sources.mic.releaseHeld = false;
  }

  releaseBackingHold() {
    this.sources.backing.releaseHeld = false;
  }

  /**
   * Sum one sample after both source edges have been applied. Ownership is the
   * snapshot taken before those edges can finish a release: a hold completed
   * on this sample changes the join target on the following sample.
   *
   * Song contribution already includes songGain, so source edge shaping stays
   * with the timeline owner. The bus owns the summing headroom and join path.
   */
  mixSample(
    voice: number,
    songContribution: number,
    twoSourceOwnership: boolean,
    micAudibleMissing: boolean,
    backingSourceMissing: boolean,
  ) {
    this.startJoinIfReal(micAudibleMissing, backingSourceMissing, twoSourceOwnership);
    const summed = voice + songContribution;
    const mixHeadroomGain = this.headroomGain;
    return this.joinSafetyActiveValue === null
      ? summed * mixHeadroomGain
      : this.joinSafetyValue(
          summed,
          voice,
          songContribution,
          this.songGain,
          mixHeadroomGain,
          twoSourceOwnership,
          micAudibleMissing,
          backingSourceMissing,
        );
  }

  /**
   * One sample's mix value while a source crosses between the single-source
   * bus and the two-source bus, ending the crossing once it is complete.
   */
  private joinSafetyValue(
    summed: number,
    voice: number,
    songContribution: number,
    songGain: number,
    mixHeadroomGain: number,
    twoSourceOwnership: boolean,
    micAudibleMissing: boolean,
    backingSourceMissing: boolean,
  ) {
    const targetBlend = twoSourceOwnership ? 1 : 0;
    if (this.joinSafetyBlend < targetBlend) {
      this.joinSafetyBlend = Math.min(
        targetBlend,
        this.joinSafetyBlend + this.joinSafetyStep,
      );
    } else if (this.joinSafetyBlend > targetBlend) {
      this.joinSafetyBlend = Math.max(
        targetBlend,
        this.joinSafetyBlend - this.joinSafetyStep,
      );
    }

    // While entering a two-source bus, the zero-blend endpoint is the peer
    // that was already audible before the recorded joining source arrived.
    // While leaving, expectation release holds ensure targetBlend stays at 1
    // until one source is actually missing; then the zero-blend endpoint is
    // whichever real source remains. Both endpoints are bounded, so their
    // convex crossfade never needs the final hard clamp.
    let singleSourceValue: number;
    if (targetBlend === 1) {
      singleSourceValue = this.joinSafetyActiveValue === 'mic'
        ? songContribution * mixHeadroomGain
        : voice * mixHeadroomGain;
    } else if (!micAudibleMissing && backingSourceMissing) {
      singleSourceValue = voice * mixHeadroomGain;
    } else if (micAudibleMissing && !backingSourceMissing) {
      singleSourceValue = songContribution * mixHeadroomGain;
    } else if (micAudibleMissing && backingSourceMissing) {
      singleSourceValue = 0;
    } else {
      // Defensive fallback: effective ownership should not release while
      // both sources remain real, but preserve the original pre-join peer
      // if a future policy change violates that assumption.
      singleSourceValue = this.joinSafetyActiveValue === 'mic'
        ? songContribution * mixHeadroomGain
        : voice * mixHeadroomGain;
    }

    const safeTwoSourceGain = sumHeadroomGain(this.voiceCeiling, songGain);
    const safeTwoSourceValue = summed * safeTwoSourceGain;
    const blend = this.joinSafetyBlend;
    const value = singleSourceValue * (1 - blend) + safeTwoSourceValue * blend;

    if (
      targetBlend === 1
      && blend === 1
      && this.duck === 1
    ) {
      // At steady duck the safe endpoint is byte-for-byte the ordinary
      // two-source path, so safety ownership can return without a seam.
      this.joinSafetyActiveValue = null;
      this.joinSafetyBlend = 0;
    } else if (
      targetBlend === 0
      && blend === 0
      && (micAudibleMissing || backingSourceMissing)
    ) {
      this.joinSafetyActiveValue = null;
      this.joinSafetyBlend = 0;
    }

    return value;
  }
}
