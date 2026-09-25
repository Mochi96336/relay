/**
 * Turns Relay's /statusz Mic transport evidence into readable diagnostics.
 *
 * Technical details stay technical, but a person rehearsing on a phone should
 * not need to know what "micHeadroomMs" means to tell whether the voice is
 * reaching the room. Every row therefore carries a plain value, a one-line
 * explanation and a tone. This module is pure: it owns wording and thresholds,
 * never fetching or DOM.
 */

/** Below this much buffered Mic audio, lost packets stop waiting for a resend. */
export const LOW_HEADROOM_MS = 60;
/** Capture clock error small enough to ignore for a whole evening. */
const NEGLIGIBLE_DRIFT_PPM = 20;

const EPISODE_LABELS = {
  'uplink-underfed': 'Too little audio arriving',
  'mix-unplayable': 'Playback hitting gaps',
  'digital-silence': 'Exact digital silence',
};

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function count(value) {
  const number = finite(value);
  return number === null ? 0 : Math.max(0, Math.round(number));
}

function plural(value, one, many = `${one}s`) {
  return `${value} ${value === 1 ? one : many}`;
}

function percent(fraction) {
  return `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

function samplesToMs(samples, sampleRate) {
  return Math.round((count(samples) / (finite(sampleRate) || 48_000)) * 1000);
}

function row(key, label, value, note = '', tone = 'neutral') {
  return { key, label, value, note, tone };
}

const unknown = (key, label) => row(key, label, '—');

export function describeMicAudio(status) {
  const source = status?.source;
  const audio = status?.audio;
  if (!source || !audio) return unknown('audio', 'Mic audio');

  if (!source.micConnected) {
    return row('audio', 'Mic audio', 'No Mic', 'Nobody is holding the Mic right now.');
  }
  if (!source.micStreaming) {
    return row(
      'audio',
      'Mic audio',
      'Not delivering',
      'The Mic is connected, but no audio is arriving at Relay.',
      'bad',
    );
  }

  const audibility = audio.micAudibility;
  const window = audibility?.lastWindow;
  const kinds = (audibility?.activeEpisodes ?? []).map((episode) => episode?.kind);
  if (audibility?.degraded) {
    if (kinds.length > 0 && kinds.every((kind) => kind === 'digital-silence')) {
      return row(
        'audio',
        'Mic audio',
        'Silent input',
        'The phone is sending exact digital silence. If someone is singing, retry the Mic.',
        'warn',
      );
    }
    const missing = window
      ? Math.max(finite(window.missingFraction) ?? 0, 1 - (finite(window.receivedFraction) ?? 1))
      : null;
    return row(
      'audio',
      'Mic audio',
      'Dropping out',
      missing === null
        ? 'Much of the voice is not reaching the room.'
        : `About ${percent(missing)} of the last second did not reach the room.`,
      'warn',
    );
  }

  if (!window) {
    return row('audio', 'Mic audio', 'Starting', 'Waiting for the first second of mixed audio.');
  }
  const received = finite(window.receivedFraction) ?? 0;
  return row(
    'audio',
    'Mic audio',
    'Reaching the room',
    `${percent(Math.min(1, received))} of the last second arrived.`,
    'ok',
  );
}

function describePath(status) {
  const path = status?.audio?.micMediaPath;
  const transport = status?.audio?.captureAndSender?.transport;
  if (!status?.source?.micConnected || !path) return unknown('path', 'Path');

  const retries = count(transport?.webTransportRetries);
  const demotions = count(transport?.webTransportDemotions);
  const history = [];
  if (demotions > 0) history.push(`fell back ${plural(demotions, 'time')}`);
  if (retries > 0) history.push(`retried direct ${plural(retries, 'time')}`);
  const suffix = history.length > 0 ? ` This Mic ${history.join(', ')}.` : '';

  if (path === 'webtransport') {
    return row(
      'path',
      'Path',
      'Direct (WebTransport)',
      `UDP straight to Relay, the best path for live voice.${suffix}`,
      'ok',
    );
  }
  return row(
    'path',
    'Path',
    'Fallback (WebSocket)',
    `Works everywhere, but a network stall briefly holds the voice back.${suffix}`,
    'neutral',
  );
}

function describeLossRepair(status) {
  const receiver = status?.audio?.receiverTransport;
  if (!status?.source?.micConnected || !receiver) return unknown('repair', 'Loss repair');

  const retransmit = status.audio.receiverRetransmit;
  const recovered = count(retransmit?.recoveredPackets);
  const lost = count(receiver.lostPackets);
  const retried = count(retransmit?.retriedPackets);
  const roundTripMs = finite(retransmit?.repairRoundTripMs);
  const concealedMs = count(status.audio.timeline?.micConcealedMs);
  const resendSupported = count(status.audio.captureAndSender?.transport?.retransmitBufferPackets) > 0;

  if (lost === 0 && recovered === 0) {
    return row('repair', 'Loss repair', 'No loss', 'Every Mic packet has arrived so far.', 'ok');
  }
  const notes = [];
  if (recovered > 0) {
    notes.push(`${plural(recovered, 'packet')} resent in time${
      roundTripMs === null ? '' : ` (about ${Math.round(roundTripMs)} ms each)`
    }`);
  }
  if (retried > 0) notes.push(`${plural(retried, 'resend')} had to be asked for twice`);
  if (lost > 0) notes.push(`${plural(lost, 'packet')} lost for good`);
  if (concealedMs > 0) notes.push(`${concealedMs} ms smoothed over`);
  if (!resendSupported) notes.push('this phone page cannot resend; reload it');
  const tone = lost === 0 ? 'ok' : lost > recovered ? 'warn' : 'neutral';
  return row(
    'repair',
    'Loss repair',
    `${recovered} resent · ${lost} lost`,
    `${notes.join(', ')}.`.replace(/^./, (first) => first.toUpperCase()),
    tone,
  );
}

function describeBuffer(status) {
  const headroom = finite(status?.audio?.timeline?.micHeadroomMs);
  if (!status?.source?.micStreaming || headroom === null || !status?.mix?.active) {
    return unknown('buffer', 'Buffer');
  }
  if (headroom < 0) {
    return row(
      'buffer',
      'Buffer',
      `${Math.round(headroom)} ms`,
      'Playback is reaching audio that has not arrived yet; the voice has gaps.',
      'bad',
    );
  }
  if (headroom < LOW_HEADROOM_MS) {
    return row(
      'buffer',
      'Buffer',
      `${Math.round(headroom)} ms`,
      'Very little slack: late packets will be heard as gaps.',
      'warn',
    );
  }
  return row(
    'buffer',
    'Buffer',
    `${Math.round(headroom)} ms`,
    'Mic audio waiting ahead of playback. More slack absorbs network hiccups.',
    'ok',
  );
}

function describePhoneSend(status) {
  const sender = status?.audio?.captureAndSender;
  if (!status?.source?.micConnected || !sender) return unknown('send', 'Phone send');

  const rate = status.audio.micSampleRate;
  const dropped = sender.droppedSamples ?? {};
  const parts = [
    ['network busy', samplesToMs(dropped.congested, rate)],
    ['page stalled', samplesToMs(dropped.captureBacklog, rate)],
    ['while connecting', samplesToMs(dropped.disconnected, rate)],
  ].filter(([, ms]) => ms > 0);
  const totalMs = samplesToMs(dropped.total, rate);
  const transport = sender.transport ?? {};
  const queued = count(transport.webTransportBacklogQueued);
  const smoothed = queued > 0 ? ` ${plural(queued, 'burst packet')} held briefly instead of dropped.` : '';

  if (totalMs === 0) {
    return row('send', 'Phone send', 'No drops', `The phone sent everything it captured.${smoothed}`, 'ok');
  }
  const onlyConnecting = parts.length === 1 && parts[0][0] === 'while connecting';
  const context = onlyConnecting ? ' Normal right after the Mic starts or reconnects.' : '';
  return row(
    'send',
    'Phone send',
    `${totalMs} ms dropped`,
    `${parts.map(([reason, ms]) => `${reason} ${ms} ms`).join(' · ') || 'Dropped before sending'}.${context}${smoothed}`,
    totalMs >= 1000 && !onlyConnecting ? 'warn' : 'neutral',
  );
}

function describePhoneInput(status) {
  const sender = status?.audio?.captureAndSender;
  if (!status?.source?.micConnected || !sender) return unknown('input', 'Phone input');

  if (sender.inputMuted) {
    return row('input', 'Phone input', 'Muted', 'The phone muted its microphone (system or hardware).', 'bad');
  }
  if (sender.inputGapActive) {
    return row('input', 'Phone input', 'No input', 'The phone reports its microphone input is missing.', 'bad');
  }
  const peak = finite(sender.captureLevel?.peakDbfs);
  if (peak === null) return row('input', 'Phone input', 'Live', 'No level reported yet.');
  const value = `${Math.round(peak)} dBFS peak`;
  if (peak <= -90) {
    return row('input', 'Phone input', value, 'Practically no signal from the microphone.', 'warn');
  }
  if (peak >= -1) {
    return row('input', 'Phone input', value, 'Very hot: the loudest moments may be clipping.', 'warn');
  }
  return row('input', 'Phone input', value, 'The microphone is picking up sound.', 'ok');
}

function describeClockDrift(status) {
  if (!status?.source?.micStreaming) return unknown('drift', 'Clock drift');
  const estimate = status?.audio?.timeline?.micClockDrift;
  const ppm = finite(estimate?.ppm);
  if (ppm === null) {
    return row('drift', 'Clock drift', 'Measuring…', 'Needs about a minute of steady Mic audio; shorter samples are too noisy to trust.');
  }
  // Math.round keeps -0.3 from printing as "-0".
  const rounded = Math.round(ppm) || 0;
  const value = `${rounded > 0 ? '+' : ''}${rounded} ppm`;
  if (Math.abs(ppm) < NEGLIGIBLE_DRIFT_PPM) {
    return row('drift', 'Clock drift', value, 'Phone and Relay clocks agree.', 'ok');
  }
  const msPerMinute = (Math.abs(ppm) * 60_000) / 1e6;
  const rate = msPerMinute < 10 ? msPerMinute.toFixed(1) : String(Math.round(msPerMinute));
  return row(
    'drift',
    'Clock drift',
    value,
    ppm > 0
      ? `The phone clock runs slow: the buffer shrinks about ${rate} ms per minute.`
      : `The phone clock runs fast: the voice drifts about ${rate} ms per minute later.`,
    'warn',
  );
}

function describeProblems(status) {
  if (!status?.source?.micConnected) return unknown('problems', 'Now');
  const episodes = status?.audio?.micAudibility?.activeEpisodes ?? [];
  if (episodes.length === 0) return row('problems', 'Now', 'No problems', '', 'ok');
  const described = episodes.map((episode) => {
    const label = EPISODE_LABELS[episode?.kind] ?? String(episode?.kind ?? 'Unknown');
    const seconds = Math.round((finite(episode?.durationMs) ?? 0) / 1000);
    return seconds > 0 ? `${label} for ${seconds} s` : label;
  });
  return row('problems', 'Now', described[0], described.slice(1).join(' · '), 'warn');
}

/** Rows for the Mic diagnostics tab, most important first. */
export function describeMicTransport(status) {
  return [
    describeMicAudio(status),
    describeProblems(status),
    describePath(status),
    describeLossRepair(status),
    describeBuffer(status),
    describePhoneSend(status),
    describePhoneInput(status),
    describeClockDrift(status),
  ];
}
