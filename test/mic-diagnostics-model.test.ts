import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { diagnosticsTranslator } from '../public/diagnostics-copy.js';
import { describeMicAudio, describeMicTransport } from '../public/mic-diagnostics-model.js';

type Status = Record<string, any>;

/** A healthy live Mic on the direct path, shaped like /statusz. */
function liveStatus(overrides: (status: Status) => void = () => {}): Status {
  const status: Status = {
    source: { micConnected: true, micStreaming: true },
    mix: { active: true },
    audio: {
      micMediaPath: 'webtransport',
      micSampleRate: 48_000,
      captureAndSender: {
        inputMuted: false,
        inputGapActive: false,
        captureLevel: { peakDbfs: -18, rmsDbfs: -30 },
        droppedSamples: { total: 0, disconnected: 0, congested: 0, packetTooLarge: 0, captureBacklog: 0 },
        transport: {
          webTransportDemotions: 0,
          webTransportRetries: 0,
          webTransportBacklogQueued: 0,
          retransmitBufferPackets: 128,
        },
      },
      receiverTransport: { lostPackets: 0 },
      receiverRetransmit: { requestedPackets: 0, recoveredPackets: 0, budgetDeniedPackets: 0 },
      micAudibility: {
        degraded: false,
        lastWindow: { receivedFraction: 1, missingFraction: 0 },
        activeEpisodes: [],
      },
      timeline: { micHeadroomMs: 180, micConcealedMs: 0, micClockDrift: null },
    },
  };
  overrides(status);
  return status;
}

function rows(status: Status | null) {
  return Object.fromEntries(describeMicTransport(status).map((row) => [row.key, row]));
}

