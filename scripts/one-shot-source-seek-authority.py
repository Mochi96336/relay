from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: {label}: expected one match, found {count}')
    target.write_text(text.replace(old, new, 1))


replace_once(
    'public/source.js',
    """      lastSeekAt = performance.now();\n      robotDeltaSuppressedUntil = lastSeekAt + ROBOT_DELTA_SETTLE_MS;\n      send({ type: 'source-seeked' });\n      renderTimeline();\n""",
    """      lastSeekAt = performance.now();\n      robotDeltaSuppressedUntil = lastSeekAt + ROBOT_DELTA_SETTLE_MS;\n      // Loading a preview while Source is unarmed is not an authoritative\n      // playback discontinuity. Only the player actually feeding Relay may\n      // invalidate timing calibration.\n      if (armed) send({ type: 'source-seeked' });\n      renderTimeline();\n""",
    'do not publish preview cue as an active source seek',
)

replace_once(
    'public/source.js',
    """    const shouldSeek = Number.isFinite(errorSeconds)\n      && Math.abs(errorSeconds) > 0.45\n      && now - lastSeekAt > 700;\n""",
    """    const shouldSeek = armed\n      && Number.isFinite(errorSeconds)\n      && Math.abs(errorSeconds) > 0.45\n      && now - lastSeekAt > 700;\n""",
    'do not drift-seek an unarmed source preview',
)

replace_once(
    'src/server.ts',
    """    if (payload.type === 'source-seeked') {\n      sourceGeneration += 1;\n""",
    """    if (payload.type === 'source-seeked') {\n      // `isRobotSource` is intentionally tri-state here: undefined means this\n      // socket was never a Robot source, while true/false means it has entered\n      // the Robot source lifecycle. Replacement clears the active flag to\n      // false, but must not restore seek authority to that old socket.\n      if (socket.isRobotSource !== undefined && socket !== activeRobotSource) return;\n      sourceGeneration += 1;\n""",
    'reject seek discontinuities from superseded Robot source',
)

Path('test/source-seek-authority.test.ts').write_text("""import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';

const source = readFileSync(new URL('../public/source.js', import.meta.url), 'utf8');
const serverSource = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('an unarmed Source preview cannot announce or chase authoritative seek discontinuities', () => {
  assert.match(
    source,
    /loadedVideoId !== timeline\.videoId[\s\S]{0,500}if \(armed\) send\(\{ type: 'source-seeked' \}\)/,
    'initial preview cue may position YouTube but must not invalidate active calibration',
  );
  assert.match(
    source,
    /const shouldSeek = armed\s*&&\s*Number\.isFinite\(errorSeconds\)/,
    'an unarmed paused preview must not chase the advancing phone timeline every 700 ms',
  );
});

test('server fences source-seeked from any no-longer-active Robot source', () => {
  assert.match(
    serverSource,
    /if \(payload\.type === 'source-seeked'\) \{[\s\S]{0,700}if \(socket\.isRobotSource !== undefined && socket !== activeRobotSource\) return;[\s\S]{0,200}sourceGeneration \+= 1/,
  );
});

async function freshCalibrationStatus(client: RelayClient) {
  const from = client.messages.length;
  client.send({ type: 'timing-calibration-status-request' });
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const status = client.messages.slice(from).find((message) => message.type === 'timing-calibration-status');
    if (status) return status;
    await sleep(10);
  }
  throw new Error('Timed out waiting for fresh timing-calibration-status.');
}

test('superseded Robot seek cannot erase the active Robot delta', async () => {
  const relay = await startRelay({
    RELAY_AUTO_CALIBRATE: '0',
    RELAY_CALIBRATION_PROBE: '0',
    RELAY_HEARTBEAT_MS: '60000',
  });
  try {
    const observer = await RelayClient.connect(relay);
    observer.send({ type: 'register', role: 'monitor' });
    await observer.waitForType('registered');

    const first = await RelayClient.connect(relay);
    first.send({ type: 'robot-source-hello' });
    const second = await RelayClient.connect(relay);
    second.send({ type: 'robot-source-hello' });
    await first.waitForType('robot-source-replaced');

    second.send({ type: 'robot-player-offset', offsetMs: 35 });
    await sleep(30);
    const before = await freshCalibrationStatus(observer);
    assert.equal(Math.round(before.robotPlayerOffsetMs), 35);

    first.send({ type: 'source-seeked' });
    await sleep(30);
    const afterStale = await freshCalibrationStatus(observer);
    assert.equal(
      Math.round(afterStale.robotPlayerOffsetMs),
      35,
      'a superseded Robot page must not clear timing evidence owned by the active source',
    );

    second.send({ type: 'source-seeked' });
    await sleep(30);
    const afterActive = await freshCalibrationStatus(observer);
    assert.equal(afterActive.robotPlayerOffsetMs, null, 'the active Robot seek remains a real discontinuity');

    observer.close();
    first.close();
    second.close();
  } finally {
    await relay.stop();
  }
});
""")
