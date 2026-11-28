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

/**
 * How long a request may wait for its AudioContext before it is no longer this
 * page's to play. The server gives up on an acknowledgement after 3 s and sends
 * the next attempt; a tone that sounded after that would land in the next
 * attempt's capture window and could be measured as its match. A running
 * context resumes at once, so only a suspended page (iOS) ever reaches this.
 */
export const PROBE_RESUME_DEADLINE_MS = 1_000;

/** Owns pending preparation and scheduled nodes; capture and socket authority stay with the publisher. */
export class CalibrationProbePlayback {
  #pending = null;
  #playback = null;

  constructor({ getCapture, isCurrentCapture, isControlOpen, sendControl, onDisconnected,
    nowMs = () => performance.now(), timingDiagnostics = probeTimingDiagnostics,
    warn = (...args) => console.warn(...args),
  }) {
    Object.assign(this, { getCapture, isCurrentCapture, isControlOpen, sendControl,
      onDisconnected, nowMs, timingDiagnostics, warn });
  }

  // Server advancement or control disconnect retires preparation only. A probe
  // already acknowledged must still finish so the server can measure it.
  cancelPending() {
    this.#pending = null;
  }

  retireRequest(requestId) {
    if (this.#pending?.requestId === requestId || this.#playback?.requestId === requestId) this.retire();
  }

  // Capture/session/pagehide boundaries also silence future-scheduled nodes.
  // A hidden page is not one: its context keeps running and its capture keeps
  // sending, so the measurement it takes is as good as a visible page's.
  retire() {
    this.cancelPending();
    this.#retirePlayback();
  }

  #retirePlayback() {
    const playback = this.#playback;
    this.#playback = null;
    if (!playback) return;
    playback.context?.removeEventListener?.('statechange', playback.onStateChange);
    for (const { oscillator, gain } of playback.nodes) {
      try { oscillator?.disconnect(); } catch {}
      try { gain?.disconnect(); } catch {}
      try { oscillator?.stop(); } catch {}
    }
  }

  async play(requestId, leadMs) {
    this.retire();
    const request = { requestId };
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
      // Mobile Safari may leave resume() pending while a page is suspended. The
      // server can retire this request meanwhile, so every continuation has to
      // re-prove request and capture ownership before it may create audible nodes.
      await context.resume();
      if (
        this.#pending !== request
        || !this.isCurrentCapture(sessionEpoch, expectedGeneration)
        || !this.isControlOpen()
      ) return;
      if (this.getCapture().context !== context) throw new Error('Mic probe AudioContext was replaced.');
      if (context.state !== 'running') {
        throw new Error(`Mic probe AudioContext is ${context.state}.`);
      }
      const resumeMs = this.nowMs() - receivedAtMs;
      if (resumeMs > PROBE_RESUME_DEADLINE_MS) {
        throw new Error(`Mic probe AudioContext took ${Math.round(resumeMs)} ms to resume.`);
      }

      this.#retirePlayback();
      const scheduledAtMs = this.nowMs();
      const startTime = context.currentTime + leadMs / 1000;
      playback = { requestId, nodes: [], context, onStateChange: null };
      // A context that stops (iOS suspends a backgrounded page's) would play
      // the remaining notes when it resumes, at a time nothing measures.
      playback.onStateChange = () => {
        if (context.state !== 'running' && this.#playback === playback) this.#retirePlayback();
      };
      context.addEventListener?.('statechange', playback.onStateChange);
      this.#playback = playback;
      let remainingNotes = PROBE_NOTES.length;
      for (const note of PROBE_NOTES) {
        const at = startTime + note.offsetMs / 1000;
        const oscillator = context.createOscillator();
        // Register each resource as soon as it exists. Gain creation, envelope
        // setup and connect can all throw before a complete note is scheduled.
        const nodes = { oscillator, gain: null };
        playback.nodes.push(nodes);
        const gain = nodes.gain = context.createGain();
        oscillator.frequency.value = note.frequencyHz;
        // A slightly softened attack avoids a sharp test-beep edge. The decay is
        // close to the reference envelope used by the server's correlation.
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(note.gain, at + 0.004);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + PROBE_NOTE_SECONDS);
        oscillator.connect(gain).connect(context.destination);
        oscillator.addEventListener('ended', () => {
          remainingNotes -= 1;
          if (remainingNotes === 0 && this.#playback === playback) {
            context.removeEventListener?.('statechange', playback.onStateChange);
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
