from pathlib import Path

p = Path('.tmp/apply-backing-capture-identity.py')
text = p.read_text()
old = """replace_once(
    'src/server.ts',
    '''function validCaptureGeneration(value: unknown) {\\n  const generation = Number(value);\\n  if (!Number.isInteger(generation) || generation < 0 || generation > 0xffff_ffff) return null;\\n  return generation >>> 0;\\n}\\n''',
    '''function validCaptureGeneration(value: unknown) {\\n  const generation = Number(value);\\n  if (!Number.isInteger(generation) || generation < 0 || generation > 0xffff_ffff) return null;\\n  return generation >>> 0;\\n}\\n\\nfunction validSampleCursor(value: unknown) {\\n  const cursor = Number(value);\\n  if (!Number.isSafeInteger(cursor) || cursor < 0) return null;\\n  return cursor;\\n}\\n''',
)
"""
new = """replace_once(
    'src/server.ts',
    '''function validCaptureGeneration(value: unknown) {\\n  const generation = Number(value);\\n  return Number.isInteger(generation) && generation >= 0 && generation <= 0xffff_ffff\\n    ? generation >>> 0\\n    : null;\\n}\\n''',
    '''function validCaptureGeneration(value: unknown) {\\n  const generation = Number(value);\\n  return Number.isInteger(generation) && generation >= 0 && generation <= 0xffff_ffff\\n    ? generation >>> 0\\n    : null;\\n}\\n\\nfunction validSampleCursor(value: unknown) {\\n  const cursor = Number(value);\\n  if (!Number.isSafeInteger(cursor) || cursor < 0) return null;\\n  return cursor;\\n}\\n''',
)
"""
if text.count(old) != 1:
    raise SystemExit(f'expected one capture validator harness block, found {text.count(old)}')
p.write_text(text.replace(old, new, 1))
print('aligned capture validator patch with exact main')
