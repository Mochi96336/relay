from pathlib import Path


def replace_once(path: str, old: str, new: str):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one patch anchor, found {count}')
    p.write_text(text.replace(old, new, 1))


def replace_exact(path: str, old: str, new: str, expected: int):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != expected:
        raise SystemExit(f'{path}: expected {expected} patch anchors, found {count}')
    p.write_text(text.replace(old, new))

replace_once(
    'src/server.ts',
    """/**
 * Whether Robot Source may create a follower seek right now.
 *
 * A seek is safe only when the transition verifier already has a proven
 * pre-seek content lag. Trying to discover that lag after seek is a catch-22:
 * backing PCM is quarantined at that point, so an initially missing anchor can
 * never gain safe pre-seek backing evidence and the transition dies at
 * windows=0. Keep reporting player delta until content calibration itself has
 * confirmed the reference-frame lag; then a seek can use that authority
 * synchronously without a speculative anchor worker.
 */
function robotContentTransitionAnchorReady(nowMs = performance.now()) {
  if (!backingRuntime.isRobot && !sourceRuntime.connected()) return true;
  const context = calibrationContext();
  return sourceRuntime.connected()
    && robotContentTimeline.isReady(context, nowMs)
    && !robotContentTimeline.needsBackingBoundary(context)
    && timingRuntime.calibrationKind === 'content'
    && calibration.confirmedResult !== null
    && !calibrationIsStale();
}
""",
    """/**
 * Whether a concrete Robot follower seek may preserve the existing content
 * mapping rather than becoming a destructive bootstrap remap.
 *
 * Confirmed content authority is sufficient even while a prior correction is
 * still waiting for its PCM boundary: repeated finite corrections intentionally
 * carry that proven pre-seek reference forward. Before first promotion, an
 * in-flight content collection may also preserve a small correction when it
 * already owns enough common pre-seek PCM to launch the anchor worker
 * immediately. With neither source of evidence, preservation would recreate
 * the windows=0 catch-22, so the seek must reset mapping instead.
 */
function robotContentTransitionAnchorReady(nowMs = performance.now()) {
  if (!backingRuntime.isRobot && !sourceRuntime.connected()) return true;
  const context = calibrationContext();
  if (!sourceRuntime.connected() || !robotContentTimeline.isReady(context, nowMs)) return false;

  const confirmedContentAuthority = appliedCalibrationKind() === 'content'
    && calibration.confirmedResult !== null
    && !calibrationIsStale();
  if (confirmedContentAuthority) return true;

  if (timingRuntime.calibrationKind !== 'content' || !calibration.collecting) return false;
  const evidence = calibration.transitionEvidence(ROBOT_CONTENT_TRANSITION_HISTORY_SAMPLES);
  return evidence !== null
    && evidence.mic.length > MIX_SAMPLE_RATE
    && evidence.backing.length > MIX_SAMPLE_RATE;
}
""",
)

replace_exact(
    'src/server.ts',
    """  const confirmedReferenceLagMs = timingRuntime.calibrationKind === 'content'
    ? calibration.confirmedResult?.micLagMs ?? null
    : null;
""",
    """  const confirmedReferenceLagMs = appliedCalibrationKind() === 'content'
    && !calibrationIsStale()
    ? calibration.confirmedResult?.micLagMs ?? null
    : null;
""",
    2,
)

replace_once(
    'test/server-robot-content-anchor-readiness.test.ts',
    """test('Robot follower seek requires fresh confirmed content authority before it can create quarantine', () => {
  const gate = functionBlock('robotContentTransitionAnchorReady');
  assert.match(gate, /robotContentTimeline\\.isReady\\(context, nowMs\\)/);
  assert.match(gate, /!robotContentTimeline\\.needsBackingBoundary\\(context\\)/);
  assert.match(gate, /timingRuntime\\.calibrationKind === 'content'/);
  assert.match(gate, /calibration\\.confirmedResult !== null/);
  assert.match(gate, /!calibrationIsStale\\(\\)/);
  assert.doesNotMatch(
    gate,
    /transitionEvidence|readBacking|readMic/,
    'seek permission must use already-confirmed authority, not speculative post-seek discovery',
  );
});
""",
    """test('Robot follower preservation requires proven content authority or enough in-flight pre-seek evidence', () => {
  const gate = functionBlock('robotContentTransitionAnchorReady');
  assert.match(gate, /robotContentTimeline\\.isReady\\(context, nowMs\\)/);
  assert.match(gate, /appliedCalibrationKind\\(\\) === 'content'/);
  assert.match(gate, /calibration\\.confirmedResult !== null/);
  assert.match(gate, /!calibrationIsStale\\(\\)/);
  assert.match(gate, /timingRuntime\\.calibrationKind !== 'content' \\|\\| !calibration\\.collecting/);
  assert.match(gate, /calibration\\.transitionEvidence\\(ROBOT_CONTENT_TRANSITION_HISTORY_SAMPLES\\)/);
  assert.match(gate, /evidence\\.mic\\.length > MIX_SAMPLE_RATE/);
  assert.match(gate, /evidence\\.backing\\.length > MIX_SAMPLE_RATE/);
  assert.doesNotMatch(
    gate,
    /needsBackingBoundary/,
    'a repeated mapped correction must not become destructive merely because the prior boundary is still pending',
  );
});
""",
)

