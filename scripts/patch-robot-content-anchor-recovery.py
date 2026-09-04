from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one anchor, found {count}: {old[:80]!r}")
    file.write_text(text.replace(old, new, 1))


# 1) Expose the shared non-consuming span without rendering/copying PCM.
replace_once(
    "src/timing-window-collector.ts",
    """  get backingSpanSamples() {\n    return this.spanSamples(this.backing);\n  }\n\n  observeMic(samples: Int16Array, startSample: number) {""",
    """  get backingSpanSamples() {\n    return this.spanSamples(this.backing);\n  }\n\n  /** Shared timing-coordinate span currently covered by both sides. */\n  get sharedSpanSamples() {\n    return this.capturedSamples;\n  }\n\n  observeMic(samples: Int16Array, startSample: number) {""",
)

# 2) Surface context-fenced transition evidence readiness without allocating a window.
replace_once(
    "src/calibration-session.ts",
    """  /** Read-only, context-fenced PCM for media-transition verification only. */\n  transitionEvidence(maxSamples: number): TimingWindow | null {\n    const currentContext = this.context();\n    const ownsPrimedEvidence = this.primedContext !== null\n      && this.contextsEqual(this.primedContext, currentContext);\n    if ((!this.collecting && !ownsPrimedEvidence) || this.analysisPending) return null;\n    return this.collector.peekRecentWindow(maxSamples);\n  }""",
    """  /**\n   * Shared context-fenced evidence currently available to a media-transition\n   * verifier. This is intentionally metadata-only so Robot Source can ask\n   * whether a seek is provable without copying several seconds of PCM.\n   */\n  get transitionEvidenceSpanSamples() {\n    const currentContext = this.context();\n    const ownsPrimedEvidence = this.primedContext !== null\n      && this.contextsEqual(this.primedContext, currentContext);\n    if ((!this.collecting && !ownsPrimedEvidence) || this.analysisPending) return 0;\n    return this.collector.sharedSpanSamples;\n  }\n\n  /** Read-only, context-fenced PCM for media-transition verification only. */\n  transitionEvidence(maxSamples: number): TimingWindow | null {\n    const currentContext = this.context();\n    const ownsPrimedEvidence = this.primedContext !== null\n      && this.contextsEqual(this.primedContext, currentContext);\n    if ((!this.collecting && !ownsPrimedEvidence) || this.analysisPending) return null;\n    return this.collector.peekRecentWindow(maxSamples);\n  }""",
)

