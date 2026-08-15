(() => {
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
  const stopButton = document.querySelector('#stop');

  if (
    !participantCount || !participantList || !identityButton || !identityInput
    || !releaseButton || !takeoverPanel || !takeoverCopy
    || !confirmTakeoverButton || !cancelTakeoverButton || !publisherButton || !stopButton
  ) return;

  const PARTICIPANT_ID_KEY = 'relay.participantId.v1';
  const NICKNAME_KEY = 'relay.nickname.v1';
  const RECONNECT_MS = 1_000;
  const adjectives = [
    'Blue', 'Quiet', 'Tiny', 'Silver', 'Mint', 'Soft', 'Bright', 'Lazy',
    'Lucky', 'Warm', 'Swift', 'Night', 'Sunny', 'Mellow', 'Cloud', 'Little',
  ];
  const nouns = [
    'Fox', 'Otter', 'Panda', 'Cat', 'Moth', 'Robin', 'Seal', 'Gecko',
    'Whale', 'Finch', 'Koala', 'Lynx', 'Sparrow', 'Rabbit', 'Dolphin', 'Bear',
  ];

  function randomNickname() {
    const random = new Uint32Array(3);
    crypto.getRandomValues(random);
    return `${adjectives[random[0] % adjectives.length]} ${nouns[random[1] % nouns.length]} ${10 + (random[2] % 90)}`;
  }

  function storedIdentity() {
    let participantId = localStorage.getItem(PARTICIPANT_ID_KEY);
    if (!participantId || !/^[A-Za-z0-9_-]{8,128}$/.test(participantId)) {
      participantId = crypto.randomUUID();
      localStorage.setItem(PARTICIPANT_ID_KEY, participantId);
    }

    let nickname = localStorage.getItem(NICKNAME_KEY)?.replace(/\s+/g, ' ').trim();
    if (!nickname) {
      nickname = randomNickname();
      localStorage.setItem(NICKNAME_KEY, nickname);
    }
    nickname = Array.from(nickname).slice(0, 32).join('');
    return { participantId, nickname };
  }

  let { participantId, nickname } = storedIdentity();
  let socket = null;
  let reconnectTimer = null;
  let latestSession = null;
  let takeoverOwnerId = null;
  let startAfterTakeover = false;

  window.relayParticipantId = participantId;
  window.relayNickname = nickname;

  function setIdentityCookies() {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    const maxAge = 60 * 60 * 24 * 365;
    document.cookie = `relayParticipantId=${encodeURIComponent(participantId)}; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;
    document.cookie = `relayNickname=${encodeURIComponent(nickname)}; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  }

  setIdentityCookies();
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
    takeoverCopy.textContent = `${currentOwner.nickname} 正在使用麥克風。確認後會立即把 Mic 切到你這裡。`;
    takeoverPanel.hidden = false;
  }

  function stopLocalPublisherIfOwnershipMoved() {
    if (window.relayActiveRole !== 'publisher') return;
    if (latestSession?.micOwnerId === participantId) return;
    if (!stopButton.disabled) stopButton.click();
  }

  function renderParticipants() {
    if (!latestSession) return;

    const connected = latestSession.participants.filter((participant) => participant.connected).length;
    participantCount.textContent = `${connected} online`;
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
        ? ' · reconnecting'
        : participant.id === latestSession.micOwnerId && latestSession.micConnected === false
          ? ' · mic reconnecting'
          : '';
      chip.textContent = `${marker} ${participant.nickname}${suffix}`;
      participantList.append(chip);
    }

    const self = participantById(participantId);
    if (self && self.nickname !== nickname) {
      nickname = self.nickname;
      localStorage.setItem(NICKNAME_KEY, nickname);
      window.relayNickname = nickname;
      setIdentityCookies();
    }
    if (document.activeElement !== identityInput) identityButton.textContent = self?.nickname ?? nickname;

    const currentOwner = owner();
    const mine = latestSession.micOwnerId === participantId;
    releaseButton.hidden = !mine;

    if (currentOwner && !mine) {
      publisherButton.dataset.presenceLabel = 'takeover';
      if (!publisherButton.disabled) publisherButton.textContent = '🎤 Take over';
    } else {
      delete publisherButton.dataset.presenceLabel;
      if (!publisherButton.disabled) publisherButton.textContent = '🎤 Microphone';
    }

    if (takeoverOwnerId && latestSession.micOwnerId !== takeoverOwnerId) {
      if (startAfterTakeover && mine) {
        hideTakeover();
        queueMicrotask(() => {
          if (!publisherButton.disabled && window.relayActiveRole !== 'publisher') publisherButton.click();
        });
      } else {
        hideTakeover();
      }
    }

    stopLocalPublisherIfOwnershipMoved();
  }

  function handleMessage(message) {
    if (message.type === 'session-status') {
      if (latestSession && Number(message.revision) < Number(latestSession.revision)) return;
      latestSession = message;
      renderParticipants();
      return;
    }

    if (message.type === 'mic-takeover-rejected') {
      startAfterTakeover = false;
      takeoverOwnerId = null;
      confirmTakeoverButton.disabled = false;
      const currentOwner = message.owner;
      takeoverCopy.textContent = currentOwner
        ? `Mic 已經換成 ${currentOwner.nickname}。如果仍要接手，再按一次 Take over。`
        : 'Mic 狀態已改變；可以直接重新按 Microphone。';
      takeoverPanel.hidden = false;
    }
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
    participantCount.textContent = latestSession ? participantCount.textContent : 'Connecting…';

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

    next.send(JSON.stringify({ type: 'session-status-request' }));
    next.addEventListener('message', (event) => {
      if (socket !== next || typeof event.data !== 'string') return;
      try {
        handleMessage(JSON.parse(event.data));
      } catch {}
    });
    next.addEventListener('close', () => {
      if (socket !== next) return;
      socket = null;
      participantCount.textContent = 'Reconnecting…';
      scheduleReconnect();
    });
    next.addEventListener('error', () => {
      try { next.close(); } catch {}
    });
  }

  function send(payload) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
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
    takeoverCopy.textContent = `正在從 ${currentOwner.nickname} 接手 Mic…`;
    confirmTakeoverButton.disabled = true;
    const sent = send({
      type: 'force-acquire-mic',
      expectedOwnerId: currentOwner.id,
    });
    if (!sent) {
      confirmTakeoverButton.disabled = false;
      startAfterTakeover = false;
      takeoverCopy.textContent = 'Relay 正在重新連線；連上後再確認一次。';
    }
  });

  cancelTakeoverButton.addEventListener('click', () => {
    hideTakeover();
  });

  releaseButton.addEventListener('click', () => {
    send({ type: 'release-mic' });
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
    const next = Array.from(identityInput.value.replace(/\s+/g, ' ').trim()).slice(0, 32).join('');
    if (!next) {
      cancelRename();
      return;
    }
    nickname = next;
    localStorage.setItem(NICKNAME_KEY, nickname);
    window.relayNickname = nickname;
    setIdentityCookies();
    identityButton.textContent = nickname;
    cancelRename();
    send({ type: 'participant-rename', nickname });
  }

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

  connect().catch(scheduleReconnect);
})();
