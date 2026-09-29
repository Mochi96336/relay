/**
 * Offline-only P2 evidence: run exactly the same seeded Mic uplink losses
 * with and without the optional deadline observer. No request is suppressed.
 *
 * Every classification here uses GLOBAL mix headroom, not an authoritative
 * per-hole deadline. Aggregate 'probably-late' is NOT an estimated number
 * of requests production could safely eliminate.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { clean, randomLoss, burstyLoss, simulateMicUplink, type Scenario } from '../test/helpers/mic-loss-network.js';

const scenarios: Scenario[] = [
  { name: 'clean', seconds: 8, uplink: clean(30, 10), downlink: clean(30, 10) },
  { name: 'random 5%, 80ms RTT', seconds: 8, uplink: randomLoss(0.05, 40, 10), downlink: clean(40, 10) },
  { name: 'random 10%, 160ms RTT', seconds: 8, uplink: randomLoss(0.10, 80, 25), downlink: clean(80, 25) },
  { name: 'bursty loss, 80ms RTT', seconds: 8, uplink: burstyLoss(0.02, 6, 40), downlink: clean(40, 10) },
  {
    name: 'RTT path change after 3s', seconds: 8,
    uplink: (rngs) => ({
      delayMs: 40, jitterMs: 15,
      lose: (nowMs, kind) => (nowMs > 3_000 ? rngs[kind]() < 0.12 : rngs[kind]() < 0.05),
    }),
    downlink: clean(40, 20),
    paths: (nowMs) => ({ direct: nowMs < 3_000 || nowMs >= 3_200, control: true }),
  },
];
const seeds = [1, 7, 17];
const rows = [];
for (const scenario of scenarios) {
  for (const seed of seeds) {
    // This is a CONTROLLED headroom schedule, not a physical network trace.
    // It forces the observer to report both comfortable and tight deadlines.
    const headroom = (nowMs: number) => nowMs < 2_000 ? 400
      : nowMs < 4_000 ? 180
        : nowMs < 6_000 ? 110 : 55;
    const baseline = await simulateMicUplink({
      scenario, seed, pageRetransmits: true, mixHeadroomMs: headroom,
    });
    const classes = { unknown: 0, 'below-existing-hold-gate': 0, 'probably-late': 0, 'plausibly-on-time': 0 };
    let observedRequests = 0;
    let knownRTT = 0;
    const observed = await simulateMicUplink({
      scenario, seed, pageRetransmits: true, mixHeadroomMs: headroom,
      onRetransmitDeadlineObservation({pendingRequests, estimate}) {
        classes[estimate.classification] += pendingRequests;
        observedRequests += pendingRequests;
        if (estimate.predictedMs !== null) knownRTT += pendingRequests;
      },
    });
    assert.deepEqual(observed.missed, baseline.missed, `observation changed audible timing: ${scenario.name}, seed=${seed}`);
    for (const field of ['requested', 'recovered', 'retried', 'missing', 'budgetDenied'] as const) {
      assert.equal(observed[field], baseline[field], `observation changed ${field}: ${scenario.name}, seed=${seed}`);
    }
    rows.push({
      scenario: scenario.name, seed,
      requested: baseline.requested, recovered: baseline.recovered,
      missing: baseline.missing, retried: baseline.retried,
      observedRequests, knownRTT,
      classes,
    });
  }
}
const sum = (key: 'requested'|'recovered'|'missing'|'retried'|'observedRequests'|'knownRTT') =>
  rows.reduce((n, row) => n + row[key], 0);
const result = {
  control: 'with vs without observer identical for every seeded scenario',
  interpretation: 'observedRequests counts callback sightings, potentially repeats, NOT distinct requests or safe eliminations',
  samples: rows.length,
  totals: {
    requested: sum('requested'), recovered: sum('recovered'),
    missing: sum('missing'), retried: sum('retried'),
    observedRequests: sum('observedRequests'), knownRTT: sum('knownRTT'),
  },
  rows,
  limitations: [
    'The 400/180/110/55ms headroom schedule is synthetic rather than a measured room trace.',
    'Estimated global deadlines are not per-sequence capture deadlines.',
    'No traffic optimization is switched on; this only measures false-regression risk and informational coverage.',
  ],
};
const out = process.argv.indexOf('--out');
if (out >= 0) {
  if (!process.argv[out + 1]) throw Error('--out needs a JSON file path');
  const path = process.argv[out + 1]!;
  await mkdir((await import('node:path')).dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify(result, null, 2));
