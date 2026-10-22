/**
 * Readable rows for the Technical details tabs other than Mic.
 *
 * Each row answers one question in plain words: a value, a one-line note on
 * what it means, and a tone. The raw enums and booleans stay in the Raw tab
 * and in Copy diagnostics. Pure: callers pass the snapshots they already hold
 * and a translator, and render the rows however they like.
 *
 * Inputs, all optional:
 * - product: the pushed product-status
 * - readiness: /readyz
 * - source: the source-status snapshot (alignment the mixer is serving)
 * - statusz: /statusz
 */

import { describeMicAudio } from './mic-diagnostics-model.js';
import { diagnosticsTranslator } from './diagnostics-copy.js';
import { finite, row, signedMs, unknown } from './diagnostics-rows.js';

/** A read-ahead shortfall smaller than this is rounding, not a clamp. */
const SHORTFALL_MS = 5;

const english = diagnosticsTranslator('en');

function reasonsNote(t, reasons) {
  const described = reasons.map((reason) => {
    const key = `diag.reason.${reason}`;
    const text = t(key);
    return text === key ? String(reason) : text;
  });
  return t('diag.overview.missing', { reasons: described.join(t('diag.listSeparator')) });
}

/**
 * The Overview tab: what the room is doing, who is in it, and whether it is
 * ready to sing. Overall health is not repeated here; the System panel heads
 * with it. The Mic's audio row appears only while someone holds the Mic,
 * because the Mic row already says when nobody does.
 */
export function describeOverview({ product, readiness, statusz } = {}, t = english) {
  const rows = [];

  const lifecycle = product?.lifecycle;
  if (['idle', 'ready', 'preparing', 'live', 'recording'].includes(lifecycle)) {
    rows.push(row('lifecycle', t('diag.overview.lifecycle'), t(`diag.overview.lifecycle.${lifecycle}`),
      t(`diag.overview.lifecycle.${lifecycle}Note`)));
  } else {
    rows.push(unknown(t, 'lifecycle', 'diag.overview.lifecycle'));
  }

  const session = describeSession({ product, readiness }, t);
  const sessionRow = (key) => session.find((candidate) => candidate.key === key);
  rows.push(sessionRow('people'), sessionRow('mic'));
  if (statusz?.source?.micConnected !== false) {
    rows.push({ ...describeMicAudio(statusz, t), key: 'micAudio' });
  }
  rows.push(sessionRow('song'), sessionRow('take'));

  if (!readiness) {
    rows.push(unknown(t, 'host', 'diag.overview.host'));
    rows.push(unknown(t, 'session', 'diag.overview.session'));
    return rows;
  }

  const hostReasons = Array.isArray(readiness.reasons) ? readiness.reasons : [];
  rows.push(readiness.ready
    ? row('host', t('diag.overview.host'), t('diag.overview.host.ready'), t('diag.overview.host.readyNote'), 'ok')
    : row('host', t('diag.overview.host'), t('diag.overview.host.notReady'), reasonsNote(t, hostReasons), 'bad'));

  // Session readiness repeats every host reason; name only what it adds.
  // Missing a Mic or a playing song is an ordinary moment, not damage.
  const sessionOnly = (Array.isArray(readiness.sessionReasons) ? readiness.sessionReasons : [])
    .filter((reason) => !hostReasons.includes(reason));
  rows.push(readiness.sessionReady
    ? row('session', t('diag.overview.session'), t('diag.overview.session.ready'),
      t('diag.overview.session.readyNote'), 'ok')
    : row('session', t('diag.overview.session'), t('diag.overview.session.notReady'),
      sessionOnly.length > 0 ? reasonsNote(t, sessionOnly) : ''));
  return rows;
}

