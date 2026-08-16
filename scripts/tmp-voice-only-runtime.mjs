import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

function replaceExact(path, before, after) {
  const source = readFileSync(path, 'utf8');
  const count = source.split(before).length - 1;
  assert.equal(count, 1, `${path}: expected exactly one replacement target, got ${count}`);
  writeFileSync(path, source.replace(before, after));
}

replaceExact(
  'src/readiness.ts',
  "  if (input.backingConnected || input.sessionActive) return 'legacy';\n",
  "  // An active mixer no longer implies backing exists: a Mic-only room has a\n  // real session clock without arming any backing route. Runtime callers pass\n  // routeMode explicitly when reconnect grace must retain a legacy/Robot route.\n  if (input.backingConnected) return 'legacy';\n",
);

replaceExact(
  'src/readiness.ts',
  `  const sessionReasons: ReadinessReason[] = [...reasons];\n  if (input.sessionActive && routeMode === 'idle') {\n    // A live mixer without a backing route is a degraded transition (for\n    // example the backing grace window), not a legitimately idle host.\n    sessionReasons.push('backing-not-connected');\n  }\n\n  if (!input.micConnected) sessionReasons.push('mic-not-connected');\n  else if (!input.micStreaming) sessionReasons.push('mic-not-streaming');\n\n  if (!input.timelineConnected) sessionReasons.push('phone-timeline-not-connected');\n  else if (input.timelineState !== 1) sessionReasons.push('phone-not-playing');\n  else if (routeMode === 'robot' && !input.playerOffsetFresh) {\n    sessionReasons.push('robot-player-offset-stale');\n  }\n\n  if (!input.calibrationValid) {\n    if (input.calibrationState === 'collecting') sessionReasons.push('calibration-collecting');\n    else if (input.calibrationStale) sessionReasons.push('calibration-stale');\n    else sessionReasons.push('calibration-missing');\n  }\n`,
  `  const sessionReasons: ReadinessReason[] = [...reasons];\n\n  if (!input.micConnected) sessionReasons.push('mic-not-connected');\n  else if (!input.micStreaming) sessionReasons.push('mic-not-streaming');\n\n  // Timeline and calibration describe the relationship between Voice and Song.\n  // A voice-only room has nothing to align, so missing playback/calibration is\n  // normal state rather than incomplete session readiness.\n  if (routeMode !== 'idle') {\n    if (!input.timelineConnected) sessionReasons.push('phone-timeline-not-connected');\n    else if (input.timelineState !== 1) sessionReasons.push('phone-not-playing');\n    else if (routeMode === 'robot' && !input.playerOffsetFresh) {\n      sessionReasons.push('robot-player-offset-stale');\n    }\n\n    if (!input.calibrationValid) {\n      if (input.calibrationState === 'collecting') sessionReasons.push('calibration-collecting');\n      else if (input.calibrationStale) sessionReasons.push('calibration-stale');\n      else sessionReasons.push('calibration-missing');\n    }\n  }\n`,
);

replaceExact(
  'src/product-view-model.ts',
  `function productLifecycle(input: ProductViewModelInput): ProductLifecycle {\n  if (input.take.lifecycle === 'recording' || input.take.lifecycle === 'finalizing') {\n    return 'recording';\n  }\n  if (input.roomSong.handoffState !== 'idle' || input.timing.calibrationState === 'collecting') {\n    return 'preparing';\n  }\n  if (\n    input.roomSong.videoId !== null\n    && input.roomSong.state === 1\n    && input.readiness.components.session.active\n  ) {\n    return 'live';\n  }\n  if (input.roomSong.videoId !== null) return 'ready';\n  return 'idle';\n}\n`,
  `function productLifecycle(input: ProductViewModelInput): ProductLifecycle {\n  if (input.take.lifecycle === 'recording' || input.take.lifecycle === 'finalizing') {\n    return 'recording';\n  }\n  const songLoaded = input.roomSong.videoId !== null;\n  if (\n    input.roomSong.handoffState !== 'idle'\n    || (songLoaded && input.timing.calibrationState === 'collecting')\n  ) {\n    return 'preparing';\n  }\n\n  const mic = micState(input);\n  if (\n    input.readiness.components.session.active\n    && (input.roomSong.state === 1 || mic === 'live' || mic === 'reconnecting')\n  ) {\n    return 'live';\n  }\n  if (songLoaded) return 'ready';\n  return 'idle';\n}\n`,
);

