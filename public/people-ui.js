import './live-i18n.js';

const t = (key, vars) => window.relayI18n?.t(key, vars) ?? key;
const menu = document.querySelector('.people-menu');
const summary = menu?.querySelector(':scope > summary');
const participantCount = document.querySelector('#participant-count');
const participantList = document.querySelector('#participant-list');
const identityEditor = menu?.querySelector('.identity-editor');

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
  participantList.after(identityEditor);

  let latestPresence = window.relayPresenceState ?? null;
  let latestSession = latestPresence?.session ?? null;
  let authorityFresh = latestPresence?.authorityFresh === true;
  let hasAuthoritativeSnapshot = Boolean(latestSession);

  function statusCopy(participant) {
    if (!participant.connected) return t('people.status.reconnecting');
    if (participant.id === latestSession?.micOwnerId) {
      return latestSession?.micConnected === false
        ? t('people.status.micReconnecting')
        : t('people.status.singing');
    }
    return t('people.status.online');
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
    ambient.replaceChildren();
    if (!authorityFresh) {
      const dot = document.createElement('span');
      dot.className = 'participant-avatar placeholder';
      ambient.append(dot);
      return;
    }

    const connected = orderedParticipants().filter((participant) => participant.connected);
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
    if (!authorityFresh) return;

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
      const state = document.createElement('span');
      state.textContent = statusCopy(participant);
      copy.append(name, state);
      row.append(avatar, copy);
      participantList.append(row);
    }
  }

  function render() {
    heading.textContent = t('people.inRoom');
    if (!authorityFresh) {
      participantCount.textContent = hasAuthoritativeSnapshot
        ? t('people.reconnecting')
        : t('people.connecting');
    } else {
      const connected = orderedParticipants().filter((participant) => participant.connected).length;
      participantCount.textContent = t('people.online', { count: connected });
    }
    renderAmbient();
    renderList();
  }

  window.addEventListener('relay-presence-state', (event) => {
    latestPresence = event.detail ?? null;
    latestSession = latestPresence?.session ?? null;
    authorityFresh = latestPresence?.authorityFresh === true;
    if (authorityFresh && latestSession) hasAuthoritativeSnapshot = true;
    render();
  });

  window.addEventListener('relay-locale-changed', render);

  render();
  window.dispatchEvent(new Event('relay-request-presence-state'));
}
