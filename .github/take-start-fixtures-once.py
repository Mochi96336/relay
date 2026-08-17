from pathlib import Path


def patch_test(text: str, name: str, old: str, new: str) -> str:
    marker = f"test('{name}'"
    start = text.find(marker)
    if start < 0:
        raise SystemExit(f'{name}: test not found')
    end = text.find("\ntest('", start + len(marker))
    if end < 0:
        end = len(text)
    block = text[start:end]
    count = block.count(old)
    if count != 1:
        raise SystemExit(f'{name}: expected one fixture match, found {count}')
    block = block.replace(old, new, 1)
    return text[:start] + block + text[end:]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


path = Path('test/take-server.test.ts')
text = path.read_text()

text = patch_test(
    text,
    'Relay records the authoritative mixed PCM directly into an authenticated WAV artifact',
    """    const backing = await startBacking(server, key);

    control.send({ type: 'start-take' });
""",
    """    const backing = await startBacking(server, key);
    feedBacking(backing, 8);
    await sleep(60);

    control.send({ type: 'start-take' });
""",
)

text = patch_test(
    text,
    'a Take survives Mic takeover and can be stopped by the new participant without splitting',
    """    const backing = await startBacking(server);
    a.send({ type: 'start-take' });
""",
    """    const backing = await startBacking(server);
    feedBacking(backing, 8);
    await sleep(60);
    a.send({ type: 'start-take' });
""",
)

text = patch_test(
    text,
    'Take keeps recording after the controller socket disconnects and another participant can finish it',
    """    const backing = await startBacking(server);

    a.send({ type: 'start-take' });
""",
    """    const backing = await startBacking(server);
    feedBacking(backing, 8);
    await sleep(60);

    a.send({ type: 'start-take' });
""",
)

text = patch_test(
    text,
    'ending the authoritative live mix auto-finalizes the active Take instead of leaving fake recording state',
    """    const backing = await startBacking(server);

    control.send({ type: 'start-take' });
""",
    """    const backing = await startBacking(server);
    feedBacking(backing, 8);
    await sleep(60);

    control.send({ type: 'start-take' });
""",
)

text = patch_test(
    text,
    'Take commands require participant identity, recordable room audio, and the current Take id',
    """    const backing = await startBacking(server);
    control.send({ type: 'start-take' });
""",
    """    const backing = await startBacking(server);
    feedBacking(backing, 8);
    await sleep(60);
    control.send({ type: 'start-take' });
""",
)

path.write_text(text)

owner_path = Path('test/take-owner-release-evidence-server.test.ts')
owner = owner_path.read_text()
owner = replace_once(
    owner,
    "const RATE = 48_000;\nconst VIDEO = 'dQw4w9WgXcQ';\n",
    "const RATE = 48_000;\nconst FRAME_SAMPLES = 960;\nconst VIDEO = 'dQw4w9WgXcQ';\n",
    'add owner-release frame size',
)
owner = replace_once(
    owner,
    """async function startBacking(server: RelayServer) {
  const backing = await RelayClient.connect(server);
  backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
  await backing.waitFor((message) => message.type === 'registered' && message.role === 'backing');
  return backing;
}
""",
    """async function startBacking(server: RelayServer) {
  const backing = await RelayClient.connect(server);
  backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
  await backing.waitFor((message) => message.type === 'registered' && message.role === 'backing');
  return backing;
}

function feedBacking(backing: RelayClient, frames = 8, value = 10_000) {
  const frame = Buffer.alloc(FRAME_SAMPLES * 2);
  for (let i = 0; i < FRAME_SAMPLES; i += 1) frame.writeInt16LE(value, i * 2);
  for (let i = 0; i < frames; i += 1) backing.sendPcm(frame);
}
""",
    'add owner-release backing feeder',
)
owner = replace_once(
    owner,
    """  const backing = await startBacking(server);
  return { control, backing };
}
""",
    """  const backing = await startBacking(server);
  feedBacking(backing);
  await sleep(60);
  return { control, backing };
}
""",
    'make owner-release room recordable',
)
owner_path.write_text(owner)