replaceExact(
  'src/product-view-model.ts',
  `  const performanceActive = lifecycle === 'live' || lifecycle === 'recording';\n  if (input.timing.calibrationState === 'collecting') return 'calibrating';\n  if (!performanceActive) return 'idle';\n`,
  `  const songLoaded = input.roomSong.videoId !== null;\n  if (!songLoaded) return 'idle';\n  if (input.timing.calibrationState === 'collecting') return 'calibrating';\n  const performanceActive = input.roomSong.state === 1\n    && (lifecycle === 'live' || lifecycle === 'recording');\n  if (!performanceActive) return 'idle';\n`,
);

replaceExact(
  'src/product-view-model.ts',
  `  const host = hostAttention(input);\n  if (host) return host;\n\n  const songLoaded = input.roomSong.videoId !== null;\n  const performanceActive = lifecycle === 'live' || lifecycle === 'recording';\n`,
  `  const songLoaded = input.roomSong.videoId !== null;\n  // Backing/Robot failures remain visible in technical readiness, but they are\n  // not a product blocker when the room intentionally has no Song.\n  const host = songLoaded ? hostAttention(input) : null;\n  if (host) return host;\n\n  const performanceActive = songLoaded\n    && input.roomSong.state === 1\n    && (lifecycle === 'live' || lifecycle === 'recording');\n`,
);

replaceExact(
  'src/product-view-model.ts',
  `    actions: {\n      canStartTake: health !== 'blocked'\n        && input.readiness.components.session.active\n        && input.roomSong.videoId !== null\n        && input.take.lifecycle !== 'recording'\n        && input.take.lifecycle !== 'finalizing',\n      canStopTake: input.take.lifecycle === 'recording',\n    },\n`,
  `    actions: {\n      canStartTake: health !== 'blocked'\n        && input.readiness.components.session.active\n        && (\n          input.roomSong.videoId === null\n            ? micState(input) === 'live'\n            : input.readiness.components.backing.connected\n              && input.readiness.components.backing.streaming\n        )\n        && input.take.lifecycle !== 'recording'\n        && input.take.lifecycle !== 'finalizing',\n      canStopTake: input.take.lifecycle === 'recording',\n    },\n`,
);

replaceExact(
  'src/take-session.ts',
  `export type TakeSongSnapshot = {\n  videoId: string;\n`,
  `export type TakeSongSnapshot = {\n  // Null is an intentional voice-only Take, not a missing required field.\n  videoId: string | null;\n`,
);

replaceExact(
  'src/take-controller.ts',
  `    this.quality = new TakeQualityTracker({ sampleRate: this.options.sampleRate });\n`,
  `    const backingExpected = song.videoId !== null;\n    this.quality = new TakeQualityTracker({\n      sampleRate: this.options.sampleRate,\n      backingExpected,\n      timingExpected: backingExpected,\n    });\n`,
);

replaceExact(
  'src/take-quality.ts',
  `  constructor(private readonly options: { sampleRate: number }) {}\n`,
  `  constructor(private readonly options: {\n    sampleRate: number;\n    /** False for an intentional voice-only Take. */\n    backingExpected?: boolean;\n    /** False when there is no Song for Voice to align against. */\n    timingExpected?: boolean;\n  }) {}\n`,
);

