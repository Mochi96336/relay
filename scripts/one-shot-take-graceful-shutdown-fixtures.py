from pathlib import Path

for path in ['test/take-quality.test.ts', 'test/take-session.test.ts']:
    target = Path(path)
    text = target.read_text()
    old = "      'mic-owner-changed': 0,\n"
    if text.count(old) != 1:
        raise SystemExit(f'{path}: expected one Take quality event fixture, found {text.count(old)}')
    target.write_text(text.replace(old, old + "      'server-shutdown': 0,\n", 1))
