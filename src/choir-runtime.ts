import WebSocket from 'ws';
import type { AudioSession } from './audio-session.js';
import { ChoirContent, createChoirContentWorkerAnalyzer } from './choir-content.js';
import { ChoirIngress } from './choir-ingress.js';
import { ChoirMediaClaims } from './choir-media-claims.js';
import { ChoirProbe, type ProbeLegConfig } from './choir-probe.js';
import { ChoirSeat } from './choir-seat.js';
import type { ProductDuet } from './product-view-model.js';
import type { RelaySocket } from './relay-socket-server.js';
import { SampleSongFallback, type SongSampleAnchor } from './sample-song-fallback.js';

/** What the second singer needs from the rest of Relay. See CHOIR.md. */
export type ChoirRuntimeDeps = {
  session: AudioSession;
  /** Content windows below this confidence are not a measurement. */
  contentMinConfidence: number;
  /** The boot probe's own settings, for B's test tone. */
  probe: Omit<ProbeLegConfig, 'sampleRate' | 'sessionSampleAt'>;
  /** B may send Opus v3, as the main Mic may. */
  opusAllowed: boolean;
  mic: {
    ownerId: () => string | null;
    /** Whose capture the Mic's media is. */
    mediaOwnerId: () => string | null;
    controlConnected: () => boolean;
  };
  participantConnected: (id: string) => boolean;
  nickname: (id: string) => string | null;
  /** A short, log-safe name for a participant. */
  logLabel: (id: string) => unknown;
  send: (socket: RelaySocket, payload: Record<string, unknown>) => void;
  /** An infrastructure socket (the Robot's) is never a singer. */
  isInfrastructure: (socket: RelaySocket) => boolean;
  song: {
    /** The room's own song: its state, videoId and playbackRate. */
    room: (nowMs: number) => Record<string, unknown>;
    /** The video the main Mic's sample/song mapping is on, if any. */
    videoId: (nowMs: number) => string | null;
    /** A song plays and its backing is playable. */
    playing: (nowMs: number) => boolean;
    playbackRate: (nowMs: number) => number;
  };
  /** A Take records or finalizes: alignment holds. */
  takeBlocksCalibration: () => boolean;
  robot: {
    /** The Robot can be asked for notes now (connected, not mid boot probe). */
    available: () => boolean;
    playProbe: (request: { requestId: number; leadMs: number }) => boolean;
    /** The Robot route's own boot probe leg, kept by the server. */
    backingLatencyMs: () => number | null;
    keepBackingPath: (latencyMs: number) => void;
    playerOffsetMs: (nowMs: number) => number;
  };
  productStatusChanged: () => void;
  /** A requested Mic gain clamped to the allowed range, or null. */
  requestedGainDb: (value: unknown) => number | null;
};

type SecondaryPlacement = {
  lagMs: number;
  source: 'content' | 'probe' | 'youtube-time' | 'no-song';
};

const MEDIA_MESSAGES = new Set(['choir-secondary-media-claim-request', 'choir-secondary-media-register']);
const JOIN_MESSAGES = new Set(['choir-secondary-join', 'choir-secondary-withdraw']);
const REPORT_MESSAGES = new Set([
  'choir-secondary-song-anchor', 'choir-secondary-page', 'choir-secondary-gain',
  'choir-probe-played', 'choir-probe-failed', 'choir-probe-request',
]);

/**
 * With Choir off: whether this is a second Mic message. It is then refused
 * (a join or media request is told so) rather than left to the ordinary
 * protocols.
 */
export function refuseChoirMessage(payload: Record<string, unknown>,
  reply: (refusal: Record<string, unknown>) => void): boolean {
  const type = String(payload.type);
  if (JOIN_MESSAGES.has(type)) reply({ type: 'choir-consent-rejected', reason: 'unavailable' });
  else if (MEDIA_MESSAGES.has(type)) reply({ type: 'choir-media-rejected', reason: 'disabled-or-unverified' });
  else return REPORT_MESSAGES.has(type);
  return true;
}

/** One line per Choir step, so a real two-device run can be read back. */
function logChoir(event: string, fields: Record<string, unknown> = {}) {
  console.log('[choir]', JSON.stringify({ event, ...fields }));
}

