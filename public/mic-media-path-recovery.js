export const DEFAULT_MEDIA_PATH_STALE_OBSERVATIONS = 3;
export const DEFAULT_MEDIA_PATH_MIN_DELIVERY_RATIO = 0.5;

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

function positiveFinite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function mediaPath(value) {
  return value === 'webtransport' || value === 'websocket' ? value : null;
}

/**
 * Pure policy for the failure class where the local capture clock still moves
 * and the publisher control round-trip still succeeds, but the server does not
 * accept enough new microphone PCM.
 *
 * `serverAcceptedFrameSerial` is incremented only at the server's accepted-PCM
 * authority boundary (AudioSession ingest produced samples). When available,
 * `serverAcceptedSampleCount` measures the amount of novel PCM accepted at that
 * same boundary. Delivery coverage compares duration, not raw sample counts, so
 * a 44.1 kHz capture and Relay's 48 kHz mix clock remain commensurate.
 *
 * This policy cannot rebuild capture. Its bounded actions are media-only: one
 * semantic WebTransport demotion, then at most one same-capture physical
 * WebSocket replacement, then a latched degraded state. reset() starts the
 * budget for a new capture generation.
 */
export class MicMediaPathRecovery {
  constructor({
    staleObservations = DEFAULT_MEDIA_PATH_STALE_OBSERVATIONS,
    minimumDeliveryRatio = DEFAULT_MEDIA_PATH_MIN_DELIVERY_RATIO,
  } = {}) {
    if (!Number.isInteger(staleObservations) || staleObservations < 1) {
      throw new Error('Mic media-path staleObservations must be a positive integer.');
    }
    if (!Number.isFinite(minimumDeliveryRatio) || minimumDeliveryRatio <= 0 || minimumDeliveryRatio > 1) {
      throw new Error('Mic media-path minimumDeliveryRatio must be in (0, 1].');
    }
    this.staleObservations = staleObservations;
    this.minimumDeliveryRatio = minimumDeliveryRatio;
    this.reset();
  }