replaceExact(
  'src/take-quality.ts',
  `    this.micGapSamples += audio.micGapSamples;\n    this.backingGapSamples += audio.backingGapSamples;\n    this.micStarvedSamples += audio.micStarvedSamples;\n    this.backingStarvedSamples += audio.backingStarvedSamples;\n    if (audio.micStarvedSamples > 0) this.micStarvedFrames += 1;\n    if (audio.backingStarvedSamples > 0) this.backingStarvedFrames += 1;\n    this.clippedSamples += audio.clippedSamples;\n    this.limitedSamples += audio.limitedSamples;\n    this.unheaderedSamples += audio.unheaderedSamples;\n    this.micUnavailableSamples += audio.micUnavailableSamples;\n    this.backingUnavailableSamples += audio.backingUnavailableSamples;\n\n    if (state.timingMode === 'network-estimate') this.networkEstimateSamples += sampleCount;\n    if (state.calibrationStale) this.calibrationStaleSamples += sampleCount;\n    if (state.alignmentClamped) this.alignmentClampedSamples += sampleCount;\n    if (state.robotRoute && !state.robotDeltaFresh) this.robotDeltaMissingSamples += sampleCount;\n`,
  `    this.micGapSamples += audio.micGapSamples;\n    this.micStarvedSamples += audio.micStarvedSamples;\n    if (audio.micStarvedSamples > 0) this.micStarvedFrames += 1;\n    this.micUnavailableSamples += audio.micUnavailableSamples;\n\n    if (this.options.backingExpected !== false) {\n      this.backingGapSamples += audio.backingGapSamples;\n      this.backingStarvedSamples += audio.backingStarvedSamples;\n      if (audio.backingStarvedSamples > 0) this.backingStarvedFrames += 1;\n      this.backingUnavailableSamples += audio.backingUnavailableSamples;\n    }\n\n    this.clippedSamples += audio.clippedSamples;\n    this.limitedSamples += audio.limitedSamples;\n    this.unheaderedSamples += audio.unheaderedSamples;\n\n    if (this.options.timingExpected !== false) {\n      if (state.timingMode === 'network-estimate') this.networkEstimateSamples += sampleCount;\n      if (state.calibrationStale) this.calibrationStaleSamples += sampleCount;\n      if (state.alignmentClamped) this.alignmentClampedSamples += sampleCount;\n      if (state.robotRoute && !state.robotDeltaFresh) this.robotDeltaMissingSamples += sampleCount;\n    }\n`,
);

replaceExact(
  'src/take-quality.ts',
  `  noteEvent(kind: TakeQualityEventKind) {\n    this.events[kind] += 1;\n  }\n`,
  `  noteEvent(kind: TakeQualityEventKind) {\n    if (\n      this.options.backingExpected === false\n      && (kind.startsWith('backing-') || kind.startsWith('robot-'))\n    ) return;\n    this.events[kind] += 1;\n  }\n`,
);

replaceExact(
  'src/server.ts',
  `import { buildReadiness } from './readiness.js';\n`,
  `import { buildReadiness, type RouteMode } from './readiness.js';\n`,
);

replaceExact(
  'src/server.ts',
  `function takeSongSnapshot(nowMs = performance.now()): TakeSongSnapshot | null {\n  const room = youtubeTimeline.roomStatusPayload(nowMs) as Record<string, unknown>;\n  if (typeof room.videoId !== 'string' || !room.videoId) return null;\n\n  const revision = Number(room.revision);\n  const state = Number(room.state);\n  const serverTime = Number(room.serverTime);\n  const playbackRate = Number(room.playbackRate);\n  return {\n    videoId: room.videoId,\n    revision: Number.isInteger(revision) ? revision : null,\n    state: Number.isFinite(state) ? state : null,\n    serverTime: Number.isFinite(serverTime) ? serverTime : null,\n    playbackRate: Number.isFinite(playbackRate) ? playbackRate : null,\n  };\n}\n`,
  `function takeSongSnapshot(nowMs = performance.now()): TakeSongSnapshot {\n  const room = youtubeTimeline.roomStatusPayload(nowMs) as Record<string, unknown>;\n  const videoId = typeof room.videoId === 'string' && room.videoId ? room.videoId : null;\n  if (videoId === null) {\n    return {\n      videoId: null,\n      revision: null,\n      state: null,\n      serverTime: null,\n      playbackRate: null,\n    };\n  }\n\n  const revision = Number(room.revision);\n  const state = Number(room.state);\n  const serverTime = Number(room.serverTime);\n  const playbackRate = Number(room.playbackRate);\n  return {\n    videoId,\n    revision: Number.isInteger(revision) ? revision : null,\n    state: Number.isFinite(state) ? state : null,\n    serverTime: Number.isFinite(serverTime) ? serverTime : null,\n    playbackRate: Number.isFinite(playbackRate) ? playbackRate : null,\n  };\n}\n\nfunction roomHasSong(nowMs = performance.now()) {\n  return takeSongSnapshot(nowMs).videoId !== null;\n}\n`,
);

