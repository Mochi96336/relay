const params = new URLSearchParams(location.search);
const state = params.get('state') || 'listener';
const selfId = 'visual-self';
const ownerId = state === 'singer' || state === 'recording' ? selfId : 'visual-owner';
const now = Date.now();

window.relayParticipantId = selfId;
window.relayIdentityReady = Promise.resolve();

const songSnapshot = {
  videoId: 'PZGwZwGQTlk',
  videoTitle: '林俊傑 JJ Lin－偉大的渺小',
  videoAuthor: 'JJ Lin 林俊傑',
  state: 1,
  serverTime: 102,
  duration: 311,
  handoffState: 'idle',
  playbackLeaderParticipantId: ownerId,
  playbackTransportId: 'visual-playback',
  playbackGeneration: 1,
  leaderConnected: true,
  leaderFresh: true,
  ageMs: 0,
};

function productStatusFor(nextState) {
  if (nextState === 'reconnecting') return null;
  const empty = nextState === 'empty';
  const recording = nextState === 'recording';
  const selfOwner = nextState === 'singer' || recording;
  const issueState = nextState === 'system-issue';
  const recordingBlocked = nextState === 'recording-blocked';
  const issues = issueState
    ? [{
        code: 'mic-audio-stalled',
        scope: 'mic',
        severity: 'warning',
        cause: 'mic-audio-stalled',
        affects: ['voice', 'recording'],
        recovery: 'retry-mic',
      }]
    : recordingBlocked
      ? [{
          code: 'robot-audio-unavailable',
          scope: 'robot',
          severity: 'critical',
          cause: 'backing-stalled',
          affects: ['song', 'recording'],
          recovery: 'automatic',
        }]
      : [];
  const startTakeBlockingIssue = recordingBlocked ? issues[0] : null;
  return {
    type: 'product-status',
    lifecycle: empty ? 'ready' : 'live',
    health: recordingBlocked ? 'blocked' : issueState ? 'degraded' : 'healthy',
    room: {
      participantCount: 2,
      mic: empty
        ? { state: 'free', ownerId: null, ownerNickname: null }
        : issueState
          ? { state: 'interrupted', ownerId: 'visual-owner', ownerNickname: 'Mellow Rabbit 57' }
          : { state: 'live', ownerId: selfOwner ? selfId : 'visual-owner', ownerNickname: selfOwner ? '浚翔' : 'Mellow Rabbit 57' },
      song: empty ? { state: 'empty', videoId: null } : { state: 'playing', ...songSnapshot },
    },
    timing: { state: empty ? 'idle' : 'aligned' },
    take: { lifecycle: recording ? 'recording' : 'idle' },
    issues,
    actions: {
      canStartTake: !empty && !recording && !recordingBlocked,
      startTakeBlockedReason: empty ? 'mix-not-active' : recordingBlocked ? 'room-blocked' : null,
      startTakeBlockingIssue,
    },
  };
}

const productStatus = productStatusFor(state);

class FixtureWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    super();
    this.url = url;
    this.readyState = FixtureWebSocket.CONNECTING;
    queueMicrotask(() => {
      this.readyState = FixtureWebSocket.OPEN;
      this.dispatchEvent(new Event('open'));
    });
  }

  send(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (message.type !== 'product-status-request' || !productStatus) return;
    queueMicrotask(() => {
      this.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify(productStatus),
      }));
    });
  }

  close() {
    if (this.readyState === FixtureWebSocket.CLOSED) return;
    this.readyState = FixtureWebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }
}

window.WebSocket = FixtureWebSocket;

function presenceStateFor(nextState) {
  if (nextState === 'reconnecting') {
    return {
      authorityFresh: false,
      session: {
        participants: [
          { id: 'visual-owner', nickname: 'Mellow Rabbit 57', connected: true },
          { id: selfId, nickname: 'Jade Fox 18', connected: true },
        ],
        micOwnerId: 'visual-owner',
        micConnected: true,
      },
    };
  }
  const empty = nextState === 'empty';
  const selfOwner = nextState === 'singer' || nextState === 'recording';
  return {
    authorityFresh: true,
    session: {
      participants: [
        { id: selfOwner ? selfId : 'visual-owner', nickname: selfOwner ? '浚翔' : 'Mellow Rabbit 57', connected: true },
        { id: selfOwner ? 'visual-owner' : selfId, nickname: selfOwner ? 'Mellow Rabbit 57' : 'Jade Fox 18', connected: true },
      ],
      micOwnerId: empty ? null : selfOwner ? selfId : 'visual-owner',
      micConnected: !empty,
    },
  };
}

function micActionStateFor(nextState) {
  const reconnecting = nextState === 'reconnecting';
  const empty = nextState === 'empty';
  const selfOwner = nextState === 'singer' || nextState === 'recording';
  const takeoverOpen = nextState === 'takeover';
  const owner = empty ? null : {
    id: selfOwner ? selfId : 'visual-owner',
    nickname: selfOwner ? '浚翔' : 'Mellow Rabbit 57',
  };
  return {
    owner,
    takeoverOpen,
    takeoverPending: false,
    primaryMode: empty || selfOwner ? 'microphone' : 'takeover',
    authorityFresh: !reconnecting,
    commandChannelFresh: !reconnecting,
    mine: selfOwner,
    localPublisherActive: selfOwner,
    releaseVisible: selfOwner,
    primaryActionable: !reconnecting && !selfOwner,
    takeoverConfirmActionable: !reconnecting && takeoverOpen,
    takeoverCancelActionable: takeoverOpen,
    failure: null,
  };
}

