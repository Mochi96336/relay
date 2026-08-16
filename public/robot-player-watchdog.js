const CHECK_INTERVAL_MS = 1_000;
const ERROR_GRACE_MS = 5_000;
const NOT_READY_GRACE_MS = 15_000;
const STALL_GRACE_MS = 12_000;
const RELOAD_WINDOW_MS = 5 * 60_000;
const MAX_RELOADS_PER_WINDOW = 3;
const HISTORY_KEY = 'relay.robot-player-watchdog.reloads';

export function decideRobotPlayerRecovery({
  hasTimeline,
  phonePlaying,
  playerError,
  playerLoaded,
  errorAgeMs,
  notReadyAgeMs,
  stalledForMs,
}) {
  if (!hasTimeline) return null;
  if (playerError && errorAgeMs >= ERROR_GRACE_MS) return 'youtube-player-error';
  if (!playerLoaded && notReadyAgeMs >= NOT_READY_GRACE_MS) return 'youtube-player-not-ready';
  if (phonePlaying && playerLoaded && stalledForMs >= STALL_GRACE_MS) return 'youtube-player-stalled';
  return null;
}

export function trimReloadHistory(history, nowMs) {
  return history.filter((at) => Number.isFinite(at) && nowMs - at < RELOAD_WINDOW_MS);
}

export function reloadBudgetAvailable(history, nowMs) {
  return trimReloadHistory(history, nowMs).length < MAX_RELOADS_PER_WINDOW;
}

export function playerLoadedFromMirrorState(text) {
  const state = String(text).trim().toLowerCase();
  return !/^(?:not loaded|waiting)(?:\s*·|$)/.test(state);
}

function parseClock(text) {
  const match = String(text).match(/^(\d+):(\d{2})\s*\/\s*target/);
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

function readReloadHistory(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.map(Number) : [];
  } catch {
    return [];
  }
}

function installRobotPlayerWatchdog() {
  const robotMode = new URLSearchParams(location.search).get('robot') === '1';
  if (!robotMode) return;

  const stateNode = document.querySelector('#source-state');
  const detailNode = document.querySelector('#source-detail');
  const mirrorState = document.querySelector('#mirror-state');
  const mirrorTimeline = document.querySelector('#mirror-timeline');
  if (!stateNode || !detailNode || !mirrorState || !mirrorTimeline) return;

  let errorSince = null;
  let notReadySince = null;
  let lastProgressAt = performance.now();
  let lastPlayerTime = Number.NaN;
  let exhaustedReported = false;

  const check = () => {
    const now = performance.now();
    const stateText = stateNode.textContent ?? '';
    const detailText = detailNode.textContent ?? '';
    const mirrorText = mirrorState.textContent ?? '';
    const timelineText = mirrorTimeline.textContent ?? '';

    const hasTimeline = /^[\w-]{6,}\s+·\s+phone\s+/i.test(detailText);
    const phonePlaying = /·\s*phone\s+playing\s*·/i.test(`· ${detailText} ·`);
    const playerError = stateText.startsWith('YouTube source error');
    const playerLoaded = playerLoadedFromMirrorState(mirrorText);
    const playerTime = parseClock(timelineText);

    if (playerError) errorSince ??= now;
    else errorSince = null;

    if (hasTimeline && !playerLoaded) notReadySince ??= now;
    else notReadySince = null;

    if (!phonePlaying) {
      lastProgressAt = now;
      lastPlayerTime = playerTime;
    } else if (Number.isFinite(playerTime)) {
      if (!Number.isFinite(lastPlayerTime) || Math.abs(playerTime - lastPlayerTime) >= 1) {
        lastProgressAt = now;
        lastPlayerTime = playerTime;
      }
    }

    const reason = decideRobotPlayerRecovery({
      hasTimeline,
      phonePlaying,
      playerError,
      playerLoaded,
      errorAgeMs: errorSince === null ? 0 : now - errorSince,
      notReadyAgeMs: notReadySince === null ? 0 : now - notReadySince,
      stalledForMs: now - lastProgressAt,
    });
    if (!reason) return;

    const wallNow = Date.now();
    const history = trimReloadHistory(readReloadHistory(sessionStorage), wallNow);
    if (!reloadBudgetAvailable(history, wallNow)) {
      if (!exhaustedReported) {
        exhaustedReported = true;
        console.error(`[robot-watchdog] ${reason}; reload budget exhausted`, history);
      }
      return;
    }

    history.push(wallNow);
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    console.warn(`[robot-watchdog] ${reason}; reloading source page (${history.length}/${MAX_RELOADS_PER_WINDOW})`);
    location.reload();
  };

  const timer = setInterval(check, CHECK_INTERVAL_MS);
  window.addEventListener('beforeunload', () => clearInterval(timer), { once: true });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  installRobotPlayerWatchdog();
}
