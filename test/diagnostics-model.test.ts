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
  it('says how late a clamped voice is and why', () => {
    const rows = byKey(describeTiming({
      product: { timing: { state: 'clamped' } },
      readiness: readiness(),
      source: source({ requestedMicAdvanceMs: 245, appliedMicAdvanceMs: 200 }),
    }, en));
    assert.deepEqual([rows.alignment.value, rows.alignment.tone], ['Buffer too small', 'bad']);
    assert.deepEqual(
      [rows.offset.value, rows.offset.note, rows.offset.tone],
      ['200 ms', 'Needs 245 ms but the buffer allows 200 ms, so the voice is 45 ms late.', 'bad'],
    );
  });

  it('names the measurement method or admits it is an estimate', () => {
    const measured = byKey(describeTiming({ source: source({ activeCalibrationKind: 'content' }) }, en));
    assert.deepEqual([measured.method.value, measured.method.note], ['Measured', 'From the song itself, while it plays.']);
    const estimated = byKey(describeTiming({
      product: { timing: { state: 'fallback' } },
      source: source({ timingMode: 'network-estimate' }),
    }, en));
    assert.equal(estimated.method.value, 'Network estimate');
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

describe('locales', () => {
  it('renders Chinese from the same facts', () => {
    const rows = byKey(describeTiming({
      product: { timing: { state: 'clamped' } },
      source: source({ requestedMicAdvanceMs: 245, appliedMicAdvanceMs: 200 }),
    }, zh));
    assert.equal(rows.alignment.value, '緩衝不足');
    assert.equal(rows.offset.note, '需要 245 ms，但緩衝只容許 200 ms，所以人聲晚了 45 ms。');
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
        }
      }
    }
  });
});