/**
 * The second singer, B, beside the Mic owner, A: who B is (ChoirSeat), how
 * B's media socket is granted (ChoirMediaClaims) and checked (ChoirIngress),
 * and where B is placed in the room output (Content, test tone, YouTube time).
 *
 * B is a second MicTrack in the N=1 AudioSession, so Listen, Take and timing
 * need no path of their own. The server calls in at its own seams: socket
 * messages, binary frames and closes, each mix frame, captured PCM and the
 * Robot's song anchors and probe replies.
 */
export class ChoirRuntime {
  private readonly seat: ChoirSeat;
  private readonly ingress: ChoirIngress;
  private readonly claims: ChoirMediaClaims;
  /**
   * Places B against A by Content on the room output's own timeline: both
   * singers' PCM as the mixer holds it, against the backing the main Content
   * calibration sees.
   */
  private readonly content: ChoirContent;
  /**
   * B's own test tone: the boot probe's Mic leg for the second singer, sent to
   * the page B joined from, after a Robot leg of its own when none is kept.
   */
  private readonly probe: ChoirProbe;
  /**
   * B's YouTube-time alignment, as the main Mic's sample/song fallback: B's
   * page reports which capture sample was recorded at which point of its local
   * YouTube, the Robot reports the same for the backing, and the difference
   * places B in the room output within seconds.
   */
  private readonly sampleSong = new SampleSongFallback();
  private sampleSongOwner: string | null = null;
  /** B's own remembered Mic gain, from its media registration; null keeps the default. */
  private secondaryGainDb: number | null = null;
  /** The song epoch Content is measuring; null while there is nothing to measure. */
  private contentKey: string | null = null;
  private contentVideoId: string | null = null;
  private lastMediaReadySentMs = Number.NEGATIVE_INFINITY;
  private lastProbeState: string | null = null;
  private lastAudible = false;
  private lastRecentlyHeard = false;
  private lastLagSource: SecondaryPlacement['source'] | null = null;
  private lastPageReport = '';

  constructor(private readonly deps: ChoirRuntimeDeps) {
    const { session } = deps;
    const open = (socket: object) => (socket as RelaySocket).readyState === WebSocket.OPEN;
    this.seat = new ChoirSeat({
      primaryStillOwnsMic: id =>
        deps.mic.ownerId() === id && deps.mic.mediaOwnerId() === id
        && deps.mic.controlConnected() && deps.participantConnected(id),
      holdsMic: id => deps.mic.ownerId() === id,
      participantConnected: deps.participantConnected,
      socketOpen: open,
      notifySocket: (raw, payload) => {
        const socket = raw as RelaySocket;
        if (payload.status === 'revoked') logChoir('b-revoked', { reason: payload.reason,
          participant: socket.participantId ? deps.logLabel(socket.participantId) : null });
        deps.send(socket, payload);
      },
    });
    this.ingress = new ChoirIngress(open, (participantId) => this.liveVoiceAllowed(participantId));
    // B's frame passed the ingress; the room output holds it too, silent until
    // placeSecondary() gives B a lag.
    this.ingress.onAcceptedFrame = (frame, sampleRate, participantId, nowMs) => {
      if (this.seat.active()?.secondaryId !== participantId) return;
      if (!session.secondaryMic) {
        session.attachSecondaryMic();
        if (this.secondaryGainDb !== null) session.setSecondaryMicGainDb(this.secondaryGainDb);
        this.content.reset('b-attached', { hard: true });
      }
      const ingested = session.ingestSecondaryMic(frame, sampleRate, nowMs);
      if (!ingested) return;
      if (ingested.captureRestarted) this.content.reset('b-capture-restarted', { hard: true });
      this.content.observeSecondary(ingested.samples, ingested.start);
    };
    this.claims = new ChoirMediaClaims(this.ingress, open, (raw) => {
      const socket = raw as RelaySocket;
      return Boolean(socket.participantId) && this.seat.isJoinSocket(socket)
        && this.liveVoiceAllowed(socket.participantId!);
    });
    this.content = new ChoirContent({
      sampleRate: session.sampleRate,
      minConfidence: deps.contentMinConfidence,
      analyze: createChoirContentWorkerAnalyzer(session.sampleRate),
    });
    this.probe = new ChoirProbe({
      ...deps.probe,
      sampleRate: session.sampleRate,
      sessionSampleAt: (atMs) => session.sessionSampleAt(atMs),
      secondary: {
        totalSamples: () => session.secondaryMicTotalSamples,
        generation: () => session.secondaryMicGeneration,
        read: (start, count) => session.readSecondaryMic(start, count),
        evidence: (start, count) => session.readSecondaryMicEvidence(start, count),
      },
      backing: {
        totalSamples: () => session.backingTotalSamples,
        generation: () => null,
        read: (start, count) => session.readBacking(start, count),
        evidence: (start, count) => session.readBackingEvidence(start, count),
      },
      backingLatencyMs: deps.robot.backingLatencyMs,
      onBackingMeasured: deps.robot.keepBackingPath,
      robotAvailable: deps.robot.available,
      sendSecondary: (request) => {
        const socket = this.joinSocket();
        if (!socket) return false;
        deps.send(socket, { type: 'choir-probe', ...request });
        return true;
      },
      sendRobot: deps.robot.playProbe,
    });
    console.log('[choir] enabled: a second Mic can join whoever holds the Mic');
  }

