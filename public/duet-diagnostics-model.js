/**
 * The second Mic (Choir's B) in Technical details, as a short block beside the
 * main Mic rather than a tab of its own.
 *
 * Only what Relay itself measured for B is shown. B's page reports no device,
 * network or retransmit evidence, so the main Mic's path, repair and device
 * rows have no B counterpart here and are not imitated.
 *
 * Inputs, all optional:
 * - product: the pushed product-status; room.duet names B and its state
 * - statusz: /statusz; audio.duet* is what the server measured for B
 * - source: the source-status snapshot (the main Mic's applied compensation)
 *
 * Every describe* returns null while no second Mic has joined, so a solo room
 * renders exactly as before.
 */

import { diagnosticsTranslator } from './diagnostics-copy.js';

const english = diagnosticsTranslator('en');

/** B's compensation still moving toward its target by at least this much. */
const SETTLING_MS = 5;

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function row(key, label, value, note = '', tone = 'neutral') {
  return { key, label, value, note, tone };
}

function signedDb(db) {
  const rounded = Math.round(db * 10) / 10 || 0;
  return `${rounded > 0 ? '+' : ''}${rounded} dB`;
}

function samplesMs(samples, rate) {
  const count = finite(samples);
  const hz = finite(rate);
  return count === null || hz === null || hz <= 0 ? null : Math.round((count / hz) * 1000);
}

/** Text for a key, or '' when the key has no copy (an enum this page predates). */
function copyOr(t, key, fallback = '') {
  const text = t(key);
  return text === key ? fallback : text;
}

function duetOf(product) {
  const duet = product?.room?.duet;
  return duet && typeof duet === 'object' ? duet : null;
}

function partnerName(duet, t) {
  return typeof duet.secondaryNickname === 'string' && duet.secondaryNickname
    ? duet.secondaryNickname : t('diag.duet.someone');
}

function mainName(product, t) {
  const name = product?.room?.mic?.ownerNickname;
  return typeof name === 'string' && name ? name : t('diag.session.mic.someone');
}

/**
 * Joined, aligning, singing, or stalled. Joining is not singing: the room
 * output carries B only once B is aligned, allowed to sound and B's audio
 * keeps arriving.
 */
function describeState(duet, secondary, t) {
  const label = t('diag.duet.state');
  if (secondary?.audible === true && secondary.recentlyHeard === false) {
    return row('duetState', label, t('diag.duet.state.stalled'), t('diag.duet.state.stalledNote'), 'bad');
  }
  if (duet.state === 'singing') {
    return row('duetState', label, t('diag.duet.state.singing'), t('diag.duet.state.singingNote'), 'ok');
  }
  if (duet.state === 'aligning') {
    return row('duetState', label, t('diag.duet.state.aligning'), t('diag.duet.state.aligningNote'));
  }
  return row('duetState', label, t('diag.duet.state.joined'), t('diag.duet.state.joinedNote'));
}

function describeCodec(ingress, t) {
  if (ingress?.codec === 'opus') {
    return row('duetEncoding', t('diag.mic.encoding'), 'Opus', t('diag.duet.encoding.opusNote'));
  }
  if (ingress?.codec === 'pcm') {
    return row('duetEncoding', t('diag.mic.encoding'), 'PCM16', t('diag.mic.encoding.pcmNote'));
  }
  return null;
}

function describeGaps(secondary, t) {
  const gap = samplesMs(secondary.gapSamples, secondary.sampleRate);
  const starved = samplesMs(secondary.starvedSamples, secondary.sampleRate);
  const label = t('diag.duet.gaps');
  if (gap === null || starved === null) return row('duetGaps', label, t('diag.unknown'));
  const total = gap + starved;
  if (total === 0) return row('duetGaps', label, '0 ms', t('diag.duet.gaps.noneNote'), 'ok');
  // Totals since B entered the mix, like the receiver totals: history, not a
  // current fault. The state row above says whether B is missing right now.
  return row('duetGaps', label, `${total} ms`, t('diag.duet.gaps.note', { gap, starved }));
}

/** The short block under the main Mic's rows. Null without a second Mic. */
export function describeDuetMic({ product, statusz } = {}, t = english) {
  const duet = duetOf(product);
  if (!duet) return null;
  const audio = statusz?.audio ?? {};
  const secondary = audio.duetSecondary ?? null;
  const rows = [describeState(duet, secondary, t), describeCodec(audio.duetIngress, t)];
  if (secondary) {
    const gain = finite(secondary.gainDb);
    rows.push(row('duetGain', t('diag.duet.gain'), gain === null ? t('diag.unknown') : signedDb(gain),
      t('diag.duet.gain.note')));
    rows.push(describeGaps(secondary, t));
  }
  return {
    title: t('diag.duet.title', { name: partnerName(duet, t) }),
    mainTitle: t('diag.duet.mainTitle', { name: mainName(product, t) }),
    rows: rows.filter(Boolean),
    advanced: describeDuetMicAdvanced(audio, t),
  };
}

