from pathlib import Path

path = Path('test/mic-startup.test.ts')
text = path.read_text()
old = '  let callback = null;\n'
new = '  let callback: (() => void) | null = null;\n'
count = text.count(old)
if count != 1:
    raise SystemExit(f'mic startup fake timer callback: expected one match, found {count}')
path.write_text(text.replace(old, new, 1))