# 3) Runtime: remember how much anchor evidence was already tried and retry only
# when the safe pre-seek window actually grows.
replace_once(
    "src/robot-content-transition-runtime.ts",
    """  preShiftSamples: number;\n  preRawLagMs: number | null;\n  postRawLagMs: number | null;\n  transportFrontierCaptureSample: number | null;""",
    """  preShiftSamples: number;\n  anchorAdjustmentMs: number;\n  anchorEvidenceSamplesAttempted: number;\n  preRawLagMs: number | null;\n  postRawLagMs: number | null;\n  transportFrontierCaptureSample: number | null;""",
)
replace_once(
    "src/robot-content-transition-runtime.ts",
    """      postDeltaMs: input.preDeltaMs + seekJumpMs,\n      preShiftSamples,\n      preRawLagMs: null,\n      postRawLagMs: null,""",
    """      postDeltaMs: input.preDeltaMs + seekJumpMs,\n      preShiftSamples,\n      anchorAdjustmentMs: input.preDeltaMs - input.referenceDeltaMs,\n      anchorEvidenceSamplesAttempted: 0,\n      preRawLagMs: null,\n      postRawLagMs: null,""",
)
replace_once(
    "src/robot-content-transition-runtime.ts",
    """    if (input.confirmedReferenceLagMs !== null) {\n      state.preRawLagMs = input.confirmedReferenceLagMs + input.preDeltaMs - input.referenceDeltaMs;\n      state.postRawLagMs = state.preRawLagMs + state.seekJumpMs;\n      return;\n    }\n\n    const evidence = this.host.transitionEvidence(this.historySamples);\n    if (evidence === null || evidence.mic.length <= this.sampleRate) return;\n    if (!beginRobotContentTransitionWorker(state.bounds, 'anchor', nowMs)) {\n      this.settleDegraded(state, nowMs);\n      return;\n    }\n\n    const controller = new AbortController();\n    this.abortController = controller;\n    state.analysisPending = true;\n    void this.estimateRawLag(\n      evidence.mic,\n      evidence.backing,\n      this.sampleRate,\n      this.maxLagMs,\n      controller.signal,\n    ).then((anchor) => {\n      if (!this.current(state)) return;\n      state.analysisPending = false;\n      this.abortController = null;\n      const completedAt = this.now();\n      if (sweepRobotContentTransitionBounds(state.bounds, completedAt)) {\n        this.settleDegraded(state, completedAt);\n        return;\n      }\n      if (anchor === null) return;\n      state.preRawLagMs = anchor.rawLagMs + input.preDeltaMs - input.referenceDeltaMs;\n      state.postRawLagMs = state.preRawLagMs + state.seekJumpMs;\n      this.maybeAnalyze(completedAt);\n    }, () => {\n      if (!this.current(state) || state.bounds.phase === 'degraded') return;\n      state.analysisPending = false;\n      this.abortController = null;\n      const failedAt = this.now();\n      if (noteRobotContentTransitionWorkerFailure(state.bounds, 'anchor', failedAt)) {\n        this.settleDegraded(state, failedAt);\n      }\n    });""",
    """    if (input.confirmedReferenceLagMs !== null) {\n      state.preRawLagMs = input.confirmedReferenceLagMs + state.anchorAdjustmentMs;\n      state.postRawLagMs = state.preRawLagMs + state.seekJumpMs;\n      return;\n    }\n\n    this.maybeStartAnchor(state, nowMs);""",
)
replace_once(
    "src/robot-content-transition-runtime.ts",
    """    state.chunks = state.chunks.filter((chunk) => chunk.start + chunk.samples.length > keepAfter);\n    this.maybeAnalyze(nowMs);\n    return true;\n  }\n\n  noteMicProgress(nowMs = this.now()) {\n    this.maybeAnalyze(nowMs);\n  }""",
    """    state.chunks = state.chunks.filter((chunk) => chunk.start + chunk.samples.length > keepAfter);\n    this.maybeStartAnchor(state, nowMs);\n    this.maybeAnalyze(nowMs);\n    return true;\n  }\n\n  noteMicProgress(nowMs = this.now()) {\n    const state = this.state;\n    if (state !== null) this.maybeStartAnchor(state, nowMs);\n    this.maybeAnalyze(nowMs);\n  }""",
)
replace_once(
    "src/robot-content-transition-runtime.ts",
    """  private maybeAnalyze(nowMs = this.now()) {\n    const state = this.state;""",
    """  private maybeStartAnchor(state: RobotContentTransitionState, nowMs = this.now()) {\n    if (\n      !this.current(state)\n      || state.bounds.phase !== 'verifying'\n      || state.analysisPending\n      || state.preRawLagMs !== null\n      || state.postRawLagMs !== null\n      || !contextMatches(state.context, this.host.context())\n    ) return false;\n\n    const evidence = this.host.transitionEvidence(this.historySamples);\n    if (evidence === null) return false;\n    const evidenceSamples = Math.min(evidence.mic.length, evidence.backing.length);\n    if (\n      evidenceSamples <= this.sampleRate\n      || evidenceSamples <= state.anchorEvidenceSamplesAttempted\n    ) return false;\n\n    // A null/ambiguous anchor is not terminal. More pre-seek evidence may make\n    // the next bounded attempt decisive. Never rerun the worker for the exact\n    // same snapshot, though: Mic/backing frame callbacks are much faster than\n    // the analyser and would otherwise create an accidental worker storm.\n    state.anchorEvidenceSamplesAttempted = evidenceSamples;\n    if (!beginRobotContentTransitionWorker(state.bounds, 'anchor', nowMs)) {\n      this.settleDegraded(state, nowMs);\n      return false;\n    }\n\n    const controller = new AbortController();\n    this.abortController = controller;\n    state.analysisPending = true;\n    void this.estimateRawLag(\n      evidence.mic,\n      evidence.backing,\n      this.sampleRate,\n      this.maxLagMs,\n      controller.signal,\n    ).then((anchor) => {\n      if (!this.current(state)) return;\n      state.analysisPending = false;\n      this.abortController = null;\n      const completedAt = this.now();\n      if (sweepRobotContentTransitionBounds(state.bounds, completedAt)) {\n        this.settleDegraded(state, completedAt);\n        return;\n      }\n      if (anchor === null) return;\n      state.preRawLagMs = anchor.rawLagMs + state.anchorAdjustmentMs;\n      state.postRawLagMs = state.preRawLagMs + state.seekJumpMs;\n      this.maybeAnalyze(completedAt);\n    }, () => {\n      if (!this.current(state) || state.bounds.phase === 'degraded') return;\n      state.analysisPending = false;\n      this.abortController = null;\n      const failedAt = this.now();\n      if (noteRobotContentTransitionWorkerFailure(state.bounds, 'anchor', failedAt)) {\n        this.settleDegraded(state, failedAt);\n      }\n    });\n    return true;\n  }\n\n  private maybeAnalyze(nowMs = this.now()) {\n    const state = this.state;""",
)