export function describeSession({ product, readiness } = {}, t = english) {
  const room = product?.room;
  if (!room) {
    return [
      unknown(t, 'people', 'diag.session.people'),
      unknown(t, 'mic', 'diag.session.mic'),
      unknown(t, 'song', 'diag.session.song'),
      unknown(t, 'take', 'diag.session.take'),
    ];
  }

  const rows = [row('people', t('diag.session.people'),
    t('diag.session.people.value', { count: Number(room.participantCount) || 0 }))];

  const mic = room.mic;
  if (!mic || mic.state === 'free') {
    rows.push(row('mic', t('diag.session.mic'), t('diag.session.mic.free'), t('diag.session.mic.freeNote')));
  } else {
    const tone = mic.state === 'live' ? 'ok' : mic.state === 'starting' ? 'neutral' : 'warn';
    const behind = mic.state === 'interrupted'
      && (product?.issues ?? []).some((issue) => issue?.cause === 'mic-timeline-behind');
    const noteKey = behind ? 'diag.session.mic.behind' : `diag.session.mic.${mic.state}`;
    const note = t(noteKey);
    rows.push(row('mic', t('diag.session.mic'), mic.ownerNickname || t('diag.session.mic.someone'),
      note === noteKey ? '' : note, tone));
  }

  const song = room.song?.state;
  const songTones = { playing: 'ok', unavailable: 'warn' };
  if (song === 'ready' && Number(readiness?.components?.player?.state) === 0) {
    // "Paused or not started" misdescribed a Song that has simply finished.
    rows.push(row('song', t('diag.session.song'), t('diag.session.song.ended')));
  } else if (['empty', 'ready', 'playing', 'handoff', 'unavailable'].includes(song)) {
    const noteKey = `diag.session.song.${song}Note`;
    const note = t(noteKey);
    rows.push(row('song', t('diag.session.song'), t(`diag.session.song.${song}`),
      note === noteKey ? '' : note, songTones[song] ?? 'neutral'));
  } else {
    rows.push(unknown(t, 'song', 'diag.session.song'));
  }

  const take = product?.take?.lifecycle;
  const takeTones = { recording: 'ok', failed: 'warn' };
  rows.push(['idle', 'recording', 'finalizing', 'ready', 'failed'].includes(take)
    ? row('take', t('diag.session.take'), t(`diag.session.take.${take}`), '', takeTones[take] ?? 'neutral')
    : unknown(t, 'take', 'diag.session.take'));
  return rows;
}

/** Connected-and-flowing, connected-but-silent, or not connected. */
function flow(t, key, labelKey, connected, streaming, { flowingNote = '', absent }) {
  if (connected && streaming) return row(key, t(labelKey), t('diag.audio.flowing'), flowingNote, 'ok');
  if (connected) return row(key, t(labelKey), t('diag.audio.silent'), t('diag.audio.silentNote'), 'warn');
  return absent;
}

function backingFlowNote(t, components, statusz) {
  const rate = finite(components.backing?.sampleRate);
  const headroom = finite(statusz?.mix?.backingHeadroomMs);
  if (rate === null) return '';
  return headroom === null
    ? t('diag.audio.backing.flowingNoteNoBuffer', { rate })
    : t('diag.audio.backing.flowingNote', { rate, ms: Math.round(headroom) });
}

