const menu = document.querySelector('.people-menu');
const summary = menu?.querySelector(':scope > summary');
const participantCount = document.querySelector('#participant-count');
const participantList = document.querySelector('#participant-list');
const identityEditor = menu?.querySelector('.identity-editor');

function chinese() {
  return window.relayI18n?.getLocale?.() === 'zh-Hant';
}

function localCopy(english, traditionalChinese) {
  return chinese() ? traditionalChinese : english;
}

function initialFor(nickname) {
  const value = typeof nickname === 'string' ? nickname.trim() : '';
  return Array.from(value)[0]?.toLocaleUpperCase() ?? '•';
}

if (menu && summary && participantCount && participantList && identityEditor) {
  const ambient = document.createElement('span');
  ambient.className = 'participant-ambient';
  ambient.setAttribute('aria-hidden', 'true');
  summary.insertBefore(ambient, participantCount);

  const heading = document.createElement('strong');
  heading.className = 'people-popover-title';
  participantList.before(heading);

  // People is first a room-awareness surface. Keep rename available here, but
  // below the room list so entering the popover answers "who is here?" before
  // exposing identity maintenance.
  participantList.after(identityEditor);

  let latestSession = null;

  function statusCopy(participant) {
    if (!participant.connected) return localCopy('Reconnecting', '重新連線中');
    if (participant.id === latestSession?.micOwnerId) {
      return latestSession?.micConnected === false
        ? localCopy('Mic reconnecting', 'Mic 重新連線中')
        : localCopy('Singing', '正在唱');
    }
    // Presence proves only that this participant is connected. Do not label
    // them "listening" because Listen can be muted or never unlocked locally.
    return localCopy('Online', '在線');
  }

  function orderedParticipants() {
    const participants = Array.isArray(latestSession?.participants)
      ? [...latestSession.participants]
      : [];
    const ownerId = latestSession?.micOwnerId ?? null;
    const selfId = typeof window.relayParticipantId === 'string'
      ? window.relayParticipantId
      : null;
    return participants.sort((a, b) => {
      const rank = (participant) => {
        if (participant.id === ownerId) return 0;
        if (participant.id === selfId) return 1;
        if (participant.connected) return 2;
        return 3;
      };
      return rank(a) - rank(b);
    });
  }

  function renderAmbient() {
    const connected = orderedParticipants().filter((participant) => participant.connected);
    ambient.replaceChildren();

    if (connected.length === 0) {
      const dot = document.createElement('span');
      dot.className = 'participant-avatar placeholder';
      ambient.append(dot);
      return;
    }

    const visible = connected.slice(0, 3);
    for (const participant of visible) {
      const avatar = document.createElement('span');
      avatar.className = 'participant-avatar';
      if (participant.id === latestSession?.micOwnerId) avatar.classList.add('mic-owner');
      avatar.textContent = initialFor(participant.nickname);
      ambient.append(avatar);
    }

    if (connected.length > visible.length) {
      const overflow = document.createElement('span');
      overflow.className = 'participant-avatar overflow';
      overflow.textContent = `+${connected.length - visible.length}`;
      ambient.append(overflow);
    }
  }

  function renderList() {
    participantList.replaceChildren();
    for (const participant of orderedParticipants()) {
      const row = document.createElement('div');
      row.className = 'participant-row';
      if (participant.id === latestSession?.micOwnerId) row.classList.add('mic-owner');
      if (!participant.connected) row.classList.add('reconnecting');

      const avatar = document.createElement('span');
      avatar.className = 'participant-row-avatar';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = initialFor(participant.nickname);

      const copy = document.createElement('span');
      copy.className = 'participant-row-copy';
      const name = document.createElement('strong');
      name.textContent = participant.nickname;
      const status = document.createElement('span');
      status.textContent = statusCopy(participant);
      copy.append(name, status);
      row.append(avatar, copy);
      participantList.append(row);
    }
  }

  function render() {
    heading.textContent = localCopy('In the room', '房間裡');
    renderAmbient();
    renderList();
  }

  window.addEventListener('relay-session-status', (event) => {
    latestSession = event.detail ?? null;
    render();
  });

  // presence.js also localizes its legacy count/list on this event. Defer our
  // presentation projection until all synchronous locale listeners have run so
  // it remains the final visible People surface without taking over presence.
  window.addEventListener('relay-locale-changed', () => queueMicrotask(render));

  // live-ia deliberately loads optional presenters outside its own failure
  // domain. If Presence already published before this module finished loading,
  // ask it to replay the latest authoritative room snapshot; if Presence has
  // not started yet, its normal first snapshot will arrive afterward.
  window.dispatchEvent(new Event('relay-request-session-status'));
  render();
}
