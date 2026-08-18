function ensureStyles() {
  if (document.querySelector('link[data-relay-recording-ui]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/recording-ui.css';
  link.dataset.relayRecordingUi = 'true';
  document.head.append(link);
}

const strip = document.querySelector('.take-strip');
const status = document.querySelector('#recording-status');

function chinese() {
  return window.relayI18n?.getLocale?.() === 'zh-Hant';
}

function finishedCopy() {
  return chinese() ? '✓ 錄好了' : '✓ Recording ready';
}

if (strip && status) {
  ensureStyles();

  let lifecycle = 'idle';
  let previousLifecycle = 'idle';
  let finishFlash = false;
  let finishTimer = null;

  function setLifecycle(next) {
    previousLifecycle = lifecycle;
    lifecycle = typeof next === 'string' ? next : 'idle';
    strip.dataset.takeState = lifecycle;
  }

  function showFinishedFlash() {
    finishFlash = true;
    queueMicrotask(() => {
      if (finishFlash && lifecycle === 'ready') status.textContent = finishedCopy();
    });
    if (finishTimer) clearTimeout(finishTimer);
    finishTimer = setTimeout(() => {
      finishTimer = null;
      finishFlash = false;
      if (lifecycle === 'ready' && status.textContent === finishedCopy()) {
        status.textContent = '';
      }
    }, 1_400);
  }

  window.addEventListener('relay-take-status', (event) => {
    const next = String(event.detail?.lifecycle ?? 'idle');
    setLifecycle(next);

    if (
      lifecycle === 'ready'
      && (previousLifecycle === 'recording' || previousLifecycle === 'finalizing')
    ) {
      showFinishedFlash();
      return;
    }

    if (lifecycle !== 'ready') {
      finishFlash = false;
      if (finishTimer) {
        clearTimeout(finishTimer);
        finishTimer = null;
      }
    }
  });

  window.addEventListener('relay-locale-changed', () => {
    if (!finishFlash || lifecycle !== 'ready') return;
    queueMicrotask(() => {
      if (finishFlash && lifecycle === 'ready') status.textContent = finishedCopy();
    });
  });

  strip.dataset.takeState = lifecycle;
}