describe('Mic diagnostics model', () => {
  it('says plainly that a healthy Mic is reaching the room', () => {
    const described = rows(liveStatus());
    assert.deepEqual(
      { value: described.audio.value, tone: described.audio.tone },
      { value: 'Reaching the room', tone: 'ok' },
    );
    assert.equal(described.audio.note, '100% of the last second arrived.');
    assert.equal(described.problems.value, 'No problems');
    assert.equal(described.path.value, 'Direct (WebTransport)');
    assert.equal(described.repair.value, 'No loss');
    assert.equal(described.buffer.value, '180 ms');
    assert.equal(described.send.value, 'No drops');
    assert.equal(described.input.value, '-18 dBFS peak');
    assert.equal(described.drift.value, 'Measuring…');
  });

  it('keeps the order a person reads first: verdict, then what is wrong, then why', () => {
    assert.deepEqual(
      describeMicTransport(liveStatus()).map((row) => row.key),
      ['audio', 'level', 'problems', 'path', 'repair', 'buffer', 'send', 'input', 'drift'],
    );
  });

  it('distinguishes no Mic, a Mic that stopped delivering, and a silent capture', () => {
    assert.equal(describeMicAudio(liveStatus((s) => { s.source.micConnected = false; })).value, 'No Mic');

    const stopped = describeMicAudio(liveStatus((s) => { s.source.micStreaming = false; }));
    assert.deepEqual([stopped.value, stopped.tone], ['Not delivering', 'bad']);

    const silent = describeMicAudio(liveStatus((s) => {
      s.audio.micAudibility.degraded = true;
      s.audio.micAudibility.activeEpisodes = [{ kind: 'digital-silence', windows: 6, durationMs: 6_000 }];
    }));
    assert.equal(silent.value, 'Silent input');
    assert.match(silent.note, /retry the Mic/);
  });

  it('quantifies a Mic that is dropping out and names what is going wrong', () => {
    const described = rows(liveStatus((s) => {
      s.audio.micAudibility.degraded = true;
      s.audio.micAudibility.lastWindow = { receivedFraction: 0.7, missingFraction: 0.25 };
      s.audio.micAudibility.activeEpisodes = [
        { kind: 'uplink-underfed', windows: 3, durationMs: 3_000 },
        { kind: 'mix-unplayable', windows: 2, durationMs: 2_000 },
      ];
    }));
    assert.equal(described.audio.value, 'Dropping out');
    assert.equal(described.audio.note, 'About 30% of the last second did not reach the room.');
    assert.equal(described.problems.value, 'Too little audio arriving for 3 s');
    assert.equal(described.problems.note, 'Playback hitting gaps for 2 s');
    assert.equal(described.problems.tone, 'warn');
  });

  it('explains loss repair, including a page that cannot resend', () => {
    const repaired = rows(liveStatus((s) => {
      s.audio.receiverTransport.lostPackets = 2;
      s.audio.receiverRetransmit.recoveredPackets = 40;
      s.audio.timeline.micConcealedMs = 20;
    })).repair;
    assert.equal(repaired.value, '40 resent · 2 lost');
    assert.equal(repaired.note, '40 packets resent in time, 2 packets lost for good, 20 ms smoothed over.');

    const retried = rows(liveStatus((s) => {
      s.audio.receiverTransport.lostPackets = 1;
      s.audio.receiverRetransmit = {
        requestedPackets: 12,
        recoveredPackets: 11,
        budgetDeniedPackets: 0,
        retriedPackets: 3,
        repairRoundTripMs: 84.4,
      };
    })).repair;
    assert.equal(
      retried.note,
      '11 packets resent in time (about 84 ms each), 3 resends had to be asked for twice, 1 packet lost for good.',
    );

    const legacy = rows(liveStatus((s) => {
      s.audio.receiverTransport.lostPackets = 5;
      s.audio.captureAndSender.transport.retransmitBufferPackets = undefined;
    })).repair;
    assert.equal(legacy.tone, 'warn');
    assert.match(legacy.note, /cannot resend; reload it/);
  });

  it('warns before a thin buffer turns into audible gaps', () => {
    assert.equal(rows(liveStatus((s) => { s.audio.timeline.micHeadroomMs = 40; })).buffer.tone, 'warn');
    const starved = rows(liveStatus((s) => { s.audio.timeline.micHeadroomMs = -15; })).buffer;
    assert.deepEqual([starved.value, starved.tone], ['-15 ms', 'bad']);
  });

  it('converts phone-side drops to time and names each reason', () => {
    const send = rows(liveStatus((s) => {
      s.audio.captureAndSender.droppedSamples = {
        total: 4_800 + 9_600,
        congested: 4_800,
        captureBacklog: 9_600,
        disconnected: 0,
        packetTooLarge: 0,
      };
      s.audio.captureAndSender.transport.webTransportBacklogQueued = 12;
    })).send;
    assert.equal(send.value, '300 ms dropped');
    assert.equal(send.note, 'network busy 100 ms · page stalled 200 ms. 12 burst packets held briefly instead of dropped.');
  });

  it('treats drops while the Mic connects as the normal start-up they are', () => {
    const send = rows(liveStatus((s) => {
      s.audio.captureAndSender.droppedSamples = {
        total: 57_600, congested: 0, captureBacklog: 0, disconnected: 57_600, packetTooLarge: 0,
      };
    })).send;
    assert.equal(send.value, '1200 ms dropped');
    assert.equal(send.note, 'while connecting 1200 ms. Normal right after the Mic starts or reconnects.');
    assert.equal(send.tone, 'neutral');
  });

  it('reports path history and phone input state', () => {
    const described = rows(liveStatus((s) => {
      s.audio.micMediaPath = 'websocket';
      s.audio.captureAndSender.transport.webTransportDemotions = 1;
      s.audio.captureAndSender.transport.webTransportRetries = 2;
      s.audio.captureAndSender.inputMuted = true;
    }));
    assert.equal(described.path.value, 'Fallback (WebSocket)');
    assert.match(described.path.note, /This Mic fell back 1 time, retried direct 2 times\./);
    assert.deepEqual([described.input.value, described.input.tone], ['Muted', 'bad']);
  });

  it('turns clock drift into what it does to the performance', () => {
    const slow = rows(liveStatus((s) => { s.audio.timeline.micClockDrift = { ppm: 80, windows: 24, spanMs: 115_000 }; })).drift;
    assert.equal(slow.value, '+80 ppm');
    assert.equal(slow.note, 'The device clock runs slow: the buffer shrinks about 4.8 ms per minute.');
    const fast = rows(liveStatus((s) => { s.audio.timeline.micClockDrift = { ppm: -30, windows: 24, spanMs: 115_000 }; })).drift;
    assert.match(fast.note, /drifts about 1\.8 ms per minute later/);
    const fine = rows(liveStatus((s) => { s.audio.timeline.micClockDrift = { ppm: 4, windows: 24, spanMs: 115_000 }; })).drift;
    assert.deepEqual([fine.value, fine.tone], ['+4 ppm', 'ok']);
    const zero = rows(liveStatus((s) => { s.audio.timeline.micClockDrift = { ppm: -0.3, windows: 24, spanMs: 115_000 }; })).drift;
    assert.equal(zero.value, '0 ppm', 'no signed zero');
  });

  it('says a drifting clock is handled once Relay trims the Mic for it', () => {
    const slow = rows(liveStatus((s) => {
      s.audio.timeline.micClockDrift = { ppm: 80, windows: 24, spanMs: 115_000 };
      s.audio.timeline.micClockTrimPpm = 80;
    })).drift;
    assert.deepEqual(
      [slow.value, slow.note, slow.tone],
      ['+80 ppm', 'The device clock runs slow; Relay stretches the Mic to match.', 'ok'],
    );
    const fast = rows(liveStatus((s) => {
      s.audio.timeline.micClockDrift = { ppm: -30, windows: 24, spanMs: 115_000 };
      s.audio.timeline.micClockTrimPpm = -30;
    })).drift;
    assert.deepEqual(
      [fast.note, fast.tone],
      ['The device clock runs fast; Relay shortens the Mic to match.', 'ok'],
    );
    const untrimmed = rows(liveStatus((s) => {
      s.audio.timeline.micClockDrift = { ppm: 80, windows: 24, spanMs: 115_000 };
      s.audio.timeline.micClockTrimPpm = 0;
    })).drift;
    assert.equal(untrimmed.tone, 'warn');
  });

  it('shows the numbers behind a Mic too loud warning', () => {
    // A real window from the Pi: -17 dBFS raw at the +24 dB default gain.
    const level = (warning: string | null, heavyLimitedMs: number, rawPeakDbfs = -17.07) => rows(liveStatus((s) => {
      s.audio.micLevel = {
        warning,
        lastWindow: { eligible: true, songPlaying: true, heavyLimitedMs, rawPeakDbfs, micGainDb: 24 },
      };
    })).level;

    const loud = level('too-loud', 758.2);
    assert.deepEqual(
      [loud.label, loud.value, loud.note, loud.tone],
      [
        'Level',
        '+7 dBFS before the limiter',
        'Held down more than 3 dB for 758 ms of the last second, at Mic gain +24 dB. Lower the Mic gain.',
        'warn',
      ],
    );
    assert.deepEqual([level(null, 21).tone, level(null, 21).note],
      ['neutral', 'Held down more than 3 dB for 21 ms of the last second, at Mic gain +24 dB. Fine unless it keeps happening.']);
    assert.deepEqual([level(null, 0, -40).value, level(null, 0, -40).tone], ['-16 dBFS before the limiter', 'ok']);
    assert.match(level('too-quiet', 0, -60).note, /raise the Mic gain/);

    const zh = diagnosticsTranslator('zh-Hant');
    const zhLoud = Object.fromEntries(describeMicTransport(liveStatus((s) => {
      s.audio.micLevel = {
        warning: 'too-loud',
        lastWindow: { eligible: true, songPlaying: true, heavyLimitedMs: 758.2, rawPeakDbfs: -17.07, micGainDb: 24 },
      };
    }), zh).map((row) => [row.key, row])).level;
    assert.deepEqual(
      [zhLoud.label, zhLoud.value, zhLoud.note],
      ['音量', '限幅前 +7 dBFS', 'Mic 增益 +24 dB 時，上一秒有 758 ms 被壓低超過 3 dB。請調低 Mic 增益。'],
    );
  });

  function levelRow(micLevel: Status, t = diagnosticsTranslator('en'), overrides: (status: Status) => void = () => {}) {
    const status = liveStatus((s) => { s.audio.micLevel = micLevel; overrides(s); });
    return Object.fromEntries(describeMicTransport(status, t).map((row) => [row.key, row])).level;
  }

  it('never invents a peak for a live second with no Mic PCM', () => {
    const row = levelRow({
      warning: null,
      lastWindow: { eligible: true, songPlaying: true, heavyLimitedMs: 0, rawPeakDbfs: null, micGainDb: 24 },
      micGainDb: 24,
    });
    assert.equal(row.value, '—');
    assert.doesNotMatch(`${row.value} ${row.note}`, /dBFS|\+24/);
  });

  it('explains a too-loud warning beside a calm last second instead of contradicting it', () => {
    const calm = {
      warning: 'too-loud',
      calmWindows: 3,
      calmWindowsNeeded: 10,
      lastWindow: { eligible: true, songPlaying: true, heavyLimitedMs: 0, rawPeakDbfs: -30, micGainDb: 24 },
      micGainDb: 24,
    };
    const row = levelRow(calm);
    assert.deepEqual(
      [row.value, row.note, row.tone],
      [
        '-6 dBFS before the limiter',
        'The last second was not held down, but the seconds before it often were. Calm for 3 of the 10 seconds that clear the warning.',
        'warn',
      ],
    );
    assert.doesNotMatch(row.note, /0 ms|Lower the Mic gain/);
    assert.equal(
      levelRow(calm, diagnosticsTranslator('zh-Hant')).note,
      '這一秒沒有被壓低，但前幾秒常被壓低。已經連續 3 秒沒被壓低，滿 10 秒警告就會解除。',
    );

    const hot = levelRow({ ...calm, calmWindows: 0, lastWindow: { ...calm.lastWindow, heavyLimitedMs: 240 } });
    assert.match(hot.note, /^Held down more than 3 dB for 240 ms/);
  });

  it('labels a reading taken before a gain change with the gain it was taken at', () => {
    // The singer lowered +24 to +16; the warning is already re-judged, but the
    // last window was measured at +24 until the next second closes.
    const moved = {
      warning: null,
      lastWindow: { eligible: true, songPlaying: true, heavyLimitedMs: 758, rawPeakDbfs: -17, micGainDb: 24 },
      micGainDb: 16,
    };
    const row = levelRow(moved);
    assert.deepEqual(
      [row.value, row.note, row.tone],
      [
        '+7 dBFS before the limiter',
        'Measured at Mic gain +24 dB. The reading at +16 dB shows once the next second is measured.',
        'neutral',
      ],
    );
    assert.equal(
      levelRow(moved, diagnosticsTranslator('zh-Hant')).note,
      '這是 Mic 增益 +24 dB 時量到的。+16 dB 的結果會在下一秒量完後顯示。',
    );
    assert.equal(levelRow({ ...moved, warning: 'too-loud' }).tone, 'warn');
  });

  it('drops a stale level once the Mic stops streaming', () => {
    const row = levelRow({
      warning: null,
      lastWindow: { eligible: true, songPlaying: true, heavyLimitedMs: 0, rawPeakDbfs: -20, micGainDb: 24 },
      micGainDb: 24,
    }, diagnosticsTranslator('en'), (s) => { s.source.micStreaming = false; });
    assert.equal(row.value, '—');
  });

  it('reads a null capture level or drift as missing, not as zero', () => {
    const input = rows(liveStatus((s) => { s.audio.captureAndSender.captureLevel = { peakDbfs: null }; })).input;
    assert.deepEqual([input.value, input.tone], ['Live', 'neutral']);
    const drift = rows(liveStatus((s) => { s.audio.timeline.micClockDrift = { ppm: null }; })).drift;
    assert.equal(drift.value, 'Measuring…');
  });

  it('shows no level before the monitor has judged a live window', () => {
    assert.equal(rows(liveStatus()).level.value, '—');
    const notLive = rows(liveStatus((s) => {
      s.audio.micLevel = { warning: null, lastWindow: { eligible: false, songPlaying: false, heavyLimitedMs: 0, rawPeakDbfs: null, micGainDb: 24 } };
    })).level;
    assert.equal(notLive.value, '—');
  });

  it('renders placeholders rather than guesses before statusz has answered', () => {
    for (const row of describeMicTransport(null)) assert.equal(row.value, '—', row.key);
  });
});