export function describeAudio({ readiness, statusz } = {}, t = english) {
  const components = readiness?.components;
  if (!components) {
    return [
      unknown(t, 'route', 'diag.audio.route'),
      unknown(t, 'backing', 'diag.audio.backing'),
      unknown(t, 'mic', 'diag.audio.mic'),
      unknown(t, 'mixer', 'diag.audio.mixer'),
      unknown(t, 'listeners', 'diag.audio.listeners'),
    ];
  }

  const mode = components.route?.mode;
  const rows = [['robot', 'legacy', 'song', 'idle'].includes(mode)
    ? row('route', t('diag.audio.route'), t(`diag.audio.route.${mode}`), t(`diag.audio.route.${mode}Note`))
    : unknown(t, 'route', 'diag.audio.route')];

  const backing = components.backing ?? {};
  rows.push(flow(t, 'backing', 'diag.audio.backing', backing.connected, backing.streaming, {
    flowingNote: backingFlowNote(t, components, statusz),
    // No song route means no song audio is expected.
    absent: row('backing', t('diag.audio.backing'), t('diag.audio.notConnected'), '',
      mode === 'idle' ? 'neutral' : 'bad'),
  }));

  const mic = components.mic ?? {};
  if (mic.connected && !mic.streaming && mic.arriving === true) {
    rows.push(row('mic', t('diag.audio.mic'), t('diag.audio.late'), t('diag.audio.lateNote'), 'warn'));
  } else {
    rows.push(flow(t, 'mic', 'diag.audio.mic', mic.connected, mic.streaming, {
      absent: row('mic', t('diag.audio.mic'), t('diag.audio.mic.none')),
    }));
  }

  const clipped = finite(statusz?.mix?.clippedSamples);
  if (components.session?.active) {
    rows.push(row(
      'mixer',
      t('diag.audio.mixer'),
      t('diag.audio.mixer.running'),
      // Only a clip is news. The limiter and summing headroom exist so the
      // final mix never clips; "no clipping" beside a Mic-too-loud warning
      // read as a contradiction.
      clipped !== null && clipped > 0
        ? t('diag.audio.mixer.clipped', { count: Math.round(clipped) })
        : t(mixerNoteKey(Boolean(mic.streaming), Number(components.player?.state) === 1)),
      clipped !== null && clipped > 0 ? 'warn' : 'ok',
    ));
  } else {
    rows.push(row('mixer', t('diag.audio.mixer'), t('diag.audio.mixer.stopped'), t('diag.audio.mixer.stoppedNote')));
  }

  const dropped = finite(statusz?.mix?.monitorRecentDroppedFrames);
  const listeners = finite(statusz?.mix?.monitorRecentDroppingListeners) ?? 0;
  if (dropped === null) {
    rows.push(unknown(t, 'listeners', 'diag.audio.listeners'));
  } else if (dropped > 0) {
    rows.push(row('listeners', t('diag.audio.listeners'),
      t('diag.audio.listeners.dropping', { count: Math.round(dropped) }),
      t('diag.audio.listeners.droppingNote', { listeners: Math.max(1, Math.round(listeners)) }), 'warn'));
  } else {
    rows.push(row('listeners', t('diag.audio.listeners'), t('diag.audio.listeners.clean'),
      t('diag.audio.listeners.cleanNote'), 'ok'));
  }
  return rows;
}

/** What the running mixer is actually mixing, not what it could mix. */
function mixerNoteKey(voice, song) {
  if (voice && song) return 'diag.audio.mixer.runningNote';
  if (voice) return 'diag.audio.mixer.voiceNote';
  if (song) return 'diag.audio.mixer.songNote';
  return 'diag.audio.mixer.idleNote';
}

const ALIGNMENT_TONES = {
  idle: 'neutral',
  calibrating: 'neutral',
  aligned: 'ok',
  fallback: 'warn',
  stale: 'warn',
  clamped: 'bad',
};

/**
 * Why the serving read-ahead differs from the one alignment asked for.
 *
 * AudioSession clamps the request to the configured buffers first, then holds
 * the read head back by the live Mic frontier correction when Mic audio has
 * not arrived that far yet. Those are different faults with different repairs
 * (a larger prebuffer or history vs a fresh Mic capture), so they are reported
 * apart. `short` is signed: positive means the voice plays later than it
 * should, negative earlier.
 */
function readAheadShortfall(source) {
  const applied = finite(source?.appliedMicAdvanceMs);
  const requested = finite(source?.requestedMicAdvanceMs);
  if (applied === null || requested === null) return null;
  const frontier = Math.max(0, finite(source.micFrontierCorrectionMs) ?? 0);
  const short = requested - applied;
  const budgetShort = short - frontier;
  return {
    requested,
    applied,
    short,
    frontier,
    /** What the buffers alone allowed, before the frontier hold-back. */
    budgeted: applied + frontier,
    bufferLimited: Math.abs(budgetShort) >= SHORTFALL_MS,
    // The same line product issues draw for `mic-frontier-lagging`.
    frontierLimited: frontier >= 0.5,
  };
}