  /**
   * B is heard while joined, song or no song: B is the joined singer and the
   * singer B joined still holds the Mic.
   */
  private liveVoiceAllowed(participantId: string) {
    const joined = this.seat.active();
    return joined !== null && joined.secondaryId === participantId
      && this.deps.mic.ownerId() === joined.primaryId;
  }

  /** The socket B joined from, while it is open: the only one that speaks for B. */
  private joinSocket(): RelaySocket | null {
    const socket = this.seat.active()?.socket as RelaySocket | undefined;
    return socket && socket.readyState === WebSocket.OPEN ? socket : null;
  }

  /** Tells an authenticated page that the second Mic is on offer. */
  welcome(socket: RelaySocket) {
    this.deps.send(socket, { type: 'choir-available' });
  }

  /**
   * A JSON message: B's join, media and page reports. Returns true when it was
   * Choir's, including anything a bound media socket sends: that socket
   * carries only its packets, and never claims the main Mic, a Take, the Robot
   * or the song.
   */
  handleMessage(socket: RelaySocket, payload: Record<string, unknown>): boolean {
    if (this.ingress.isAttached(socket)) return true;
    const type = String(payload.type);
    if (MEDIA_MESSAGES.has(type)) this.handleMedia(socket, payload);
    else if (JOIN_MESSAGES.has(type)) this.handleJoin(socket, payload);
    else if (REPORT_MESSAGES.has(type)) this.handleReport(socket, payload);
    else return false;
    return true;
  }

  /**
   * A binary frame. A bound socket's frames are B's and never reach the main
   * Mic, backing, recording or monitor paths, even malformed. Returns whether
   * Choir took it.
   */
  interceptBinary(socket: RelaySocket, data: Buffer, nowMs: number) {
    return this.ingress.interceptBinary(socket, data, nowMs).intercepted;
  }

  socketClosed(socket: RelaySocket) {
    this.claims.disconnected(socket);
    if (this.seat.disconnected(socket))
      logChoir('consent-disconnected', { participant: socket.participantId ? this.deps.logLabel(socket.participantId) : null });
    if (this.ingress.disconnect(socket)) logChoir('b-media-disconnected', {
      participant: socket.participantId ? this.deps.logLabel(socket.participantId) : null,
    });
  }

  /** Releases sockets and claims whose join ended without a frame or a close. */
  sweep(nowMs: number) {
    this.ingress.sweepStale(nowMs);
    this.seat.sweep();
    this.claims.sweep(nowMs);
  }

  /** The timeline tick: a sweep, then Content's windows. */
  tick(nowMs: number) {
    this.sweep(nowMs);
    this.tickContent(nowMs);
  }

  /** Once per mix frame: ask B for media if it has none, and place B. */
  afterMixFrame(nowMs: number) {
    this.askForMedia(nowMs);
    this.placeSecondary(nowMs);
  }

  /** The main Mic's captured PCM, as the mixer holds it. */
  primaryCaptured(samples: Int16Array, start: number) {
    if (this.deps.session.secondaryMic) this.content.observePrimary(samples, start);
  }

