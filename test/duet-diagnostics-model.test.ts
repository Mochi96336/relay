import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { diagnosticsTranslator } from '../public/diagnostics-copy.js';
import { describeDuetMic, describeDuetTiming } from '../public/duet-diagnostics-model.js';

type Facts = Record<string, any>;

const zh = diagnosticsTranslator('zh-Hant');

/** A duet room with B mixed in on Content, shaped like product-status and /statusz. */
function duetFacts(overrides: (facts: Facts) => void = () => {}): Facts {
  const facts: Facts = {
    product: {
      room: {
        mic: { state: 'live', ownerNickname: 'Ann' },
        duet: { secondaryId: 'b', secondaryNickname: 'Bo', state: 'singing' },
      },
    },
    source: { timingMode: 'acoustic-calibration', activeCalibrationKind: 'content', appliedMicAdvanceMs: 150 },
    statusz: {
      audio: {
        duetSecondary: {
          audible: true, blend: 1, lagMs: 180, targetLagMs: 180, gainDb: 24,
          gapSamples: 0, starvedSamples: 0, mixedFrames: 500, recentlyHeard: true,
          bufferedSamples: 9_600, sampleRate: 48_000,
        },
        duetIngress: { accepted: 500, rejected: {}, lastRejected: null, codec: 'opus' },
        duetRoom: { state: 'duet-ready', primaryId: 'a', secondaryId: 'b', primary: 'ready', secondary: 'ready' },
        duetContent: { submitted: 4, applied: 2, rejected: 1, timedOut: 1, lastFailureReason: null },
        duetYoutube: { lagSource: 'content', mic: { ageMs: 400 }, backing: { ageMs: 900 }, calculation: null },
      },
    },
  };
  overrides(facts);
  return facts;
}

function byKey(rows: Array<{ key: string }>) {
  return Object.fromEntries(rows.map((row) => [row.key, row])) as Record<string, any>;
}

