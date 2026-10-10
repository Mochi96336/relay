#!/usr/bin/env node
// Read-only observation: no registration, Take commands or alignment mutations.
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const durationSeconds = Number(process.argv[2] ?? 180);
if (!Number.isInteger(durationSeconds) || durationSeconds < 5 || durationSeconds > 3600) {
  throw new Error('duration must be 5..3600 seconds');
}
const output = path.resolve(process.argv[3] ?? `sample-song-shadow-${Date.now()}.jsonl`);
const url = new URL(process.env.RELAY_URL ?? `ws://localhost:${process.env.PORT ?? 3100}/ws`);
if (process.env.RELAY_KEY) url.searchParams.set('key', process.env.RELAY_KEY);
const http = new URL('/statusz', url);
http.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
if (process.env.RELAY_KEY) http.searchParams.set('key', process.env.RELAY_KEY);
const fd = fs.openSync(output, 'wx', 0o600);
const ws = new WebSocket(url);
let timeline, timing, timelineAt = 0, timingAt = 0, stopped = false;
const rows = [];
let takeStatus = null;
let sessionStatus = null;
const start = performance.now();
let busy = false;
function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return Math.round(sorted[Math.floor((sorted.length - 1) * fraction)] * 10) / 10;
}
function stats(values) {
  return { n: values.length, min: percentile(values, 0), median: percentile(values, .5), max: percentile(values, 1) };
}
function finish(error) {
  if (stopped) return;
  stopped = true;
  clearInterval(timer); clearTimeout(deadline);
  ws.close(); fs.closeSync(fd);
  const segments = new Map();
  for (const r of rows) {
    const key = JSON.stringify([r.sessionGeneration, r.micGeneration, r.videoId, r.playbackRate, r.calibrationKind, r.playing, r.referenceMeasurementMs, r.calibrationState, r.provisional, r.serverIncarnation ?? null]);
    const last = [...segments.values()].at(-1);
    const group = last?.key === key ? last : { key, from: r.at, to: r.at, rows: [] };
    if (group !== last) segments.set(segments.size, group);
    group.to = r.at; group.rows.push(r);
  }
  const report = {
    output, error: error ?? null, samples: rows.length,
    segments: [...segments.values()].map(g => ({ identity: JSON.parse(g.key), from: g.from, to: g.to,
      samples: g.rows.length, validShadow: g.rows.filter(r => r.shadowMs !== null).length,
      shadowMs: stats(g.rows.map(r => r.shadowMs).filter(Number.isFinite)),
      shadowMinusRttMs: stats(g.rows.filter(r => Number.isFinite(r.shadowMs) && Number.isFinite(r.rttHalfMs)).map(r => r.shadowMs - r.rttHalfMs)),
      shadowMinusAppliedMs: stats(g.rows.filter(r => Number.isFinite(r.shadowMs) && Number.isFinite(r.appliedMs)).map(r => r.shadowMs - r.appliedMs)),
      shadowMinusLiveBootMs: stats(g.rows.filter(r => Number.isFinite(r.shadowMs) && Number.isFinite(r.liveBootEstimateMs)).map(r => r.shadowMs - r.liveBootEstimateMs)),
      shadowMinusRobotDeltaMs: stats(g.rows.filter(r => Number.isFinite(r.shadowMs) && Number.isFinite(r.robotDeltaMs)).map(r => r.shadowMs - r.robotDeltaMs / r.playbackRate)),
    })),
  };
  fs.writeFileSync(`${output}.summary.json`, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = error ? 1 : 0;
}
const timer = setInterval(async () => {
  if (busy || stopped || ws.readyState !== WebSocket.OPEN) return;
  busy = true;
  try {
    ws.send(JSON.stringify({ type: 'youtube-timeline-request' }));
    ws.send(JSON.stringify({ type: 'timing-calibration-status-request' }));
    ws.send(JSON.stringify({ type: 'take-status-request' }));
    ws.send(JSON.stringify({ type: 'session-status-request' }));
    const response = await fetch(http, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`statusz HTTP ${response.status}`);
    const status = await response.json();
    if (stopped) return;
    const now = performance.now();
    const fresh = timing && timeline && now - timingAt < 1500 && now - timelineAt < 1500;
    const rate = timeline?.playbackRate;
    const boot = timing?.bootCalibration;
    const row = {
      at: new Date().toISOString(), elapsedMs: Math.round(now - start),
      serverIncarnation: sessionStatus?.serverIncarnation ?? null,
      sessionGeneration: timing?.sessionGeneration ?? null,
      micGeneration: status.audio?.captureAndSender?.captureGeneration ?? null,
      videoId: timeline?.videoId ?? null, playbackRate: rate ?? null, playing: timeline?.state === 1,
      timelineConnected: timeline?.connected ?? false,
      micArriving: status.source?.micArriving ?? false,
      micStreaming: status.source?.micStreaming ?? false,
      micMediaPath: status.source?.micMediaPath ?? null,
      micCaptureGenerationReason: status.audio?.captureAndSender?.captureGenerationReason ?? null,
      micHealthReportAgeMs: status.audio?.captureAndSender?.reportAgeMs ?? null,
      micTransport: status.audio?.captureAndSender?.transport ?? null,
      micReceiverTransport: status.audio?.receiverTransport ?? null,
      backingStreaming: status.source?.backingStreaming ?? false,
      micFrameAgeMs: status.source?.micFrameAgeMs ?? null,
      micHeadroomMs: status.mix?.micHeadroomMs ?? null,
      micCaptureDelivery: status.audio?.micCaptureDelivery ?? null,
      micUplinkBacklog: status.audio?.micUplinkBacklog ?? null,
      captureSenderClockMs: status.audio?.captureAndSender?.capturedAtPerformanceMs ?? null,
      capturedSamples: status.audio?.captureAndSender?.capturedSamples ?? null,
      captureClock: status.audio?.captureAndSender?.captureClock ?? null,
      phaseCorrections: timeline?.phaseCorrections ?? null,
      lastPhaseCorrectionMs: timeline?.lastPhaseCorrectionMs ?? null,
      backingFrameAgeMs: status.source?.backingFrameAgeMs ?? null,
      calibrationKind: timing?.activeCalibrationKind ?? null,
      confirmedCalibrationRevision: timing?.confirmedCalibrationRevision ?? null,
      mixerCalibrationAuthority: timing?.mixerCalibrationAuthority ?? null,
      takeLifecycle: takeStatus?.lifecycle ?? null,
      fresh: !!fresh, timingAgeMs: Math.round(now - timingAt), timelineAgeMs: Math.round(now - timelineAt),
      shadowMs: fresh ? timing.sampleSongFallback?.candidateMs ?? null : null,
      shadowEvidence: fresh ? timing.sampleSongFallback?.evidence ?? null : null,
      shadowSelected: timing?.sampleSongFallback?.selected ?? false,
      shadowActive: timing?.sampleSongFallback?.active ?? false,
      rttHalfMs: fresh ? timeline.transportEstimateMs ?? null : null,
      appliedMs: fresh ? timing.appliedMicAdvanceMs ?? null : null,
      contentLiveTargetMs: fresh && timing.activeCalibrationKind === 'content'
        ? timing.desiredCalibratedMicLagMs ?? null : null,
      calibrationSlewTargetMs: timing?.calibratedMicLagTargetMs ?? null,
      requestedMs: fresh ? timing.requestedMicAdvanceMs ?? null : null,
      referenceMeasurementMs: timing?.micLagMs ?? null, confidence: timing?.confidence ?? null,
      calibrationState: timing?.state ?? null, calibrationStale: timing?.calibrationStale ?? null,
      provisional: timing?.provisional ?? null,
      bootStoredMs: boot?.advanceMs ?? null, bootMicMs: boot?.micLatencyMs ?? null, bootBackingMs: boot?.backingLatencyMs ?? null,
      robotDeltaMs: timing?.robotPlayerOffsetMs ?? null,
      bootProbeTimingEvidence: timing?.bootProbeTimingEvidence ?? null,
      completedBootProbeTimingEvidence: timing?.completedBootProbeTimingEvidence ?? null,
      robotOffsetTimingEvidence: timing?.robotOffsetTimingEvidence ?? null,
      timelineServerSeconds: timeline?.serverTime ?? null,
      timelineYoutubeSeconds: timeline?.youtubeTime ?? null,
      timelineDifferenceMs: timeline?.differenceMs ?? null,
      liveBootEstimateMs: fresh && boot && Number.isFinite(timing.robotPlayerOffsetMs) && rate > 0
        ? boot.micLatencyMs - boot.backingLatencyMs + timing.robotPlayerOffsetMs / rate : null,
      validation: timing?.validation ?? null,
      frontierMs: status.audio?.timeline?.micFrontierCorrectionMs ?? null,
      foldCount: status.audio?.timeline?.micTimelineFolds ?? null,
      micGapMs: status.mix?.micGapMs ?? null, backingGapMs: status.mix?.backingGapMs ?? null,
      faults: status.faults, warnings: status.warnings,
    };
    rows.push(row); fs.writeSync(fd, JSON.stringify(row) + '\n');
  } catch (error) {
    if (stopped) return;
    fs.writeSync(fd, JSON.stringify({ at: new Date().toISOString(), error: error.message }) + '\n');
  } finally { busy = false; }
}, 1000);
const deadline = setTimeout(() => finish(rows.length ? null : 'no observations'), durationSeconds * 1000 + 500);
ws.on('message', data => {
  try {
    const m = JSON.parse(data.toString());
    if (m.type === 'take-status') takeStatus = m;
    if (m.type === 'session-status') sessionStatus = m;
    if (m.type === 'youtube-timeline-status') { timeline = m; timelineAt = performance.now(); }
    if (m.type === 'timing-calibration-status') { timing = m; timingAt = performance.now(); }
  } catch { /* Binary or unrelated messages are not evidence. */ }
});
ws.on('error', error => finish(error.message));
process.on('SIGINT', () => finish('interrupted'));
console.error(`Collecting read-only shadow evidence for ${durationSeconds}s into ${output}`);