# 4) Server: advertise whether a follower seek can be verified before Source does it.
replace_once(
    "src/server.ts",
    """function mappedContentBackingStart(startSample: number, nowMs = performance.now()) {\n  if (!backingRuntime.isRobot) return startSample;\n  return robotContentTimeline.mapBackingStart(startSample, calibrationContext(), nowMs);\n}\n\nfunction clearRobotContentTransition() {""",
    """function mappedContentBackingStart(startSample: number, nowMs = performance.now()) {\n  if (!backingRuntime.isRobot) return startSample;\n  return robotContentTimeline.mapBackingStart(startSample, calibrationContext(), nowMs);\n}\n\nfunction robotContentTransitionAnchorReady(nowMs = performance.now()) {\n  if (!robotProbeTimingActive()) return true;\n  const context = calibrationContext();\n  if (\n    !sourceRuntime.connected()\n    || !robotContentTimeline.isReady(context, nowMs)\n    || robotContentTimeline.needsBackingBoundary(context)\n  ) return false;\n\n  // An existing confirmed content authority already names the pre-seek raw\n  // hypothesis, so no backup correlation window is needed. Otherwise require\n  // the full bounded history before allowing Source to create a discontinuity.\n  if (\n    timingRuntime.calibrationKind === 'content'\n    && calibration.confirmedResult !== null\n    && !calibrationIsStale()\n  ) return true;\n  return calibration.transitionEvidenceSpanSamples >= ROBOT_CONTENT_TRANSITION_HISTORY_SAMPLES;\n}\n\nfunction clearRobotContentTransition() {""",
)
replace_once(
    "src/server.ts",
    """    robotSourceConnected: sourceRuntime.connected(),\n    robotDeltaFresh: robotDeltaIsFresh(nowMs),\n    vocalFineTuneMs: alignment.fineTuneMs,""",
    """    robotSourceConnected: sourceRuntime.connected(),\n    robotDeltaFresh: robotDeltaIsFresh(nowMs),\n    robotContentTransitionAnchorReady: robotContentTransitionAnchorReady(nowMs),\n    vocalFineTuneMs: alignment.fineTuneMs,""",
)

