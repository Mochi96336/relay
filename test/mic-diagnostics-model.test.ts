import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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
      ['audio', 'problems', 'path', 'repair', 'buffer', 'send', 'input', 'drift'],
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
    assert.equal(slow.note, 'The phone clock runs slow: the buffer shrinks about 4.8 ms per minute.');
    const fast = rows(liveStatus((s) => { s.audio.timeline.micClockDrift = { ppm: -30, windows: 24, spanMs: 115_000 }; })).drift;
    assert.match(fast.note, /drifts about 1\.8 ms per minute later/);
    const fine = rows(liveStatus((s) => { s.audio.timeline.micClockDrift = { ppm: 4, windows: 24, spanMs: 115_000 }; })).drift;
    assert.deepEqual([fine.value, fine.tone], ['+4 ppm', 'ok']);
    const zero = rows(liveStatus((s) => { s.audio.timeline.micClockDrift = { ppm: -0.3, windows: 24, spanMs: 115_000 }; })).drift;
    assert.equal(zero.value, '0 ppm', 'no signed zero');
  });

  it('renders placeholders rather than guesses before statusz has answered', () => {
    for (const row of describeMicTransport(null)) assert.equal(row.value, '—', row.key);
  });
});
