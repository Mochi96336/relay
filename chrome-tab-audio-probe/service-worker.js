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
    justification: 'Analyze the audio MediaStream captured from the active tab.',
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function clearBadge(tabId) {
  if (!Number.isInteger(tabId)) return;
  await chrome.action.setBadgeText({ tabId, text: '' });
  await chrome.action.setTitle({ tabId, title: 'Start Relay tab-audio probe' });
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

    await ensureOffscreenDocument();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    activeTabId = tab.id;

    await chrome.action.setBadgeText({ tabId: tab.id, text: '…' });
    await chrome.action.setTitle({ tabId: tab.id, title: 'Relay tab-audio probe · starting…' });

    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'start-capture',
      streamId,
      tabId: tab.id,
    });
  } catch (error) {
    console.error('Could not start tab capture', error);
    await clearBadge(tab.id);
    activeTabId = null;
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== 'service-worker') return;

  if (message.type === 'audio-level' && message.tabId === activeTabId) {
    const db = Number(message.dbfs);
    const text = Number.isFinite(db) && db > -80 ? String(Math.round(db)) : '--';
    chrome.action.setBadgeText({ tabId: activeTabId, text }).catch(() => {});
    chrome.action.setTitle({
      tabId: activeTabId,
      title: Number.isFinite(db)
        ? `Relay tab-audio probe · ${db.toFixed(1)} dBFS`
        : 'Relay tab-audio probe · silence',
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