  reset() {
    this.captureGeneration = null;
    this.currentSocketEpoch = null;
    this.lastCapturedSamples = null;
    this.lastCaptureSampleRate = null;
    this.lastServerAcceptedFrameSerial = null;
    this.lastServerAcceptedSampleCount = null;
    this.lastServerAcceptedSampleRate = null;
    this.lastDeliveryRatio = null;
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
      deliveryRatio: this.lastDeliveryRatio,
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
    captureSampleRate,
    serverAcceptedFrameSerial,
    serverAcceptedSampleCount,
    serverAcceptedSampleRate,
    socketEpoch,
  } = {}) {
    this.lastCapturedSamples = nonNegativeInteger(capturedSamples);
    this.lastCaptureSampleRate = positiveFinite(captureSampleRate);
    this.lastServerAcceptedFrameSerial = nonNegativeInteger(serverAcceptedFrameSerial);
    this.lastServerAcceptedSampleCount = nonNegativeInteger(serverAcceptedSampleCount);
    this.lastServerAcceptedSampleRate = positiveFinite(serverAcceptedSampleRate);
    this.lastDeliveryRatio = null;
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
    captureSampleRate,
    serverAcceptedFrameSerial,
    serverAcceptedSampleCount,
    serverAcceptedSampleRate,
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
    const coverageFieldsPresent = captureSampleRate !== undefined
      || serverAcceptedSampleCount !== undefined
      || serverAcceptedSampleRate !== undefined;
    const captureRate = captureSampleRate === undefined ? null : positiveFinite(captureSampleRate);
    const acceptedSamples = serverAcceptedSampleCount === undefined
      ? null
      : nonNegativeInteger(serverAcceptedSampleCount);
    const acceptedRate = serverAcceptedSampleRate === undefined
      ? null
      : positiveFinite(serverAcceptedSampleRate);

    if (
      generation === null
      || captured === null
      || acceptedSerial === null
      || normalizedEpoch === null
      || localPath === null
      || (coverageFieldsPresent && (captureRate === null || acceptedSamples === null || acceptedRate === null))
    ) {
      return { action: 'none', reason: 'invalid-observation', ...this.status() };
    }

    if (!this.beginGeneration(generation)) {
      return { action: 'none', reason: 'invalid-generation', ...this.status() };
    }

    const coverageInput = coverageFieldsPresent
      ? {
          captureSampleRate: captureRate,
          serverAcceptedSampleCount: acceptedSamples,
          serverAcceptedSampleRate: acceptedRate,
        }
      : {};

    if (this.currentSocketEpoch !== null && normalizedEpoch !== this.currentSocketEpoch) {
      // #304/control lifecycle owns physical socket replacement. Never let ACK
      // cadence from the retired socket count toward a media verdict.
      this.rebaseline({
        capturedSamples: captured,
        serverAcceptedFrameSerial: acceptedSerial,
        socketEpoch: normalizedEpoch,
        ...coverageInput,
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
        ...coverageInput,
      });
      return { action: 'none', reason: 'ineligible', ...this.status() };
    }

    if (this.lastCapturedSamples === null || this.lastServerAcceptedFrameSerial === null) {
      this.rebaseline({
        capturedSamples: captured,
        serverAcceptedFrameSerial: acceptedSerial,
        socketEpoch: normalizedEpoch,
        ...coverageInput,
      });
      return { action: 'none', reason: 'baseline', ...this.status() };
    }

    if (
      coverageFieldsPresent
      && (
        this.lastCaptureSampleRate === null
        || this.lastServerAcceptedSampleCount === null
        || this.lastServerAcceptedSampleRate === null
      )
    ) {
      this.rebaseline({
        capturedSamples: captured,
        serverAcceptedFrameSerial: acceptedSerial,
        socketEpoch: normalizedEpoch,
        ...coverageInput,
      });
      return { action: 'none', reason: 'sample-coverage-baseline', ...this.status() };
    }

    if (
      coverageFieldsPresent
      && (
        captureRate !== this.lastCaptureSampleRate
        || acceptedRate !== this.lastServerAcceptedSampleRate
        || acceptedSamples < this.lastServerAcceptedSampleCount
      )
    ) {
      this.rebaseline({
        capturedSamples: captured,
        serverAcceptedFrameSerial: acceptedSerial,
        socketEpoch: normalizedEpoch,
        ...coverageInput,
      });
      return { action: 'none', reason: 'sample-coverage-rebaseline', ...this.status() };
    }

    const previousCaptured = this.lastCapturedSamples;
    const previousSerial = this.lastServerAcceptedFrameSerial;
    const previousAcceptedSamples = this.lastServerAcceptedSampleCount;
    const localAdvanced = captured > previousCaptured;
    const serverAdvanced = acceptedSerial > previousSerial;
    let deliveryRatio = null;
    if (coverageFieldsPresent && localAdvanced) {
      const capturedDelta = captured - previousCaptured;
      const acceptedDelta = acceptedSamples - previousAcceptedSamples;
      const capturedDuration = capturedDelta / captureRate;
      const acceptedDuration = acceptedDelta / acceptedRate;
      deliveryRatio = capturedDuration > 0 ? acceptedDuration / capturedDuration : null;
    }

    this.lastCapturedSamples = captured;
    this.lastServerAcceptedFrameSerial = acceptedSerial;
    if (coverageFieldsPresent) {
      this.lastCaptureSampleRate = captureRate;
      this.lastServerAcceptedSampleCount = acceptedSamples;
      this.lastServerAcceptedSampleRate = acceptedRate;
    }
    this.lastDeliveryRatio = deliveryRatio;

    if (!localAdvanced) {
      // Capture-clock stalls belong to the existing capture watchdog. Media
      // recovery must never manufacture a transport diagnosis from them.
      this.staleCount = 0;
      return { action: 'none', reason: 'local-capture-not-advancing', ...this.status() };
    }

    const deliveryHealthy = deliveryRatio === null || deliveryRatio >= this.minimumDeliveryRatio;
    const serverProgressHealthy = serverAdvanced && deliveryHealthy;
    const underDelivered = serverAdvanced && deliveryRatio !== null && !deliveryHealthy;

    if (this.phase === 'degraded-latched') {
      // Do not spend any more recovery actions. Clear only the visible degraded
      // verdict after the server proves a healthy delivery window; trickle PCM
      // is not enough to restore product confidence.
      if (serverProgressHealthy) {
        this.phase = 'observing';
        this.staleCount = 0;
        return {
          action: 'recovered',
          reason: deliveryRatio === null ? 'server-pcm-resumed' : 'server-pcm-coverage-resumed',
          ...this.status(),
        };
      }
      return { action: 'none', reason: 'degraded-latched', ...this.status() };
    }

    if (this.phase === 'fallback-proving' || this.phase === 'reconnect-proving') {
      // A late WT frame can be accepted after the browser has demoted locally.
      // Do not establish the fallback proof baseline until the server agrees
      // that the direct-media session is gone and WebSocket is the live path.
      // Healthy PCM while the old label lingers keeps us waiting; sparse trickle
      // remains failure evidence and cannot spend forever behind a moving serial.
      if (!this.proofServerWebSocketReady) {
        if (this.beginWebSocketProof(serverPath, acceptedSerial)) {
          return { action: 'none', reason: 'server-websocket-rebaseline', ...this.status() };
        }
        if (serverProgressHealthy) {
          this.staleCount = 0;
          return { action: 'none', reason: 'waiting-server-websocket', ...this.status() };
        }
        this.staleCount += 1;
        if (this.staleCount < this.staleObservations) {
          return { action: 'none', reason: 'waiting-server-websocket', ...this.status() };
        }
        return this.escalateProofFailure(
          underDelivered
            ? 'server-pcm-under-delivered-after-fallback'
            : 'server-media-path-stale-after-fallback',
        );
      }

      if (serverPath !== 'websocket') {
        this.proofServerWebSocketReady = false;
        this.proofBaselineSerial = null;
        if (serverProgressHealthy) {
          this.staleCount = 0;
          return { action: 'none', reason: 'waiting-server-websocket', ...this.status() };
        }
        this.staleCount = 1;
        if (this.staleCount < this.staleObservations) {
          return { action: 'none', reason: 'waiting-server-websocket', ...this.status() };
        }
        return this.escalateProofFailure(
          underDelivered
            ? 'server-pcm-under-delivered-after-fallback'
            : 'server-media-path-stale-after-fallback',
        );
      }

      if (deliveryRatio !== null) {
        if (serverProgressHealthy) {
          this.phase = 'observing';
          this.staleCount = 0;
          this.proofBaselineSerial = null;
          this.proofServerWebSocketReady = false;
          return {
            action: 'recovered',
            reason: 'server-pcm-coverage-recovered-on-websocket',
            ...this.status(),
          };
        }
      } else if (
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
        return {
          action: 'none',
          reason: underDelivered ? 'proving-recovery-under-delivery' : 'proving-recovery',
          ...this.status(),
        };
      }
      return this.escalateProofFailure(
        underDelivered
          ? 'server-pcm-under-delivered-after-fallback'
          : 'server-pcm-stale-after-fallback',
      );
    }

    if (serverProgressHealthy) {
      this.staleCount = 0;
      return { action: 'none', reason: 'server-pcm-advancing', ...this.status() };
    }

    this.staleCount += 1;
    if (this.staleCount < this.staleObservations) {
      return {
        action: 'none',
        reason: underDelivered ? 'server-pcm-under-delivery-observation' : 'server-pcm-stale-observation',
        ...this.status(),
      };
    }

    this.staleCount = 0;
    const failureReason = underDelivered ? 'server-pcm-under-delivered' : 'server-pcm-stale';
    if (localPath === 'webtransport' && !this.webTransportDemotionUsed) {
      this.webTransportDemotionUsed = true;
      this.webTransportQuarantined = true;
      this.phase = 'fallback-proving';
      this.proofBaselineSerial = null;
      this.proofServerWebSocketReady = false;
      return { action: 'demote-webtransport', reason: failureReason, ...this.status() };
    }

    if (localPath === 'websocket' && !this.webSocketReplacementUsed) {
      // A same-generation reconnect advertises WT again. Quarantine it before
      // replacing this socket so the recovery proof stays on WebSocket.
      this.webTransportQuarantined = true;
      this.webSocketReplacementUsed = true;
      this.phase = 'reconnect-proving';
      this.proofBaselineSerial = null;
      this.proofServerWebSocketReady = false;
      return { action: 'replace-websocket', reason: failureReason, ...this.status() };
    }

    this.phase = 'degraded-latched';
    return { action: 'degraded-latched', reason: 'server-pcm-stale-after-bounded-recovery', ...this.status() };
  }
}