describe('second Mic diagnostics', () => {
  it('stays out of a solo room entirely', () => {
    const facts = duetFacts((f) => { delete f.product.room.duet; });
    assert.equal(describeDuetMic(facts), null);
    assert.equal(describeDuetTiming(facts), null);
  });

  it('names both singers and says B is in the mix', () => {
    const block = describeDuetMic(duetFacts())!;
    assert.equal(block.title, 'Second Mic · Bo');
    assert.equal(block.mainTitle, 'Main Mic · Ann');
    const rows = byKey(block.rows);
    assert.equal(rows.duetState.value, 'In the mix');
    assert.equal(rows.duetState.tone, 'ok');
    assert.equal(rows.duetEncoding.value, 'Opus');
    assert.equal(rows.duetGain.value, '+24 dB');
    assert.equal(rows.duetGaps.value, '0 ms');
    assert.equal(rows.duetGaps.tone, 'ok');
  });

  it('does not call a joined B normal before it is mixed', () => {
    const joined = byKey(describeDuetMic(duetFacts((f) => {
      f.product.room.duet.state = 'joined';
      f.statusz.audio.duetSecondary = null;
      f.statusz.audio.duetIngress.codec = null;
    }))!.rows);
    assert.equal(joined.duetState.value, 'Joined');
    assert.equal(joined.duetState.tone, 'neutral');
    // Nothing measured for B yet: no gain, gaps or codec rows to imply one.
    assert.deepEqual(Object.keys(joined), ['duetState']);

    const aligning = byKey(describeDuetMic(duetFacts((f) => { f.product.room.duet.state = 'aligning'; }))!.rows);
    assert.equal(aligning.duetState.value, 'Measuring timing');
  });

  it('says B stopped when B is mixed but its audio no longer arrives', () => {
    const rows = byKey(describeDuetMic(duetFacts((f) => {
      f.product.room.duet.state = 'aligning';
      f.statusz.audio.duetSecondary.recentlyHeard = false;
    }))!.rows);
    assert.equal(rows.duetState.value, 'Audio stopped');
    assert.equal(rows.duetState.tone, 'bad');
  });

  it('reports B gaps in milliseconds at B sample rate, as totals', () => {
    const rows = byKey(describeDuetMic(duetFacts((f) => {
      f.statusz.audio.duetSecondary.gapSamples = 4_800;
      f.statusz.audio.duetSecondary.starvedSamples = 960;
    }))!.rows);
    assert.equal(rows.duetGaps.value, '120 ms');
    assert.match(rows.duetGaps.note, /lost 100 ms, not yet arrived 20 ms/);
    assert.equal(rows.duetGaps.tone, 'neutral');
  });

  it('keeps packet counts and room state in the fold', () => {
    const block = describeDuetMic(duetFacts((f) => {
      f.statusz.audio.duetIngress.rejected = { 'duplicate-packet': 3 };
      f.statusz.audio.duetIngress.lastRejected = 'duplicate-packet';
    }))!;
    assert.ok(!block.rows.some((row) => row.key === 'duetPackets'));
    const advanced = byKey(block.advanced);
    assert.equal(advanced.duetPackets.value, '500 accepted · 1 kinds rejected');
    assert.match(advanced.duetPackets.note, /duplicate-packet ×3/);
    assert.equal(advanced.duetBuffered.value, '200 ms');
    assert.equal(advanced.duetRoom.value, 'Both singers measured');
  });

  it('puts A and B compensation side by side and names what B rests on', () => {
    const block = describeDuetTiming(duetFacts())!;
    const rows = byKey(block.rows);
    assert.equal(rows.duetMainOffset.label, 'Main Mic · Ann');
    assert.equal(rows.duetMainOffset.value, '150 ms');
    assert.equal(rows.duetMainOffset.note, 'Song content');
    assert.equal(rows.duetSecondOffset.label, 'Second Mic · Bo');
    assert.equal(rows.duetSecondOffset.value, '180 ms');
    assert.match(rows.duetSecondOffset.note, /^Song content/);
    assert.equal(rows.duetSecondOffset.tone, 'ok');
  });

  it('never presents a YouTube time estimate as a Content measurement', () => {
    const rows = byKey(describeDuetTiming(duetFacts((f) => {
      f.statusz.audio.duetYoutube.lagSource = 'youtube-time';
      f.statusz.audio.duetSecondary.lagMs = 170;
      f.statusz.audio.duetSecondary.targetLagMs = 190;
    }))!.rows);
    assert.match(rows.duetSecondOffset.note, /^YouTube time estimate/);
    assert.match(rows.duetSecondOffset.note, /Moving toward 190 ms/);
    assert.equal(rows.duetSecondOffset.tone, 'neutral');

    const songless = byKey(describeDuetTiming(duetFacts((f) => {
      f.statusz.audio.duetYoutube.lagSource = 'no-song';
    }))!.rows);
    assert.match(songless.duetSecondOffset.note, /^No song/);

    const none = byKey(describeDuetTiming(duetFacts((f) => {
      f.statusz.audio.duetYoutube.lagSource = null;
      f.statusz.audio.duetSecondary.lagMs = null;
      f.statusz.audio.duetSecondary.targetLagMs = null;
    }))!.rows);
    assert.equal(none.duetSecondOffset.value, 'Not measured yet');
  });

  it('keeps per-singer Content readiness and anchor ages in the timing fold', () => {
    const advanced = byKey(describeDuetTiming(duetFacts((f) => {
      f.statusz.audio.duetRoom.secondary = 'calibration-required';
      f.statusz.audio.duetContent.lastFailureReason = 'worker-timeout';
    }))!.advanced);
    assert.equal(advanced.duetReadiness.value, 'Main measured · Second measuring');
    assert.equal(advanced.duetContent.value, '2 of 4 used');
    assert.match(advanced.duetContent.note, /worker-timeout/);
    assert.equal(advanced.duetContent.tone, 'warn');
    assert.equal(advanced.duetAnchors.value, 'Second Mic 0.4 s ago · Robot 0.9 s ago');
  });

  it('reads in Chinese', () => {
    const mic = describeDuetMic(duetFacts(), zh)!;
    assert.equal(mic.title, '副 Mic · Bo');
    assert.equal(byKey(mic.rows).duetState.value, '已混入');
    const timing = byKey(describeDuetTiming(duetFacts(), zh)!.rows);
    assert.equal(timing.duetMainOffset.note, '歌曲內容');
  });
});

describe('second Mic blocks in Technical details', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const system = readFileSync(new URL('../public/system-details.js', import.meta.url), 'utf8');

  it('sit inside the Mic and Timing tabs, hidden until a second Mic joins', () => {
    const panel = (name: string) => {
      const start = html.indexOf(`data-diagnostics-panel="${name}"`);
      return html.slice(start, html.indexOf('</section>', start));
    };
    assert.match(panel('mic'), /<div id="diag-duet-mic" hidden>/);
    assert.match(panel('timing'), /<div id="diag-duet-timing" hidden>/);
    assert.match(panel('mic'), /<p id="diag-mic-main-heading" class="diagnostic-group" hidden><\/p>/);
    assert.doesNotMatch(html, /data-diagnostics-tab="duet"/);
    assert.match(system, /renderDuet\(facts\)/);
  });
});