function recordingStateFor(nextState) {
  if (nextState === 'recording') {
    return {
      lifecycle: 'recording',
      take: { takeId: 'visual-take', startedAtMs: now - 18_000 },
      authorityFresh: true,
      commandChannelFresh: true,
      canStart: false,
      canStop: true,
      startPending: false,
      startBlockedReason: 'take-active',
      startBlockingIssue: null,
      snapshotObservedAt: now,
      commandError: null,
    };
  }
  if (nextState === 'reconnecting') {
    return {
      lifecycle: 'idle',
      take: null,
      authorityFresh: false,
      commandChannelFresh: false,
      canStart: false,
      canStop: false,
      startPending: false,
      startBlockedReason: 'reconnecting',
      startBlockingIssue: null,
      snapshotObservedAt: now,
      commandError: null,
    };
  }
  const empty = nextState === 'empty';
  const recordingBlocked = nextState === 'recording-blocked';
  const canStart = !empty && !recordingBlocked;
  return {
    lifecycle: 'idle',
    take: null,
    authorityFresh: true,
    commandChannelFresh: true,
    canStart,
    canStop: false,
    startPending: false,
    startBlockedReason: empty ? 'mix-not-active' : recordingBlocked ? 'room-blocked' : null,
    startBlockingIssue: recordingBlocked
      ? {
          code: 'robot-audio-unavailable',
          scope: 'robot',
          severity: 'critical',
          cause: 'backing-stalled',
          affects: ['song', 'recording'],
          recovery: 'automatic',
        }
      : null,
    snapshotObservedAt: now,
    commandError: null,
  };
}

function roomSoundStateFor(nextState) {
  if (nextState === 'singer' || nextState === 'recording') {
    return {
      state: 'mic-muted',
      phase: 'mic-owned',
      muted: true,
      forcedReason: 'mic',
      volumePercent: 100,
    };
  }
  if (nextState === 'reconnecting') {
    return {
      state: 'ready',
      phase: 'reconnecting',
      muted: false,
      forcedReason: null,
      volumePercent: 100,
    };
  }
  return {
    state: nextState === 'empty' ? 'ready' : 'audible',
    phase: nextState === 'empty' ? '' : 'playing',
    muted: false,
    forcedReason: null,
    volumePercent: 100,
  };
}

window.relayPresenceState = presenceStateFor(state);
window.relayMicActionState = micActionStateFor(state);
window.relayRecordingState = recordingStateFor(state);
window.relayListenState = roomSoundStateFor(state);

await import('/live-ia.js');
await import('/mic-actions.js');
await import('/room-sound-ui.js');
await import('/recording-ui.js');
await import('/song-surface.js');
await import('/live-status.js');

const playbackRole = state === 'empty'
  ? 'empty'
  : state === 'singer' || state === 'recording'
    ? 'holder'
    : 'observer';
window.dispatchEvent(new CustomEvent('relay:playback-view', {
  detail: {
    role: playbackRole,
    timeline: state === 'empty' ? { videoId: null, handoffState: 'idle' } : songSnapshot,
    isMicOwner: state === 'singer' || state === 'recording',
    isMicFree: state === 'empty',
  },
}));

const samples = [
  { rmsDbfs: -38, spectrumBands: [0.15, .32, .72, .55, .18], f0Hz: 110, pitchConfidence: .92 },
  { rmsDbfs: -31, spectrumBands: [0.10, .38, .88, .62, .22], f0Hz: 123, pitchConfidence: .94 },
  { rmsDbfs: -24, spectrumBands: [0.14, .50, .94, .75, .28], f0Hz: 147, pitchConfidence: .96 },
  { rmsDbfs: -29, spectrumBands: [0.10, .44, .80, .72, .33], f0Hz: 165, pitchConfidence: .93 },
  { rmsDbfs: -18, spectrumBands: [0.18, .60, 1.00, .66, .24], f0Hz: 196, pitchConfidence: .97 },
  { rmsDbfs: -26, spectrumBands: [0.12, .48, .82, .58, .18], f0Hz: 220, pitchConfidence: .95 },
  { rmsDbfs: -16, spectrumBands: [0.20, .66, .96, .54, .15], f0Hz: 262, pitchConfidence: .97 },
  { rmsDbfs: -27, spectrumBands: [0.12, .54, .78, .46, .11], f0Hz: 330, pitchConfidence: .94 },
  { rmsDbfs: -20, spectrumBands: [0.16, .70, .90, .48, .12], f0Hz: 392, pitchConfidence: .96 },
  { rmsDbfs: -33, spectrumBands: [0.10, .42, .62, .36, .08], f0Hz: 440, pitchConfidence: .93 },
];

function publishPresenceEvidence() {
  if (!productStatus || productStatus.room?.mic?.state !== 'live') return;
  for (const sample of samples) {
    window.dispatchEvent(new CustomEvent('relay-room-mic-presence', {
      detail: {
        active: true,
        ownerId: productStatus.room.mic.ownerId,
        captureGeneration: 1,
        ...sample,
      },
    }));
  }
}
setTimeout(publishPresenceEvidence, 20);
setInterval(publishPresenceEvidence, 120);

await new Promise((resolve) => setTimeout(resolve, 20));
if (state === 'people') document.querySelector('.people-menu').open = true;
if (state === 'more') document.querySelector('#room-more').open = true;
if (state === 'system' || state === 'system-issue') document.querySelector('#system-panel').open = true;

document.body.dataset.fixtureState = state;
window.__relayVisualReady = true;