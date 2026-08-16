import { readFileSync, writeFileSync } from 'node:fs';

const path = 'src/server.ts';
let source = readFileSync(path, 'utf8');

function replaceOnce(label, needle, replacement) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`missing ${label} needle`);
  if (source.indexOf(needle, first + needle.length) >= 0) throw new Error(`ambiguous ${label} needle`);
  source = source.replace(needle, replacement);
}

replaceOnce(
  'product imports',
  "import { decodePcmFrame } from './pcm-frame.js';\n",
  "import { decodePcmFrame } from './pcm-frame.js';\nimport { buildProductViewModel } from './product-view-model.js';\nimport { buildReadiness } from './readiness.js';\n",
);

replaceOnce(
  'readiness endpoint',
  "app.get('/statusz', (_req, res) => {\n  res.json(remoteStatusPayload());\n});\n",
  "app.get('/statusz', (_req, res) => {\n  res.json(remoteStatusPayload());\n});\napp.get('/readyz', (_req, res) => {\n  const readiness = readinessPayload();\n  res.status(readiness.ready ? 200 : 503).json(readiness);\n});\n",
);

const statusHelpers = `function currentTimelineStatus(nowMs = performance.now()) {
  return youtubeTimeline.statusPayload(nowMs) as TimelineStatus & Record<string, unknown>;
}

/**
 * One runtime readiness collector shared by diagnostics and product UI.
 *
 * Keep transport facts here rather than reconstructing them in /readyz, the
 * browser, or ProductViewModel independently. The pure readiness model decides
 * what those facts mean; this function only samples the live server once.
 */
function readinessPayload(nowMs = performance.now()) {
  const timeline = currentTimelineStatus(nowMs);
  const calibrationStatus = calibration.status();
  const timelineState = Number(timeline.state);

  return buildReadiness({
    backingConnected: backing?.readyState === WebSocket.OPEN,
    backingStreaming: nowMs - lastBackingFrameAt < STREAM_LIVE_MS,
    backingSampleRate,
    backingIsRobot,
    micConnected: publisher?.readyState === WebSocket.OPEN,
    micStreaming: nowMs - lastMicFrameAt < STREAM_LIVE_MS,
    robotSourceConnected: activeRobotSource?.readyState === WebSocket.OPEN,
    sessionActive: session.active,
    timelineConnected: Boolean(timeline.connected && timeline.videoId),
    timelineState: Number.isFinite(timelineState) ? timelineState : null,
    playerOffsetMs: robotPlayerOffsetMs,
    playerOffsetFresh: robotDeltaIsFresh(nowMs),
    calibrationState: String(calibrationStatus.state ?? 'idle'),
    calibrationValid: calibrationCanApply() && session.alignment.calibratedMicLagMs !== null,
    calibrationStale: calibrationIsStale(),
    calibrationKind,
    probeCorrelation: lastProbeCorrelation,
    bootCalibration: lastBootCalibration,
  });
}

function productStatusPayload(nowMs = performance.now()) {
  const readiness = readinessPayload(nowMs);
  const participantSnapshot = participants.snapshot();
  const micOwner = participantSnapshot.micOwnerId
    ? participantSnapshot.participants.find((participant) => participant.id === participantSnapshot.micOwnerId) ?? null
    : null;
  const room = youtubeTimeline.roomStatusPayload(nowMs) as Record<string, unknown>;
  const roomState = Number(room.state);
  const takeStatus = takeController.statusPayload();
  const take = takeStatus.take;
  const alignment = session.alignment;
  const calibrationStatus = calibration.status();

  return buildProductViewModel({
    readiness,
    participantCount: participantSnapshot.participants.length,
    micOwnerId: participantSnapshot.micOwnerId,
    micOwnerNickname: micOwner?.nickname ?? null,
    roomSong: {
      videoId: typeof room.videoId === 'string' && room.videoId ? room.videoId : null,
      connected: Boolean(room.connected),
      state: Number.isFinite(roomState) ? roomState : null,
      handoffState: typeof room.handoffState === 'string' ? room.handoffState : 'idle',
    },
    take: {
      lifecycle: takeStatus.lifecycle,
      takeId: take?.takeId ?? null,
      qualityVerdict: take?.quality?.verdict ?? null,
    },
    timing: {
      timingMode: alignment.calibratedMicLagMs === null ? 'network-estimate' : 'acoustic-calibration',
      calibrationState: String(calibrationStatus.state ?? 'idle'),
      calibrationStale: calibrationIsStale(),
      alignmentClamped: Math.abs(session.requestedMicAdvanceMs - session.appliedMicAdvanceMs) >= 0.5,
      robotRoute: robotRouteActive(),
      robotDeltaFresh: robotDeltaIsFresh(nowMs),
    },
  });
}

let lastProductStatusJson = '';
function broadcastProductStatus(nowMs = performance.now()) {
  const status = productStatusPayload(nowMs);
  const serialized = JSON.stringify(status);
  if (serialized === lastProductStatusJson) return false;
  lastProductStatusJson = serialized;
  broadcastJson(status);
  return true;
}`;

replaceOnce(
  'runtime status helpers',
  "function currentTimelineStatus(nowMs = performance.now()) {\n  return youtubeTimeline.statusPayload(nowMs) as TimelineStatus & Record<string, unknown>;\n}",
  statusHelpers,
);

replaceOnce(
  'periodic product publication',
  "  if (presenceSweep.changed) broadcastSessionStatus();\n}, 250);",
  "  if (presenceSweep.changed) broadcastSessionStatus();\n\n  broadcastProductStatus(nowMs);\n}, 250);",
);

replaceOnce(
  'product status request',
  "    if (payload.type === 'session-status-request') {\n      sendJson(socket, sessionStatusPayload());\n      return;\n    }\n\n    if (payload.type === 'take-status-request') {",
  "    if (payload.type === 'session-status-request') {\n      sendJson(socket, sessionStatusPayload());\n      return;\n    }\n\n    if (payload.type === 'product-status-request') {\n      sendJson(socket, productStatusPayload());\n      return;\n    }\n\n    if (payload.type === 'take-status-request') {",
);

replaceOnce(
  'start Take product gate',
  "      if (!session.active) {\n        rejectTakeCommand(socket, 'start', 'mix-not-active');\n        return;\n      }\n      const song = takeSongSnapshot();",
  "      const product = productStatusPayload();\n      if (!product.actions.canStartTake) {\n        rejectTakeCommand(\n          socket,\n          'start',\n          product.health === 'blocked' ? 'product-blocked' : 'take-not-ready',\n        );\n        return;\n      }\n      const song = takeSongSnapshot();",
);

writeFileSync(path, source);
console.log('Applied readiness/product-status runtime wiring.');
