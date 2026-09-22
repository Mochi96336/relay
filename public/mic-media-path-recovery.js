export const DEFAULT_MEDIA_PATH_STALE_OBSERVATIONS = 3;
export const DEFAULT_MEDIA_PATH_MIN_PACKET_COVERAGE = 0.5;
export const DEFAULT_MEDIA_PATH_MIN_PACKET_WINDOW = 8;

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

function optionalNonNegativeInteger(value) {
  if (value === undefined || value === null) return null;
  return nonNegativeInteger(value);
}

function mediaPath(value) {
  return value === 'webtransport' || value === 'websocket' ? value : null;
}

/**
 * Pure policy for the failure class where the local capture clock still moves
 * and the publisher control round-trip still succeeds, but the server does not
 * receive enough new microphone PCM.
 *
 * `serverAcceptedFrameSerial` is incremented only at the server's accepted-PCM
 * authority boundary (AudioSession ingest produced samples). Quantitative media
 * coverage uses sender-submitted packet counters against the server receiver's
 * emitted-packet counter, keeping network delivery separate from later timeline
 * acceptance. Older peers can omit those counters and retain the event-progress
 * fallback semantics.
 *
 * This policy cannot rebuild capture. Its bounded actions are media-only: one
 * semantic WebTransport demotion, then at most one same-capture physical
 * WebSocket replacement, then a latched degraded state. reset() starts the
 * budget for a new capture generation.
 */
export class MicMediaPathRecovery {
  constructor({
    staleObservations = DEFAULT_MEDIA_PATH_STALE_OBSERVATIONS,
    minPacketCoverage = DEFAULT_MEDIA_PATH_MIN_PACKET_COVERAGE,
    minPacketWindow = DEFAULT_MEDIA_PATH_MIN_PACKET_WINDOW,
  } = {}) {
    if (!Number.isInteger(staleObservations) || staleObservations < 1) {
      throw new Error('Mic media-path staleObservations must be a positive integer.');
    }
    if (!Number.isFinite(minPacketCoverage) || minPacketCoverage <= 0 || minPacketCoverage > 1) {
      throw new Error('Mic media-path minPacketCoverage must be in (0, 1].');
    }
    if (!Number.isInteger(minPacketWindow) || minPacketWindow < 1) {
      throw new Error('Mic media-path minPacketWindow must be a positive integer.');
    }
    this.staleObservations = staleObservations;
    this.minPacketCoverage = minPacketCoverage;
    this.minPacketWindow = minPacketWindow;
    this.reset();
  }

