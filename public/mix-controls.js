import { MIC_GAIN_KEY, storeNumber, storedNumber } from './device-preferences.js';

// The singer's mix controls on the Mic page: what the sliders show, and the
// values the Relay last confirmed. Primary changes go through the publisher
// session in app.js; a joined second singer changes its own gain.

const micGain = document.querySelector('#mic-gain');
const micGainValue = document.querySelector('#mic-gain-value');

const SLIDER_HOLD_MS = 2000;
export const FIXED_SONG_LEVEL = 100;

let secondaryActive = false;
let primaryActionable = false;
let secondaryGainTimer = null;
let secondaryGainSentAtMs = Number.NEGATIVE_INFINITY;

let lastKnownControlSnapshot = {
  micGainDb: Number(micGain.value) || 24,
  // The vocal timing the Relay last reported. The Mic page has no control for
  // it; it is part of the confirmed snapshot command authority reads.
  vocalFineTuneMs: 0,
};

export function lastKnownControls() {
  return lastKnownControlSnapshot;
}

export function signed(value, suffix) {
  const number = Number(value);
  return `${number > 0 ? '+' : ''}${number}${suffix}`;
}

// Server broadcasts echo every mix change back to every client. Without this an
// incoming echo rewrites the slider the user is still dragging.
const sliderTouchedAt = new WeakMap();

function markSliderTouched(element) {
  sliderTouchedAt.set(element, performance.now());
}

function sliderIsBusy(element) {
  if (document.activeElement === element) return true;
  const touchedAt = sliderTouchedAt.get(element);
  return touchedAt !== undefined && performance.now() - touchedAt < SLIDER_HOLD_MS;
}

export function updateMixLabels() {
  micGainValue.value = signed(micGain.value, ' dB');
}

export function micGainDb() {
  return Number(micGain.value);
}

export function restoreLastKnownControl(command = null) {
  if (!secondaryActive && (command === null || command === 'set-mix')) {
    micGain.value = String(lastKnownControlSnapshot.micGainDb);
    updateMixLabels();
  }
}

/** A `mix-settings` from the Relay. Returns whether it carried a Mic gain. */
export function acceptMixSettings(message) {
  const nextGain = Number(message.micGainDb ?? 24);
  const accepted = Number.isFinite(nextGain);
  if (accepted) {
    lastKnownControlSnapshot = {
      ...lastKnownControlSnapshot,
      micGainDb: nextGain,
    };
    if (!secondaryActive && !sliderIsBusy(micGain)) micGain.value = String(nextGain);
  }
  updateMixLabels();
  return accepted;
}

/** A `source-status` from the Relay. Returns whether it carried a vocal timing. */
export function acceptVocalFineTune(message) {
  const nextFineTune = Number(message.vocalFineTuneMs);
  if (!Number.isFinite(nextFineTune)) return false;
  lastKnownControlSnapshot = {
    ...lastKnownControlSnapshot,
    vocalFineTuneMs: nextFineTune,
  };
  return true;
}

export function setSingerControlsEnabled(actionable) {
  primaryActionable = actionable;
  micGain.disabled = !(secondaryActive || primaryActionable);
}

/** Routes the shared Mic slider to the microphone held on this device. */
export function listenForSingerInput({ onMix }) {
  micGain.addEventListener('input', () => {
    markSliderTouched(micGain);
    if (secondaryActive) {
      updateMixLabels();
      storeNumber(MIC_GAIN_KEY, micGainDb());
      const waitMs = 100 - (performance.now() - secondaryGainSentAtMs);
      if (waitMs <= 0) sendSecondaryGain();
      else if (!secondaryGainTimer) secondaryGainTimer = setTimeout(sendSecondaryGain, waitMs);
    } else onMix();
  });
  micGain.addEventListener('change', () => {
    markSliderTouched(micGain);
    if (secondaryActive) sendSecondaryGain();
  });
}

// The single Mic rail follows the microphone held on this device. Room mix
// broadcasts still update the primary snapshot without replacing B's gain.
function sendSecondaryGain() {
  clearTimeout(secondaryGainTimer);
  secondaryGainTimer = null;
  if (!secondaryActive) return;
  storeNumber(MIC_GAIN_KEY, micGainDb());
  secondaryGainSentAtMs = performance.now();
  window.dispatchEvent(new CustomEvent('relay-choir-consent-command', {
    detail: { type: 'choir-secondary-gain', micGainDb: micGainDb() },
  }));
}
window.addEventListener('relay-choir-guest-state', (event) => {
  const enabled = event.detail?.enabled === true;
  if (enabled === secondaryActive) return;
  secondaryActive = enabled;
  clearTimeout(secondaryGainTimer);
  secondaryGainTimer = null;
  micGain.value = String(enabled
    ? storedNumber(MIC_GAIN_KEY, 0, 40) ?? 24
    : lastKnownControlSnapshot.micGainDb);
  updateMixLabels();
  setSingerControlsEnabled(primaryActionable);
});
window.dispatchEvent(new Event('relay-request-choir-guest-state'));