function clampCause(shortfall) {
  if (!shortfall) return null;
  if (shortfall.bufferLimited && shortfall.frontierLimited) return 'both';
  if (shortfall.bufferLimited) return 'buffer';
  if (shortfall.frontierLimited) return 'frontier';
  return null;
}

/**
 * How the voice delay compensation adds up, as one line for whichever method
 * owns it. `result` is what the method asks for now; the mixer may still be
 * holding or easing toward it, which the caller says beside the line.
 */
function timingFormula(timing, timeline, source, t) {
  if (!timing) return null;
  const ms = (v) => signedMs(Number(v));
  const rate = finite(timeline?.playbackRate) > 0 ? Number(timeline.playbackRate) : 1;
  const playing = timeline?.connected === true && Number(timeline.state) === 1;
  const robotRoute = source?.robotRoute === true || timing.robotRoute === true;
  const freshShift = timing.robotDeltaFresh === true && finite(timing.robotPlayerOffsetMs) !== null
    ? Number(timing.robotPlayerOffsetMs) / rate : null;

  if ((source?.timingMode ?? timing.timingMode) !== 'acoustic-calibration') {
    const estimate = finite(timing.fallbackNetworkMs);
    if (estimate === null) return null;
    const key = timing.sampleSongFallback?.active ? 'diag.timing.formula.sampleSong' : 'diag.timing.formula.transport';
    return { text: t(key, { result: ms(estimate) }), result: estimate };
  }

  // The same method the Method row names.
  const kind = source?.activeCalibrationKind ?? timing.activeCalibrationKind ?? timing.calibrationKind;
  if (kind === 'content') {
    const measured = finite(timing.micLagMs);
    if (measured === null) return null;
    if (!robotRoute) return { text: t('diag.timing.formula.measured', { result: ms(measured) }), result: measured };
    const live = finite(timing.desiredCalibratedMicLagMs);
    const held = live === null && timing.mixerCalibrationAuthority?.kind === 'content'
      ? finite(timing.calibratedMicLagTargetMs) : null;
    const result = live ?? held;
    if (result === null) return null;
    return {
      text: t('diag.timing.formula.content', { measured: ms(measured), shift: ms(result - measured), result: ms(result) }),
      result,
      held: live === null,
    };
  }

  const boot = timing.bootCalibration;
  const mic = finite(boot?.micLatencyMs), song = finite(boot?.backingLatencyMs);
  if (kind !== 'boot-probe' || mic === null || song === null) return null;
  const name = typeof timing.bootCalibrationMic?.nickname === 'string'
    ? t('diag.cal.pathMicOf', { name: timing.bootCalibrationMic.nickname }) : 'Mic';
  const path = { mic: name, micMs: `${Math.round(mic)} ms`, songMs: `${Math.round(song)} ms` };
  if (!robotRoute || !playing) {
    return { text: t('diag.timing.formula.bootPath', { ...path, result: ms(mic - song) }), result: mic - song };
  }
  const storedShift = finite(boot.deltaMs) === null ? null : Number(boot.deltaMs) / rate;
  const shift = freshShift ?? storedShift;
  if (shift === null) return null;
  const result = mic - song + shift;
  return {
    text: t('diag.timing.formula.boot', { ...path, shift: ms(shift), result: ms(result) }),
    result,
    held: freshShift === null,
  };
}

