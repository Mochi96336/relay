from pathlib import Path


Path('src/participant-capability.ts').write_text("""import { createHash } from 'node:crypto';

const CAPABILITY_PATTERN = /^[0-9a-f]{64}$/;
const BROWSER_PARTICIPANT_PATTERN = /^participant-([0-9a-f]{32})$/;

export function normalizeParticipantCapability(value: unknown) {
  if (typeof value !== 'string') return null;
  const capability = value.trim();
  return CAPABILITY_PATTERN.test(capability) ? capability : null;
}

/**
 * Browser identities publish only a truncated SHA-256 digest of the complete
 * 256-bit capability. Presence can expose the public id without exposing any
 * contiguous capability bits that another client could reuse as authority.
 */
export function participantIdForCapability(value: unknown) {
  const capability = normalizeParticipantCapability(value);
  if (!capability) return null;
  const digest = createHash('sha256').update(capability, 'utf8').digest('hex');
  return `participant-${digest.slice(0, 32)}`;
}

export function participantCapabilityMatches(participantId: string, value: unknown) {
  if (!BROWSER_PARTICIPANT_PATTERN.test(participantId)) return true;
  return participantIdForCapability(value) === participantId;
}

export function browserParticipantIdentity(participantId: string) {
  return BROWSER_PARTICIPANT_PATTERN.test(participantId);
}
""")


test_path = Path('test/participant-capability.test.ts')
test_text = test_path.read_text()
old = """  test('derives a stable public browser id while keeping 128 secret bits', () => {
    const capability = 'ab'.repeat(32);
    const participantId = `participant-${'ab'.repeat(16)}`;
    assert.equal(normalizeParticipantCapability(capability), capability);
    assert.equal(participantIdForCapability(capability), participantId);
    assert.equal(browserParticipantIdentity(participantId), true);
    assert.equal(participantCapabilityMatches(participantId, capability), true);
    assert.equal(
      participantCapabilityMatches(participantId, `${'ab'.repeat(16)}${'cd'.repeat(16)}`),
      false,
    );
    assert.equal(participantCapabilityMatches(participantId, null), false);
  });
"""
new = """  test('derives the public browser id from the full private capability', () => {
    const capability = 'ab'.repeat(32);
    const samePrefixDifferentSecret = `${'ab'.repeat(16)}${'cd'.repeat(16)}`;
    const participantId = participantIdForCapability(capability);
    assert.equal(normalizeParticipantCapability(capability), capability);
    assert.match(participantId ?? '', /^participant-[0-9a-f]{32}$/);
    assert.notEqual(participantIdForCapability(samePrefixDifferentSecret), participantId);
    assert.equal(browserParticipantIdentity(participantId ?? ''), true);
    assert.equal(participantCapabilityMatches(participantId ?? '', capability), true);
    assert.equal(participantCapabilityMatches(participantId ?? '', samePrefixDifferentSecret), false);
    assert.equal(participantCapabilityMatches(participantId ?? '', null), false);
  });
"""
count = test_text.count(old)
if count != 1:
    raise SystemExit(f'participant capability unit contract: expected one old block, found {count}')
test_text = test_text.replace(old, new, 1)
old_browser_asserts = """      assert.match(source, /relayParticipantCapability/);
      assert.match(source, /params\\.set\\('cap',/);
"""
new_browser_asserts = """      assert.match(source, /relayParticipantCapability/);
      assert.match(source, /relayIdentityReady/);
      assert.match(source, /params\\.set\\('cap',/);
"""
count = test_text.count(old_browser_asserts)
if count != 1:
    raise SystemExit(f'participant browser source contract: expected one assertion block, found {count}')
test_path.write_text(test_text.replace(old_browser_asserts, new_browser_asserts, 1))


presence_path = Path('public/presence.js')
presence = presence_path.read_text()
outer = "(() => {\n"
if not presence.startswith(outer):
    raise SystemExit('identity readiness promise: presence outer IIFE changed')
presence = "window.relayIdentityReady = (async () => {\n" + presence[len(outer):]
replacements = [
    (
        """  function participantIdForCapability(capability) {
    return `participant-${capability.slice(0, 32)}`;
  }

  function storedIdentity() {
""",
        """  async function participantIdForCapability(capability) {
    const bytes = new TextEncoder().encode(capability);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const publicId = Array.from(
      digest.subarray(0, 16),
      (value) => value.toString(16).padStart(2, '0'),
    ).join('');
    return `participant-${publicId}`;
  }

  async function storedIdentity() {
""",
        'browser full-capability digest',
    ),
    (
        "    const participantId = participantIdForCapability(participantCapability);\n",
        "    const participantId = await participantIdForCapability(participantCapability);\n",
        'await public id derivation',
    ),
    (
        "  let { participantId, participantCapability, nickname } = storedIdentity();\n",
        "  let { participantId, participantCapability, nickname } = await storedIdentity();\n",
        'await stored identity',
    ),
]
for old_text, new_text, label in replacements:
    count = presence.count(old_text)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, found {count}')
    presence = presence.replace(old_text, new_text, 1)
presence_path.write_text(presence)


for filename in [
    'public/app.js',
    'public/listen.js',
    'public/live-status.js',
    'public/system-details.js',
    'public/recorder.js',
    'public/youtube-sync.js',
]:
    path = Path(filename)
    source = path.read_text()
    marker = 'await window.relayIdentityReady;\n'
    if marker in source:
        raise SystemExit(f'{filename}: identity readiness wait already exists')
    path.write_text(marker + source)
