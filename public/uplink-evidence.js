// What the Mic page has seen of its own uplink during one capture: audio it
// dropped and why, how late worklet chunks reached the main thread, and
// clipping since the last uplink-health report the Relay acknowledged. The
// report itself, and when it is sent, stay with the publisher in app.js.
import { DEFAULT_CAPTURE_DISPATCH_BACKLOG_MS } from './capture-dispatch.js';
import {
  captureClippingSnapshot,
  captureRecentInputClippingDetected,
} from './capture-observability.js';

const UPLINK_WARNING_INTERVAL_MS = 2000;

function noDroppedSamples() {
  return { disconnected: 0, congested: 0, packetTooLarge: 0, captureBacklog: 0 };
}

let uplinkDroppedSamples = 0;
let uplinkDroppedSamplesByReason = noDroppedSamples();
let lastUplinkWarningAt = 0;
let latestCaptureDispatchLagMs = null;
let maxCaptureDispatchLagMs = null;
let captureDispatchBacklogActive = false;
/**
 * Null means the active worklet does not expose interval clipping evidence
 * (rollout-compatible legacy). Once observed, this is the OR of clipped 20 ms
 * windows since the last server-acknowledged uplink-health report.
 */
let captureInputClippingSinceHealth = null;
let captureInputClippingRevision = 0;
const pendingCaptureClippingHealth = new Map();

/** A new capture starts with no evidence. */
export function resetUplinkEvidence() {
  uplinkDroppedSamples = 0;
  uplinkDroppedSamplesByReason = noDroppedSamples();
  latestCaptureDispatchLagMs = null;
  maxCaptureDispatchLagMs = null;
  captureDispatchBacklogActive = false;
  captureInputClippingSinceHealth = null;
  captureInputClippingRevision = 0;
  pendingCaptureClippingHealth.clear();
}

/**
 * Counts audio that never left the page. Returns the warning to show, or
 * null: a disconnect is not one, and the page shows at most one every 2 s.
 */
export function countUplinkDrop(sampleCount, reason, { nowMs, sampleRate }) {
  if (!Number.isFinite(sampleCount) || sampleCount <= 0) return null;
  uplinkDroppedSamples += sampleCount;
  if (reason === 'disconnected') uplinkDroppedSamplesByReason.disconnected += sampleCount;
  else if (reason === 'congested') uplinkDroppedSamplesByReason.congested += sampleCount;
  else if (reason === 'packet-too-large') uplinkDroppedSamplesByReason.packetTooLarge += sampleCount;
  else if (reason === 'capture-backlog') uplinkDroppedSamplesByReason.captureBacklog += sampleCount;
  if (reason === 'disconnected') return null;

  if (nowMs - lastUplinkWarningAt <= UPLINK_WARNING_INTERVAL_MS) return null;
  lastUplinkWarningAt = nowMs;
  const droppedMs = Math.round((uplinkDroppedSamples * 1000) / sampleRate);
  const title = reason === 'packet-too-large'
    ? 'Microphone datagram budget changed'
    : reason === 'capture-backlog'
      ? 'Microphone capture caught up to live audio'
      : 'Microphone uplink congested';
  return {
    title,
    detail: `Dropped about ${droppedMs} ms of microphone audio. `
      + 'The sample timeline keeps the hole in the right place instead of pulling later audio earlier.',
  };
}

/** How late one worklet chunk reached the page, from classifyCaptureDispatch. */
export function noteCaptureDispatch(dispatch) {
  if (!dispatch.measurable) return;
  latestCaptureDispatchLagMs = Math.round(dispatch.lagMs);
  maxCaptureDispatchLagMs = Math.max(
    maxCaptureDispatchLagMs ?? 0,
    latestCaptureDispatchLagMs,
  );
  captureDispatchBacklogActive = dispatch.stale;
}

/** The clipping snapshot of one worklet level window: did it clip? */
export function noteCaptureClipping(clipping) {
  if (clipping?.windowMaxConsecutiveRailSamples === undefined) return;
  if (captureInputClippingSinceHealth === null) captureInputClippingSinceHealth = false;
  if (captureRecentInputClippingDetected(clipping)) {
    captureInputClippingSinceHealth = true;
    captureInputClippingRevision += 1;
  }
}

/** The evidence fields of an uplink-health report. */
export function uplinkEvidenceReport(latestLocalMicLevel) {
  return {
    captureClipping: captureClippingHealthSnapshot(latestLocalMicLevel),
    captureDispatch: latestCaptureDispatchLagMs === null ? null : {
      lagMs: latestCaptureDispatchLagMs,
      maxLagMs: maxCaptureDispatchLagMs,
      backlogMs: DEFAULT_CAPTURE_DISPATCH_BACKLOG_MS,
      backlogActive: captureDispatchBacklogActive,
    },
    droppedSamples: { total: uplinkDroppedSamples, ...uplinkDroppedSamplesByReason },
  };
}

function captureClippingHealthSnapshot(latestLocalMicLevel) {
  const clipping = captureClippingSnapshot(latestLocalMicLevel);
  if (!clipping) return null;
  const {
    windowMaxConsecutiveRailSamples: _windowMaxConsecutiveRailSamples,
    ...lifetime
  } = clipping;
  return {
    ...lifetime,
    ...(captureInputClippingSinceHealth === null
      ? {}
      : { recentDetected: captureInputClippingSinceHealth }),
  };
}

/**
 * A report carrying the current clipping evidence left the page. Keep interval
 * evidence until the server ACK proves this exact health report was accepted.
 * The revision prevents a late ACK from clearing clipping that happened after
 * this request left the page.
 */
export function noteUplinkHealthSent(healthRequestId, sentAtMs) {
  pendingCaptureClippingHealth.set(healthRequestId, {
    revision: captureInputClippingRevision,
    sentAtMs,
  });
}

/** The Relay acknowledged this report. */
export function settleCaptureClippingHealth(healthRequestId) {
  const accepted = pendingCaptureClippingHealth.get(healthRequestId);
  if (!accepted) return false;

  // Mirror PublisherCommandLiveness supersession: once this request is
  // acknowledged, any older clipping snapshot can never become authoritative.
  for (const [requestId, pending] of pendingCaptureClippingHealth) {
    if (pending.sentAtMs <= accepted.sentAtMs) pendingCaptureClippingHealth.delete(requestId);
  }

  // Do not let an older ACK erase a clipped window that occurred after that
  // request was sent.
  if (
    captureInputClippingSinceHealth !== null
    && accepted.revision === captureInputClippingRevision
  ) {
    captureInputClippingSinceHealth = false;
  }
  return true;
}

/**
 * No ACK from an older socket can settle anything any more. Keep the interval
 * evidence itself, but discard request ids that can no longer settle it so
 * repeated failed reconnect cycles cannot grow this map indefinitely.
 */
export function forgetUnsettledUplinkHealth() {
  pendingCaptureClippingHealth.clear();
}