# 5) Source: refresh server readiness alongside timeline snapshots and never seek
# while the server says it cannot prove the resulting content transition.
replace_once(
    "public/source.js",
    """    const shouldSeek = armed\n      && Number.isFinite(errorSeconds)\n      && Math.abs(errorSeconds) > 0.45\n      && now - lastSeekAt > 700;""",
    """    const shouldSeek = armed\n      && latestSourceStatus?.robotContentTransitionAnchorReady === true\n      && Number.isFinite(errorSeconds)\n      && Math.abs(errorSeconds) > 0.45\n      && now - lastSeekAt > 700;""",
)
replace_once(
    "public/source.js",
    """    if (message.type === 'youtube-timeline-status') {\n      latestTimeline = message;\n      // `serverTime` is already projected to the instant the server emitted""",
    """    if (message.type === 'youtube-timeline-status') {\n      latestTimeline = message;\n      // Follower correction is allowed only after the server confirms it has\n      // enough pre-seek content evidence to verify the backing transition.\n      // Refresh that narrow readiness fact at the same cadence as the 250 ms\n      // authoritative timeline rather than trusting the connect-time snapshot.\n      if (ROBOT_MODE && armed) send({ type: 'source-status-request' });\n      // `serverTime` is already projected to the instant the server emitted""",
)

# 6) Unit/regression coverage.
replace_once(
    "test/timing-window-collector.test.ts",
    """    assert.equal(collector.micSpanSamples, 2_000 * MS);\n    assert.equal(collector.backingSpanSamples, 4_000 * MS);\n  });""",
    """    assert.equal(collector.micSpanSamples, 2_000 * MS);\n    assert.equal(collector.backingSpanSamples, 4_000 * MS);\n    assert.equal(collector.sharedSpanSamples, 2_000 * MS);\n  });""",
)
replace_once(
    "test/calibration-primed-fallback.test.ts",
    """  test('discardPrimedContent makes a destructive source change start from zero backup evidence', () => {""",
    """  test('reports shared context-fenced primed evidence without consuming it', () => {\n    const harness = makeSession();\n    prime(harness.calibration, RATE * 3, 0);\n\n    assert.equal(harness.calibration.transitionEvidenceSpanSamples, RATE * 3);\n    const snapshot = harness.calibration.transitionEvidence(RATE * 2);\n    assert.ok(snapshot);\n    assert.equal(snapshot.mic.length, RATE * 2);\n    assert.equal(snapshot.backing.length, RATE * 2);\n    assert.equal(\n      harness.calibration.transitionEvidenceSpanSamples,\n      RATE * 3,\n      'readiness inspection must not consume the primed transition history',\n    );\n\n    harness.setContext({ ...harness.context, sourceGeneration: harness.context.sourceGeneration + 1 });\n    assert.equal(\n      harness.calibration.transitionEvidenceSpanSamples,\n      0,\n      'stale source-generation evidence must never authorize a follower seek',\n    );\n  });\n\n  test('discardPrimedContent makes a destructive source change start from zero backup evidence', () => {""",
)
replace_once(
    "test/robot-content-transition-runtime.test.ts",
    """test('post evidence commits only after the acknowledged transport floor and current mapping agree', async () => {""",
    """test('anchor retries only after safe pre-seek evidence grows', async () => {\n  let evidenceSamples = 900;\n  let anchorRuns = 0;\n  const { runtime } = runtimeHarness({\n    transitionEvidence: () => ({\n      mic: new Int16Array(evidenceSamples),\n      backing: new Int16Array(evidenceSamples),\n    }),\n    estimateRawLag: async () => {\n      anchorRuns += 1;\n      return null;\n    },\n  });\n\n  runtime.begin({\n    fromMediaTime: 100.5,\n    toMediaTime: 100,\n    preDeltaMs: 500,\n    referenceDeltaMs: 500,\n    context,\n    confirmedReferenceLagMs: null,\n  }, 100);\n  assert.equal(anchorRuns, 0, 'sub-second evidence cannot start an anchor worker');\n\n  evidenceSamples = 1_500;\n  runtime.noteMicProgress(120);\n  await nextTurn();\n  await nextTurn();\n  assert.equal(anchorRuns, 1, 'newly sufficient evidence must retry the missing anchor');\n\n  runtime.noteMicProgress(130);\n  await nextTurn();\n  assert.equal(anchorRuns, 1, 'the same evidence snapshot must not spin another worker');\n\n  evidenceSamples = 2_000;\n  runtime.noteMicProgress(140);\n  await nextTurn();\n  await nextTurn();\n  assert.equal(anchorRuns, 2, 'a larger safe pre-seek window may retry an ambiguous anchor');\n});\n\ntest('post evidence commits only after the acknowledged transport floor and current mapping agree', async () => {""",
)