export function describeTiming({ product, readiness, source, timing, timeline } = {}, t = english) {
  const rows = [];
  const shortfall = source ? readAheadShortfall(source) : null;

  const state = product?.timing?.state;
  if (state === 'clamped') {
    const cause = clampCause(shortfall);
    const key = cause ? `diag.timing.alignment.clamped.${cause}` : 'diag.timing.alignment.clamped';
    rows.push(row('alignment', t('diag.timing.alignment'), t(key), t(`${key}Note`), 'bad'));
  } else {
    rows.push(Object.hasOwn(ALIGNMENT_TONES, state)
      ? row('alignment', t('diag.timing.alignment'), t(`diag.timing.alignment.${state}`),
        t(`diag.timing.alignment.${state}Note`), ALIGNMENT_TONES[state])
      : unknown(t, 'alignment', 'diag.timing.alignment'));
  }

  if (!source) {
    rows.push(unknown(t, 'method', 'diag.timing.method'));
    rows.push(unknown(t, 'offset', 'diag.timing.offset'));
  } else if (source.micConnected === false) {
    // Without a Mic there is no voice to place; these rows only added noise.
  } else {
    if (source.timingMode === 'acoustic-calibration') {
      const kind = source.activeCalibrationKind ?? source.calibrationKind;
      const kindKey = `diag.timing.method.${kind}`;
      const kindNote = t(kindKey);
      // Name the method itself: "Measured" right under an aligned verdict
      // said the same thing twice.
      const kindValue = t(`${kindKey}.value`);
      rows.push(row('method', t('diag.timing.method'),
        kindValue === `${kindKey}.value` ? t('diag.timing.method.measured') : kindValue,
        kindNote === kindKey ? t('diag.timing.method.other') : kindNote, 'ok'));
    } else {
      rows.push(row('method', t('diag.timing.method'), t(timing?.sampleSongFallback?.active ? 'diag.timing.shadow' : 'diag.timing.method.estimate'),
        t(timing?.sampleSongFallback?.active ? 'diag.timing.shadowActive' : 'diag.timing.method.estimateNote')));
    }

    const applied = finite(source.appliedMicAdvanceMs);
    if (applied === null) {
      rows.push(unknown(t, 'offset', 'diag.timing.offset'));
    } else if (shortfall && Math.abs(shortfall.short) >= SHORTFALL_MS) {
      // Say what a person hears, and why. The requested and applied numbers
      // stay in the calibration measurements below.
      const notes = [];
      if (shortfall.bufferLimited) {
        notes.push(t(shortfall.budgeted >= 0 ? 'diag.timing.offset.bufferAhead' : 'diag.timing.offset.bufferBehind', {
          limit: Math.round(Math.abs(shortfall.budgeted)),
        }));
      }
      if (shortfall.frontierLimited) {
        notes.push(t('diag.timing.offset.frontier', { ms: Math.round(shortfall.frontier) }));
      }
      const effect = t(shortfall.short > 0 ? 'diag.timing.offset.late' : 'diag.timing.offset.early', {
        ms: Math.round(Math.abs(shortfall.short)),
      });
      rows.push(row('offset', t('diag.timing.offset'), effect, notes.join(t('diag.sentenceGap')), 'bad'));
    } else {
      rows.push(row('offset', t('diag.timing.offset'), `${Math.round(applied)} ms`, t('diag.timing.offset.note')));
    }

    // Live no longer offers fine tune; a value can only remain from an older
    // page, and then it still shifts the voice, so show it only then.
    const fineTune = finite(source.vocalFineTuneMs) ?? 0;
    if (Math.abs(fineTune) >= 0.5) {
      rows.push(row('fineTune', t('diag.timing.fineTune'), signedMs(fineTune), t('diag.timing.fineTune.note'), 'warn'));
    }
    const formula = timingFormula(timing, timeline, source, t);
    if (formula) {
      const note = applied !== null && Math.abs(formula.result - (applied + fineTune)) >= 1
        ? t('diag.timing.formula.settling')
        : formula.held ? t('diag.timing.formula.held') : '';
      rows.push(row('formula', t('diag.timing.formula'), formula.text, note));
    }
  }

  const player = readiness?.components?.player;
  if (!player) {
    rows.push(unknown(t, 'clock', 'diag.timing.clock'));
  } else {
    rows.push(player.timelineConnected
      ? row('clock', t('diag.timing.clock'), t('diag.timing.clock.connected'), t('diag.timing.clock.connectedNote'), 'ok')
      : row('clock', t('diag.timing.clock'), t('diag.timing.clock.disconnected'), t('diag.timing.clock.disconnectedNote')));
  }

  // Only the Robot route measures a player delta; elsewhere the row would
  // describe equipment the room is not using.
  if (source?.robotRoute) {
    const offset = finite(player?.offsetMs);
    const songPlaying = Boolean(player?.timelineConnected) && Number(player?.state) === 1;
    const label = t('diag.timing.robotDelta');
    if (!songPlaying) {
      // The Robot reports a position only while the song plays; out of date
      // with nothing playing was a warning about nothing.
      rows.push(row('robotDelta', label, t('diag.timing.robotDelta.idle'), t('diag.timing.robotDelta.idleNote')));
    } else if (source.robotDeltaFresh) {
      rows.push(row('robotDelta', label, t('diag.timing.robotDelta.fresh'),
        offset === null ? '' : t('diag.timing.robotDelta.freshNote', { ms: Math.round(offset) }), 'ok'));
    } else {
      rows.push(row('robotDelta', label, t('diag.timing.robotDelta.stale'), t('diag.timing.robotDelta.staleNote'), 'warn'));
    }
  }
  if (timeline) {
    // One row: the phone, room and Robot positions agree to milliseconds and
    // only flickered as three rows. How far the Robot's player sits from the
    // room is what timing uses; it is in the player offset and robotDelta.
    const connected = timeline.connected === true;
    const position = finite(timeline.serverTime);
    const clock = position === null ? null
      : `${Math.floor(position / 60)}:${String(Math.floor(position % 60)).padStart(2, '0')}`;
    const stateKeys = { '-1': 'unstarted', 0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'cued' };
    const stateName = stateKeys[timeline.state];
    const parts = [stateName ? t(`diag.timing.ytState.${stateName}`) : '—',
      finite(timeline.playbackRate) === null ? '—' : `${timeline.playbackRate}×`];
    if (clock) parts.push(clock);
    rows.push(row('youtubeRate', t('diag.timing.ytRate'),
      connected ? parts.join(' · ') : t('diag.timing.clock.disconnected')));
  }
  if (timing) {
    const value = (v) => finite(v) === null ? '—' : signedMs(Number(v));
    const fallback = timing.sampleSongFallback;
    if (fallback) {
      rows.push(row('shadow', t('diag.timing.shadow'), value(fallback.candidateMs),
        t(fallback.active ? 'diag.timing.shadowActive' : 'diag.timing.shadowStandby')));
    }
  }
  return rows;
}

