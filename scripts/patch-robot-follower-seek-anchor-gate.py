from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one anchor, found {count}: {old[:100]!r}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "src/server.ts",
    """function mappedContentBackingStart(startSample: number, nowMs = performance.now()) {\n  if (!backingRuntime.isRobot) return startSample;\n  return robotContentTimeline.mapBackingStart(startSample, calibrationContext(), nowMs);\n}\n\nfunction clearRobotContentTransition() {""",
    """function mappedContentBackingStart(startSample: number, nowMs = performance.now()) {\n  if (!backingRuntime.isRobot) return startSample;\n  return robotContentTimeline.mapBackingStart(startSample, calibrationContext(), nowMs);\n}\n\n/**\n * Whether Robot Source may create a follower seek right now.\n *\n * A seek is safe only when the transition verifier already has a proven\n * pre-seek content lag. Trying to discover that lag after seek is a catch-22:\n * backing PCM is quarantined at that point, so an initially missing anchor can\n * never gain safe pre-seek backing evidence and the transition dies at\n * windows=0. Keep reporting player delta until content calibration itself has\n * confirmed the reference-frame lag; then a seek can use that authority\n * synchronously without a speculative anchor worker.\n */\nfunction robotContentTransitionAnchorReady(nowMs = performance.now()) {\n  if (!backingRuntime.isRobot && !sourceRuntime.connected()) return true;\n  const context = calibrationContext();\n  return sourceRuntime.connected()\n    && robotContentTimeline.isReady(context, nowMs)\n    && !robotContentTimeline.needsBackingBoundary(context)\n    && timingRuntime.calibrationKind === 'content'\n    && calibration.confirmedResult !== null\n    && !calibrationIsStale();\n}\n\nfunction clearRobotContentTransition() {""",
)

replace_once(
    "src/server.ts",
    """    robotSourceConnected: sourceRuntime.connected(),\n    robotDeltaFresh: robotDeltaIsFresh(nowMs),\n    vocalFineTuneMs: alignment.fineTuneMs,""",
    """    robotSourceConnected: sourceRuntime.connected(),\n    robotDeltaFresh: robotDeltaIsFresh(nowMs),\n    robotContentTransitionAnchorReady: robotContentTransitionAnchorReady(nowMs),\n    vocalFineTuneMs: alignment.fineTuneMs,""",
)

replace_once(
    "public/source.js",
    """    const shouldSeek = armed\n      && Number.isFinite(errorSeconds)\n      && Math.abs(errorSeconds) > 0.45\n      && now - lastSeekAt > 700;""",
    """    const shouldSeek = armed\n      && latestSourceStatus?.robotContentTransitionAnchorReady === true\n      && Number.isFinite(errorSeconds)\n      && Math.abs(errorSeconds) > 0.45\n      && now - lastSeekAt > 700;""",
)

replace_once(
    "test/robot-content-correction-liveness.test.ts",
    """test('production follower cadence permits another correction before fresh Robot delta telemetry resumes', () => {\n  const { settleMs, correctionIntervalMs } = productionCorrectionCadence();\n  assert.equal(settleMs, 1_000);\n  assert.equal(correctionIntervalMs, 700);\n  assert.ok(\n    correctionIntervalMs < settleMs,\n    'this regression must continue to model the production 700 ms correction / 1000 ms suppression overlap',\n  );\n});""",
    """test('production follower correction waits for a server-proven content anchor', () => {\n  const { settleMs, correctionIntervalMs } = productionCorrectionCadence();\n  assert.equal(settleMs, 1_000);\n  assert.equal(correctionIntervalMs, 700);\n  assert.ok(correctionIntervalMs < settleMs);\n  assert.match(\n    source,\n    /const shouldSeek = armed[\\s\\S]*?latestSourceStatus\\?\\.robotContentTransitionAnchorReady === true[\\s\\S]*?Math\\.abs\\(errorSeconds\\) > 0\\.45[\\s\\S]*?now - lastSeekAt > 700/,\n    'local correction cadence must never outrun server transition authority',\n  );\n  assert.ok(\n    source.indexOf('latestSourceStatus?.robotContentTransitionAnchorReady === true')\n      < source.indexOf('player.seekTo(seekTarget, true)'),\n    'server-proven content authority must gate the actual seekTo call',\n  );\n});""",
)

Path("test/server-robot-content-anchor-readiness.test.ts").write_text("""import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nimport test from 'node:test';\n\nconst server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');\n\nfunction functionBlock(name: string) {\n  const start = server.indexOf(`function ${name}(`);\n  assert.notEqual(start, -1, `${name} must exist`);\n  const next = server.indexOf('\\nfunction ', start + 1);\n  return server.slice(start, next === -1 ? server.length : next);\n}\n\ntest('Robot follower seek requires fresh confirmed content authority before it can create quarantine', () => {\n  const gate = functionBlock('robotContentTransitionAnchorReady');\n  assert.match(gate, /robotContentTimeline\\.isReady\\(context, nowMs\\)/);\n  assert.match(gate, /!robotContentTimeline\\.needsBackingBoundary\\(context\\)/);\n  assert.match(gate, /timingRuntime\\.calibrationKind === 'content'/);\n  assert.match(gate, /calibration\\.confirmedResult !== null/);\n  assert.match(gate, /!calibrationIsStale\\(\\)/);\n  assert.doesNotMatch(\n    gate,\n    /transitionEvidence|readBacking|readMic/,\n    'seek permission must use already-confirmed authority, not speculative post-seek discovery',\n  );\n});\n\ntest('source-status publishes the server-owned follower-seek authority fact', () => {\n  const status = functionBlock('sourceStatusPayload');\n  assert.match(\n    status,\n    /robotContentTransitionAnchorReady: robotContentTransitionAnchorReady\\(nowMs\\)/,\n  );\n});\n""")