  primaryCaptureRestarted() {
    this.content.reset('a-capture-restarted', { hard: true });
  }

  /**
   * The Robot's backing as the mixer sums it. B is placed by its lag relative
   * to A, both against this same backing, so the backing's own song mapping
   * cancels: the raw room position is the right coordinate.
   */
  backingCaptured(samples: Int16Array, start: number) {
    if (this.deps.session.secondaryMic) this.content.observeBacking(samples, start);
  }

  backingCaptureRestarted() {
    this.content.reset('backing-capture-restarted');
  }

  /** The Robot moved to new content: Content's open windows straddle it. */
  robotContentTransition() {
    this.content.reset('robot-transition');
  }

  /** Where the Robot's song was at a backing capture sample. */
  backingSongAnchor(anchor: SongSampleAnchor, nowMs: number) {
    this.sampleSong.observe('backing', anchor, nowMs);
  }

  /** The Robot's reply to B's test tone's Robot leg; false when the request is not Choir's. */
  robotProbeReply(payload: Record<string, unknown>, nowMs: number) {
    if (!this.probe.ownsRobotRequest(payload.requestId)) return false;
    if (payload.type === 'calibration-probe-played') {
      this.probe.robotPlayed({ requestId: payload.requestId, timingDiagnostics: payload.timingDiagnostics }, nowMs);
    } else {
      this.probe.clientFailed({ requestId: payload.requestId, reason: payload.reason }, nowMs);
    }
    return true;
  }

  /**
   * What the room shows about a second singer: joined (B's audio not
   * connected yet), aligning (connected, not heard yet: its test tone is
   * sounding, or it waits for a lag) or singing (B is in the room mix that
   * Listen and Take carry).
   */
  view(): ProductDuet | null {
    const joined = this.seat.active();
    if (!joined) return null;
    const secondary = this.deps.session.secondaryMic;
    // Allowed to sound is not singing: B's PCM must also be reaching the mix.
    const singing = secondary?.audible === true && secondary.blend > 0 && secondary.recentlyHeard;
    // Where B is placed, as B's own Realign shows it: the measured target, not
    // each step of the slew toward it, so the room status does not churn.
    const lag = secondary?.targetLagMs ?? secondary?.lagMs ?? null;
    return {
      secondaryId: joined.secondaryId,
      secondaryNickname: this.deps.nickname(joined.secondaryId),
      state: singing ? 'singing' : this.ingress.liveTransportFor(joined.secondaryId) ? 'aligning' : 'joined',
      lagMs: lag === null || !Number.isFinite(lag) ? null : Math.round(lag),
      realigning: this.probe.running,
    };
  }

  /** The `/statusz` audio fields. */
  status(nowMs: number) {
    return {
      duetSecondary: this.deps.session.secondaryMic,
      duetIngress: { ...this.ingress.counts, codec: this.ingress.codec },
      duetContent: this.content.status(),
      duetProbe: this.probe.status(),
      duetYoutube: { lagSource: this.lastLagSource, ...this.sampleSong.diagnostics(nowMs) },
    };
  }

  /**
   * B's media, in two steps: B's join socket asks for a one-use claim, and a
   * separate media socket of B's redeems it with its registration.
   */
  private handleMedia(socket: RelaySocket, payload: Record<string, unknown>) {
    const { deps } = this;
    if (!socket.participantId || socket.role !== 'unknown' || deps.isInfrastructure(socket)
      || !deps.participantConnected(socket.participantId)) {
      deps.send(socket, { type: 'choir-media-rejected', reason: 'disabled-or-unverified' });
      return;
    }
    const nowMs = performance.now();
    if (payload.type === 'choir-secondary-media-claim-request') {
      const claim = this.claims.issue(socket, nowMs);
      logChoir(claim ? 'b-claim' : 'b-claim-refused', { participant: deps.logLabel(socket.participantId) });
      deps.send(socket, claim
        ? { type: 'choir-secondary-media-claim', ...claim }
        : { type: 'choir-media-rejected', reason: 'claim-not-authorized' });
      return;
    }
    const token = payload.claimToken;
    const rate = payload.sampleRate;
    const version = payload.packetVersion;
    // B speaks PCM v2, or Opus v3 when the Mic codec trial is on (as the main Mic).
    const granted = typeof token === 'string'
      && (version === 2 || (version === 3 && deps.opusAllowed)) && typeof rate === 'number'
      ? this.claims.redeem(socket, token, rate, version, nowMs) : null;
    if (!granted) {
      deps.send(socket, { type: 'choir-media-rejected', reason: 'claim-invalid-or-expired' });
      return;
    }
    logChoir('b-media-registered', {
      participant: deps.logLabel(socket.participantId),
      sampleRate: rate, codec: version === 3 ? 'opus' : 'pcm',
    });
    this.secondaryGainDb = deps.requestedGainDb(payload.micGainDb);
    if (this.secondaryGainDb !== null) deps.session.setSecondaryMicGainDb(this.secondaryGainDb);
    deps.send(socket, { type: 'choir-secondary-media-registered', packetVersion: version, sampleRate: rate });
  }