export function describeRobot({ readiness } = {}, t = english) {
  const components = readiness?.components;
  if (!components) {
    return [
      unknown(t, 'route', 'diag.robot.route'),
      unknown(t, 'source', 'diag.robot.source'),
    ];
  }
  const robot = components.route?.mode === 'robot';
  const rows = [robot
    ? row('route', t('diag.robot.route'), t('diag.robot.route.active'), '', 'ok')
    : row('route', t('diag.robot.route'), t('diag.robot.route.inactive'), t('diag.robot.route.inactiveNote'))];

  rows.push(components.robotSource?.connected
    ? row('source', t('diag.robot.source'), t('diag.robot.source.connected'), t('diag.robot.source.connectedNote'), 'ok')
    : row('source', t('diag.robot.source'), t('diag.robot.source.disconnected'),
      t('diag.robot.source.disconnectedNote'), robot ? 'bad' : 'neutral'));

  // Whether the song audio arrives is the Audio tab's backing row; repeating
  // it here under another name read as a second, different stream. Only a
  // backing that is not the Robot's capture is Robot-specific.
  const backing = components.backing ?? {};
  if (backing.connected && !backing.robot) {
    rows.push(row('backing', t('diag.robot.backing'), t('diag.audio.notConnected'), t('diag.robot.backing.notRobot'),
      robot ? 'bad' : 'neutral'));
  }
  return rows;
}
