from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str):
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: {label}: expected one match, found {count}')
    target.write_text(text.replace(old, new, 1))


replace_once(
    'public/presence.js',
    """  function handleMessage(message) {
""",
    """  function publishSessionStatus() {
    if (!latestSession) return;
    window.dispatchEvent(new CustomEvent('relay-session-status', { detail: latestSession }));
  }

  // Module scripts such as Listen can start after the first Presence snapshot
  // has already arrived. Let late consumers explicitly request a replay instead
  // of relying on script/network timing.
  window.addEventListener('relay-request-session-status', publishSessionStatus);

  function handleMessage(message) {
""",
    'add replayable room session projection',
)

replace_once(
    'public/presence.js',
    """    latestSession = message;
    renderParticipants();
  }
""",
    """    latestSession = message;
    renderParticipants();
    // Every tab has its own Presence socket but tabs from the same browser share
    // one participant capability/ID. Project authoritative room ownership to
    // local page consumers so sibling Listen tabs follow the server, not each
    // other's process-local Mic events.
    publishSessionStatus();
  }
""",
    'publish authoritative room session status to page consumers',
)

replace_once(
    'public/listen.js',
    """  let userMuted = false;
  let micForcedMuted = false;
  let playbackForcedMuted = false;
""",
    """  let userMuted = false;
  let micForcedMuted = false;
  let roomMicForcedMuted = false;
  let playbackForcedMuted = false;
""",
    'track room-level Mic mute separately from local startup intent',
)

replace_once(
    'public/listen.js',
    """  function effectiveMuted() {
    return userMuted || micForcedMuted || playbackForcedMuted;
  }

  function forcedMuteReason() {
    if (micForcedMuted) return 'mic';
""",
    """  function effectiveMuted() {
    return userMuted || micForcedMuted || roomMicForcedMuted || playbackForcedMuted;
  }

  function forcedMuteReason() {
    if (micForcedMuted || roomMicForcedMuted) return 'mic';
""",
    'include authoritative room Mic ownership in effective mute',
)

replace_once(
    'public/listen.js',
    """  function restoreAfterMic(copy = t('listen.resumed')) {
    micForcedMuted = false;
    if (playbackForcedMuted) {
      reconcile(t('listen.songOwned'));
      return;
    }
""",
    """  function restoreAfterMic(copy = t('listen.resumed')) {
    micForcedMuted = false;
    if (roomMicForcedMuted) {
      reconcile(t('listen.micOwned'));
      return;
    }
    if (playbackForcedMuted) {
      reconcile(t('listen.songOwned'));
      return;
    }
""",
    'do not resume local Listen while a sibling tab still owns Mic',
)

replace_once(
    'public/listen.js',
    """  function setPlaybackForcedMute(forced) {
    if (playbackForcedMuted === forced) return;
    playbackForcedMuted = forced;
    if (forced) {
      reconcile(t('listen.songOwned'));
      return;
    }
    if (micForcedMuted) {
      reconcile(t('listen.micOwned'));
      return;
    }
""",
    """  function setRoomMicForcedMute(forced) {
    if (roomMicForcedMuted === forced) return;
    roomMicForcedMuted = forced;
    if (forced) {
      reconcile(t('listen.micOwned'));
      return;
    }
    if (micForcedMuted) {
      reconcile(t('listen.micStarting'));
      return;
    }
    if (playbackForcedMuted) {
      reconcile(t('listen.songOwned'));
      return;
    }
    if (userMuted) {
      reconcile(t('listen.adjust.userMuted'));
      return;
    }
    reconcile(t('listen.resumed'));
  }

  function setPlaybackForcedMute(forced) {
    if (playbackForcedMuted === forced) return;
    playbackForcedMuted = forced;
    if (forced) {
      reconcile(t('listen.songOwned'));
      return;
    }
    if (micForcedMuted || roomMicForcedMuted) {
      reconcile(t('listen.micOwned'));
      return;
    }
""",
    'add authoritative room Mic mute reconciler',
)