  /** B joins whoever holds the Mic, or leaves. */
  private handleJoin(socket: RelaySocket, payload: Record<string, unknown>) {
    const { deps } = this;
    if (!socket.participantId || socket.role !== 'unknown' || !deps.participantConnected(socket.participantId)) {
      deps.send(socket, { type: 'choir-consent-rejected', reason: 'unavailable' });
      return;
    }
    const nowMs = performance.now();
    const ownerId = deps.mic.ownerId();
    const joining = payload.type === 'choir-secondary-join';
    let accepted: boolean;
    if (!joining) {
      accepted = this.seat.withdraw(socket);
    } else {
      // The joiner never names the other singer: it is whoever holds the Mic.
      accepted = ownerId !== null
        // A local file song exists only on the Mic owner's phone: a second
        // singer could neither hear it nor be aligned to it.
        && !deps.session.micPremixed
        && deps.mic.mediaOwnerId() === ownerId
        && (payload.resume !== true || payload.expectedPrimaryId === ownerId)
        && this.seat.join(socket, ownerId, { resume: payload.resume === true });
      if (accepted) {
        // Ask for B's media now rather than on the next mix frame.
        this.lastMediaReadySentMs = Number.NEGATIVE_INFINITY;
        this.askForMedia(nowMs);
      }
    }
    logChoir(joining ? (accepted ? 'b-joined' : 'b-join-refused') : 'b-left', {
      participant: deps.logLabel(socket.participantId),
      micOwner: ownerId ? deps.logLabel(ownerId) : null,
      ...(joining ? { resume: payload.resume === true } : {
        reason: typeof payload.reason === 'string' ? payload.reason.slice(0, 80) : 'unspecified',
      }),
      ...(accepted ? {} : { mediaOwnerMatches: deps.mic.mediaOwnerId() === ownerId }),
    });
    if (!accepted) deps.send(socket, { type: 'choir-consent-rejected', reason: 'invalid-or-stale' });
    else if (!joining) deps.send(socket, {
      type: 'choir-secondary-consent-status', status: 'withdrawn', secondaryId: socket.participantId,
    });
  }

