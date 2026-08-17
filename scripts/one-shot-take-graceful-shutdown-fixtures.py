from pathlib import Path

for path in ['test/take-quality.test.ts', 'test/take-session.test.ts']:
    target = Path(path)
    text = target.read_text()
    old = "      'mic-owner-changed': 0,\n"
    if text.count(old) != 1:
        raise SystemExit(f'{path}: expected one Take quality event fixture, found {text.count(old)}')
    target.write_text(text.replace(old, old + "      'server-shutdown': 0,\n", 1))

quality_test = Path('test/take-quality.test.ts')
quality_text = quality_test.read_text()
quality_test.write_text(quality_text + """

test('controlled server shutdown is explicit review evidence', () => {
  const quality = tracker();
  quality.observeFrame(960, frameState(), mixedFrame());
  quality.noteEvent('server-shutdown');

  const result = quality.assessment();
  assert.equal(result.evidence.events['server-shutdown'], 1);
  assert.equal(result.verdict, 'review');
  assert.equal(result.issues.some((issue) => issue.code === 'recording-interrupted'), true);
});
""")

shutdown_test = Path('test/server-take-shutdown.test.ts')
shutdown_text = shutdown_test.read_text()
old_env = """      RELAY_CALIBRATION_PROBE: '0',
      RELAY_HEARTBEAT_MS: '60000',
    };
"""
new_env = """      RELAY_CALIBRATION_PROBE: '0',
      RELAY_HEARTBEAT_MS: '60000',
      RELAY_LIVE_PREBUFFER_MS: '1',
    };
"""
if shutdown_text.count(old_env) != 1:
    raise SystemExit(f'test/server-take-shutdown.test.ts: expected one test env block, found {shutdown_text.count(old_env)}')
shutdown_text = shutdown_text.replace(old_env, new_env, 1)

old_assertions = """    assert.equal(ready.take.stopReason, 'server-shutdown');
    assert.equal(ready.take.quality?.verdict, 'review');
    assert.ok(ready.take.quality?.issues?.some((issue: any) => issue.code === 'recording-interrupted'));
"""
new_assertions = """    assert.equal(ready.take.stopReason, 'server-shutdown');
    assert.equal(
      ready.take.quality?.evidence?.events?.['server-shutdown'],
      1,
      `shutdown event missing from final Take quality: ${JSON.stringify(ready.take.quality)}`,
    );
    assert.equal(
      ready.take.quality?.verdict,
      'review',
      `controlled shutdown must not masquerade as a clean Take: ${JSON.stringify(ready.take.quality)}`,
    );
    assert.ok(
      ready.take.quality?.issues?.some((issue: any) => issue.code === 'recording-interrupted'),
      `controlled shutdown must publish recording-interrupted: ${JSON.stringify(ready.take.quality)}`,
    );
    assert.ok(
      Number(ready.take.artifact?.sampleCount) > 0,
      `fault injection must happen after authoritative mixed PCM reached the Take: ${JSON.stringify(ready.take.artifact)}`,
    );
"""
if shutdown_text.count(old_assertions) != 1:
    raise SystemExit(f'test/server-take-shutdown.test.ts: expected one shutdown assertion block, found {shutdown_text.count(old_assertions)}')
shutdown_test.write_text(shutdown_text.replace(old_assertions, new_assertions, 1))
