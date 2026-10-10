#!/usr/bin/env node
// Offline comparison. Content is the user-confirmed listening reference for this experiment.
import fs from 'node:fs';
import path from 'node:path';

const inputs = process.argv.slice(2);
if (!inputs.length) throw new Error('usage: node scripts/sample-song-shadow-report.mjs observations.jsonl [...]');
const chunks = inputs.map(file => ({ file: path.resolve(file), rows: fs.readFileSync(file, 'utf8').split('\n')
  .filter(Boolean).map(line => JSON.parse(line)).filter(r => 'shadowMs' in r) }));
function quantile(values, p) {
  if (!values.length) return null;
  const v = values.toSorted((a, b) => a - b), position = (v.length - 1) * p;
  const lo = Math.floor(position), hi = Math.ceil(position);
  return Math.round((v[lo] + (v[hi] - v[lo]) * (position - lo)) * 100) / 100;
}
function errorStats(values) {
  const abs = values.map(Math.abs);
  return { n: values.length, signedMedianMs: quantile(values, .5), absoluteMedianMs: quantile(abs, .5),
    absoluteP95Ms: quantile(abs, .95), worstAbsoluteMs: quantile(abs, 1),
    within25Ms: values.length ? Math.round(abs.filter(v => v <= 25).length / values.length * 1000) / 10 : null };
}
function measuredValues(rows) {
  const fields = ['bootMicMs', 'bootBackingMs', 'robotDeltaMs', 'liveBootEstimateMs',
    'referenceMeasurementMs', 'contentLiveTargetMs', 'shadowMs', 'rttHalfMs', 'appliedMs'];
  return Object.fromEntries(fields.map(field => {
    const values = rows.map(r => r[field]).filter(Number.isFinite);
    return [field, { n: values.length, min: quantile(values, 0), median: quantile(values, .5), max: quantile(values, 1) }];
  }));
}
function identity(r) {
  const completed = r.completedBootProbeTimingEvidence;
  const mic = completed?.mic ?? (r.bootProbeTimingEvidence?.mic && r.bootProbeTimingEvidence.mic.latencyMs === r.bootMicMs ? r.bootProbeTimingEvidence.mic : null);
  const backing = completed?.backing ?? (r.bootProbeTimingEvidence?.backing && r.bootProbeTimingEvidence.backing.latencyMs === r.bootBackingMs ? r.bootProbeTimingEvidence.backing : null);
  return JSON.stringify([r.sessionGeneration, r.micGeneration, r.videoId, r.playbackRate,
    r.calibrationKind, r.referenceMeasurementMs, r.calibrationState, r.provisional, r.takeLifecycle ?? 'unknown', r.serverIncarnation ?? null,
    mic?.requestId ?? null, backing?.requestId ?? null,
    r.bootMicMs ?? null, r.bootBackingMs ?? null]);
}
function contentReference(r) {
  if (Object.hasOwn(r, 'contentLiveTargetMs')) return Number.isFinite(r.contentLiveTargetMs) ? r.contentLiveTargetMs : null;
  // Old telemetry cannot distinguish a Content target from an inherited Boot read head.
  if (Number.isFinite(r.bootStoredMs) && Math.abs(r.appliedMs - r.bootStoredMs) < .001) return null;
  return Number.isFinite(r.appliedMs) ? r.appliedMs : null;
}
function eligible(r) {
  return r.fresh && r.playing && r.calibrationKind === 'content' && r.calibrationState === 'complete'
    && r.calibrationStale === false && r.provisional === false
    && contentReference(r) !== null
    && ['stable', 'drift-confirmed'].includes(r.validation?.lastOutcome)
    && Number.isFinite(r.validation?.lastValidationAgeMs) && r.validation.lastValidationAgeMs <= 60000
    && r.validation.baselineLagMs === r.referenceMeasurementMs
    && r.frontierMs === 0 && r.faults?.length === 0
    && Number.isFinite(r.appliedMs) && Math.abs(r.appliedMs - r.requestedMs) < .1
    && r.timelineConnected !== false && r.micArriving !== false && r.backingStreaming !== false
    && !['recording', 'finalizing'].includes(r.takeLifecycle);
}
const segments = [];
for (const chunk of chunks) {
  let group;
  for (const r of chunk.rows) {
    const key = identity(r);
    const previous = group?.rows.at(-1);
    if (!group || group.key !== key || Date.parse(r.at) - Date.parse(previous.at) > 2500) {
      group = { source: chunk.file, key, rows: [] };
      segments.push(group);
    }
    group.rows.push(r);
  }
}
const result = [];
for (const group of segments) {
  const accepted = [], excluded = { ineligible: 0, settling: 0, newGapOrFold: 0 };
  let stableSince = null;
  for (let i = 0; i < group.rows.length; i++) {
    const r = group.rows[i], previous = group.rows[i - 1];
    const gapOrFold = previous && (r.micGapMs > previous.micGapMs || r.backingGapMs > previous.backingGapMs || r.foldCount !== previous.foldCount);
    if (!eligible(r) || gapOrFold) {
      stableSince = null; excluded[gapOrFold ? 'newGapOrFold' : 'ineligible']++; continue;
    }
    const dt = previous ? (Date.parse(r.at) - Date.parse(previous.at)) / 1000 : 0;
    const moving = previous && dt > 0 && Math.abs(r.appliedMs - previous.appliedMs) / dt > 1;
    if (moving) { stableSince = null; excluded.settling++; continue; }
    if (stableSince === null) stableSince = Date.parse(r.at);
    if (Date.parse(r.at) - stableSince < 5000) { excluded.settling++; continue; }
    accepted.push(r);
  }
  const matched = accepted.filter(r => [r.shadowMs, r.liveBootEstimateMs, r.rttHalfMs].every(Number.isFinite));
  const blocks = new Map();
  for (const r of matched) {
    // Non-overlapping 30-second blocks summarize temporal persistence, not independent trials.
    const bucket = Math.floor((Date.parse(r.at) - Date.parse(group.rows[0].at)) / 30000);
    const block = blocks.get(bucket) ?? [];
    block.push(r); blocks.set(bucket, block);
  }
  const summarize = rows => ({
    shadow: errorStats(rows.map(r => r.shadowMs - contentReference(r))),
    boot: errorStats(rows.map(r => r.liveBootEstimateMs - contentReference(r))),
    rtt: errorStats(rows.map(r => r.rttHalfMs - contentReference(r))),
  });
  result.push({ source: group.source, identity: JSON.parse(group.key), from: group.rows[0].at, to: group.rows.at(-1).at,
    samples: group.rows.length, eligibleStableSamples: accepted.length, shadowAvailable: accepted.filter(r => Number.isFinite(r.shadowMs)).length,
    matchedSamples: matched.length, excluded, contentAppliedMs: { min: quantile(accepted.map(r => r.appliedMs), 0),
      median: quantile(accepted.map(r => r.appliedMs), .5), max: quantile(accepted.map(r => r.appliedMs), 1) },
    contentReferenceMs: { min: quantile(accepted.map(contentReference), 0), median: quantile(accepted.map(contentReference), .5), max: quantile(accepted.map(contentReference), 1) },
    targetReferenceSamples: accepted.filter(r => Number.isFinite(r.contentLiveTargetMs)).length,
    ambiguousInheritedBootSamples: group.rows.filter(r => r.calibrationKind === 'content' && contentReference(r) === null).length,
    measurements: measuredValues(matched),
    latestMatchedObservation: matched.at(-1) ?? null,
    errorsVsContent: summarize(matched), blocks30s: [...blocks.values()].filter(b => b.length >= 15).map(b => ({
      from: b[0].at, to: b.at(-1).at, samples: b.length, ...summarize(b),
    })),
  });
}
const eligibleRows = result.filter(s => s.matchedSamples >= 15);
const probes = new Map();
for (const { rows } of chunks) for (const r of rows) {
  for (const side of ['mic', 'backing']) {
    const evidence = r.bootProbeTimingEvidence?.[side];
    if (!evidence) continue;
    const key = JSON.stringify([r.serverIncarnation ?? null, evidence.sessionGeneration, side,
      evidence.captureGeneration, evidence.requestId]);
    const previous = probes.get(key);
    probes.set(key, { side, serverIncarnation: r.serverIncarnation ?? null,
      firstSeen: previous?.firstSeen ?? r.at, lastSeen: r.at, ...evidence });
  }
}
console.log(JSON.stringify({ reference: 'Content live-coordinate target when available; otherwise settled audible Content advance excluding ambiguous inherited Boot values',
  measurementDefinitions: {
    bootMicMs: 'Server correlation of the publisher probe against captured microphone PCM, milliseconds',
    bootBackingMs: 'Server correlation of the Robot probe against captured backing PCM, milliseconds',
    robotDeltaMs: 'Robot player seconds minus projected publisher YouTube seconds, multiplied by 1000',
    liveBootEstimateMs: 'bootMicMs - bootBackingMs + robotDeltaMs / playbackRate',
    referenceMeasurementMs: 'Content correlation lag in reference coordinates; not directly the live advance',
    contentLiveTargetMs: 'Content lag mapped by server into the current live microphone advance',
    shadowMs: 'Server candidate from publisher and Robot sample/song anchors; individual anchors are not retained in these historical rows',
    rttHalfMs: 'Server transport estimate from publisher RTT / 2',
    appliedMs: 'Advance actually applied to the mixer; distinct from each candidate and the Content target',
  },
  bootProbeMeasurements: [...probes.values()],
  filters: 'Content live target or unambiguous audible Content; complete nonprovisional Content with matching baseline and stable/drift-confirmed validation <=60s old; fresh playing streams; no frontier/buffer clamp; idle Take; no new gap/fold; 5s settled read head at <=1ms/s',
  independentTrials: { captures: new Set(eligibleRows.map(s => `${s.identity[9] ?? 'legacy-unknown'}:${s.identity[0]}:${s.identity[1]}`)).size,
    songs: new Set(eligibleRows.map(s => s.identity[2])).size,
    note: 'Samples and 30s blocks are temporally correlated; no independence or significance claim.' },
  segments: result }, null, 2));