  /**
   * Reports from the joined B's page, never answered:
   * - choir-secondary-song-anchor: which capture sample was recorded at which
   *   point of B's local YouTube, for B's YouTube-time alignment;
   * - choir-secondary-page: what B's page shows and plays (its local player
   *   state), logged on change, so a silent or songless B can be explained;
   * - choir-secondary-gain: B's own Mic gain, set on B's page as the main
   *   Mic's is on the owner's;
   * - choir-probe-*: B's test tone played or failed, or B's own Realign.
   */
  private handleReport(socket: RelaySocket, payload: Record<string, unknown>) {
    const { deps } = this;
    const nowMs = performance.now();
    const joined = this.seat.active();
    // Only the socket B joined from speaks for B, as only it may claim B's media.
    if (!joined || socket !== joined.socket || socket.role !== 'unknown') return;
    switch (payload.type) {
      case 'choir-probe-played':
        this.probe.played({
          requestId: payload.requestId, generation: payload.generation,
          timingDiagnostics: payload.timingDiagnostics,
        }, nowMs);
        return;
      case 'choir-probe-failed':
        this.probe.clientFailed({ requestId: payload.requestId, reason: payload.reason }, nowMs);
        return;
      case 'choir-probe-request': {
        // B's own Realign: only B's test tone; the main Mic's alignment is untouched.
        const generation = deps.session.secondaryMicGeneration;
        if (generation !== null && !deps.takeBlocksCalibration()
          && this.probe.realign(`${joined.secondaryId}:${generation}`, nowMs)) {
          logChoir('b-realign', {});
          deps.productStatusChanged();
        }
        return;
      }
      case 'choir-secondary-gain': {
        const gainDb = deps.requestedGainDb(payload.micGainDb);
        if (gainDb === null || gainDb === this.secondaryGainDb) return;
        const previousGainDb = this.secondaryGainDb;
        this.secondaryGainDb = gainDb;
        deps.session.setSecondaryMicGainDb(gainDb);
        console.warn('[mic-gain]', JSON.stringify({ reason: 'second-mic',
          participant: deps.logLabel(joined.secondaryId), previousGainDb, gainDb }));
        return;
      }
      case 'choir-secondary-page': {
        const report = JSON.stringify(payload.page ?? null).slice(0, 600);
        if (report === this.lastPageReport) return;
        this.lastPageReport = report;
        logChoir('b-page', { participant: deps.logLabel(joined.secondaryId), page: payload.page ?? null });
        return;
      }
      default: {
        const a = payload.captureAnchor as Record<string, unknown> | null;
        if (!a || typeof a !== 'object') return;
        if (this.sampleSongOwner !== joined.secondaryId) {
          this.sampleSong.clear('mic');
          this.sampleSongOwner = joined.secondaryId;
        }
        this.sampleSong.observe('mic', {
          videoId: String(payload.videoId), state: Number(payload.state),
          playbackRate: Number(payload.playbackRate),
          mediaSeconds: Number(payload.currentTime) + Number(a.mediaDeltaSeconds) * Number(payload.playbackRate),
          generation: Number(a.generation), sampleRate: Number(a.sampleRate),
          sampleIndex: Number(a.sampleIndex), uncertaintyMs: Number(a.uncertaintyMs),
        }, nowMs);
      }
    }
  }

  /**
   * A joined B without media is asked for it (choir-media-ready) on its join
   * socket, at once and then every 3 s until B's media socket is bound: the
   * first ask can be missed by a page still loading, a reload, or a dropped link.
   */
  private askForMedia(nowMs: number) {
    const joined = this.seat.active();
    if (!joined || this.ingress.liveTransportFor(joined.secondaryId)
      || nowMs - this.lastMediaReadySentMs < 3_000) return;
    const socket = this.joinSocket();
    if (!socket) return;
    this.lastMediaReadySentMs = nowMs;
    this.deps.send(socket, { type: 'choir-media-ready' });
  }

  private sampleSongLagMs(nowMs: number): number | null {
    const { session } = this.deps;
    const videoId = this.deps.song.videoId(nowMs);
    if (videoId === null) return null;
    return this.sampleSong.estimate(nowMs, videoId, (side, a) => side === 'mic'
      ? session.secondarySampleSongPosition(a.generation, a.sampleIndex, a.sampleRate)
      : session.sampleSongPosition('backing', a.generation, a.sampleIndex, a.sampleRate),
    session.sampleRate);
  }

  /**
   * Measures B while a song plays and B is in the room output. Each song,
   * pause and resume, or rate change is measured afresh; a seek retires the
   * measurement through the Robot content transition it causes. Not keyed on
   * the room song revision: its drift corrections would retire every
   * measurement before it finished.
   */
  private tickContent(nowMs: number) {
    const room = this.deps.song.room(nowMs);
    // The room song itself, not whether the backing is playable yet: windows
    // simply do not fill until backing arrives.
    const playing = room.state === 1 && typeof room.videoId === 'string';
    const key = this.deps.session.secondaryMic && playing ? `${room.videoId}|${room.playbackRate}` : null;
    if (key !== this.contentKey) {
      // Another song is a new reference; a pause or resume of the same one is not.
      const newSong = key !== null && this.contentVideoId !== room.videoId;
      this.contentKey = key;
      if (key !== null) this.contentVideoId = String(room.videoId);
      this.content.reset(key === null ? 'no-song' : newSong ? 'new-song' : 'song', { hard: newSong });
    }
    if (key !== null) this.content.tick(nowMs);
  }

