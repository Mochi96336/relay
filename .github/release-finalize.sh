#!/usr/bin/env bash
set -euo pipefail

test "$(git branch --show-current)" = 'integration'
git fetch origin main
MAIN_SHA="$(git rev-parse origin/main)"

echo '=== merge current main into verified integration tree ==='
if ! git merge --no-ff --no-commit origin/main; then
  conflicts="$(git diff --name-only --diff-filter=U)"
  expected=$'deploy/relay-server.service\nsrc/server.ts\ntest/robot-scripts.test.ts'
  printf 'final main conflicts:\n%s\n' "$conflicts"
  test "$conflicts" = "$expected"

  # #25/current main owns the deployment executable and host-aware verifier.
  git checkout origin/main -- deploy/relay-server.service test/robot-scripts.test.ts

  # Keep the fully integrated runtime and port only #23's stable observation API.
  git checkout --ours src/server.ts
  python3 - <<'PY'
from pathlib import Path

path = Path('src/server.ts')
text = path.read_text()

old = "import { CalibrationSession, type CalibrationContext } from './calibration-session.js';"
new = old + "\nimport { buildRelayObservationStatusV1 } from './observation-status.js';"
assert old in text
assert "from './observation-status.js'" not in text
text = text.replace(old, new, 1)

old = """app.get('/statusz', (_req, res) => {
  res.json(remoteStatusPayload());
});
app.get('/readyz', (_req, res) => {"""
new = """app.get('/statusz', (_req, res) => {
  res.json(remoteStatusPayload());
});
app.get('/api/status/v1', (_req, res) => {
  res.json(observationStatusV1Payload());
});
app.get('/readyz', (_req, res) => {"""
assert old in text
text = text.replace(old, new, 1)

anchor = "\nfunction recommendedMicGainDb(micPeakDbfs: number | null) {"
observation = """
function observationStatusV1Payload() {
  const remote = remoteStatusPayload();
  const snapshot = participants.snapshot();

  return buildRelayObservationStatusV1({
    workload: {
      id: 'relay',
      state: remote.state,
      ok: remote.ok,
      uptimeMs: remote.uptimeMs,
    },
    activity: {
      sessionActive: remote.mix.active,
      participants: {
        total: remote.source.participants,
        connected: remote.source.participantsConnected,
      },
      microphoneLease: {
        held: snapshot.micOwnerId !== null,
        transportConnected: remote.source.micConnected,
      },
    },
    sources: {
      backing: {
        connected: remote.source.backingConnected,
        streaming: remote.source.backingStreaming,
        sampleRate: remote.source.backingSampleRate,
        robot: remote.source.backingIsRobot,
        frameAgeMs: remote.source.backingFrameAgeMs,
      },
      microphone: {
        connected: remote.source.micConnected,
        streaming: remote.source.micStreaming,
        sampleRate: publisherSampleRate,
        frameAgeMs: remote.source.micFrameAgeMs,
      },
      robot: {
        routeActive: remote.robot.route,
        sourceConnected: remote.robot.sourceConnected,
        playerDeltaFresh: remote.robot.deltaFresh,
      },
    },
    calibration: {
      kind: remote.robot.calibrationKind,
      stale: remote.robot.calibrationStale,
      timingMode: remote.robot.timingMode,
      activeCalibratedMicLagMs: remote.robot.activeCalibratedMicLagMs,
    },
    mix: remote.mix,
    issues: {
      faults: remote.faults,
      warnings: remote.warnings,
    },
  });
}
"""
assert anchor in text
assert 'function observationStatusV1Payload()' not in text
text = text.replace(anchor, observation + anchor, 1)

path.write_text(text)
PY

  git add deploy/relay-server.service src/server.ts test/robot-scripts.test.ts
fi

git diff --check
git commit -m 'integrate current main observation and deployment decisions'

echo '=== final release-tree verification ==='
npm ci
npm run check
find public chrome-tab-audio-probe -name '*.js' -print0 | xargs -0 -n1 node --check
bash -n scripts/*.sh
npm test
npm run test:webtransport-loopback

echo '=== flatten verified tree onto current main ==='
TREE_SHA="$(git rev-parse 'HEAD^{tree}')"
RC_COMMIT="$({
  printf '%s\n\n' 'release: converge Relay Live runtime and audio stack'
  printf '%s\n' 'Flatten the verified Relay product/runtime/UI/audio stack onto current main while preserving observation v1 and host-aware deployment semantics.'
} | git commit-tree "$TREE_SHA" -p "$MAIN_SHA")"

test "$(git rev-list --count "$MAIN_SHA..$RC_COMMIT")" = '1'
git push --force origin "$RC_COMMIT:refs/heads/agent/release-candidate"
echo "FINAL_MAIN_SHA=$MAIN_SHA"
echo "FINAL_RC_SHA=$RC_COMMIT"
echo 'FINAL_RELEASE_TREE_GREEN'
