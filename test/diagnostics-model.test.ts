import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DIAGNOSTICS_MESSAGES, diagnosticsTranslator } from '../public/diagnostics-copy.js';
import {
  describeAudio,
  describeOverview,
  describeRobot,
  describeSession,
  describeTiming,
} from '../public/diagnostics-model.js';
import { describeMicTransport } from '../public/mic-diagnostics-model.js';

type Facts = Record<string, any>;

const en = diagnosticsTranslator('en');
const zh = diagnosticsTranslator('zh-Hant');

function readiness(overrides: Facts = {}): Facts {
  return {
    ready: true,
    sessionReady: true,
    reasons: [],
    sessionReasons: [],
    components: {
      route: { mode: 'robot' },
      backing: { connected: true, streaming: true, sampleRate: 48_000, robot: true },
      mic: { connected: true, streaming: true },
      robotSource: { connected: true },
      session: { active: true },
      player: { timelineConnected: true, state: 1, offsetMs: 12, offsetFresh: true },
    },
    ...overrides,
  };
}

function source(overrides: Facts = {}): Facts {
  return {
    timingMode: 'acoustic-calibration',
    activeCalibrationKind: 'boot-probe',
    appliedMicAdvanceMs: 129,
    requestedMicAdvanceMs: 129,
    micFrontierCorrectionMs: 0,
    vocalFineTuneMs: 0,
    robotRoute: true,
    robotDeltaFresh: true,
    ...overrides,
  };
}

function byKey(rows: Array<{ key: string }>) {
  return Object.fromEntries(rows.map((row) => [row.key, row])) as Record<string, any>;
}

describe('diagnostics copy', () => {
  it('has the same keys and placeholders in every locale', () => {
    const locales = ['en', 'zh-Hant'] as const;
    const reference = DIAGNOSTICS_MESSAGES.en;
    const placeholders = (template: string) => [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const locale of locales) {
      const table = DIAGNOSTICS_MESSAGES[locale];
      assert.deepEqual(Object.keys(table).sort(), Object.keys(reference).sort(), locale);
      for (const [key, template] of Object.entries(reference)) {
        assert.deepEqual(placeholders(table[key]), placeholders(template), `${locale}:${key}`);
      }
    }
  });

  it('owns only diag.* keys, so it never collides with product copy', () => {
    for (const key of Object.keys(DIAGNOSTICS_MESSAGES.en)) assert.match(key, /^diag\./);
  });
});

describe('Overview', () => {
  it('says why the room equipment is not ready, in words', () => {
    const rows = byKey(describeOverview({
      readiness: readiness({
        ready: false,
        sessionReady: false,
        reasons: ['robot-source-not-connected'],
        sessionReasons: ['robot-source-not-connected', 'mic-not-connected'],
      }),
    }, en));
    assert.deepEqual(
      [rows.host.value, rows.host.note, rows.host.tone],
      ['Not ready', 'Missing: the Robot player page is not connected.', 'bad'],
    );
    assert.deepEqual(
      [rows.session.value, rows.session.note, rows.session.tone],
      ['Not yet', 'Missing: nobody holds the Mic.', 'neutral'],
      'session names only what it adds, and a free Mic is not damage',
    );
  });

  it('points at the System issues instead of repeating them', () => {
    const rows = byKey(describeOverview({
      product: { health: 'degraded', lifecycle: 'live', issues: [{}, {}] },
    }, en));
    assert.deepEqual(
      [rows.health.value, rows.health.note, rows.health.tone],
      ['Degraded', '2 problems are listed in System above.', 'warn'],
    );
    assert.equal(rows.lifecycle.value, 'Live');
  });
});

