import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { estimateRepairDeadline, type RepairDeadlineEstimate } from '../src/retransmit-deadline-estimate.js';
import { clean, randomLoss, simulateMicUplink } from './helpers/mic-loss-network.js';

describe('repair deadline research (observation only)', () => {
  it('never treats cold-start or poorly sampled RTT as evidence to reject repair', () => {
    assert.equal(estimateRepairDeadline({ mixHeadroomMs: 200, timing: null }).classification, 'unknown');
    assert.equal(estimateRepairDeadline({
      mixHeadroomMs: 200,
      timing: { rttMs: 80, variationMs: 20, observations: 1 },
    }).classification, 'unknown');
    assert.equal(estimateRepairDeadline({
      mixHeadroomMs: null,
      timing: { rttMs: 80, variationMs: 20, observations: 5 },
    }).classification, 'unknown');
  });

  it('reports the existing headroom gate rather than inventing a new holding policy', () => {
    const timing = { rttMs: 80, variationMs: 10, observations: 5 };
    const low = estimateRepairDeadline({ mixHeadroomMs: 55, timing });
    assert.equal(low.classification, 'below-existing-hold-gate');
    assert.equal(low.availableMs, 0);
    assert.equal(estimateRepairDeadline({ mixHeadroomMs: 60, timing }).classification, 'below-existing-hold-gate');
    assert.deepEqual(estimateRepairDeadline({ mixHeadroomMs: 300, timing }), {
      classification: 'plausibly-on-time',
      availableMs: 240,
      predictedMs: 110,
    });
    assert.deepEqual(estimateRepairDeadline({ mixHeadroomMs: 140, timing }), {
      classification: 'probably-late',
      availableMs: 80,
      predictedMs: 110,
    });
  });

  it('collecting observations has exactly zero transport or audible-timing effects', async () => {
    const scenario = {
      name: 'seeded repair observation',
      seconds: 8,
      uplink: randomLoss(0.1, 40, 15),
      downlink: clean(40, 10),
    };
    const seed = 17;
    const mixHeadroomMs = (atMs: number) => atMs < 4_000 ? 400 : 140;
    const baseline = await simulateMicUplink({
      scenario, pageRetransmits: true, seed, mixHeadroomMs,
    });
    const observations: RepairDeadlineEstimate[] = [];
    const observed = await simulateMicUplink({
      scenario, pageRetransmits: true, seed, mixHeadroomMs,
      onRetransmitDeadlineObservation: ({ estimate }) => observations.push(estimate),
    });
    assert.ok(observations.length > 0, 'network fixture must exercise actual request dispatch');
    assert.ok(observations.some(x => x.classification === 'unknown'), 'early RTT samples are exploratory');
    assert.ok(observations.some(x => x.classification !== 'unknown'),
      'the network fixture must eventually supply enough successful RTT observations');
    assert.equal(observed.missing, baseline.missing);
    assert.equal(observed.requested, baseline.requested);
    assert.equal(observed.recovered, baseline.recovered);
    assert.equal(observed.retried, baseline.retried);
    assert.deepEqual(observed.missed, baseline.missed,
      'observation must never alter packet scheduling, withholding or mix deadlines');
  });
});
