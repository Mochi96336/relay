from pathlib import Path

source = Path('.github/restart-mobile-audio-wiring-v2.py').read_text()

# ParticipantSession.snapshot() already owns Presence's process incarnation.
# Do not duplicate it in server.ts; only Room Song status still needs explicit
# wiring because that payload is owned by RoomSongCommandSession instead.
duplicate_presence_block = '''replace_once(
    'src/server.ts',
    "  return {\\n    type: 'session-status',\\n    ...snapshot,",
    "  return {\\n    type: 'session-status',\\n    serverIncarnation: SERVER_INCARNATION,\\n    ...snapshot,",
)
'''
if source.count(duplicate_presence_block) != 1:
    raise SystemExit('expected exactly one redundant Presence incarnation patch')
source = source.replace(duplicate_presence_block, '', 1)

exec(compile(source, '.github/restart-mobile-audio-wiring-v2.py', 'exec'))

# Runtime coverage below already asserts session-status has a non-empty process
# incarnation and equals the Room Song status incarnation. The old source-shape
# assertion expected the incarnation to be spelled in server.ts, but its actual
# canonical owner is ParticipantSession.snapshot().
test_path = Path('test/restart-mobile-audio-contract.test.ts')
test_source = test_path.read_text()
redundant_assertion = "  assert.match(serverSource, /type: 'session-status',[\\s\\S]*serverIncarnation: SERVER_INCARNATION/);\n"
if test_source.count(redundant_assertion) != 1:
    raise SystemExit('expected exactly one redundant server session-status source assertion')
test_path.write_text(test_source.replace(redundant_assertion, '', 1))
