from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one patch target, found {count}")
    target.write_text(text.replace(old, new, 1))


def insert_before_final_describe_close(path: str, marker: str, block: str) -> None:
    target = Path(path)
    text = target.read_text()
    if marker in text:
        return
    close = "\n});\n"
    index = text.rfind(close)
    if index < 0:
        raise SystemExit(f"{path}: final describe close not found")
    target.write_text(text[:index] + block + text[index:])


replace_once(
    "src/participant-capability.ts",
    """export function participantCapabilityMatches(participantId: string, value: unknown) {\n  if (!BROWSER_PARTICIPANT_PATTERN.test(participantId)) return true;\n  return participantIdForCapability(value) === participantId;\n}\n""",
    """function legacyTestParticipantIdentityEnabled() {\n  return process.env.NODE_ENV === 'test'\n    && process.env.RELAY_TEST_LEGACY_PARTICIPANTS === '1';\n}\n\nexport function participantCapabilityMatches(participantId: string, value: unknown) {\n  if (!BROWSER_PARTICIPANT_PATTERN.test(participantId)) {\n    return legacyTestParticipantIdentityEnabled();\n  }\n  return participantIdForCapability(value) === participantId;\n}\n""",
)

replace_once(
    "test/helpers/harness.ts",
    """      env: { ...process.env, PORT: '0', ...env },\n""",
    """      env: {\n        ...process.env,\n        PORT: '0',\n        NODE_ENV: 'test',\n        RELAY_TEST_LEGACY_PARTICIPANTS: '1',\n        ...env,\n      },\n""",
)

replace_once(
    "test/participant-capability.test.ts",
    """  test('keeps non-browser legacy fixture ids outside the browser capability namespace', () => {\n    assert.equal(browserParticipantIdentity('participant-alice'), false);\n    assert.equal(participantCapabilityMatches('participant-alice', null), true);\n  });\n""",
    """  test('legacy fixture ids are test-only and production fails closed', () => {\n    const previousNodeEnv = process.env.NODE_ENV;\n    const previousLegacyGate = process.env.RELAY_TEST_LEGACY_PARTICIPANTS;\n    try {\n      assert.equal(browserParticipantIdentity('participant-alice'), false);\n\n      process.env.NODE_ENV = 'production';\n      process.env.RELAY_TEST_LEGACY_PARTICIPANTS = '1';\n      assert.equal(participantCapabilityMatches('participant-alice', null), false);\n\n      process.env.NODE_ENV = 'test';\n      delete process.env.RELAY_TEST_LEGACY_PARTICIPANTS;\n      assert.equal(participantCapabilityMatches('participant-alice', null), false);\n\n      process.env.RELAY_TEST_LEGACY_PARTICIPANTS = '1';\n      assert.equal(participantCapabilityMatches('participant-alice', null), true);\n    } finally {\n      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;\n      else process.env.NODE_ENV = previousNodeEnv;\n      if (previousLegacyGate === undefined) delete process.env.RELAY_TEST_LEGACY_PARTICIPANTS;\n      else process.env.RELAY_TEST_LEGACY_PARTICIPANTS = previousLegacyGate;\n    }\n  });\n""",
)

insert_before_final_describe_close(
    "test/participant-server.test.ts",
    "production websocket identities cannot bypass capability binding",
    """

  test('production websocket identities cannot bypass capability binding with a legacy-shaped id', async () => {
    const server = await startRelay({
      ...FAST,
      NODE_ENV: 'production',
      RELAY_TEST_LEGACY_PARTICIPANTS: '1',
    });
    try {
      const legacy = await RelayClient.connect(
        server,
        participantQuery('participant-alice', 'Alice'),
      );
      const rejected = await legacy.waitForType('participant-auth-rejected');
      assert.match(rejected.message, /capability/i);
      legacy.close();
    } finally {
      await server.stop();
    }
  });
""",
)

replace_once(
    "src/room-song-command-session.ts",
    """    if (roomStatus.connected === false && sameIdentity(statusLeader(roomStatus), identity)) {\n      return { ok: true };\n    }\n""",
    """    // Staleness only relaxes the clock-position proof. Changing video,\n    // playback rate, or play/pause state is still room intent and must travel\n    // through the accepted command path even when the leader has gone stale.\n    if (\n      mutation === 'seek'\n      && roomStatus.connected === false\n      && sameIdentity(statusLeader(roomStatus), identity)\n    ) {\n      return { ok: true };\n    }\n""",
)

replace_once(
    "test/room-song-command.test.ts",
    """    const stale = room({ connected: false, serverTime: 40, youtubeTime: 40, ageMs: 30_000 });\n""",
    """    const stale = room({ connected: false, serverTime: 40, youtubeTime: 10, ageMs: 30_000 });\n""",
)
replace_once(
    "test/room-song-command.test.ts",
    """      session.gateTelemetry(telemetry({ state: 1, currentTime: 11 }), A, stale, 0),\n""",
    """      session.gateTelemetry(telemetry({ currentTime: 11 }), A, stale, 0),\n""",
)
replace_once(
    "test/room-song-command.test.ts",
    """      session.gateTelemetry(telemetry({ state: 1, currentTime: 11 }), B, stale, 0),\n""",
    """      session.gateTelemetry(telemetry({ currentTime: 11 }), B, stale, 0),\n""",
)
replace_once(
    "test/room-song-command.test.ts",
    """    // And a clock with a fresh source is still protected from its own leader:\n    // that is the seek rule, which staleness must not weaken.\n    assert.deepEqual(\n      session.gateTelemetry(telemetry({ videoId: OTHER_VIDEO }), A, room(), 0),\n      { ok: false, reason: 'command-required' },\n    );\n""",
    """    // Staleness is not semantic authority for the leader itself. Only the\n    // clock position can re-anchor; video, rate, and play/pause remain commands.\n    for (const attemptedMutation of [\n      telemetry({ videoId: OTHER_VIDEO, currentTime: 11 }),\n      telemetry({ playbackRate: 1.25, currentTime: 11 }),\n      telemetry({ state: 1, currentTime: 11 }),\n    ]) {\n      assert.deepEqual(\n        session.gateTelemetry(attemptedMutation, A, stale, 0),\n        { ok: false, reason: 'command-required' },\n      );\n    }\n\n    // And a clock with a fresh source is still protected from its own leader.\n    assert.deepEqual(\n      session.gateTelemetry(telemetry({ currentTime: 11 }), A, room(), 0),\n      { ok: false, reason: 'command-required' },\n    );\n""",
)
