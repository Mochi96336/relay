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
    """    latestSession = message;
    renderParticipants();
  }
""",
    """    latestSession = message;
    renderParticipants();
    // Every tab has its own Presence socket but tabs from the same browser share
    // one participant capability/ID. Publish the authoritative owner snapshot
    // locally so a Listen tab can mute when a sibling tab owns the microphone.
    window.dispatchEvent(new CustomEvent('relay-session-status', { detail: message }));
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
    """  window.addEventListener('relay-microphone-start-failed', () => restoreAfterMicBoundary(t('listen.micFailedResume')));
  window.addEventListener('relay:playback-view', (event) => {
""",
    """  window.addEventListener('relay-microphone-start-failed', () => restoreAfterMicBoundary(t('listen.micFailedResume')));
  window.addEventListener('relay-session-status', (event) => {
    const participantId = typeof window.relayParticipantId === 'string'
      ? window.relayParticipantId
      : null;
    const ownerId = typeof event.detail?.micOwnerId === 'string'
      ? event.detail.micOwnerId
      : null;
    setRoomMicForcedMute(Boolean(participantId && ownerId === participantId));
  });
  window.addEventListener('relay:playback-view', (event) => {
""",
    'consume authoritative Mic ownership in every tab',
)

path = Path('test/mic-lifecycle-recovery.test.ts')
text = path.read_text()
anchor = """test('hardware input ending completes the same Mic lifecycle', () => {
"""
contract = """test('room Mic ownership force-mutes Listen in sibling tabs that share the participant identity', () => {
  const presenceSessionAt = presence.indexOf('latestSession = message;');
  const presenceReconnectAt = presence.indexOf('function scheduleReconnect', presenceSessionAt);
  assert.ok(presenceSessionAt >= 0 && presenceReconnectAt > presenceSessionAt);
  const presenceStatus = presence.slice(presenceSessionAt, presenceReconnectAt);
  assert.match(presenceStatus, /relay-session-status/,
    'Presence must project authoritative room ownership to each tab');

  assert.match(listen, /let roomMicForcedMuted = false/);
  assert.match(listen, /return userMuted \|\| micForcedMuted \|\| roomMicForcedMuted \|\| playbackForcedMuted/);
  assert.match(listen, /if \(micForcedMuted \|\| roomMicForcedMuted\) return 'mic'/);
  assert.match(listen, /function restoreAfterMic[\s\S]*if \(roomMicForcedMuted\)[\s\S]*listen\.micOwned/,
    'a local terminal event must not unmute while another tab still owns the room Mic');
  assert.match(listen, /relay-session-status[\s\S]*ownerId === participantId[\s\S]*setRoomMicForcedMute/,
    'all tabs with the owner participant identity must follow server Mic ownership');
});

"""
count = text.count(anchor)
if count != 1:
    raise SystemExit(f'test/mic-lifecycle-recovery.test.ts: multitab anchor count={count}')
path.write_text(text.replace(anchor, contract + anchor, 1))
