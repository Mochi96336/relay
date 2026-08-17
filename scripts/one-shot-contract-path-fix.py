from pathlib import Path

path = Path('test/i18n-contract.test.ts')
text = path.read_text()
old = "const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');"
new = "const read = (path: string) => readFileSync(path, 'utf8');"
if text.count(old) != 1:
    raise SystemExit(f'i18n contract read helper: expected one match, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))