describe('Timing', () => {
  function clamped(overrides: Facts, t = en) {
    return byKey(describeTiming({
      product: { timing: { state: 'clamped' } },
      readiness: readiness(),
      source: source(overrides),
    }, t));
  }

  it('blames the buffer only for what the buffer limited', () => {
    const rows = clamped({ requestedMicAdvanceMs: 245, appliedMicAdvanceMs: 200 });
    assert.deepEqual([rows.alignment.value, rows.alignment.tone], ['Buffer too small', 'bad']);
    assert.deepEqual(
      [rows.offset.value, rows.offset.note, rows.offset.tone],
      ['Voice may be 45 ms late', 'The host buffer only allows 200 ms of compensation.', 'bad'],
    );
    assert.doesNotMatch(rows.offset.note, /RELAY_/, 'no environment variable names in what a singer reads');
    const zhRows = clamped({ requestedMicAdvanceMs: 245, appliedMicAdvanceMs: 200 }, zh);
    assert.equal(zhRows.alignment.value, '緩衝不足');
    assert.deepEqual([zhRows.offset.value, zhRows.offset.note], ['人聲可能晚 45 ms', '主機緩衝設定最多補償 200 ms。']);
  });

  it('blames late Mic audio, not the buffer, for a frontier hold-back', () => {
    // A 120 ms request the buffer affords, held back 50 ms because Mic audio
    // has not arrived that far: applied 70 ms, and the buffer is not at fault.
    const facts = { requestedMicAdvanceMs: 120, appliedMicAdvanceMs: 70, micFrontierCorrectionMs: 50 };
    const rows = clamped(facts);
    assert.deepEqual([rows.alignment.value, rows.alignment.tone], ['Mic audio late', 'bad']);
    assert.match(rows.alignment.note, /Retry the Mic/);
    assert.equal(rows.offset.value, 'Voice may be 50 ms late');
    assert.equal(
      rows.offset.note,
      'Mic audio is arriving late, so Relay waits 50 ms longer before playing it. If the voice sounds late, retry the Mic.',
    );
    assert.doesNotMatch(rows.offset.note, /buffer/i);

    const zhRows = clamped(facts, zh);
    assert.equal(zhRows.alignment.value, 'Mic 音訊晚到');
    assert.equal(zhRows.offset.note, 'Mic 音訊晚到，Relay 延後 50 ms 播放。若人聲聽起來偏晚，請重試 Mic。');
    assert.doesNotMatch(zhRows.offset.note, /緩衝/);
  });

  it('names both causes when the buffer clamps and the frontier holds back', () => {
    // The buffer allowed 200 of 300 ms; the frontier then held back 40 more.
    const facts = { requestedMicAdvanceMs: 300, appliedMicAdvanceMs: 160, micFrontierCorrectionMs: 40 };
    const rows = clamped(facts);
    assert.equal(rows.alignment.value, 'Buffer too small, Mic late');
    assert.equal(rows.offset.value, 'Voice may be 140 ms late');
    assert.equal(
      rows.offset.note,
      'The host buffer only allows 200 ms of compensation. '
        + 'Mic audio is arriving late, so Relay waits 40 ms longer before playing it. If the voice sounds late, retry the Mic.',
    );
    assert.equal(clamped(facts, zh).alignment.value, '緩衝不足且 Mic 晚到');
  });

  it('says early, not late, when a negative request is clipped by the kept history', () => {
    // Alignment asks to read 500 ms behind; history allows 300 ms, so the voice
    // is not delayed enough and plays 200 ms early.
    const facts = { requestedMicAdvanceMs: -500, appliedMicAdvanceMs: -300 };
    const rows = clamped(facts);
    assert.equal(rows.alignment.value, 'Buffer too small');
    assert.deepEqual(
      [rows.offset.value, rows.offset.note],
      ['Voice may be 200 ms early', 'Relay only keeps 300 ms of Mic audio to read back.'],
    );
    assert.doesNotMatch(rows.offset.note, /late|PREBUFFER/);
    assert.deepEqual(
      [clamped(facts, zh).offset.value, clamped(facts, zh).offset.note],
      ['人聲可能早 200 ms', 'Relay 僅保留 300 ms 的 Mic 音訊可供回讀。'],
    );
  });

  it('keeps a generic clamp when the serving alignment is unknown', () => {
    const rows = byKey(describeTiming({ product: { timing: { state: 'clamped' } } }, en));
    assert.deepEqual([rows.alignment.value, rows.alignment.tone], ['Correction limited', 'bad']);
  });

  it('names the measurement method or admits it is an estimate', () => {
    const measured = byKey(describeTiming({ source: source({ activeCalibrationKind: 'content' }) }, en));
    assert.deepEqual([measured.method.value, measured.method.note], ['Song content', 'From the song itself, while it plays.']);
    const probe = byKey(describeTiming({ source: source({ activeCalibrationKind: 'boot-probe' }) }, zh));
    assert.deepEqual([probe.method.value, probe.method.note], ['測試音', 'Mic 開始時，以手機播放的測試音量測延遲。']);
    const estimated = byKey(describeTiming({
      product: { timing: { state: 'fallback' } },
      source: source({ timingMode: 'network-estimate' }),
    }, en));
    assert.equal(estimated.method.value, 'Estimate');
    assert.equal(estimated.alignment.tone, 'warn');
  });

  it('shows the Robot player position only on the Robot route', () => {
    const stale = byKey(describeTiming({ readiness: readiness(), source: source({ robotDeltaFresh: false }) }, en));
    assert.deepEqual([stale.robotDelta.value, stale.robotDelta.tone], ['Out of date', 'warn']);
    const legacy = byKey(describeTiming({ readiness: readiness(), source: source({ robotRoute: false }) }, en));
    assert.equal(legacy.robotDelta, undefined);
  });
});