replaceExact(
  'src/server.ts',
  `function readinessPayload(nowMs = performance.now()) {\n`,
  `function readinessRouteMode(): RouteMode {\n  if (backingIsRobot || activeRobotSource?.readyState === WebSocket.OPEN) return 'robot';\n  if (backing?.readyState === WebSocket.OPEN || backingAbsenceTimer !== null) return 'legacy';\n  return 'idle';\n}\n\nfunction readinessPayload(nowMs = performance.now()) {\n`,
);

replaceExact(
  'src/server.ts',
  `  return buildReadiness({\n    backingConnected: backing?.readyState === WebSocket.OPEN,\n`,
  `  return buildReadiness({\n    routeMode: readinessRouteMode(),\n    backingConnected: backing?.readyState === WebSocket.OPEN,\n`,
);

replaceExact(
  'src/server.ts',
  `    if (payload.type === 'start-take') {\n      if (!socket.participantId) {\n        rejectTakeCommand(socket, 'start', 'participant-required');\n        return;\n      }\n      if (!session.active) {\n        rejectTakeCommand(socket, 'start', 'mix-not-active');\n        return;\n      }\n      const song = takeSongSnapshot();\n      if (!song) {\n        rejectTakeCommand(socket, 'start', 'song-required');\n        return;\n      }\n\n      const result = takeController.start(socket.participantId, song);\n`,
  `    if (payload.type === 'start-take') {\n      if (!socket.participantId) {\n        rejectTakeCommand(socket, 'start', 'participant-required');\n        return;\n      }\n      if (!session.active) {\n        rejectTakeCommand(socket, 'start', 'mix-not-active');\n        return;\n      }\n      const nowMs = performance.now();\n      const song = takeSongSnapshot(nowMs);\n      const micStreaming = publisher?.readyState === WebSocket.OPEN\n        && nowMs - lastMicFrameAt < STREAM_LIVE_MS;\n      const backingStreaming = backing?.readyState === WebSocket.OPEN\n        && nowMs - lastBackingFrameAt < STREAM_LIVE_MS;\n      if (song.videoId === null ? !micStreaming : !backingStreaming) {\n        rejectTakeCommand(socket, 'start', 'take-not-ready');\n        return;\n      }\n\n      const result = takeController.start(socket.participantId, song);\n`,
);

replaceExact(
  'src/server.ts',
  `      restartLiveSourceAfterMicReconnect();\n      sendJson(socket, {\n`,
  `      if (session.active) restartLiveSourceAfterMicReconnect();\n      else startLiveSource();\n      sendJson(socket, {\n`,
);

replaceExact(
  'src/server.ts',
  `    invalidateMicTiming('Microphone transport did not reconnect before its grace period expired.');\n    broadcastSessionStatus();\n  }, MIC_TRANSPORT_GRACE_MS);\n`,
  `    invalidateMicTiming('Microphone transport did not reconnect before its grace period expired.');\n    broadcastSessionStatus();\n    maybeStopLiveSourceWhenUnarmed();\n  }, MIC_TRANSPORT_GRACE_MS);\n`,
);

