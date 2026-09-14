from pathlib import Path

p = Path('.tmp/apply-backing-capture-identity.py')
text = p.read_text()
old = """p = Path('src/audio-session.ts')
text = p.read_text()
needle = '    this.micCaptureRestartPending = false;\\n'
if text.count(needle) != 2:
    raise SystemExit(f'src/audio-session.ts: expected stop/reset pending assignments twice, found {text.count(needle)}')
text = text.replace(needle, needle + '    this.backingCaptureRestartPending = false;\\n')
p.write_text(text)
"""
new = """replace_once(
    'src/audio-session.ts',
    '''    this.clearTimeline(this.mic);\\n    this.clearTimeline(this.backing);\\n    this.micCaptureRestartPending = false;\\n    this.resetHealth();\\n''',
    '''    this.clearTimeline(this.mic);\\n    this.clearTimeline(this.backing);\\n    this.micCaptureRestartPending = false;\\n    this.backingCaptureRestartPending = false;\\n    this.resetHealth();\\n''',
)
replace_once(
    'src/audio-session.ts',
    '''    this.clearTimeline(this.mic);\\n    this.clearTimeline(this.backing);\\n    this.micCaptureRestartPending = false;\\n    // The frontier correction described the old timelines' positions.\\n''',
    '''    this.clearTimeline(this.mic);\\n    this.clearTimeline(this.backing);\\n    this.micCaptureRestartPending = false;\\n    this.backingCaptureRestartPending = false;\\n    // The frontier correction described the old timelines' positions.\\n''',
)
"""
if text.count(old) != 1:
    raise SystemExit(f'expected one old harness block, found {text.count(old)}')
p.write_text(text.replace(old, new, 1))
print('tightened backing pending reset patch contexts')
