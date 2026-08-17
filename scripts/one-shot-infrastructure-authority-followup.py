from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f'missing patch anchor in {path}: {old[:120]!r}')
    if text.count(old) != 1:
        raise SystemExit(f'patch anchor is not unique in {path}: {old[:120]!r}')
    file.write_text(text.replace(old, new, 1))


replace_once(
    'test/robot-scripts.test.ts',
    "  test('uses one sample rate, hides the key, and treats a child exit as failure', () => {\n"
    "    const { env, state } = mockedEnvironment();\n"
    "    const result = run('robot-source.sh', {\n"
    "      ...env,\n"
    "      PORT: '3100',\n"
    "      RELAY_BACKING_SAMPLE_RATE: '44100',\n"
    "      RELAY_BACKING_CAPTURE_LATENCY_MS: '60',\n"
    "      RELAY_KEY: 'do-not-print-this-key',\n"
    "    });\n",
    "  test('uses one sample rate, hides deployment secrets, and treats a child exit as failure', () => {\n"
    "    const { env, state } = mockedEnvironment();\n"
    "    const infrastructureKey = 'cd'.repeat(32);\n"
    "    const result = run('robot-source.sh', {\n"
    "      ...env,\n"
    "      PORT: '3100',\n"
    "      RELAY_BACKING_SAMPLE_RATE: '44100',\n"
    "      RELAY_BACKING_CAPTURE_LATENCY_MS: '60',\n"
    "      RELAY_KEY: 'do-not-print-this-key',\n"
    "      RELAY_INFRA_KEY: infrastructureKey,\n"
    "    });\n",
)

replace_once(
    'test/robot-scripts.test.ts',
    "    assert.doesNotMatch(result.stderr, /do-not-print-this-key/);\n"
    "    assert.match(result.stderr, /localhost:3100\\/source\\.html\\?robot=1/);\n"
    "    assert.match(result.stderr, /authenticated/);\n",
    "    assert.doesNotMatch(result.stderr, /do-not-print-this-key/);\n"
    "    assert.doesNotMatch(result.stderr, new RegExp(infrastructureKey));\n"
    "    assert.match(result.stderr, /localhost:3100\\/source\\.html\\?robot=1/);\n"
    "    assert.match(result.stderr, /authenticated/);\n",
)