replaceExact(
  'src/server.ts',
  `function stopLiveSource() {\n  cancelBackingGrace();\n  backingIsRobot = false;\n  if (!session.active) return;\n  takeController.endMix();\n  clearBootCalibrationState();\n  robotPlayerOffsetMs = null;\n  robotPlayerOffsetAt = -Infinity;\n  session.stop();\n  calibration.reset();\n  calibrationKind = 'none';\n  lastAutoCalibrationAt = -Infinity;\n  broadcastJson(timingCalibrationStatusPayload());\n  broadcastJson(sourceStatusPayload());\n  broadcastJson(testStatusPayload());\n  broadcastStatus();\n}\n`,
  `function stopLiveSource() {\n  cancelBackingGrace();\n  backingIsRobot = false;\n  if (!session.active) return;\n  takeController.endMix();\n  clearBootCalibrationState();\n  robotPlayerOffsetMs = null;\n  robotPlayerOffsetAt = -Infinity;\n  session.stop();\n  calibration.reset();\n  calibrationKind = 'none';\n  lastAutoCalibrationAt = -Infinity;\n  broadcastJson(timingCalibrationStatusPayload());\n  broadcastJson(sourceStatusPayload());\n  broadcastJson(testStatusPayload());\n  broadcastStatus();\n}\n\nfunction maybeStopLiveSourceWhenUnarmed() {\n  if (!session.active) return;\n  const micArmed = publisher?.readyState === WebSocket.OPEN || micTransportGraceTimer !== null;\n  const backingArmed = backing?.readyState === WebSocket.OPEN || backingAbsenceTimer !== null;\n  if (!micArmed && !backingArmed) stopLiveSource();\n}\n\nfunction expireBackingGrace() {\n  backingAbsenceTimer = null;\n  if (roomHasSong() || publisher?.readyState !== WebSocket.OPEN) {\n    stopLiveSource();\n    return;\n  }\n\n  // The backing route disappeared, but a voice-only room still has a valid\n  // authoritative mix. Retire backing timing state without killing the Mic.\n  backingIsRobot = false;\n  invalidateMicTiming('Backing route ended while the room continued voice-only.');\n  broadcastStatus();\n}\n`,
);

replaceExact(
  'src/server.ts',
  `      invalidateMicTiming('Microphone was released.');\n      broadcastSessionStatus();\n      sendJson(socket, { type: 'mic-released' });\n`,
  `      invalidateMicTiming('Microphone was released.');\n      broadcastSessionStatus();\n      maybeStopLiveSourceWhenUnarmed();\n      sendJson(socket, { type: 'mic-released' });\n`,
);

replaceExact(
  'src/server.ts',
  `  if (!PROBE_CALIBRATE || !robotRouteActive()) return;\n  if (!session.active || calibration.collecting) return;\n`,
  `  if (!PROBE_CALIBRATE || !robotRouteActive()) return;\n  if (!roomHasSong()) return;\n  if (!session.active || calibration.collecting) return;\n`,
);

replaceExact(
  'src/server.ts',
  `        if (reconnectingOwnerId) scheduleMicTransportGrace(reconnectingOwnerId);\n        if (calibration.collecting) {\n`,
  `        if (reconnectingOwnerId) scheduleMicTransportGrace(reconnectingOwnerId);\n        else maybeStopLiveSourceWhenUnarmed();\n        if (calibration.collecting) {\n`,
);

replaceExact(
  'src/server.ts',
  `        backingAbsenceTimer = setTimeout(stopLiveSource, BACKING_GRACE_MS);\n`,
  `        backingAbsenceTimer = setTimeout(expireBackingGrace, BACKING_GRACE_MS);\n`,
);