bounds = Path('test/robot-content-transition-bounds.test.ts')
text = bounds.read_text()
start = text.index("test('server deadline makes quarantine terminal and a later follower correction starts a fresh budget'")
new = """test('server treats an unanchored follower correction as destructive bootstrap instead of opening quarantine', async () => {
  const server = await startRelay({
    RELAY_CALIBRATION_PROBE: '1',
    RELAY_ROBOT_CONTENT_TRANSITION_LIFETIME_MS: '600',
    RELAY_ROBOT_CONTENT_TRANSITION_MAX_WINDOWS: '3',
    RELAY_ROBOT_CONTENT_TRANSITION_MAX_WORKER_FAILURES: '2',
    RELAY_HEARTBEAT_MS: '60000',
  });
  const backing = await RelayClient.connect(server);
  const publisher = await RelayClient.connect(server);
  const robot = await RelayClient.connect(server);
  const monitor = await RelayClient.connect(server);

  try {
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE, robot: true });
    await backing.waitForType('registered');
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await publisher.waitForType('registered');
    robot.send({ type: 'robot-source-hello' });
    monitor.send({ type: 'register', role: 'monitor' });
    await monitor.waitForType('registered');

    robot.send({ type: 'robot-player-offset', offsetMs: 500 });
    await sleep(50);
    const requestsBeforeSeek = boundaryRequestCount(backing);
    robot.send({
      type: 'source-seeked',
      reason: 'follower-correction',
      fromMediaTime: 100.5,
      toMediaTime: 100,
    });

    const reset = await waitForServerTransition(
      monitor,
      (status) => status.robotContentTransition?.state === 'idle'
        && status.robotContentTransition?.quarantined === false
        && status.robotDeltaFresh === false,
      2_000,
    );
    assert.equal(reset.robotContentTransition.state, 'idle');
    assert.equal(reset.robotContentTransition.quarantined, false);
    assert.equal(
      boundaryRequestCount(backing),
      requestsBeforeSeek,
      'an unanchored bootstrap remap must not request a transition boundary',
    );

    robot.send({ type: 'robot-player-offset', offsetMs: 0 });
    await sleep(100);
    const stable = await waitForServerTransition(
      monitor,
      (status) => status.robotContentTransition?.state === 'idle'
        && status.robotDeltaFresh === true,
      2_000,
    );
    assert.equal(stable.robotContentTransition.quarantined, false);
  } finally {
    monitor.close();
    robot.close();
    publisher.close();
    backing.close();
    await server.stop();
  }
});
"""
bounds.write_text(text[:start] + new)

bootstrap = Path('test/server-robot-bootstrap-timing-deadlock.test.ts')
text = bootstrap.read_text()
insert = """test('gross Robot offset is revoked before boot-probe can fold it into mixer timing', () => {
"""
addition = """test('boot-probe result cannot impersonate a confirmed content transition anchor', () => {
  const begin = functionBlock('beginRobotContentTransition');
  const reconcile = functionBlock('reconcileRobotContentTransitionWithFreshDelta');
  for (const block of [begin, reconcile]) {
    assert.match(block, /appliedCalibrationKind\\(\\) === 'content'/);
    assert.match(block, /!calibrationIsStale\\(\\)/);
    assert.doesNotMatch(
      block,
      /timingRuntime\\.calibrationKind === 'content'/,
      'candidate content mode must not relabel a retained boot-probe result as content authority',
    );
  }
});

"""
if text.count(insert) != 1:
    raise SystemExit('bootstrap test insertion point changed')
bootstrap.write_text(text.replace(insert, addition + insert, 1))