describe('Audio, Session and Robot', () => {
  it('does not call missing song audio a fault when no song needs it', () => {
    const idle = readiness();
    idle.components.route.mode = 'idle';
    idle.components.backing = { connected: false, streaming: false, sampleRate: null, robot: false };
    const rows = byKey(describeAudio({ readiness: idle }, en));
    assert.deepEqual([rows.backing.value, rows.backing.tone], ['Not connected', 'neutral']);
    assert.equal(rows.route.value, 'Not needed');
  });

  it('reports flowing song audio with its rate and buffer, and listener drops', () => {
    const rows = byKey(describeAudio({
      readiness: readiness(),
      statusz: { mix: { backingHeadroomMs: 395.4, clippedSamples: 0, monitorRecentDroppedFrames: 12, monitorRecentDroppingListeners: 2 } },
    }, en));
    assert.equal(rows.backing.note, '48000 Hz · 395 ms buffered ahead of the mix.');
    assert.deepEqual([rows.listeners.value, rows.listeners.tone], ['12 frames dropped', 'warn']);
  });

  it('says what the mixer does, and mentions clipping only when the final mix clipped', () => {
    const running = byKey(describeAudio({ readiness: readiness(), statusz: { mix: { clippedSamples: 0 } } }, en)).mixer;
    assert.deepEqual([running.note, running.tone], ['Mixing the voice and the song into the room sound.', 'ok']);
    assert.doesNotMatch(running.note, /clip/i);
    const clipped = byKey(describeAudio({ readiness: readiness(), statusz: { mix: { clippedSamples: 4 } } }, en)).mixer;
    assert.equal(clipped.tone, 'warn');
    assert.match(clipped.note, /since the mixer started\. This is separate from the Mic limiter/);
    const zhRunning = byKey(describeAudio({ readiness: readiness(), statusz: { mix: { clippedSamples: 0 } } }, zh)).mixer;
    assert.doesNotMatch(zhRunning.note, /削波|削平/);
  });

  it('names the Mic holder and what their Mic is doing', () => {
    const rows = byKey(describeSession({
      product: {
        room: {
          participantCount: 3,
          mic: { state: 'reconnecting', ownerNickname: 'Mochi' },
          song: { state: 'playing' },
        },
        take: { lifecycle: 'idle' },
      },
    }, en));
    assert.equal(rows.people.value, '3 online');
    assert.deepEqual([rows.mic.value, rows.mic.note, rows.mic.tone], ['Mochi', 'Holds the Mic; reconnecting.', 'warn']);
    assert.equal(rows.song.value, 'Playing');
  });

  it('treats a missing Robot page as a fault only on the Robot route', () => {
    const robot = readiness();
    robot.components.robotSource.connected = false;
    assert.equal(byKey(describeRobot({ readiness: robot }, en)).source.tone, 'bad');
    const legacy = readiness();
    legacy.components.route.mode = 'legacy';
    legacy.components.robotSource.connected = false;
    legacy.components.backing.robot = false;
    const rows = byKey(describeRobot({ readiness: legacy }, en));
    assert.deepEqual([rows.route.value, rows.source.tone, rows.backing.tone], ['Not in use', 'neutral', 'neutral']);
  });
});

