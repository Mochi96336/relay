/**
 * Turns Relay's /statusz Mic transport evidence into readable diagnostics.
 *
 * Technical details stay technical, but a person rehearsing on a phone should
 * not need to know what "micHeadroomMs" means to tell whether the voice is
 * reaching the room. Every row therefore carries a plain value, a one-line
 * explanation and a tone. This module is pure: it owns wording and thresholds,
 * never fetching or DOM. Copy comes from `t`, English unless a caller passes
 * the page's translator.
 */

import { diagnosticsTranslator, plural } from './diagnostics-copy.js';

/** Below this much buffered Mic audio, lost packets stop waiting for a resend. */
export const LOW_HEADROOM_MS = 60;
/** Capture clock error small enough to ignore for a whole evening. */
const NEGLIGIBLE_DRIFT_PPM = 20;

const english = diagnosticsTranslator('en');

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function count(value) {
  const number = finite(value);
  return number === null ? 0 : Math.max(0, Math.round(number));
}

function percent(fraction) {
  return `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

function samplesToMs(samples, sampleRate) {
  return Math.round((count(samples) / (finite(sampleRate) || 48_000)) * 1000);
}

/** A clause list as one sentence: joined, first letter raised, closed. */
function sentence(t, clauses) {
  const text = clauses.join(t('diag.listSeparator'));
  return t('diag.sentence', { text: text.replace(/^./, (first) => first.toUpperCase()) });
}

function row(key, label, value, note = '', tone = 'neutral') {
  return { key, label, value, note, tone };
}

const unknown = (t, key, labelKey) => row(key, t(labelKey), t('diag.unknown'));

export function describeMicAudio(status, t = english) {
  const label = t('diag.mic.audio');
  const source = status?.source;
  const audio = status?.audio;
  if (!source || !audio) return unknown(t, 'audio', 'diag.mic.audio');

  if (!source.micConnected) {
    return row('audio', label, t('diag.mic.audio.none'), t('diag.mic.audio.noneNote'));
  }
  if (!source.micStreaming) {
    return row(
      'audio',
      label,
      t('diag.mic.audio.notDelivering'),
      t('diag.mic.audio.notDeliveringNote'),
      'bad',
    );
  }

  const audibility = audio.micAudibility;
  const window = audibility?.lastWindow;
  const kinds = (audibility?.activeEpisodes ?? []).map((episode) => episode?.kind);
  if (audibility?.degraded) {
    if (kinds.length > 0 && kinds.every((kind) => kind === 'digital-silence')) {
      return row('audio', label, t('diag.mic.audio.silent'), t('diag.mic.audio.silentNote'), 'warn');
    }
    const missing = window
      ? Math.max(finite(window.missingFraction) ?? 0, 1 - (finite(window.receivedFraction) ?? 1))
      : null;
    return row(
      'audio',
      label,
      t('diag.mic.audio.dropping'),
      missing === null
        ? t('diag.mic.audio.droppingNote')
        : t('diag.mic.audio.droppingShare', { percent: percent(missing) }),
      'warn',
    );
  }

  if (!window) {
    return row('audio', label, t('diag.mic.audio.starting'), t('diag.mic.audio.startingNote'));
  }
  const received = finite(window.receivedFraction) ?? 0;
  return row(
    'audio',
    label,
    t('diag.mic.audio.reaching'),
    t('diag.mic.audio.reachingNote', { percent: percent(Math.min(1, received)) }),
    'ok',
  );
}

function describePath(status, t) {
  const path = status?.audio?.micMediaPath;
  const transport = status?.audio?.captureAndSender?.transport;
  if (!status?.source?.micConnected || !path) return unknown(t, 'path', 'diag.mic.path');

  const retries = count(transport?.webTransportRetries);
  const demotions = count(transport?.webTransportDemotions);
  const history = [];
  if (demotions > 0) history.push(plural(t, 'diag.mic.path.fellBack', demotions));
  if (retries > 0) history.push(plural(t, 'diag.mic.path.retried', retries));
  const suffix = history.length > 0
    ? ` ${t('diag.mic.path.history', { history: history.join(t('diag.listSeparator')) })}`
    : '';

  if (path === 'webtransport') {
    return row(
      'path',
      t('diag.mic.path'),
      t('diag.mic.path.direct'),
      `${t('diag.mic.path.directNote')}${suffix}`,
      'ok',
    );
  }
  return row(
    'path',
    t('diag.mic.path'),
    t('diag.mic.path.fallback'),
    `${t('diag.mic.path.fallbackNote')}${suffix}`,
    'neutral',
  );
}

function describeLossRepair(status, t) {
  const receiver = status?.audio?.receiverTransport;
  if (!status?.source?.micConnected || !receiver) return unknown(t, 'repair', 'diag.mic.repair');

  const label = t('diag.mic.repair');
  const retransmit = status.audio.receiverRetransmit;
  const recovered = count(retransmit?.recoveredPackets);
  const lost = count(receiver.lostPackets);
  const retried = count(retransmit?.retriedPackets);
  const roundTripMs = finite(retransmit?.repairRoundTripMs);
  const concealedMs = count(status.audio.timeline?.micConcealedMs);
  const resendSupported = count(status.audio.captureAndSender?.transport?.retransmitBufferPackets) > 0;

  if (lost === 0 && recovered === 0) {
    return row('repair', label, t('diag.mic.repair.none'), t('diag.mic.repair.noneNote'), 'ok');
  }
  const notes = [];
  if (recovered > 0) {
    const resent = plural(t, 'diag.mic.repair.recovered', recovered);
    notes.push(roundTripMs === null
      ? resent
      : t('diag.mic.repair.roundTrip', { text: resent, ms: Math.round(roundTripMs) }));
  }
  if (retried > 0) notes.push(plural(t, 'diag.mic.repair.retried', retried));
  if (lost > 0) notes.push(plural(t, 'diag.mic.repair.lost', lost));
  if (concealedMs > 0) notes.push(t('diag.mic.repair.concealed', { ms: concealedMs }));
  if (!resendSupported) notes.push(t('diag.mic.repair.cannotResend'));
  const tone = lost === 0 ? 'ok' : lost > recovered ? 'warn' : 'neutral';
  return row(
    'repair',
    label,
    t('diag.mic.repair.value', { recovered, lost }),
    sentence(t, notes),
    tone,
  );
}

function describeBuffer(status, t) {
  const headroom = finite(status?.audio?.timeline?.micHeadroomMs);
  if (!status?.source?.micStreaming || headroom === null || !status?.mix?.active) {
    return unknown(t, 'buffer', 'diag.mic.buffer');
  }
  const label = t('diag.mic.buffer');
  const value = `${Math.round(headroom)} ms`;
  if (headroom < 0) return row('buffer', label, value, t('diag.mic.buffer.negativeNote'), 'bad');
  if (headroom < LOW_HEADROOM_MS) return row('buffer', label, value, t('diag.mic.buffer.lowNote'), 'warn');
  return row('buffer', label, value, t('diag.mic.buffer.okNote'), 'ok');
}

function describeDeviceSend(status, t) {
  const sender = status?.audio?.captureAndSender;
  if (!status?.source?.micConnected || !sender) return unknown(t, 'send', 'diag.mic.send');

  const label = t('diag.mic.send');
  const rate = status.audio.micSampleRate;
  const dropped = sender.droppedSamples ?? {};
  const parts = [
    ['congested', samplesToMs(dropped.congested, rate)],
    ['captureBacklog', samplesToMs(dropped.captureBacklog, rate)],
    ['disconnected', samplesToMs(dropped.disconnected, rate)],
  ].filter(([, ms]) => ms > 0);
  const totalMs = samplesToMs(dropped.total, rate);
  const transport = sender.transport ?? {};
  const queued = count(transport.webTransportBacklogQueued);
  const smoothed = queued > 0 ? ` ${plural(t, 'diag.mic.send.burst', queued)}` : '';

  if (totalMs === 0) {
    return row('send', label, t('diag.mic.send.none'), `${t('diag.mic.send.noneNote')}${smoothed}`, 'ok');
  }
  const onlyConnecting = parts.length === 1 && parts[0][0] === 'disconnected';
  const context = onlyConnecting ? ` ${t('diag.mic.send.connectingNormal')}` : '';
  const described = parts.length > 0
    ? parts.map(([reason, ms]) => t('diag.mic.send.part', {
      reason: t(`diag.mic.send.reason.${reason}`),
      ms,
    })).join(' · ')
    : t('diag.mic.send.unexplained');
  return row(
    'send',
    label,
    t('diag.mic.send.dropped', { ms: totalMs }),
    `${t('diag.sentence', { text: described })}${context}${smoothed}`,
    totalMs >= 1000 && !onlyConnecting ? 'warn' : 'neutral',
  );
}

function describeMicInput(status, t) {
  const sender = status?.audio?.captureAndSender;
  if (!status?.source?.micConnected || !sender) return unknown(t, 'input', 'diag.mic.input');

  const label = t('diag.mic.input');
  if (sender.inputMuted) {
    return row('input', label, t('diag.mic.input.muted'), t('diag.mic.input.mutedNote'), 'bad');
  }
  if (sender.inputGapActive) {
    return row('input', label, t('diag.mic.input.missing'), t('diag.mic.input.missingNote'), 'bad');
  }
  const peak = finite(sender.captureLevel?.peakDbfs);
  if (peak === null) return row('input', label, t('diag.mic.input.live'), t('diag.mic.input.liveNote'));
  const value = t('diag.mic.input.peak', { db: Math.round(peak) });
  if (peak <= -90) return row('input', label, value, t('diag.mic.input.silentNote'), 'warn');
  if (peak >= -1) return row('input', label, value, t('diag.mic.input.hotNote'), 'warn');
  return row('input', label, value, t('diag.mic.input.okNote'), 'ok');
}

function describeClockDrift(status, t) {
  if (!status?.source?.micStreaming) return unknown(t, 'drift', 'diag.mic.drift');
  const label = t('diag.mic.drift');
  const estimate = status?.audio?.timeline?.micClockDrift;
  const ppm = finite(estimate?.ppm);
  if (ppm === null) {
    return row('drift', label, t('diag.mic.drift.measuring'), t('diag.mic.drift.measuringNote'));
  }
  // Math.round keeps -0.3 from printing as "-0".
  const rounded = Math.round(ppm) || 0;
  const value = `${rounded > 0 ? '+' : ''}${rounded} ppm`;
  if (Math.abs(ppm) < NEGLIGIBLE_DRIFT_PPM) {
    return row('drift', label, value, t('diag.mic.drift.agree'), 'ok');
  }
  const trimPpm = finite(status?.audio?.timeline?.micClockTrimPpm);
  if (trimPpm !== null && trimPpm !== 0) {
    return row(
      'drift',
      label,
      value,
      t(ppm > 0 ? 'diag.mic.drift.slowTrimmed' : 'diag.mic.drift.fastTrimmed'),
      'ok',
    );
  }
  const msPerMinute = (Math.abs(ppm) * 60_000) / 1e6;
  const rate = msPerMinute < 10 ? msPerMinute.toFixed(1) : String(Math.round(msPerMinute));
  return row(
    'drift',
    label,
    value,
    t(ppm > 0 ? 'diag.mic.drift.slow' : 'diag.mic.drift.fast', { rate }),
    'warn',
  );
}

function describeProblems(status, t) {
  if (!status?.source?.micConnected) return unknown(t, 'problems', 'diag.mic.problems');
  const label = t('diag.mic.problems');
  const episodes = status?.audio?.micAudibility?.activeEpisodes ?? [];
  if (episodes.length === 0) return row('problems', label, t('diag.mic.problems.none'), '', 'ok');
  const described = episodes.map((episode) => {
    const kind = episode?.kind;
    const episodeLabel = typeof kind === 'string' && t(`diag.mic.episode.${kind}`) !== `diag.mic.episode.${kind}`
      ? t(`diag.mic.episode.${kind}`)
      : String(kind ?? t('diag.mic.episode.unknown'));
    const seconds = Math.round((finite(episode?.durationMs) ?? 0) / 1000);
    return seconds > 0
      ? t('diag.mic.problems.withDuration', { label: episodeLabel, seconds })
      : episodeLabel;
  });
  return row('problems', label, described[0], described.slice(1).join(' · '), 'warn');
}

/** Rows for the Mic diagnostics tab, most important first. */
export function describeMicTransport(status, t = english) {
  return [
    describeMicAudio(status, t),
    describeProblems(status, t),
    describePath(status, t),
    describeLossRepair(status, t),
    describeBuffer(status, t),
    describeDeviceSend(status, t),
    describeMicInput(status, t),
    describeClockDrift(status, t),
  ];
}
