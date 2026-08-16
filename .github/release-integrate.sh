#!/usr/bin/env bash
set -euo pipefail

git fetch origin '+refs/heads/*:refs/remotes/origin/*'
git config user.name 'relay-release-bot'
git config user.email 'relay-release-bot@users.noreply.github.com'
git checkout -B integration origin/agent/listen-default-audible

echo '=== merge latest runtime feeder (#14) ==='
if ! git merge --no-ff --no-commit origin/agent/runtime-product-status; then
  conflicts="$(git diff --name-only --diff-filter=U)"
  printf 'runtime conflicts:\n%s\n' "$conflicts"
  test "$conflicts" = 'src/server.ts'
  git checkout --ours src/server.ts
  python3 - <<'PY'
from pathlib import Path
path = Path('src/server.ts')
text = path.read_text()
anchor = "function processPublisherFrame(frame: PcmFrame) {"
helpers = """function roomHasSong(nowMs = performance.now()) {
  return takeSongSnapshot(nowMs).videoId !== null;
}

function maybeStopLiveSourceWhenUnarmed() {
  if (!session.active) return;
  const micArmed = publisher?.readyState === WebSocket.OPEN
    || webTransportMicConnected()
    || micTransportGraceTimer !== null;
  const backingArmed = backing?.readyState === WebSocket.OPEN || backingAbsenceTimer !== null;
  if (!micArmed && !backingArmed) stopLiveSource();
}

function expireBackingGrace() {
  backingAbsenceTimer = null;
  const micArmed = publisher?.readyState === WebSocket.OPEN
    || webTransportMicConnected()
    || micTransportGraceTimer !== null;
  if (roomHasSong() || !micArmed) {
    stopLiveSource();
    return;
  }

  backingIsRobot = false;
  invalidateMicTiming('Backing route ended while the room continued voice-only.');
  broadcastStatus();
}

"""
assert anchor in text
text = text.replace(anchor, helpers + anchor, 1)
old = "  if (!micAudioTransport || publisherSampleRate === null) return;\n\n  if (session.active) {"
new = "  if (!micAudioTransport || publisherSampleRate === null) return;\n  if (!session.active) startLiveSource();\n\n  if (session.active) {"
assert old in text
text = text.replace(old, new, 1)
old = "        micTransportChanged = true;\n        if (calibration.collecting) {"
new = "        micTransportChanged = true;\n        if (!reconnectingOwnerId) maybeStopLiveSourceWhenUnarmed();\n        if (calibration.collecting) {"
assert old in text
text = text.replace(old, new, 1)
old = "backingAbsenceTimer = setTimeout(stopLiveSource, BACKING_GRACE_MS);"
assert old in text
text = text.replace(old, "backingAbsenceTimer = setTimeout(expireBackingGrace, BACKING_GRACE_MS);", 1)
path.write_text(text)
PY
  git add src/server.ts
fi

# #14 predates #20's explicit timing-dependency rename. Keep the voice-only
# cases, but express them against the current ProductViewModel contract.
python3 - <<'PY'
from pathlib import Path
path = Path('test/voice-only-room.test.ts')
text = path.read_text()
text = text.replace('      robotRoute: false,', '      requiresRobotPlayerDelta: false,', 1)
text = text.replace('      robotRoute: true,', '      requiresRobotPlayerDelta: true,', 1)
path.write_text(text)
PY
git add test/voice-only-room.test.ts
git diff --check
git commit -m 'integrate latest runtime and voice-only semantics'

echo '=== merge latest Live UI feeder (#13) ==='
if ! git merge --no-ff --no-commit origin/agent/live-ui-shell; then
  python3 - <<'PY'
import subprocess
expected = {
  'public/action-language.css', 'public/app.js', 'public/index.html', 'public/listen.js',
  'public/live-composition.css', 'public/live-status.js', 'public/recorder.js',
  'public/system-details.css', 'test/adjust-ui-contract.test.ts',
  'test/legacy-monitor-retirement.test.ts', 'test/live-ui-contract.test.ts',
  'test/system-details-contract.test.ts', 'test/take-client.test.ts',
}
actual = set(subprocess.check_output(
    ['git', 'diff', '--name-only', '--diff-filter=U'], text=True).splitlines())
if actual != expected:
    raise SystemExit(f'unexpected UI conflict set: {sorted(actual)}')