# Update the source-level liveness contract: the 700ms local cadence may remain,
# but server evidence readiness must now be an independent precondition.
replace_once(
    "test/robot-content-correction-liveness.test.ts",
    """test('production follower cadence permits another correction before fresh Robot delta telemetry resumes', () => {\n  const { settleMs, correctionIntervalMs } = productionCorrectionCadence();\n  assert.equal(settleMs, 1_000);\n  assert.equal(correctionIntervalMs, 700);\n  assert.ok(\n    correctionIntervalMs < settleMs,\n    'this regression must continue to model the production 700 ms correction / 1000 ms suppression overlap',\n  );\n});""",
    """test('production follower correction requires server-confirmed transition anchor evidence', () => {\n  const { settleMs, correctionIntervalMs } = productionCorrectionCadence();\n  assert.equal(settleMs, 1_000);\n  assert.equal(correctionIntervalMs, 700);\n  assert.ok(correctionIntervalMs < settleMs);\n  assert.match(\n    source,\n    /const shouldSeek = armed[\\s\\S]*?latestSourceStatus\\?\\.robotContentTransitionAnchorReady === true[\\s\\S]*?now - lastSeekAt > 700/,\n  );\n  assert.match(\n    source,\n    /if \\(ROBOT_MODE && armed\\) send\\(\\{ type: 'source-status-request' \\}\\);/,\n    'Robot Source must refresh readiness at the authoritative timeline cadence',\n  );\n});""",
)

Path("test/server-robot-content-anchor-readiness.test.ts").write_text("""import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nimport test from 'node:test';\n\nconst server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');\nconst source = readFileSync(new URL('../public/source.js', import.meta.url), 'utf8');\n\nfunction functionBlock(name: string) {\n  const start = server.indexOf(`function ${name}(`);\n  assert.notEqual(start, -1, `${name} must exist`);\n  const next = server.indexOf('\\nfunction ', start + 1);\n  return server.slice(start, next === -1 ? server.length : next);\n}\n\ntest('Robot follower correction readiness requires full safe pre-seek evidence unless content authority already exists', () => {\n  const block = functionBlock('robotContentTransitionAnchorReady');\n  assert.match(block, /robotContentTimeline\\.needsBackingBoundary\\(context\\)/);\n  assert.match(block, /timingRuntime\\.calibrationKind === 'content'/);\n  assert.match(block, /calibration\\.confirmedResult !== null/);\n  assert.match(block, /calibration\\.transitionEvidenceSpanSamples >= ROBOT_CONTENT_TRANSITION_HISTORY_SAMPLES/);\n});\n\ntest('source-status owns the seek-readiness fact and Robot Source consumes it before seekTo', () => {\n  const status = functionBlock('sourceStatusPayload');\n  assert.match(status, /robotContentTransitionAnchorReady: robotContentTransitionAnchorReady\\(nowMs\\)/);\n  const gate = source.indexOf('latestSourceStatus?.robotContentTransitionAnchorReady === true');\n  const seek = source.indexOf('player.seekTo(seekTarget, true)');\n  assert.ok(gate >= 0 && seek > gate, 'server readiness must gate the actual follower seek');\n});\n""")