const unitTest = `import assert from 'node:assert/strict';\nimport test from 'node:test';\n\nimport { buildProductViewModel } from '../src/product-view-model.js';\nimport { buildReadiness, type ReadinessInput } from '../src/readiness.js';\nimport { TakeQualityTracker } from '../src/take-quality.js';\nimport { TakeSession } from '../src/take-session.js';\n\nconst VOICE_ONLY: ReadinessInput = {\n  routeMode: 'idle',\n  backingConnected: false,\n  backingStreaming: false,\n  backingSampleRate: null,\n  backingIsRobot: false,\n  micConnected: true,\n  micStreaming: true,\n  robotSourceConnected: false,\n  sessionActive: true,\n  timelineConnected: false,\n  timelineState: null,\n  playerOffsetMs: null,\n  playerOffsetFresh: false,\n  calibrationState: 'idle',\n  calibrationValid: false,\n  calibrationStale: false,\n  calibrationKind: 'none',\n  probeCorrelation: { mic: null, backing: null },\n  bootCalibration: null,\n};\n\ntest('voice-only session readiness does not require Song timeline or calibration', () => {\n  const readiness = buildReadiness(VOICE_ONLY);\n  assert.equal(readiness.ready, true);\n  assert.equal(readiness.sessionReady, true);\n  assert.deepEqual(readiness.reasons, []);\n  assert.deepEqual(readiness.sessionReasons, []);\n  assert.equal(readiness.components.route.mode, 'idle');\n});\n\ntest('product lifecycle and Take availability treat live Mic as a complete voice-only room', () => {\n  const status = buildProductViewModel({\n    readiness: buildReadiness(VOICE_ONLY),\n    participantCount: 1,\n    micOwnerId: 'participant-a',\n    micOwnerNickname: 'A',\n    roomSong: { videoId: null, connected: false, state: null, handoffState: 'idle' },\n    take: { lifecycle: 'idle', takeId: null, qualityVerdict: null },\n    timing: {\n      timingMode: 'network-estimate',\n      calibrationState: 'idle',\n      calibrationStale: false,\n      alignmentClamped: false,\n      robotRoute: false,\n      robotDeltaFresh: false,\n    },\n  });\n\n  assert.equal(status.lifecycle, 'live');\n  assert.equal(status.health, 'healthy');\n  assert.equal(status.room.song.state, 'empty');\n  assert.equal(status.timing.state, 'idle');\n  assert.equal(status.actions.canStartTake, true);\n});\n\ntest('voice-only Take snapshot explicitly records that there was no Song', () => {\n  const takes = new TakeSession();\n  const started = takes.start({\n    takeId: 'voice-only',\n    startedByParticipantId: 'participant-a',\n    song: { videoId: null, revision: null, state: null, serverTime: null, playbackRate: null },\n    startedAtMs: 1_000,\n  });\n  assert.equal(started.ok, true);\n  assert.equal(takes.currentTake()?.song.videoId, null);\n});\n\ntest('voice-only quality ignores intentionally absent backing and timing evidence', () => {\n  const tracker = new TakeQualityTracker({\n    sampleRate: 48_000,\n    backingExpected: false,\n    timingExpected: false,\n  });\n  tracker.observeFrame(960, {\n    timingMode: 'network-estimate',\n    calibrationStale: true,\n    alignmentClamped: true,\n    robotRoute: true,\n    robotDeltaFresh: false,\n  }, {\n    micGapSamples: 0,\n    backingGapSamples: 960,\n    micStarvedSamples: 0,\n    backingStarvedSamples: 960,\n    micUnavailableSamples: 0,\n    backingUnavailableSamples: 960,\n    clippedSamples: 0,\n    limitedSamples: 0,\n    unheaderedSamples: 0,\n  });\n  tracker.noteEvent('backing-transport-disconnected');\n  tracker.noteEvent('robot-source-disconnected');\n\n  const quality = tracker.assessment();\n  assert.equal(quality.verdict, 'clean');\n  assert.equal(quality.evidence.backingUnavailableMs, 0);\n  assert.equal(quality.evidence.networkEstimateMs, 0);\n  assert.equal(quality.evidence.calibrationStaleMs, 0);\n  assert.equal(quality.evidence.events['backing-transport-disconnected'], 0);\n  assert.equal(quality.evidence.events['robot-source-disconnected'], 0);\n});\n`;
writeFileSync('test/voice-only-room.test.ts', unitTest);