PY

  git checkout --theirs \
    public/action-language.css \
    public/live-composition.css \
    public/live-status.js \
    public/recorder.js \
    test/take-client.test.ts

  git checkout --ours \
    public/app.js \
    public/index.html \
    public/listen.js \
    public/system-details.css \
    test/adjust-ui-contract.test.ts \
    test/legacy-monitor-retirement.test.ts \
    test/live-ui-contract.test.ts \
    test/system-details-contract.test.ts

  python3 - <<'PY'
from pathlib import Path
path = Path('public/app.js')
text = path.read_text()
old = "let latestCalibration = null;\nlet pendingPublisherTakeoverOwnerId = null;"
new = "let latestCalibration = null;\nlet roomSongAvailable = null;\nlet pendingPublisherTakeoverOwnerId = null;"
assert old in text
text = text.replace(old, new, 1)
old = "  calibrateButton.disabled = !publisherActive || !liveMixActive || collecting;\n\n  if (!liveMixActive) {"
new = """  calibrateButton.disabled = !publisherActive
    || !liveMixActive
    || roomSongAvailable !== true
    || collecting;

  if (roomSongAvailable === false) {
    calibrateStatus.textContent = 'No song to align.';
    return;
  }

  if (roomSongAvailable === null) {
    calibrateStatus.textContent = 'Waiting for room state.';
    return;
  }

  if (!liveMixActive) {"""
assert old in text
text = text.replace(old, new, 1)
anchor = "publisherButton.addEventListener('click', () => {"
listener = """window.addEventListener('relay-product-status', (event) => {
  const videoId = event.detail?.room?.song?.videoId;
  roomSongAvailable = typeof videoId === 'string' && videoId.length > 0;
  updateCalibrateButton();
});

"""
assert anchor in text
text = text.replace(anchor, listener + anchor, 1)
path.write_text(text)

path = Path('public/index.html')
text = path.read_text()
old = """        <audio id="recording-player" controls hidden></audio>
        <a id="download-recording" class="take-link" hidden>Last take</a>"""
new = """        <div id="last-take" class="last-take" hidden>
          <button id="last-take-toggle" class="take-link text-action" type="button" aria-expanded="false">Last take</button>
          <div id="last-take-review" class="take-review" hidden>
            <audio id="recording-player" controls preload="metadata"></audio>
            <a id="download-recording" class="take-download text-action" download>Download WAV</a>
          </div>
        </div>"""
assert old in text
path.write_text(text.replace(old, new, 1))

path = Path('test/adjust-ui-contract.test.ts')
text = path.read_text()
addition = """

test('Timing is explicitly out of scope when the room has no Song', () => {
  assert.equal(app.includes('roomSongAvailable'), true);
  assert.equal(app.includes('roomSongAvailable !== true'), true);
  assert.equal(app.includes('No song to align.'), true);
  assert.equal(app.includes('event.detail?.room?.song?.videoId'), true);
  const noSong = app.indexOf('if (roomSongAvailable === false)');
  const noMix = app.indexOf('if (!liveMixActive)');
  assert.ok(noSong >= 0 && noMix > noSong,
    'voice-only Live must say there is no Song to align before generic playback/calibration guidance');
});
"""
assert "Timing is explicitly out of scope when the room has no Song" not in text
path.write_text(text.rstrip() + addition)

path = Path('test/live-ui-contract.test.ts')
text = path.read_text()
addition = """

test('an empty Song surface does not gate the formal Mic or imply that singing requires backing', () => {
  assert.match(liveStatus, /Take the mic, or add a song for backing\\./);
  assert.doesNotMatch(liveStatus, /Add a song to begin\\./);
  assert.match(liveStatus, /songState === 'playing' \\|\\| micState === 'live'/);
  assert.match(recorder, /Start the mic before recording a voice-only Take\\./);
  assert.doesNotMatch(recorder, /song-required/);
});
"""
assert "an empty Song surface does not gate" not in text
path.write_text(text.rstrip() + addition)
PY

  git add \
    public/action-language.css public/app.js public/index.html public/listen.js \
    public/live-composition.css public/live-status.js public/recorder.js \
    public/system-details.css test/adjust-ui-contract.test.ts \
    test/legacy-monitor-retirement.test.ts test/live-ui-contract.test.ts \
    test/system-details-contract.test.ts test/take-client.test.ts
fi

git diff --check
git commit -m 'integrate latest Live UI without reviving retired tooling'

echo '=== verify integrated feeder tree ==='
npm ci
npm run check
find public -maxdepth 1 -name '*.js' -print0 | xargs -0 -n1 node --check
npm test
echo 'FEEDER_TREE_GREEN'
