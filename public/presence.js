(() => {
  const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;
  const participantCount = document.querySelector('#participant-count');
  const participantList = document.querySelector('#participant-list');
  const identityButton = document.querySelector('#identity-name');
  const identityInput = document.querySelector('#identity-input');
  const releaseButton = document.querySelector('#release-mic');
  const takeoverPanel = document.querySelector('#mic-takeover');
  const takeoverCopy = document.querySelector('#mic-takeover-copy');
  const confirmTakeoverButton = document.querySelector('#confirm-takeover');
  const cancelTakeoverButton = document.querySelector('#cancel-takeover');
  const publisherButton = document.querySelector('#start-publisher');

  if (
    !participantCount || !participantList || !identityButton || !identityInput
    || !releaseButton || !takeoverPanel || !takeoverCopy
    || !confirmTakeoverButton || !cancelTakeoverButton || !publisherButton
  ) return;

  const PARTICIPANT_ID_KEY = 'relay.participantId.v1';
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

  function randomParticipantId() {
    const random = new Uint32Array(4);
    crypto.getRandomValues(random);
    return `participant-${Array.from(random, (value) => value.toString(16).padStart(8, '0')).join('')}`;
  }

  function storedIdentity() {
    let participantId = localStorage.getItem(PARTICIPANT_ID_KEY);
    if (!participantId || !/^[A-Za-z0-9_-]{8,128}$/.test(participantId)) {
      participantId = randomParticipantId();
      localStorage.setItem(PARTICIPANT_ID_KEY, participantId);
    }

    let nickname = normalizeNickname(localStorage.getItem(NICKNAME_KEY));
    if (!nickname) {
      nickname = randomNickname();
      localStorage.setItem(NICKNAME_KEY, nickname);
    }
    return { participantId, nickname };
  }

  let { participantId, nickname } = storedIdentity();
  let pendingNickname = normalizeNickname(localStorage.getItem(PENDING_NICKNAME_KEY));
  if (pendingNickname) {
    nickname = pendingNickname;
    localStorage.setItem(NICKNAME_KEY, nickname);
  }

  let socket = null;
  let reconnectTimer = null;
  let latestSession = null;
  let takeoverOwnerId = null;
  let startAfterTakeover = false;
  let localPublisherActive = window.relayActiveRole === 'publisher';

  // app.js reads these when it opens publisher / monitor transports. Identity
  // is explicit per socket; Relay deliberately does not use an origin-wide
  // cookie that could accidentally turn source.html or robot sockets into a
  // human participant.
  window.relayParticipantId = participantId;
  window.relayNickname = nickname;
  identityButton.textContent = nickname;

  function wsUrl() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const source = new URLSearchParams(location.search);
    const params = new URLSearchParams();
    const key = source.get('key');
    if (key) params.set('key', key);
    params.set('participant', participantId);
    params.set('name', nickname);
    return `${protocol}//${location.host}/ws?${params.toString()}`;
  }

  function participantById(id) {
    return latestSession?.participants?.find((participant) => participant.id === id) ?? null;
  }

  function owner() {
    return participantById(latestSession?.micOwnerId ?? null);
  }

  function updateReleaseVisibility() {
    const serverOwnsMic = latestSession?.micOwnerId === participantId;
    // Local capture starts before publisher registration is accepted. Keep a
    // release path visible during that gap and during control-plane reconnects;
    // server presence alone must not decide whether this phone can stop using
    // its own microphone hardware.
    releaseButton.hidden = !serverOwnsMic && !localPublisherActive;
  }

  function hideTakeover() {
    takeoverOwnerId = null;
    startAfterTakeover = false;
    confirmTakeoverButton.disabled = false;
    takeoverPanel.hidden = true;
  }

  function showTakeover(currentOwner) {
    takeoverOwnerId = currentOwner.id;
    startAfterTakeover = false;
    confirmTakeoverButton.disabled = false;
    takeoverCopy.textContent = t('mic.takeoverPrompt', { name: currentOwner.nickname });
    takeoverPanel.hidden = false;
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

  function renderParticipants() {
    if (!latestSession) {
      updateReleaseVisibility();
      return;
    }

    const connected = latestSession.participants.filter((participant) => participant.connected).length;
    participantCount.textContent = t('people.online', { count: connected });
    participantList.replaceChildren();

    for (const participant of latestSession.participants) {
      const chip = document.createElement('span');
      chip.className = 'participant-chip';
      if (participant.id === latestSession.micOwnerId) chip.classList.add('mic-owner');
      if (!participant.connected) chip.classList.add('reconnecting');

      const marker = participant.id === latestSession.micOwnerId
        ? '🎤'
        : participant.connected ? '●' : '◌';
      const suffix = !participant.connected
        ? ` · ${t('people.reconnectingSuffix')}`
        : participant.id === latestSession.micOwnerId && latestSession.micConnected === false
          ? ` · ${t('people.micReconnectingSuffix')}`
          : '';
      chip.textContent = `${marker} ${participant.nickname}${suffix}`;
      participantList.append(chip);
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
        // The server has not acknowledged the explicit rename yet. Do not let
        // an older session snapshot overwrite the user's pending intent.
        nickname = pendingNickname;
        window.relayNickname = nickname;
      }
    } else if (self && self.nickname !== nickname) {
      nickname = self.nickname;
      localStorage.setItem(NICKNAME_KEY, nickname);
      window.relayNickname = nickname;
    }
    if (document.activeElement !== identityInput) identityButton.textContent = nickname;

    const currentOwner = owner();
    const mine = latestSession.micOwnerId === participantId;
    updateReleaseVisibility();

    if (currentOwner && !mine) {
      publisherButton.dataset.presenceLabel = 'takeover';
      if (!publisherButton.disabled) publisherButton.textContent = t('mic.takeover');
    } else {
      delete publisherButton.dataset.presenceLabel;
      if (!publisherButton.disabled) publisherButton.textContent = t('mic.microphone');
    }

    if (startAfterTakeover && mine && latestSession.micConnected === true) {
      hideTakeover();
    } else if (!startAfterTakeover && takeoverOwnerId && latestSession.micOwnerId !== takeoverOwnerId) {
      hideTakeover();
    }
  }

  function handleMessage(message) {
    if (message.type !== 'session-status') return;
    if (latestSession && Number(message.revision) < Number(latestSession.revision)) return;
    latestSession = message;
    renderParticipants();
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
    participantCount.textContent = latestSession ? participantCount.textContent : t('people.connecting');

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

    next.addEventListener('message', (event) => {
      if (socket !== next || typeof event.data !== 'string') return;
      try {
        handleMessage(JSON.parse(event.data));
      } catch {}
    });
    next.addEventListener('close', () => {
      if (socket !== next) return;
      socket = null;
      participantCount.textContent = t('people.reconnecting');
      scheduleReconnect();
    });
    next.addEventListener('error', () => {
      try { next.close(); } catch {}
    });

    next.send(JSON.stringify({ type: 'session-status-request' }));
    sendPendingRename();
  }

  publisherButton.addEventListener('click', (event) => {
    const currentOwner = owner();
    if (!currentOwner || currentOwner.id === participantId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    showTakeover(currentOwner);
  }, true);

  confirmTakeoverButton.addEventListener('click', () => {
    const currentOwner = owner();
    if (!currentOwner || currentOwner.id === participantId) {
      hideTakeover();
      if (!publisherButton.disabled) publisherButton.click();
      return;
    }

    takeoverOwnerId = currentOwner.id;
    startAfterTakeover = true;
    takeoverCopy.textContent = t('mic.takeoverPreparing', { name: currentOwner.nickname });
    confirmTakeoverButton.disabled = true;
    window.dispatchEvent(new CustomEvent('relay-request-microphone', {
      detail: { takeoverExpectedOwnerId: currentOwner.id },
    }));
  });

  cancelTakeoverButton.addEventListener('click', () => {
    if (startAfterTakeover) return;
    hideTakeover();
  });

  releaseButton.addEventListener('click', () => {
    // Presence may be the only healthy control socket, so keep the idempotent
    // server release here. app.js receives the local event below and tears down
    // capture immediately even when this socket is already disconnected.
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

  function takeoverFailed(copy) {
    startAfterTakeover = false;
    confirmTakeoverButton.disabled = false;
    takeoverCopy.textContent = copy;
    takeoverPanel.hidden = false;
  }

  window.addEventListener('relay-microphone-local-state', (event) => {
    localPublisherActive = event.detail?.active === true;
    updateReleaseVisibility();
  });

  window.addEventListener('relay-microphone-start-failed', (event) => {
    if (!startAfterTakeover) return;
    const message = event.detail?.message ?? t('mic.startFailed');
    takeoverFailed(t('mic.takeoverKept', { message }));
  });

  window.addEventListener('relay-mic-takeover-rejected', (event) => {
    const currentOwner = event.detail?.owner ?? owner();
    takeoverOwnerId = currentOwner?.id ?? null;
    takeoverFailed(currentOwner
      ? t('mic.takeoverChangedOwner', { name: currentOwner.nickname })
      : t('mic.takeoverChanged'));
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

  window.addEventListener('relay-locale-changed', () => {
    renderParticipants();
    const currentOwner = owner();
    if (!takeoverPanel.hidden && currentOwner && currentOwner.id !== participantId) {
      takeoverCopy.textContent = startAfterTakeover
        ? t('mic.takeoverPreparing', { name: currentOwner.nickname })
        : t('mic.takeoverPrompt', { name: currentOwner.nickname });
    }
  });

  updateReleaseVisibility();
  connect().catch(scheduleReconnect);
})();
