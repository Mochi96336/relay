import { probeTimingDiagnostics } from './probe-timing-diagnostics.js';

// Must match src/calibration-probe.ts, which builds the reference the server
// correlates against. Irregular offsets are the point: no shift other than the
// true one lines all three notes up at once, which is exactly the ambiguity
// correlating against a song's own beat cannot escape.
const PROBE_NOTES = [
  { offsetMs: 0, frequencyHz: 1046.5, gain: 0.24 },
  { offsetMs: 125, frequencyHz: 1318.5, gain: 0.27 },
  { offsetMs: 330, frequencyHz: 1568, gain: 0.32 },
];
const PROBE_NOTE_SECONDS = 0.105;

/** Owns pending preparation and scheduled nodes; capture and socket authority stay with the publisher. */
export class CalibrationProbePlayback {
  #pending = null;
  #playback = null;

  constructor({ getCapture, isCurrentCapture, isControlOpen, sendControl, onDisconnected,
    isHidden = () => document.visibilityState === 'hidden',
    nowMs = () => performance.now(), timingDiagnostics = probeTimingDiagnostics,
    warn = (...args) => console.warn(...args),
  }) {
    Object.assign(this, { getCapture, isCurrentCapture, isControlOpen, sendControl,
      onDisconnected, isHidden, nowMs, timingDiagnostics, warn });
  }

  // Server advancement or control disconnect retires preparation only. A probe
  // already acknowledged must still finish so the server can measure it.
  cancelPending() {
    this.#pending = null;
  }

  // Capture/session/background boundaries also silence future-scheduled nodes.
  retire() {
    this.cancelPending();
    this.#retirePlayback();
  }

  #retirePlayback() {
    const playback = this.#playback;
    this.#playback = null;
    if (!playback) return;
    for (const { oscillator, gain } of playback.nodes) {
      try { oscillator?.disconnect(); } catch {}
      try { gain?.disconnect(); } catch {}
      try { oscillator?.stop(); } catch {}
    }
  }

  async play(requestId, leadMs) {
    this.retire();
    const request = {};
    this.#pending = request;
    const receivedAtMs = this.nowMs();
    const { context, sessionEpoch, generation } = this.getCapture();
    const expectedGeneration = generation >>> 0;
    if (
      !context
      || !this.isCurrentCapture(sessionEpoch, expectedGeneration)
      || this.#pending !== request
    ) return;

    let playback;
    try {
      if (this.isHidden()) {
        throw new Error('Phone probe cannot play while the page is hidden.');
      }
      // Mobile Safari may leave resume() pending while a page is suspended. The
      // server can retire this request meanwhile, so every continuation has to
      // re-prove request and capture ownership before it may create audible nodes.
      await context.resume();
      if (
        this.#pending !== request
        || !this.isCurrentCapture(sessionEpoch, expectedGeneration)
        || !this.isControlOpen()
      ) return;
      if (this.getCapture().context !== context) throw new Error('Phone probe AudioContext was replaced.');
      if (this.isHidden()) {
        throw new Error('Phone probe cannot play while the page is hidden.');
      }
      if (context.state !== 'running') {
        throw new Error(`Phone probe AudioContext is ${context.state}.`);
      }

      this.#retirePlayback();
      const scheduledAtMs = this.nowMs();
      const startTime = context.currentTime + leadMs / 1000;
      playback = { nodes: [] };
      this.#playback = playback;
      let remainingNotes = PROBE_NOTES.length;
      for (const note of PROBE_NOTES) {
        const at = startTime + note.offsetMs / 1000;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.frequency.value = note.frequencyHz;
        // A slightly softened attack avoids a sharp test-beep edge. The decay is
        // close to the reference envelope used by the server's correlation.
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(note.gain, at + 0.004);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + PROBE_NOTE_SECONDS);
        oscillator.connect(gain).connect(context.destination);
        playback.nodes.push({ oscillator, gain });
        oscillator.addEventListener('ended', () => {
          remainingNotes -= 1;
          if (remainingNotes === 0 && this.#playback === playback) {
            this.#playback = null;
          }
        }, { once: true });
        oscillator.start(at);
        oscillator.stop(at + PROBE_NOTE_SECONDS);
      }

      // Scheduling the nodes is the irreversible side effect. Retire the local
      // request before acknowledging it so a later status/retry cannot revive the
      // same identity on this page. The separate playback owner remains live
      // until every scheduled node ends or a capture/session boundary retires it.
      if (
        this.#pending !== request
        || !this.isCurrentCapture(sessionEpoch, expectedGeneration)
      ) return;
      this.cancelPending();
      if (!this.isControlOpen()) {
        this.#retirePlayback();
        return;
      }
      const result = this.sendControl({
        type: 'calibration-probe-played',
        target: 'mic',
        requestId,
        // The same truncation framePcm applies. The server compares this against
        // the generation it read off a PCM frame header, which is a uint32.
        generation: expectedGeneration,
        timingDiagnostics: this.timingDiagnostics(context, receivedAtMs, startTime, scheduledAtMs),
      });
      if (!result.sent) {
        this.#retirePlayback();
        if (result.reason === 'disconnected') this.onDisconnected();
      }
    } catch (error) {
      this.warn('phone calibration probe failed', error);
      if (playback && this.#playback === playback) {
        this.#retirePlayback();
      }
      if (
        this.#pending !== request
        || !this.isCurrentCapture(sessionEpoch, expectedGeneration)
      ) return;
      this.cancelPending();
      if (!this.isControlOpen()) return;
      const result = this.sendControl({
        type: 'calibration-probe-failed',
        target: 'mic',
        requestId,
        generation: expectedGeneration,
        reason: error instanceof Error ? error.message : String(error),
      });
      if (!result.sent && result.reason === 'disconnected') this.onDisconnected();
    }
  }
}
