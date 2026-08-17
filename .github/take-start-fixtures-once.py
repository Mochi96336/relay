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


path = Path('test/take-server.test.ts')
text = path.read_text()

healthy_backing = """    feedBacking(backing, 8);
    await sleep(60);
"""

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
