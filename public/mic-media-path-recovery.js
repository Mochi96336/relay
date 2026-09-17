export const DEFAULT_MEDIA_PATH_STALE_OBSERVATIONS = 3;

function uint32(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 0xffff_ffff
    ? number >>> 0
    : null;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function mediaPath(value) {
  return value === 'webtransport' || value === 'websocket' ? value : null;
}

/**
 * Pure policy for the failure class where the local capture clock still moves
 * and the publisher control round-trip still succeeds, but the server does not
 * accept new microphone PCM.
 *
 * `serverAcceptedFrameSerial` is incremented only at the server's accepted-PCM
 * authority boundary (AudioSession ingest produced samples). It is deliberately
 * not a socket/datagram/write counter.
 *
 * This policy cannot rebuild capture. Its bounded actions are media-only: one
 * semantic WebTransport demotion, then at most one same-capture physical
 * WebSocket replacement, then a latched degraded state. reset() starts the
 * budget for a new capture generation.
 */
export class MicMediaPathRecovery {
  constructor({ staleObservations = DEFAULT_MEDIA_PATH_STALE_OBSERVATIONS } = {}) {
    if (!Number.isInteger(staleObservations) || staleObservations < 1) {
      throw new Error('Mic media-path staleObservations must be a positive integer.');
    }
    this.staleObservations = staleObservations;
    this.reset();
  }

  reset() {
    this.captureGeneration = null;
    this.currentSocketEpoch = null;
    this.lastCapturedSamples = null;
    this.lastServerAcceptedFrameSerial = null;
    this.staleCount = 0;
    this.phase = 'observing';
    this.proofBaselineSerial = null;
    this.proofServerWebSocketReady = false;
    this.webTransportDemotionUsed = false;
    this.webSocketReplacementUsed = false;
    this.webTransportQuarantined = false;
  }

  status() {
    return {
      captureGeneration: this.captureGeneration,
      socketEpoch: this.currentSocketEpoch,
      phase: this.phase,
      staleObservations: this.staleCount,
      proofBaselineSerial: this.proofBaselineSerial,
      proofServerWebSocketReady: this.proofServerWebSocketReady,
      webTransportDemotionUsed: this.webTransportDemotionUsed,
      webSocketReplacementUsed: this.webSocketReplacementUsed,
      webTransportQuarantined: this.webTransportQuarantined,
      degraded: this.phase === 'degraded-latched',
    };
  }

  quarantineWebTransport() {
    return this.webTransportQuarantined;
  }

  beginGeneration(generation) {
    const normalized = uint32(generation);
    if (normalized === null) return false;
    if (this.captureGeneration === normalized) return true;
    this.reset();
    this.captureGeneration = normalized;
    return true;
  }

  rebaseline({
    capturedSamples,
    serverAcceptedFrameSerial,
    socketEpoch,
  } = {}) {
    this.lastCapturedSamples = nonNegativeInteger(capturedSamples);
    this.lastServerAcceptedFrameSerial = nonNegativeInteger(serverAcceptedFrameSerial);
    const normalizedEpoch = nonNegativeInteger(socketEpoch);
    if (normalizedEpoch !== null) this.currentSocketEpoch = normalizedEpoch;
    this.staleCount = 0;
  }

  beginWebSocketProof(serverPath, acceptedFrameSerial) {
    if (serverPath !== 'websocket') {
      this.proofServerWebSocketReady = false;
      this.proofBaselineSerial = null;
      return false;
    }
    this.proofServerWebSocketReady = true;
    this.proofBaselineSerial = acceptedFrameSerial;
    this.staleCount = 0;
    return true;
  }

  escalateProofFailure(reason) {
    this.staleCount = 0;
    this.proofBaselineSerial = null;
    this.proofServerWebSocketReady = false;
    if (this.phase === 'fallback-proving' && !this.webSocketReplacementUsed) {
      this.webSocketReplacementUsed = true;
      this.phase = 'reconnect-proving';
      return { action: 'replace-websocket', reason, ...this.status() };
    }
    this.phase = 'degraded-latched';
    return {
      action: 'degraded-latched',
      reason: 'server-pcm-stale-after-bounded-recovery',
      ...this.status(),
    };
  }

  observe({
    captureGeneration,
    capturedSamples,
    serverAcceptedFrameSerial,
    serverMediaPath,
    path,
    socketEpoch,
    eligible = true,
  }) {
    const generation = uint32(captureGeneration);
    const captured = nonNegativeInteger(capturedSamples);
    const acceptedSerial = nonNegativeInteger(serverAcceptedFrameSerial);
    const localPath = mediaPath(path);
    const serverPath = mediaPath(serverMediaPath);
    const normalizedEpoch = nonNegativeInteger(socketEpoch);

    if (
      generation === null
      || captured === null
      || acceptedSerial === null
      || normalizedEpoch === null
      || localPath === null
    ) {
      return { action: 'none', reason: 'invalid-observation', ...this.status() };
    }

    if (!this.beginGeneration(generation)) {
      return { action: 'none', reason: 'invalid-generation', ...this.status() };
    }

    if (this.currentSocketEpoch !== null && normalizedEpoch !== this.currentSocketEpoch) {
      // #304/control lifecycle owns physical socket replacement. Never let ACK
      // cadence from the retired socket count toward a media verdict.
      this.rebaseline({
        capturedSamples: captured,
        serverAcceptedFrameSerial: acceptedSerial,
        socketEpoch: normalizedEpoch,
      });
      if (this.phase === 'fallback-proving' || this.phase === 'reconnect-proving') {
        this.beginWebSocketProof(serverPath, acceptedSerial);
      }
      return { action: 'none', reason: 'socket-rebaseline', ...this.status() };
    }
    this.currentSocketEpoch = normalizedEpoch;

    if (!eligible) {
      this.rebaseline({
        capturedSamples: captured,
        serverAcceptedFrameSerial: acceptedSerial,
        socketEpoch: normalizedEpoch,
      });
      return { action: 'none', reason: 'ineligible', ...this.status() };
    }

    if (this.phase === 'degraded-latched') {
      // Do not spend any more recovery actions. If PCM starts advancing on its
      // own, clear only the visible degraded verdict; the action budget and WT
      // quarantine remain consumed for this capture generation.
      const recovered = this.lastServerAcceptedFrameSerial !== null
        && acceptedSerial > this.lastServerAcceptedFrameSerial;
      this.lastCapturedSamples = captured;
      this.lastServerAcceptedFrameSerial = acceptedSerial;
      if (recovered) {
        this.phase = 'observing';
        this.staleCount = 0;
        return { action: 'recovered', reason: 'server-pcm-resumed', ...this.status() };
      }
      return { action: 'none', reason: 'degraded-latched', ...this.status() };
    }

    if (this.lastCapturedSamples === null || this.lastServerAcceptedFrameSerial === null) {
      this.rebaseline({
        capturedSamples: captured,
        serverAcceptedFrameSerial: acceptedSerial,
        socketEpoch: normalizedEpoch,
      });
      return { action: 'none', reason: 'baseline', ...this.status() };
    }

    const localAdvanced = captured > this.lastCapturedSamples;
    const serverAdvanced = acceptedSerial > this.lastServerAcceptedFrameSerial;
    this.lastCapturedSamples = captured;
    this.lastServerAcceptedFrameSerial = acceptedSerial;

    if (!localAdvanced) {
      // Capture-clock stalls belong to the existing capture watchdog. Media
      // recovery must never manufacture a transport diagnosis from them.
      this.staleCount = 0;
      return { action: 'none', reason: 'local-capture-not-advancing', ...this.status() };
    }

    if (this.phase === 'fallback-proving' || this.phase === 'reconnect-proving') {
      // A late WT frame can be accepted after the browser has demoted locally.
      // Do not establish the fallback proof baseline until the server agrees
      // that the direct-media session is gone and WebSocket is the live path.
      // Waiting for that agreement is itself bounded: a server that never
      // retires the WT session is also a failed recovery, not an infinite wait.
      if (!this.proofServerWebSocketReady) {
        if (this.beginWebSocketProof(serverPath, acceptedSerial)) {
          return { action: 'none', reason: 'server-websocket-rebaseline', ...this.status() };
        }
        this.staleCount += 1;
        if (this.staleCount < this.staleObservations) {
          return { action: 'none', reason: 'waiting-server-websocket', ...this.status() };
        }
        return this.escalateProofFailure('server-media-path-stale-after-fallback');
      }

      if (serverPath !== 'websocket') {
        this.proofServerWebSocketReady = false;
        this.proofBaselineSerial = null;
        this.staleCount = 1;
        if (this.staleCount < this.staleObservations) {
          return { action: 'none', reason: 'waiting-server-websocket', ...this.status() };
        }
        return this.escalateProofFailure('server-media-path-stale-after-fallback');
      }

      if (
        this.proofBaselineSerial !== null
        && acceptedSerial > this.proofBaselineSerial
      ) {
        this.phase = 'observing';
        this.staleCount = 0;
        this.proofBaselineSerial = null;
        this.proofServerWebSocketReady = false;
        return { action: 'recovered', reason: 'server-pcm-advanced-on-websocket', ...this.status() };
      }

      this.staleCount += 1;
      if (this.staleCount < this.staleObservations) {
        return { action: 'none', reason: 'proving-recovery', ...this.status() };
      }
      return this.escalateProofFailure('server-pcm-stale-after-fallback');
    }

    if (serverAdvanced) {
      this.staleCount = 0;
      return { action: 'none', reason: 'server-pcm-advancing', ...this.status() };
    }

    this.staleCount += 1;
    if (this.staleCount < this.staleObservations) {
      return { action: 'none', reason: 'server-pcm-stale-observation', ...this.status() };
    }

    this.staleCount = 0;
    if (localPath === 'webtransport' && !this.webTransportDemotionUsed) {
      this.webTransportDemotionUsed = true;
      this.webTransportQuarantined = true;
      this.phase = 'fallback-proving';
      this.proofBaselineSerial = null;
      this.proofServerWebSocketReady = false;
      return { action: 'demote-webtransport', reason: 'server-pcm-stale', ...this.status() };
    }

    if (localPath === 'websocket' && !this.webSocketReplacementUsed) {
      // A same-generation reconnect advertises WT again. Quarantine it before
      // replacing this socket so the recovery proof stays on WebSocket.
      this.webTransportQuarantined = true;
      this.webSocketReplacementUsed = true;
      this.phase = 'reconnect-proving';
      this.proofBaselineSerial = null;
      this.proofServerWebSocketReady = false;
      return { action: 'replace-websocket', reason: 'server-pcm-stale', ...this.status() };
    }

    this.phase = 'degraded-latched';
    return { action: 'degraded-latched', reason: 'server-pcm-stale-after-bounded-recovery', ...this.status() };
  }
}