function describeDuetMicAdvanced(audio, t) {
  const rows = [];
  const ingress = audio.duetIngress;
  if (ingress) {
    const rejected = Object.entries(ingress.rejected ?? {})
      .filter(([, count]) => finite(count) > 0)
      .map(([reason, count]) => `${reason} ×${count}`);
    const accepted = finite(ingress.accepted) ?? 0;
    rows.push(row('duetPackets', t('diag.duet.packets'),
      t('diag.duet.packets.value', { accepted, rejected: rejected.length }),
      rejected.length > 0
        ? t('diag.duet.packets.rejectedNote', { reasons: rejected.join(t('diag.listSeparator')), last: ingress.lastRejected ?? '—' })
        : t('diag.duet.packets.cleanNote'),
      rejected.length > 0 ? 'warn' : 'neutral'));
  }
  const secondary = audio.duetSecondary;
  if (secondary) {
    const buffered = samplesMs(secondary.bufferedSamples, secondary.sampleRate);
    rows.push(row('duetBuffered', t('diag.duet.buffered'),
      buffered === null ? t('diag.unknown') : `${buffered} ms`, t('diag.duet.buffered.note')));
  }
  const room = audio.duetRoom;
  if (room?.state) {
    rows.push(row('duetRoom', t('diag.duet.room'),
      copyOr(t, `diag.duet.room.${room.state}`, String(room.state)), copyOr(t, `diag.duet.room.${room.state}Note`)));
  }
  return rows;
}

/** One singer's Content readiness, as the duet room recorded it. */
function readiness(t, value) {
  return typeof value === 'string' ? copyOr(t, `diag.duet.content.${value}`, value) : '—';
}

/**
 * The main Mic and B side by side on the Timing tab: each singer's
 * compensation and what it rests on. B's comes from the song content of both
 * singers or, until that is measured, from YouTube time, and with no song it
 * follows the main Mic; each is named apart.
 */
export function describeDuetTiming({ product, source, statusz } = {}, t = english) {
  const duet = duetOf(product);
  if (!duet) return null;
  const audio = statusz?.audio ?? {};
  const secondary = audio.duetSecondary ?? null;
  const rows = [];

  const applied = finite(source?.appliedMicAdvanceMs);
  const kind = source?.timingMode === 'acoustic-calibration'
    ? copyOr(t, `diag.timing.method.${source.activeCalibrationKind ?? source.calibrationKind}.value`, t('diag.timing.method.measured'))
    : t('diag.timing.method.estimate');
  rows.push(row('duetMainOffset', t('diag.duet.timing.main', { name: mainName(product, t) }),
    applied === null ? t('diag.unknown') : `${Math.round(applied)} ms`, applied === null ? '' : kind));

  const lag = finite(secondary?.lagMs);
  const target = finite(secondary?.targetLagMs);
  const lagSource = audio.duetYoutube?.lagSource;
  const label = t('diag.duet.timing.second', { name: partnerName(duet, t) });
  if (lag === null && target === null) {
    rows.push(row('duetSecondOffset', label, t('diag.duet.timing.none'), t('diag.duet.timing.noneNote')));
  } else {
    const shown = lag ?? target;
    const notes = [lagSource === 'content' ? t('diag.duet.timing.content')
      : lagSource === 'youtube-time' ? t('diag.duet.timing.youtube')
        : lagSource === 'no-song' ? t('diag.duet.timing.noSong') : t('diag.duet.timing.held')];
    if (lag !== null && target !== null && Math.abs(target - lag) >= SETTLING_MS) {
      notes.push(t('diag.duet.timing.settling', { ms: Math.round(target) }));
    }
    rows.push(row('duetSecondOffset', label, `${Math.round(shown)} ms`, notes.join(t('diag.sentenceGap')),
      lagSource === 'content' ? 'ok' : 'neutral'));
  }

  return { title: t('diag.duet.timing.title'), rows, advanced: describeDuetTimingAdvanced(audio, t) };
}

function describeDuetTimingAdvanced(audio, t) {
  const rows = [];
  const content = audio.duetContent;
  // Each singer's own Content lag in this song; B is placed by their difference.
  const measured = (lagMs) => (finite(lagMs) === null ? 'calibration-required' : 'ready');
  if (content && audio.duetSecondary) {
    rows.push(row('duetReadiness', t('diag.duet.content.readiness'),
      t('diag.duet.content.readiness.value', {
        main: readiness(t, measured(content.primaryLagMs)),
        second: readiness(t, measured(content.secondaryLagMs)),
      }),
      t('diag.duet.content.readiness.note')));
  }
  if (content) {
    const n = (value) => finite(value) ?? 0;
    rows.push(row('duetContent', t('diag.duet.content'),
      t('diag.duet.content.value', { applied: n(content.applied), submitted: n(content.submitted) }),
      content.lastFailureReason
        ? t('diag.duet.content.failedNote', { rejected: n(content.rejected), timedOut: n(content.timedOut), reason: content.lastFailureReason })
        : t('diag.duet.content.note', { rejected: n(content.rejected), timedOut: n(content.timedOut) }),
      content.lastFailureReason ? 'warn' : 'neutral'));
  }
  const youtube = audio.duetYoutube;
  if (youtube) {
    const age = (anchor) => finite(anchor?.ageMs) === null ? '—' : `${(anchor.ageMs / 1000).toFixed(1)} s`;
    rows.push(row('duetAnchors', t('diag.duet.anchors'),
      t('diag.duet.anchors.value', { mic: age(youtube.mic), backing: age(youtube.backing) }),
      t('diag.duet.anchors.note')));
  }
  return rows;
}