describe('rows that only describe what is really there', () => {
  const room = (song: string, mic: Facts = { state: 'free' }, issues: Facts[] = []) => ({
    issues,
    room: { participantCount: 2, mic, song: { state: song } },
    take: { lifecycle: 'idle' },
  });

  it('calls a finished Song ended, not paused', () => {
    const ended = readiness();
    ended.components.player = { timelineConnected: false, state: 0, offsetMs: null, offsetFresh: false };
    assert.equal(byKey(describeSession({ product: room('ready'), readiness: ended }, en)).song.value, 'Ended');
    assert.equal(byKey(describeSession({ product: room('ready'), readiness: ended }, zh)).song.value, '已播完');
    const paused = readiness();
    paused.components.player.state = 2;
    assert.equal(byKey(describeSession({ product: room('ready'), readiness: paused }, en)).song.value, 'Loaded');
  });

  it('tells a Mic arriving too late apart from a silent one', () => {
    const behind = room('ready', { state: 'interrupted', ownerNickname: 'Ka' }, [{ cause: 'mic-timeline-behind' }]);
    assert.equal(
      byKey(describeSession({ product: behind }, en)).mic.note,
      'Holds the Mic; its audio arrives too late for the live mix.',
    );
    const late = readiness();
    late.components.mic = { connected: true, streaming: false, arriving: true };
    const lateRow = byKey(describeAudio({ readiness: late }, en)).mic;
    assert.deepEqual([lateRow.value, lateRow.tone], ['Arriving late', 'warn']);
    const silent = readiness();
    silent.components.mic = { connected: true, streaming: false, arriving: false };
    assert.equal(byKey(describeAudio({ readiness: silent }, en)).mic.value, 'Silent');
  });

  it('says what the mixer is actually mixing', () => {
    const mixer = (facts: Facts) => byKey(describeAudio({ readiness: facts, statusz: { mix: { clippedSamples: 0 } } }, en)).mixer.note;
    const voiceOnly = readiness();
    voiceOnly.components.player.state = 2;
    assert.equal(mixer(voiceOnly), 'Sending the voice to the room.');
    const songOnly = readiness();
    songOnly.components.mic = { connected: false, streaming: false };
    assert.equal(mixer(songOnly), 'Sending the song to the room.');
    const neither = readiness();
    neither.components.mic = { connected: false, streaming: false };
    neither.components.player = { timelineConnected: false, state: null };
    assert.equal(mixer(neither), 'No voice and no song right now.');
  });

  it('leaves out voice timing rows while nobody holds the Mic', () => {
    const rows = byKey(describeTiming({ readiness: readiness(), source: source({ micConnected: false }) }, en));
    assert.equal(rows.method, undefined);
    assert.equal(rows.offset, undefined);
    assert.equal(rows.fineTune, undefined);
    assert.ok(rows.alignment && rows.clock);
  });

  it('shows fine tune only when an older page left one, without pointing at a hidden control', () => {
    assert.equal(byKey(describeTiming({ readiness: readiness(), source: source() }, en)).fineTune, undefined);
    const leftOver = byKey(describeTiming({ readiness: readiness(), source: source({ vocalFineTuneMs: 20 }) }, zh)).fineTune;
    assert.deepEqual([leftOver.label, leftOver.value, leftOver.tone], ['人聲微調', '+20 ms', 'warn']);
    assert.doesNotMatch(leftOver.note, /•••/);
    assert.match(leftOver.note, /已不提供/);
  });

  it('does not warn about the Robot position while no song plays', () => {
    const idle = readiness();
    idle.components.player = { timelineConnected: false, state: null, offsetMs: null, offsetFresh: false };
    const robotDelta = byKey(describeTiming({ readiness: idle, source: source({ robotDeltaFresh: false }) }, en)).robotDelta;
    assert.deepEqual([robotDelta.value, robotDelta.tone], ['Not needed', 'neutral']);
  });
});

describe('locales', () => {
  it('renders Chinese from the same facts', () => {
    const rows = byKey(describeTiming({
      product: { timing: { state: 'clamped' } },
      source: source({ requestedMicAdvanceMs: 245, appliedMicAdvanceMs: 200 }),
    }, zh));
    assert.equal(rows.alignment.value, '緩衝不足');
    assert.equal(rows.offset.note, '主機緩衝設定最多補償 200 ms。');
    const overview = byKey(describeOverview({
      readiness: readiness({ ready: false, reasons: ['backing-not-streaming', 'robot-source-not-connected'] }),
    }, zh));
    assert.equal(overview.host.note, '尚缺：伴奏已連線但沒有聲音、Robot 播放頁未連線。');
  });

  it('never leaks a copy key into what the page shows', () => {
    const facts = {
      product: {
        health: 'blocked',
        lifecycle: 'recording',
        issues: [{}],
        timing: { state: 'stale' },
        room: { participantCount: 1, mic: { state: 'interrupted', ownerNickname: '' }, song: { state: 'handoff' } },
        take: { lifecycle: 'failed' },
      },
      readiness: readiness({
        ready: false,
        sessionReady: false,
        reasons: ['backing-not-robot'],
        sessionReasons: ['backing-not-robot', 'calibration-stale', 'robot-player-offset-stale'],
      }),
      source: source({ requestedMicAdvanceMs: 300, appliedMicAdvanceMs: 180, micFrontierCorrectionMs: 40, vocalFineTuneMs: -15 }),
      statusz: { mix: { backingHeadroomMs: 120, clippedSamples: 4, monitorRecentDroppedFrames: 0 } },
    };
    for (const t of [en, zh]) {
      const rows = [
        ...describeOverview(facts, t),
        ...describeSession(facts, t),
        ...describeAudio(facts, t),
        ...describeTiming(facts, t),
        ...describeRobot(facts, t),
        ...describeMicTransport(null, t),
      ];
      for (const row of rows) {
        for (const field of [row.label, row.value, row.note]) {
          assert.doesNotMatch(String(field), /diag\.|\{\w+\}/, `${row.key}: ${field}`);
          if (t === zh) assert.doesNotMatch(String(field), /。 /, `${row.key}: no space after 。`);
        }
      }
    }
  });
});
