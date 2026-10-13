// The singer's mix controls on the Mic page: what the sliders show, and the
// values the Relay last confirmed. Whether this page may send a change, and
// the command it sends, stay with the publisher session in app.js.

const micGain = document.querySelector('#mic-gain');
const micGainValue = document.querySelector('#mic-gain-value');

const SLIDER_HOLD_MS = 2000;
export const FIXED_SONG_LEVEL = 100;

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
  if (command === null || command === 'set-mix') {
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
    if (!sliderIsBusy(micGain)) micGain.value = String(nextGain);
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
  micGain.disabled = !actionable;
}

/** Calls `onMix` each time the singer moves the Mic gain slider. */
export function listenForSingerInput({ onMix }) {
  micGain.addEventListener('input', () => {
    markSliderTouched(micGain);
    onMix();
  });
  micGain.addEventListener('change', () => markSliderTouched(micGain));
}