  /** Publish changes in audibility and delivery independently of alignment. */
  private publishSecondaryState() {
    const { session } = this.deps;
    const audible = session.secondaryMic?.audible === true;
    if (audible !== this.lastAudible) {
      this.lastAudible = audible;
      logChoir(audible ? 'b-heard' : 'b-silent', {
        lagMs: session.secondaryMic?.lagMs ?? null, source: this.lastLagSource,
      });
      this.deps.productStatusChanged();
    }
    // B can stay aligned while its PCM stops reaching the mix.
    const recentlyHeard = session.secondaryMic?.recentlyHeard === true;
    if (recentlyHeard !== this.lastRecentlyHeard) {
      this.lastRecentlyHeard = recentlyHeard;
      if (audible) logChoir(recentlyHeard ? 'b-pcm-resumed' : 'b-pcm-stalled', {});
      this.deps.productStatusChanged();
    }
  }

  /** Start B's automatic test tone once per capture; later probes require Realign. */
  private tickSecondaryProbe(secondaryId: string, nowMs: number) {
    const { session } = this.deps;
    const generation = session.secondaryMicGeneration;
    if (generation !== null && !session.secondaryMic?.audible && !this.deps.takeBlocksCalibration()) {
      this.probe.begin(`${secondaryId}:${generation}`, nowMs);
    }
    this.probe.tick(nowMs);
    if (this.probe.state !== this.lastProbeState) {
      this.lastProbeState = this.probe.state;
      logChoir('b-probe', this.probe.status());
      this.deps.productStatusChanged();
    }
  }

  /**
   * Choose the first usable measurement together with its diagnostic source.
   * Content is relative to A; B's probe remains valid with or without a song.
   * YouTube anchors are queried only when neither measurement is available.
   */
  private selectSecondaryPlacement(primaryId: string, nowMs: number): SecondaryPlacement | null {
    const { deps } = this;
    const { session } = deps;
    const primaryOwnsMic = deps.mic.ownerId() === primaryId && deps.mic.mediaOwnerId() === primaryId;
    if (primaryOwnsMic) {
      const offset = this.content.secondaryOffsetMs;
      if (offset !== null) return { lagMs: session.requestedMicAdvanceMs + offset, source: 'content' };

      const probe = this.probe.advanceMs(deps.robot.playerOffsetMs(nowMs), deps.song.playbackRate(nowMs));
      if (probe !== null) return { lagMs: probe, source: 'probe' };

      const youtube = this.sampleSongLagMs(nowMs);
      if (youtube !== null) return { lagMs: youtube, source: 'youtube-time' };
    }
    // A lapse in song-time anchors must not move an already placed singer.
    // Without a song, or before B's first placement, use A's advance. B's own
    // frontier correction still holds back audio that arrives later.
    const alreadyPlaced = session.secondaryMic?.targetLagMs != null;
    if (deps.song.playing(nowMs) && alreadyPlaced) return null;
    return { lagMs: session.requestedMicAdvanceMs, source: 'no-song' };
  }

  /** Place B on the shared Listen/Take output, holding alignment during a Take. */
  private placeSecondary(nowMs: number) {
    const { deps } = this;
    const { session } = deps;
    this.publishSecondaryState();
    if (!session.secondaryMic) return;

    const pair = this.seat.active();
    if (!pair || !this.ingress.liveTransportFor(pair.secondaryId)) {
      session.detachSecondaryMic();
      return;
    }
    this.tickSecondaryProbe(pair.secondaryId, nowMs);
    if (this.probe.silencing) {
      session.setSecondaryMicLag(null);
      return;
    }

    const placement = this.selectSecondaryPlacement(pair.primaryId, nowMs);
    if (placement === null) return;
    const { lagMs, source } = placement;
    if (source !== this.lastLagSource) {
      logChoir('b-lag-source', { source, lagMs: Math.round(lagMs) });
      this.lastLagSource = source;
    }
    if (deps.takeBlocksCalibration() && session.secondaryMic.audible) return;
    session.setSecondaryMicLag(lagMs);
  }
}
