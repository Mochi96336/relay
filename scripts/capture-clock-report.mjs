#!/usr/bin/env node
// Offline diagnosis only; never changes capture or mixer state.
import fs from 'node:fs';

const intervals = [];
for (const file of process.argv.slice(2)) {
  let base = null, previous = null;
  for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
    const r = JSON.parse(line);
    const c = r.captureClock;
    const usable = r.micArriving && c && c.sampleRate > 0
      && [r.captureSenderClockMs, r.capturedSamples, c.contextSeconds,
        c.lastChunkContextSeconds].every(Number.isFinite);
    if (!usable) { base = previous = null; continue; }
    const identity = JSON.stringify([r.serverIncarnation, r.micGeneration, c.sampleRate]);
    const changed = !previous || identity !== previous.identity
      || Date.parse(r.at) - Date.parse(previous.row.at) > 2000
      || r.captureSenderClockMs <= previous.row.captureSenderClockMs
      || r.capturedSamples < previous.row.capturedSamples
      || c.contextSeconds < previous.row.captureClock.contextSeconds;
    if (changed) base = r;
    previous = { identity, row: r };
    const wallMs = r.captureSenderClockMs - base.captureSenderClockMs;
    if (wallMs < 5000) continue;
    const contextMs = (c.contextSeconds - base.captureClock.contextSeconds) * 1000;
    const audioMs = (r.capturedSamples - base.capturedSamples) * 1000 / c.sampleRate;
    const queueMs = Math.max(0, (c.contextSeconds - c.lastChunkContextSeconds) * 1000);
    const diagnosis = queueMs > 400 ? 'worklet-to-page dispatch behind'
      : contextMs / wallMs < .95 ? 'AudioContext clock underfed or interrupted'
      : audioMs < contextMs * .95 ? 'PCM production below AudioContext progress'
      : 'capture keeping up in this interval';
    intervals.push({ file, from: base.at, to: r.at, generation: r.micGeneration,
      wallMs, contextMs, audioMs, queueMs, diagnosis });
    base = r;
  }
}
console.log(JSON.stringify({ intervals,
  note: 'Clock evidence locates the stage; it does not establish a browser, driver, or CPU cause.' }, null, 2));
