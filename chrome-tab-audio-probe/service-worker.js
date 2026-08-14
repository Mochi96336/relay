const OFFSCREEN_URL = 'offscreen.html';

let activeTabId = null;
let creatingOffscreen = null;

async function ensureOffscreenDocument() {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_URL);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [documentUrl],
  });

  if (contexts.length > 0) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Capture the Relay source tab and forward its rendered audio to the local Relay mixer.',
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

function supportedRelayPage(tab) {
  if (!tab.url) return false;
  try {
    const url = new URL(tab.url);
    return (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
      url.pathname.endsWith('/source.html');
  } catch {
    return false;
  }
}

async function clearBadge(tabId) {
  if (!Number.isInteger(tabId)) return;
  await chrome.action.setBadgeText({ tabId, text: '' });
  await chrome.action.setTitle({ tabId, title: 'Start Relay tab audio source' });
}

async function stopCapture() {
  const tabId = activeTabId;
  activeTabId = null;
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop-capture' }).catch(() => {});
  await clearBadge(tabId);
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!Number.isInteger(tab.id)) return;

  try {
    if (activeTabId !== null) {
      await stopCapture();
      return;
    }

    if (!supportedRelayPage(tab)) {
      await chrome.action.setBadgeText({ tabId: tab.id, text: 'SRC' });
      await chrome.action.setTitle({
        tabId: tab.id,
        title: 'Open http://localhost:3000/source.html and click the extension there.',
      });
      return;
    }

    await ensureOffscreenDocument();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    activeTabId = tab.id;

    await chrome.action.setBadgeText({ tabId: tab.id, text: '…' });
    await chrome.action.setTitle({ tabId: tab.id, title: 'Relay tab source · starting…' });

    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'start-capture',
      streamId,
      tabId: tab.id,
      pageUrl: tab.url,
    });
  } catch (error) {
    console.error('Could not start Relay tab source', error);
    await clearBadge(tab.id);
    activeTabId = null;
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== 'service-worker') return;

  if (message.type === 'relay-state' && message.tabId === activeTabId) {
    const labels = {
      connecting: 'WS',
      sending: 'ON',
      disconnected: 'WS',
      error: 'ERR',
    };
    chrome.action.setBadgeText({ tabId: activeTabId, text: labels[message.state] ?? '…' }).catch(() => {});
    chrome.action.setTitle({
      tabId: activeTabId,
      title: `Relay tab source · ${message.state}`,
    }).catch(() => {});
    return;
  }

  if (message.type === 'audio-level' && message.tabId === activeTabId) {
    const db = Number(message.dbfs);
    const text = Number.isFinite(db) && db > -80 ? String(Math.round(db)) : '--';
    chrome.action.setBadgeText({ tabId: activeTabId, text }).catch(() => {});
    chrome.action.setTitle({
      tabId: activeTabId,
      title: Number.isFinite(db)
        ? `Relay tab source · ${message.sending ? 'sending' : 'not connected'} · ${db.toFixed(1)} dBFS`
        : 'Relay tab source · silence',
    }).catch(() => {});
    return;
  }

  if (message.type === 'capture-ended' && message.tabId === activeTabId) {
    const tabId = activeTabId;
    activeTabId = null;
    clearBadge(tabId).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId) stopCapture().catch(() => {});
});