const serverTest = `import assert from 'node:assert/strict';\nimport { mkdtemp, rm } from 'node:fs/promises';\nimport os from 'node:os';\nimport path from 'node:path';\nimport test from 'node:test';\n\nimport { RelayClient, sleep, startRelay } from './helpers/harness.js';\n\nconst RATE = 48_000;\nconst FRAME_SAMPLES = 960;\nconst FAST = {\n  RELAY_AUTO_CALIBRATE: '0',\n  RELAY_CALIBRATION_PROBE: '0',\n  RELAY_HEARTBEAT_MS: '60000',\n  RELAY_LIVE_PREBUFFER_MS: '40',\n};\n\nfunction pcm(value = 4_000) {\n  const frame = Buffer.alloc(FRAME_SAMPLES * 2);\n  for (let i = 0; i < FRAME_SAMPLES; i += 1) frame.writeInt16LE(value, i * 2);\n  return frame;\n}\n\nfunction feedMic(client, frames, value = 4_000) {\n  const frame = pcm(value);\n  for (let i = 0; i < frames; i += 1) client.sendPcm(frame);\n}\n\ntest('real server records a voice-only Take without Song, backing or timing calibration', async () => {\n  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-voice-only-'));\n  const server = await startRelay({ ...FAST, RELAY_TAKE_DIR: directory });\n  const mic = await RelayClient.connect(server, '?participant=participant-a&name=A');\n  try {\n    mic.send({ type: 'register', role: 'publisher', sampleRate: RATE, captureGeneration: 1 });\n    await mic.waitFor((message) => message.type === 'registered' && message.role === 'publisher');\n\n    feedMic(mic, 30);\n    await sleep(30);\n    mic.send({ type: 'product-status-request' });\n    const product = await mic.waitFor((message) => (\n      message.type === 'product-status'\n      && message.room?.song?.state === 'empty'\n      && message.room?.mic?.state === 'live'\n      && message.actions?.canStartTake === true\n    ));\n    assert.equal(product.lifecycle, 'live');\n    assert.equal(product.timing.state, 'idle');\n\n    mic.send({ type: 'start-take' });\n    const accepted = await mic.waitFor((message) => (\n      message.type === 'take-command-accepted' && message.command === 'start'\n    ));\n    const takeId = String(accepted.takeId);\n    const recording = await mic.waitFor((message) => (\n      message.type === 'take-status'\n      && message.lifecycle === 'recording'\n      && message.take?.takeId === takeId\n    ));\n    assert.equal(recording.take.song.videoId, null);\n\n    feedMic(mic, 40, 3_000);\n    await sleep(180);\n    mic.send({ type: 'stop-take', takeId });\n    const ready = await mic.waitFor((message) => (\n      message.type === 'take-status'\n      && message.lifecycle === 'ready'\n      && message.take?.takeId === takeId\n    ));\n\n    const issueCodes = new Set(ready.take.quality.issues.map((issue) => issue.code));\n    for (const code of [\n      'backing-unavailable',\n      'backing-pcm-gap',\n      'backing-starvation',\n      'timing-fallback',\n      'calibration-stale',\n      'alignment-clamped',\n      'robot-delta-missing',\n    ]) assert.equal(issueCodes.has(code), false, `${code} must not describe an intentional voice-only Take`);\n    assert.equal(ready.take.song.videoId, null);\n    assert.ok(ready.take.artifact.durationMs > 0);\n  } finally {\n    mic.close();\n    await server.stop();\n    await rm(directory, { recursive: true, force: true });\n  }\n});\n`;
writeFileSync('test/voice-only-server.test.ts', serverTest);

// Update the old product contract: technical Robot readiness may still be bad,
// but without a Song that infrastructure is not a product-level blocker.
replaceExact(
  'test/product-view-model.test.ts',
  `  test('blocks the product when robot backing audio is unavailable even while idle', () => {\n`,
  `  test('keeps unused Robot backing failure out of product health when there is no Song', () => {\n`,
);
replaceExact(
  'test/product-view-model.test.ts',
  `    assert.equal(model.lifecycle, 'idle');\n    assert.equal(model.health, 'blocked');\n    assert.equal(model.attention?.code, 'robot-audio-unavailable');\n  });\n\n  test('reports a loaded paused room as ready without treating phone-not-playing as damage', () => {\n`,
  `    assert.equal(model.lifecycle, 'idle');\n    assert.equal(model.health, 'healthy');\n    assert.equal(model.attention, null);\n  });\n\n  test('reports a loaded paused room as ready without treating phone-not-playing as damage', () => {\n`,
);

console.log('voice-only runtime refactor applied');