replace_once(
    'public/listen.js',
    """  toggle.addEventListener('click', async () => {
    if (micForcedMuted || playbackForcedMuted) return;
""",
    """  toggle.addEventListener('click', async () => {
    if (micForcedMuted || roomMicForcedMuted || playbackForcedMuted) return;
""",
    'block Listen toggles while room Mic ownership forces mute',
)

replace_once(
    'public/listen.js',
    """  window.addEventListener('relay-microphone-start-failed', () => restoreAfterMicBoundary(t('listen.micFailedResume')));
  window.addEventListener('relay:playback-view', (event) => {
""",
    """  window.addEventListener('relay-microphone-start-failed', () => restoreAfterMicBoundary(t('listen.micFailedResume')));

  function applyRoomSessionStatus(status) {
    const participantId = typeof window.relayParticipantId === 'string'
      ? window.relayParticipantId
      : null;
    const ownerId = typeof status?.micOwnerId === 'string'
      ? status.micOwnerId
      : null;
    setRoomMicForcedMute(Boolean(participantId && ownerId === participantId));
  }

  window.addEventListener('relay-session-status', (event) => applyRoomSessionStatus(event.detail));
  // Presence may have received its first snapshot before this module loaded.
  // Request an immediate replay so initial multi-tab ownership cannot race the
  // listener registration above.
  window.dispatchEvent(new Event('relay-request-session-status'));

  window.addEventListener('relay:playback-view', (event) => {
""",
    'consume and replay authoritative Mic ownership in every tab',
)

path = Path('test/mic-lifecycle-recovery.test.ts')
text = path.read_text()
anchor = """test('hardware input ending completes the same Mic lifecycle', () => {
"""
contract = r"""test('room Mic ownership force-mutes Listen in sibling tabs that share the participant identity', () => {
  const publishAt = presence.indexOf('function publishSessionStatus');
  const handleAt = presence.indexOf('function handleMessage', publishAt);
  assert.ok(publishAt >= 0 && handleAt > publishAt);
  const presenceProjection = presence.slice(publishAt, handleAt);
  assert.match(presenceProjection, /relay-session-status/,
    'Presence must project authoritative room ownership to each tab');
  assert.match(presenceProjection, /relay-request-session-status/,
    'late module consumers must be able to replay the current ownership snapshot');

  assert.match(listen, /let roomMicForcedMuted = false/);
  assert.match(listen, /return userMuted \|\| micForcedMuted \|\| roomMicForcedMuted \|\| playbackForcedMuted/);
  assert.match(listen, /if \(micForcedMuted \|\| roomMicForcedMuted\) return 'mic'/);
  assert.match(listen, /function restoreAfterMic[\s\S]*if \(roomMicForcedMuted\)[\s\S]*listen\.micOwned/,
    'a local terminal event must not unmute while another tab still owns the room Mic');
  assert.match(listen, /setRoomMicForcedMute\(Boolean\(participantId && ownerId === participantId\)\)/,
    'all tabs with the owner participant identity must follow server Mic ownership');
  const sessionListenerAt = listen.indexOf("window.addEventListener('relay-session-status'");
  const replayAt = listen.indexOf("window.dispatchEvent(new Event('relay-request-session-status'))", sessionListenerAt);
  assert.ok(sessionListenerAt >= 0 && replayAt > sessionListenerAt,
    'Listen must subscribe before requesting the initial authoritative replay');
  assert.match(listen, /if \(micForcedMuted \|\| roomMicForcedMuted \|\| playbackForcedMuted\) return/,
    'forced room ownership cannot be bypassed by the Listen toggle');
});

"""
count = text.count(anchor)
if count != 1:
    raise SystemExit(f'test/mic-lifecycle-recovery.test.ts: multitab anchor count={count}')
path.write_text(text.replace(anchor, contract + anchor, 1))
