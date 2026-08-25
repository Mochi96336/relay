import { authorityState } from './authority-freshness.js';
import { sendParticipantAuthentication } from './participant-auth.js';
window.relayIdentityReady = (async () => {
  const identityButton = document.querySelector('#identity-name');
  const identityInput = document.querySelector('#identity-input');
  const releaseButton = document.querySelector('#release-mic');
  const confirmTakeoverButton = document.querySelector('#confirm-takeover');
  const cancelTakeoverButton = document.querySelector('#cancel-takeover');
  const publisherButton = document.querySelector('#start-publisher');

  if (
    !identityButton || !identityInput || !releaseButton || !confirmTakeoverButton
    || !cancelTakeoverButton || !publisherButton
  ) return;

  const PARTICIPANT_ID_KEY = 'relay.participantId.v1';
  const PARTICIPANT_CAPABILITY_KEY = 'relay.participantCapability.v1';
  const NICKNAME_KEY = 'relay.nickname.v1';
  const PENDING_NICKNAME_KEY = 'relay.pendingNickname.v1';
  const RECONNECT_MS = 1_000;
  const adjectives = [
    'Blue', 'Quiet', 'Tiny', 'Silver', 'Mint', 'Soft', 'Bright', 'Lazy',
    'Lucky', 'Warm', 'Swift', 'Night', 'Sunny', 'Mellow', 'Cloud', 'Little',
  ];
  const nouns = [
    'Fox', 'Otter', 'Panda', 'Cat', 'Moth', 'Robin', 'Seal', 'Gecko',
    'Whale', 'Finch', 'Koala', 'Lynx', 'Sparrow', 'Rabbit', 'Dolphin', 'Bear',
  ];

  function normalizeNickname(value) {
    if (typeof value !== 'string') return null;
    const normalized = Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, 32).join('');
    return normalized || null;
  }

  function randomNickname() {
    const random = new Uint32Array(3);
    crypto.getRandomValues(random);
    return `${adjectives[random[0] % adjectives.length]} ${nouns[random[1] % nouns.length]} ${10 + (random[2] % 90)}`;
  }

  function randomParticipantCapability() {
    const random = new Uint8Array(32);
    crypto.getRandomValues(random);
    return Array.from(random, (value) => value.toString(16).padStart(2, '0')).join('');
  }

  async function participantIdForCapability(capability) {
    const bytes = new TextEncoder().encode(capability);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const publicId = Array.from(
      digest.subarray(0, 16),
      (value) => value.toString(16).padStart(2, '0'),
    ).join('');
    return `participant-${publicId}`;
  }

  async function storedIdentity() {
    let participantCapability = localStorage.getItem(PARTICIPANT_CAPABILITY_KEY);
    if (!participantCapability || !/^[0-9a-f]{64}$/.test(participantCapability)) {
      participantCapability = randomParticipantCapability();
      localStorage.setItem(PARTICIPANT_CAPABILITY_KEY, participantCapability);
    }

    const participantId = await participantIdForCapability(participantCapability);
    if (localStorage.getItem(PARTICIPANT_ID_KEY) !== participantId) {
      localStorage.setItem(PARTICIPANT_ID_KEY, participantId);
    }

    let nickname = normalizeNickname(localStorage.getItem(NICKNAME_KEY));
    if (!nickname) {
      nickname = randomNickname();
      localStorage.setItem(NICKNAME_KEY, nickname);
    }
    return { participantId, participantCapability, nickname };
  }

  let { participantId, participantCapability, nickname } = await storedIdentity();
  let pendingNickname = normalizeNickname(localStorage.getItem(PENDING_NICKNAME_KEY));
  if (pendingNickname) {
    nickname = pendingNickname;
    localStorage.setItem(NICKNAME_KEY, nickname);
  }

  let socket = null;
  let reconnectTimer = null;
  let latestSession = null;
  let sessionAuthorityFresh = false;
  let takeoverOwnerId = null;
  let startAfterTakeover = false;
  let takeoverFailure = null;
  let localPublisherActive = window.relayActiveRole === 'publisher';

  window.relayParticipantId = participantId;
  window.relayParticipantCapability = participantCapability;
  window.relayNickname = nickname;
  identityButton.textContent = nickname;

  function wsUrl() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const source = new URLSearchParams(location.search);
    const params = new URLSearchParams();
    const key = source.get('key');
    if (key) params.set('key', key);
    const query = params.toString();
    return `${protocol}//${location.host}/ws${query ? `?${query}` : ''}`;
  }

  function participantById(id) {
    return latestSession?.participants?.find((participant) => participant.id === id) ?? null;
  }

  function owner() {
    return participantById(latestSession?.micOwnerId ?? null);
  }

  function micActionState() {
    const currentOwner = owner();
    const mine = latestSession?.micOwnerId === participantId;
    const commandChannelFresh = socket?.readyState === WebSocket.OPEN;
    const takeoverOpen = Boolean(
      takeoverOwnerId
      && currentOwner
      && currentOwner.id === takeoverOwnerId
      && !mine,
    );
    const baseAuthority = authorityState({
      authorityFresh: sessionAuthorityFresh,
      lastKnownSnapshot: latestSession,
      commandChannelFresh,
      authorized: true,
      serverAllowed: true,
    });
    const primaryAuthority = authorityState({
      authorityFresh: sessionAuthorityFresh,
      lastKnownSnapshot: latestSession,
      commandChannelFresh,
      authorized: !mine,
      serverAllowed: !localPublisherActive,
    });
    const takeoverAuthority = authorityState({
      authorityFresh: sessionAuthorityFresh,
      lastKnownSnapshot: latestSession,
      commandChannelFresh,
      authorized: Boolean(currentOwner && currentOwner.id !== participantId),
      serverAllowed: takeoverOpen && !startAfterTakeover,
    });

    return {
      participantId,
      authorityFresh: baseAuthority.authorityFresh,
      lastKnownSnapshot: baseAuthority.lastKnownSnapshot,
      commandChannelFresh: baseAuthority.commandChannelFresh,
      owner: currentOwner ? {
        id: currentOwner.id,
        nickname: currentOwner.nickname,
        connected: currentOwner.connected,
      } : null,
      mine,
      localPublisherActive,
      releaseVisible: Boolean(mine || localPublisherActive),
      primaryMode: currentOwner && !mine ? 'takeover' : 'take',
      primaryActionable: primaryAuthority.actionable,
      takeoverOpen,
      takeoverPending: takeoverOpen && startAfterTakeover,
      takeoverConfirmActionable: takeoverAuthority.actionable,
      takeoverCancelActionable: takeoverOpen && !startAfterTakeover,
      failure: takeoverOpen ? takeoverFailure : null,
    };
  }

  function publishMicActionState() {
    const detail = micActionState();
    window.relayMicActionState = detail;
    window.dispatchEvent(new CustomEvent('relay-mic-action-state', { detail }));
  }

  function publishPresenceState() {
    const detail = {
      session: latestSession,
      authorityFresh: sessionAuthorityFresh,
    };
    window.relayPresenceState = detail;
    window.dispatchEvent(new CustomEvent('relay-presence-state', { detail }));
  }

  window.addEventListener('relay-request-mic-action-state', publishMicActionState);
  window.addEventListener('relay-request-presence-state', publishPresenceState);

  function cancelSpeculativePlaybackPrewarm() {
    window.dispatchEvent(new CustomEvent('relay:playback-prewarm-cancel'));
  }

  function hideTakeover({ cancelPrewarm = false } = {}) {
    if (cancelPrewarm) cancelSpeculativePlaybackPrewarm();
    takeoverOwnerId = null;
    startAfterTakeover = false;
    takeoverFailure = null;
    publishMicActionState();
  }

  function showTakeover(currentOwner) {
    takeoverOwnerId = currentOwner.id;
    startAfterTakeover = false;
    takeoverFailure = null;
    publishMicActionState();
  }

  function send(payload) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }

  function sendPendingRename() {
    if (!pendingNickname) return false;
    return send({ type: 'participant-rename', nickname: pendingNickname });
  }

  function reconcileSessionState() {
    if (!latestSession) {
      publishMicActionState();
      publishPresenceState();
      return;
    }

    const self = participantById(participantId);
    if (self && pendingNickname) {
      if (self.nickname === pendingNickname) {
        nickname = self.nickname;
        pendingNickname = null;
        localStorage.setItem(NICKNAME_KEY, nickname);
        localStorage.removeItem(PENDING_NICKNAME_KEY);
        window.relayNickname = nickname;
      } else {
        nickname = pendingNickname;
        window.relayNickname = nickname;
      }
    } else if (self && self.nickname !== nickname) {
      nickname = self.nickname;
      localStorage.setItem(NICKNAME_KEY, nickname);
      window.relayNickname = nickname;
    }
    if (document.activeElement !== identityInput) identityButton.textContent = nickname;

    const mine = latestSession.micOwnerId === participantId;
    if (startAfterTakeover && mine && latestSession.micConnected === true) {
      hideTakeover();
    } else if (!startAfterTakeover && takeoverOwnerId && latestSession.micOwnerId !== takeoverOwnerId) {
      hideTakeover({ cancelPrewarm: true });
    }

    publishMicActionState();
    publishPresenceState();
  }

  function publishSessionStatus() {
    if (!latestSession) return;
    window.dispatchEvent(new CustomEvent('relay-session-status', { detail: latestSession }));
  }

  window.addEventListener('relay-request-session-status', publishSessionStatus);

  function handleMessage(message) {
    if (message.type !== 'session-status') return;
    const previousIncarnation = latestSession?.serverIncarnation;
    const nextIncarnation = message.serverIncarnation;
    const sameIncarnation = typeof previousIncarnation === 'string'
      && typeof nextIncarnation === 'string'
      && previousIncarnation === nextIncarnation;
    if (sameIncarnation && Number(message.revision) < Number(latestSession.revision)) return;
    if (
      typeof previousIncarnation === 'string'
      && typeof nextIncarnation === 'string'
      && previousIncarnation !== nextIncarnation
    ) {
      hideTakeover({ cancelPrewarm: true });
    }
    latestSession = message;
    sessionAuthorityFresh = true;
    reconcileSessionState();
    publishSessionStatus();
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch(scheduleReconnect);
    }, RECONNECT_MS);
  }

  async function connect() {
    if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
    sessionAuthorityFresh = false;
    publishMicActionState();
    publishPresenceState();

    const next = new WebSocket(wsUrl());
    socket = next;
    await new Promise((resolve, reject) => {
      next.addEventListener('open', resolve, { once: true });
      next.addEventListener('error', reject, { once: true });
    });

    if (socket !== next) {
      next.close();
      return;
    }

    sessionAuthorityFresh = false;
    publishMicActionState();
    publishPresenceState();

    next.addEventListener('message', (event) => {
      if (socket !== next || typeof event.data !== 'string') return;
      try {
        handleMessage(JSON.parse(event.data));
      } catch {}
    });
    next.addEventListener('close', () => {
      if (socket !== next) return;
      socket = null;
      sessionAuthorityFresh = false;
      publishMicActionState();
      publishPresenceState();
      scheduleReconnect();
    });
    next.addEventListener('error', () => {
      try { next.close(); } catch {}
    });

    sendParticipantAuthentication(next);
    next.send(JSON.stringify({ type: 'session-status-request' }));
    sendPendingRename();
  }

  publisherButton.addEventListener('click', (event) => {
    const state = micActionState();
    if (!state.primaryActionable) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const currentOwner = owner();
    if (!currentOwner || currentOwner.id === participantId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    showTakeover(currentOwner);
  }, true);

  confirmTakeoverButton.addEventListener('click', () => {
    if (!micActionState().takeoverConfirmActionable) return;
    const currentOwner = owner();
    if (!currentOwner || currentOwner.id === participantId) {
      hideTakeover({ cancelPrewarm: true });
      if (!publisherButton.disabled) publisherButton.click();
      return;
    }

    takeoverOwnerId = currentOwner.id;
    startAfterTakeover = true;
    takeoverFailure = null;
    publishMicActionState();
    window.dispatchEvent(new CustomEvent('relay-request-microphone', {
      detail: { takeoverExpectedOwnerId: currentOwner.id },
    }));
  });

  cancelTakeoverButton.addEventListener('click', () => {
    if (!micActionState().takeoverCancelActionable) return;
    hideTakeover({ cancelPrewarm: true });
  });

  releaseButton.addEventListener('click', () => {
    send({ type: 'release-mic' });
    window.dispatchEvent(new CustomEvent('relay-release-microphone'));
  });

  function beginRename() {
    identityInput.value = nickname;
    identityButton.hidden = true;
    identityInput.hidden = false;
    identityInput.focus();
    identityInput.select();
  }

  function cancelRename() {
    identityInput.hidden = true;
    identityButton.hidden = false;
    identityInput.value = nickname;
  }

  function commitRename() {
    const next = normalizeNickname(identityInput.value);
    if (!next) {
      cancelRename();
      return;
    }
    nickname = next;
    pendingNickname = next;
    localStorage.setItem(NICKNAME_KEY, nickname);
    localStorage.setItem(PENDING_NICKNAME_KEY, pendingNickname);
    window.relayNickname = nickname;
    identityButton.textContent = nickname;
    cancelRename();
    sendPendingRename();
  }

  function takeoverFailed(failure) {
    startAfterTakeover = false;
    takeoverFailure = failure;
    publishMicActionState();
  }

  window.addEventListener('relay-microphone-local-state', (event) => {
    localPublisherActive = event.detail?.active === true;
    publishMicActionState();
  });

  window.addEventListener('relay-microphone-start-failed', (event) => {
    if (!startAfterTakeover) return;
    takeoverFailed({
      kind: 'start-failed',
      message: typeof event.detail?.message === 'string' ? event.detail.message : null,
    });
  });

  window.addEventListener('relay-mic-takeover-rejected', (event) => {
    const currentOwner = event.detail?.owner ?? owner();
    takeoverOwnerId = currentOwner?.id ?? null;
    takeoverFailed({
      kind: currentOwner ? 'owner-changed' : 'changed',
      ownerNickname: currentOwner?.nickname ?? null,
    });
  });

  window.addEventListener('relay-mic-busy', (event) => {
    const currentOwner = event.detail?.owner ?? owner();
    if (currentOwner && currentOwner.id !== participantId) showTakeover(currentOwner);
  });

  window.addEventListener('relay-microphone-started', () => {
    if (startAfterTakeover) hideTakeover();
  });

  identityButton.addEventListener('click', beginRename);
  identityInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitRename();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelRename();
    }
  });
  identityInput.addEventListener('blur', commitRename);

  publishMicActionState();
  publishPresenceState();
  connect().catch(scheduleReconnect);
})();