  reset() {
    this.captureGeneration = null;
    this.currentSocketEpoch = null;
    this.lastLocalPath = null;
    this.lastCapturedSamples = null;
    this.lastServerAcceptedFrameSerial = null;
    this.lastSenderSubmittedPackets = null;
    this.lastSenderFailedPackets = null;
    this.lastServerReceivedPacketSerial = null;
    this.lastPacketCoverage = null;
    this.incompletePacketSemanticStalls = 0;
    this.staleCount = 0;
    this.sourceEligibilityBlocked = false;
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
      packetCoverage: this.lastPacketCoverage,
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

  rebaselinePacketCoverage({
    senderSubmittedPackets,
    senderFailedPackets,
    serverReceivedPacketSerial,
  } = {}) {
    this.incompletePacketSemanticStalls = 0;
    const submitted = optionalNonNegativeInteger(senderSubmittedPackets);
    const failed = optionalNonNegativeInteger(senderFailedPackets);
    const received = optionalNonNegativeInteger(serverReceivedPacketSerial);
    if (submitted === null || failed === null || received === null) {
      this.lastSenderSubmittedPackets = null;
      this.lastSenderFailedPackets = null;
      this.lastServerReceivedPacketSerial = null;
      this.lastPacketCoverage = null;
      return false;
    }
    this.lastSenderSubmittedPackets = submitted;
    this.lastSenderFailedPackets = failed;
    this.lastServerReceivedPacketSerial = received;
    this.lastPacketCoverage = null;
    return true;
  }

  rebaseline({
    capturedSamples,
    serverAcceptedFrameSerial,
    socketEpoch,
    senderSubmittedPackets,
    senderFailedPackets,
    serverReceivedPacketSerial,
  } = {}) {
    this.lastCapturedSamples = nonNegativeInteger(capturedSamples);
    this.lastServerAcceptedFrameSerial = nonNegativeInteger(serverAcceptedFrameSerial);
    const normalizedEpoch = nonNegativeInteger(socketEpoch);
    if (normalizedEpoch !== null) this.currentSocketEpoch = normalizedEpoch;
    this.rebaselinePacketCoverage({
      senderSubmittedPackets,
      senderFailedPackets,
      serverReceivedPacketSerial,
    });
    this.staleCount = 0;
  }

  packetCoverageEvidence({
    senderSubmittedPackets,
    senderFailedPackets,
    serverReceivedPacketSerial,
  }) {
    const submitted = optionalNonNegativeInteger(senderSubmittedPackets);
    const failed = optionalNonNegativeInteger(senderFailedPackets);
    const received = optionalNonNegativeInteger(serverReceivedPacketSerial);
    if (submitted === null || failed === null || received === null) {
      this.incompletePacketSemanticStalls = 0;
      return { available: false, ready: false, healthy: null, coverage: null, submittedDelta: null };
    }

    if (
      this.lastSenderSubmittedPackets === null
      || this.lastSenderFailedPackets === null
      || this.lastServerReceivedPacketSerial === null
      || submitted < this.lastSenderSubmittedPackets
      || failed < this.lastSenderFailedPackets
      || received < this.lastServerReceivedPacketSerial
    ) {
      this.rebaselinePacketCoverage({
        senderSubmittedPackets: submitted,
        senderFailedPackets: failed,
        serverReceivedPacketSerial: received,
      });
      return { available: true, ready: false, healthy: null, coverage: null, submittedDelta: 0 };
    }

    const submittedDelta = submitted - this.lastSenderSubmittedPackets;
    const failedDelta = failed - this.lastSenderFailedPackets;
    const receivedDelta = received - this.lastServerReceivedPacketSerial;
    const deliverableDelta = Math.max(0, submittedDelta - failedDelta);
    if (deliverableDelta < this.minPacketWindow) {
      return {
        available: true,
        ready: false,
        healthy: null,
        coverage: null,
        submittedDelta,
      };
    }

    const coverage = Math.max(0, Math.min(1, receivedDelta / deliverableDelta));
    this.lastSenderSubmittedPackets = submitted;
    this.lastSenderFailedPackets = failed;
    this.lastServerReceivedPacketSerial = received;
    this.lastPacketCoverage = coverage;
    this.incompletePacketSemanticStalls = 0;
    return {
      available: true,
      ready: true,
      healthy: coverage >= this.minPacketCoverage,
      coverage,
      submittedDelta,
    };
  }

  shouldDeferIncompletePacketWindow(semanticAdvanced) {
    if (semanticAdvanced) {
      this.incompletePacketSemanticStalls = 0;
      return true;
    }
    this.incompletePacketSemanticStalls += 1;
    if (this.incompletePacketSemanticStalls < this.staleObservations) return true;
    this.incompletePacketSemanticStalls = 0;
    this.staleCount = Math.max(this.staleCount, this.staleObservations - 1);
    return false;
  }

  beginWebSocketProof(serverPath, acceptedFrameSerial, packetCounters = {}) {
    if (serverPath !== 'websocket') {
      this.proofServerWebSocketReady = false;
      this.proofBaselineSerial = null;
      return false;
    }
    this.proofServerWebSocketReady = true;
    this.proofBaselineSerial = acceptedFrameSerial;
    this.rebaselinePacketCoverage(packetCounters);
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
    senderSubmittedPackets,
    senderFailedPackets,
    serverReceivedPacketSerial,
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
    const packetCounters = {
      senderSubmittedPackets,
      senderFailedPackets,
      serverReceivedPacketSerial,
    };

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

    const socketEpochChanged = this.currentSocketEpoch !== null
      && normalizedEpoch !== this.currentSocketEpoch;
    if (socketEpochChanged) {
      // #304/control lifecycle owns physical socket replacement. Never let ACK
      // cadence from the retired socket count toward a media verdict.
      this.rebaseline({
        capturedSamples: captured,
        serverAcceptedFrameSerial: acceptedSerial,
        socketEpoch: normalizedEpoch,
        ...packetCounters,
      });
      this.lastLocalPath = localPath;

      if (!eligible) {
        // A source/capture failure remains authoritative across physical socket
        // replacement. Keep the bounded media action budget, but any recovery
        // proof gathered before this boundary is no longer diagnostic.
        this.sourceEligibilityBlocked = true;
        this.proofBaselineSerial = null;
        this.proofServerWebSocketReady = false;
        return { action: 'none', reason: 'ineligible', ...this.status() };
      }

      const returningFromIneligible = this.sourceEligibilityBlocked;
      this.sourceEligibilityBlocked = false;
      if (this.phase === 'fallback-proving' || this.phase === 'reconnect-proving') {
        this.beginWebSocketProof(serverPath, acceptedSerial, packetCounters);
      }
      return {
        action: 'none',
        reason: returningFromIneligible ? 'eligible-rebaseline' : 'socket-rebaseline',
        ...this.status(),
      };
    }
    this.currentSocketEpoch = normalizedEpoch;

    if (!eligible) {
      this.sourceEligibilityBlocked = true;
      this.rebaseline({
        capturedSamples: captured,
        serverAcceptedFrameSerial: acceptedSerial,
        socketEpoch: normalizedEpoch,
        ...packetCounters,
      });
      this.lastLocalPath = localPath;
      // A source failure pauses, rather than satisfies or fails, any in-flight
      // WT→WS proof. Restart that proof from fresh server evidence on return.
      if (this.phase === 'fallback-proving' || this.phase === 'reconnect-proving') {
        this.proofBaselineSerial = null;
        this.proofServerWebSocketReady = false;
      }
      return { action: 'none', reason: 'ineligible', ...this.status() };
    }

    if (this.sourceEligibilityBlocked) {
      // The recovery-edge health snapshot describes the boundary at which the
      // source became diagnosable again; its deltas still span the preceding
      // ineligible interval. Baseline it without scoring stale/coverage evidence.
      this.sourceEligibilityBlocked = false;
      this.rebaseline({
        capturedSamples: captured,
        serverAcceptedFrameSerial: acceptedSerial,
        socketEpoch: normalizedEpoch,
        ...packetCounters,
      });
      this.lastLocalPath = localPath;
      if (this.phase === 'fallback-proving' || this.phase === 'reconnect-proving') {
        this.beginWebSocketProof(serverPath, acceptedSerial, packetCounters);
      }
      return { action: 'none', reason: 'eligible-rebaseline', ...this.status() };
    }

    const localPathChanged = this.lastLocalPath !== null && localPath !== this.lastLocalPath;
    this.lastLocalPath = localPath;
    if (localPathChanged) {
      if (this.phase === 'fallback-proving' || this.phase === 'reconnect-proving') {
        // Semantic recovery already owns this WT→WS transition. Fence packet
        // attribution at the local path boundary without disturbing the proof
        // phase or its already-spent action budget.
        this.rebaselinePacketCoverage(packetCounters);
        this.staleCount = 0;
      } else {
        // #287 or another transport owner can change the local path between two
        // health observations. Cumulative counters across that interval describe
        // two different transports, so they cannot be charged to the new path.
        this.rebaseline({
          capturedSamples: captured,
          serverAcceptedFrameSerial: acceptedSerial,
          socketEpoch: normalizedEpoch,
          ...packetCounters,
        });
        return { action: 'none', reason: 'media-path-rebaseline', ...this.status() };
      }
    }

    if (this.phase === 'degraded-latched') {
      const packetEvidence = this.packetCoverageEvidence(packetCounters);
      const semanticAdvanced = this.lastServerAcceptedFrameSerial !== null
        && acceptedSerial > this.lastServerAcceptedFrameSerial;
      const recovered = semanticAdvanced && (
        !packetEvidence.available
        || (packetEvidence.ready && packetEvidence.healthy === true)
      );
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
        ...packetCounters,
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
      this.rebaselinePacketCoverage(packetCounters);
      this.staleCount = 0;
      return { action: 'none', reason: 'local-capture-not-advancing', ...this.status() };
    }

    if (
      (this.phase === 'fallback-proving' || this.phase === 'reconnect-proving')
      && !this.proofServerWebSocketReady
    ) {
      if (this.beginWebSocketProof(serverPath, acceptedSerial, packetCounters)) {
        return { action: 'none', reason: 'server-websocket-rebaseline', ...this.status() };
      }
      const packetEvidence = this.packetCoverageEvidence(packetCounters);
      const serverHealthy = serverAdvanced && (
        !packetEvidence.available
        || (packetEvidence.ready && packetEvidence.healthy === true)
      );
      if (serverHealthy) {
        this.staleCount = 0;
        return { action: 'none', reason: 'waiting-server-websocket', ...this.status() };
      }
      if (
        packetEvidence.available
        && !packetEvidence.ready
        && this.shouldDeferIncompletePacketWindow(serverAdvanced)
      ) {
        return { action: 'none', reason: 'packet-window-accumulating', ...this.status() };
      }
      this.staleCount += 1;
      if (this.staleCount < this.staleObservations) {
        return { action: 'none', reason: 'waiting-server-websocket', ...this.status() };
      }
      return this.escalateProofFailure('server-media-path-stale-after-fallback');
    }

    if (this.phase === 'fallback-proving' || this.phase === 'reconnect-proving') {
      if (serverPath !== 'websocket') {
        this.proofServerWebSocketReady = false;
        this.proofBaselineSerial = null;
        const packetEvidence = this.packetCoverageEvidence(packetCounters);
        const serverHealthy = serverAdvanced && (
          !packetEvidence.available
          || (packetEvidence.ready && packetEvidence.healthy === true)
        );
        if (serverHealthy) {
          this.staleCount = 0;
          return { action: 'none', reason: 'waiting-server-websocket', ...this.status() };
        }
        if (
          packetEvidence.available
          && !packetEvidence.ready
          && this.shouldDeferIncompletePacketWindow(serverAdvanced)
        ) {
          return { action: 'none', reason: 'packet-window-accumulating', ...this.status() };
        }
        this.staleCount += 1;
        if (this.staleCount < this.staleObservations) {
          return { action: 'none', reason: 'waiting-server-websocket', ...this.status() };
        }
        return this.escalateProofFailure('server-media-path-stale-after-fallback');
      }

      const packetEvidence = this.packetCoverageEvidence(packetCounters);
      if (packetEvidence.available) {
        const semanticProofAdvanced = this.proofBaselineSerial !== null
          && acceptedSerial > this.proofBaselineSerial;
        if (
          !packetEvidence.ready
          && this.shouldDeferIncompletePacketWindow(semanticProofAdvanced)
        ) {
          if (packetEvidence.submittedDelta === 0) this.staleCount = 0;
          return { action: 'none', reason: 'packet-window-accumulating', ...this.status() };
        }
        if (packetEvidence.healthy && semanticProofAdvanced) {
          this.phase = 'observing';
          this.staleCount = 0;
          this.proofBaselineSerial = null;
          this.proofServerWebSocketReady = false;
          return { action: 'recovered', reason: 'server-pcm-coverage-healthy-on-websocket', ...this.status() };
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
        return { action: 'none', reason: 'proving-recovery', ...this.status() };
      }
      const underDelivered = packetEvidence.available
        && packetEvidence.ready
        && packetEvidence.healthy === false;
      return this.escalateProofFailure(
        underDelivered
          ? 'server-pcm-underdelivery-after-fallback'
          : 'server-pcm-stale-after-fallback',
      );
    }

    const packetEvidence = this.packetCoverageEvidence(packetCounters);
    if (packetEvidence.available) {
      if (
        !packetEvidence.ready
        && this.shouldDeferIncompletePacketWindow(serverAdvanced)
      ) {
        if (packetEvidence.submittedDelta === 0) this.staleCount = 0;
        return { action: 'none', reason: 'packet-window-accumulating', ...this.status() };
      }
      if (packetEvidence.healthy && serverAdvanced) {
        this.staleCount = 0;
        return { action: 'none', reason: 'server-pcm-coverage-healthy', ...this.status() };
      }
    } else if (serverAdvanced) {
      this.staleCount = 0;
      return { action: 'none', reason: 'server-pcm-advancing', ...this.status() };
    }

    const underDelivered = packetEvidence.available
      && packetEvidence.ready
      && packetEvidence.healthy === false;
    this.staleCount += 1;
    if (this.staleCount < this.staleObservations) {
      return {
        action: 'none',
        reason: underDelivered
          ? 'server-pcm-underdelivery-observation'
          : 'server-pcm-stale-observation',
        ...this.status(),
      };
    }

    this.staleCount = 0;
    const reason = underDelivered ? 'server-pcm-underdelivery' : 'server-pcm-stale';
    if (localPath === 'webtransport' && !this.webTransportDemotionUsed) {
      this.webTransportDemotionUsed = true;
      this.webTransportQuarantined = true;
      this.phase = 'fallback-proving';
      this.proofBaselineSerial = null;
      this.proofServerWebSocketReady = false;
      return { action: 'demote-webtransport', reason, ...this.status() };
    }

    if (localPath === 'websocket' && !this.webSocketReplacementUsed) {
      // A same-generation reconnect advertises WT again. Quarantine it before
      // replacing this socket so the recovery proof stays on WebSocket.
      this.webTransportQuarantined = true;
      this.webSocketReplacementUsed = true;
      this.phase = 'reconnect-proving';
      this.proofBaselineSerial = null;
      this.proofServerWebSocketReady = false;
      return { action: 'replace-websocket', reason, ...this.status() };
    }

    this.phase = 'degraded-latched';
    return { action: 'degraded-latched', reason: 'server-pcm-stale-after-bounded-recovery', ...this.status() };
  }
}
