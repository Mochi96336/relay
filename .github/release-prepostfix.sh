#!/usr/bin/env bash
set -euo pipefail

test "$(git branch --show-current)" = 'integration'
python3 - <<'PY'
from pathlib import Path
path = Path('src/server.ts')
text = path.read_text()
old = """function roomHasSong(nowMs = performance.now()) {
  return takeSongSnapshot(nowMs) !== null;
}"""
new = """function roomHasSong(nowMs = performance.now()) {
  return takeSongSnapshot(nowMs).videoId !== null;
}"""
assert old in text
path.write_text(text.replace(old, new, 1))
PY
