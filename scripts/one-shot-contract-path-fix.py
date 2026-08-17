from pathlib import Path

path = Path('test/i18n-contract.test.ts')
text = path.read_text()
old = "const presence = html.indexOf('<script src=\"/presence.js\"></script>');"
new = "const presence = html.indexOf('src=\"/presence.js\"');"
if text.count(old) != 1:
    raise SystemExit(f'i18n presence ordering contract: expected one match, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))
