/**
 * Deterministic loss matrix for the Mic uplink: the real page transport
 * (PreferredAudioTransport, answering repeat requests) and the real Relay side
 * (MicRuntime: ordered receiver, retransmit requests, hold) joined by a
 * simulated network on a virtual millisecond clock (helpers/mic-loss-network).
 *
 * A packet counts as heard when Relay emits it in order before the live mix
 * reads it. Each scenario runs the same seeded network twice: with a page that
 * keeps a retransmission history and with one that does not. Retransmission
 * must recover loss where the round trip allows it, and must never make a
 * scenario worse than plain loss.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  burstyLoss,
  clean,
  randomLoss,
  simulateMicUplink,
  type Rngs,
  type Scenario,
} from './helpers/mic-loss-network.js';

async function compare(scenario: Scenario, seed = 1) {
  const without = await simulateMicUplink({ scenario, pageRetransmits: false, seed });
  const withRepair = await simulateMicUplink({ scenario, pageRetransmits: true, seed });
  if (process.env.MIC_LOSS_MATRIX_REPORT) {
    console.log(JSON.stringify({
      scenario: scenario.name,
      seed,
      lostOnWire: without.lostOnWire,
      heardMissingWithout: without.missing,
      heardMissingWithRepair: withRepair.missing,
      requested: withRepair.requested,
      recovered: withRepair.recovered,
      retried: withRepair.retried,
      budgetDenied: withRepair.budgetDenied,
    }));
  }
  return { without, withRepair };
}

describe('Mic loss matrix (virtual clock, real page and Relay transports)', () => {
  it('loses nothing on a clean path, with or without a history', async () => {
    const { without, withRepair } = await compare({
      name: 'clean',
      seconds: 5,
      uplink: clean(30, 20),
      downlink: clean(30, 20),
    });
    assert.equal(without.missing, 0);
    assert.equal(withRepair.missing, 0);
    assert.equal(withRepair.requested, 0, 'jitter alone is not loss');
  });

  it('waits out heavy jitter instead of discarding late packets', async () => {
    const { without, withRepair } = await compare({
      name: 'heavy jitter, no loss',
      seconds: 8,
      uplink: clean(30, 150),
      downlink: clean(30, 150),
    });
    // Up to 150 ms of queueing reorders far past the 40 ms reorder deadline,
    // but well inside the live buffer: even a page with no history loses nothing.
    assert.equal(without.missing, 0, `late packets discarded: ${JSON.stringify(without.missed.slice(0, 10))}`);
    assert.equal(withRepair.missing, 0);
  });

  for (const rate of [0.02, 0.05, 0.1]) {
    it(`repairs ${rate * 100}% random loss at an 80 ms round trip`, async () => {
      const { without, withRepair } = await compare({
        name: `random ${rate}`,
        seconds: 10,
        uplink: randomLoss(rate, 40, 20),
        downlink: randomLoss(rate, 40, 10),
      });
      assert.ok(without.missing >= without.lostOnWire * 0.9, 'without a history every loss is heard');
      assert.ok(
        withRepair.missing <= Math.max(2, without.missing * 0.15),
        `${withRepair.missing} of ${without.missing} losses still heard: ${JSON.stringify(withRepair.missed)} `
          + `(requested ${withRepair.requested}, recovered ${withRepair.recovered}, retried ${withRepair.retried})`,
      );
      if (rate >= 0.05) assert.ok(withRepair.retried > 0, 'lost repeats and requests were retried');
    });
  }

  it('repairs bursts of consecutive loss', async () => {
    const { without, withRepair } = await compare({
      name: 'bursty',
      seconds: 10,
      uplink: burstyLoss(0.01, 6, 40),
      downlink: randomLoss(0.01, 40, 10),
    });
    assert.ok(without.missing >= 30, `the burst model should hurt: ${without.missing}`);
    assert.ok(
      withRepair.missing <= without.missing * 0.25,
      `${withRepair.missing} of ${without.missing} burst losses still heard`,
    );
  });

  it('retries when every first repeat is lost', async () => {
    const { without, withRepair } = await compare({
      name: 'first repeats lost',
      seconds: 8,
      uplink: (rngs) => {
        const repeated = new Set<number>();
        return {
          delayMs: 40,
          jitterMs: 10,
          lose: (_nowMs, kind, sequence) => {
            if (kind === 'media') return rngs.media() < 0.03;
            // The first repeat of every hole is lost; a second one gets through.
            if (repeated.has(sequence)) return false;
            repeated.add(sequence);
            return true;
          },
        };
      },
      downlink: clean(40, 10),
    });
    assert.ok(withRepair.retried > 0);
    assert.ok(
      withRepair.missing <= Math.max(2, without.missing * 0.3),
      `${withRepair.missing} of ${without.missing} heard with repeats lost`,
    );
  });

  it('keeps requests through a short outage of both request paths', async () => {
    const outages = (nowMs: number) => {
      // 60 ms of every 500 ms, both request paths are down.
      const down = nowMs > 1_500 && nowMs % 500 < 60;
      return { direct: !down, control: !down };
    };
    const { without, withRepair } = await compare({
      name: 'request path outages',
      seconds: 8,
      uplink: randomLoss(0.05, 40, 10),
      downlink: clean(40, 10),
      paths: outages,
    });
    assert.ok(
      withRepair.missing <= Math.max(2, without.missing * 0.2),
      `${withRepair.missing} of ${without.missing} heard across request outages`,
    );
  });

  it('moves requests to the control socket when the direct session is lost', async () => {
    const { without, withRepair } = await compare({
      name: 'direct path lost',
      seconds: 8,
      uplink: randomLoss(0.05, 40, 10),
      downlink: clean(40, 10),
      paths: (nowMs) => ({ direct: nowMs < 4_000, control: true }),
    });
    assert.ok(
      withRepair.missing <= Math.max(2, without.missing * 0.2),
      `${withRepair.missing} of ${without.missing} heard after the direct path went`,
    );
  });

  it('repairs packets the page could not send while its socket reconnected', async () => {
    // A WebSocket-only page whose socket drops for 120 ms every 1.5 s: the
    // network loses nothing, the page itself drops what it captured meanwhile.
    const down = (nowMs: number) => nowMs > 1_500 && nowMs % 1_500 < 120;
    const { without, withRepair } = await compare({
      name: 'page socket reconnects',
      seconds: 8,
      uplink: clean(40, 10),
      downlink: clean(40, 10),
      paths: (nowMs) => ({ direct: false, control: !down(nowMs) }),
      pageSocketUp: (nowMs) => !down(nowMs),
    });
    assert.ok(without.missing >= 40, `the outages should cost audio: ${without.missing}`);
    assert.ok(
      withRepair.missing <= Math.max(2, without.missing * 0.1),
      `${withRepair.missing} of ${without.missing} unsent packets still heard missing`,
    );
  });

  it('repairs across the uint32 sequence wrap', async () => {
    const { without, withRepair } = await compare({
      name: 'sequence wrap',
      seconds: 6,
      firstSequence: 0xffff_ffff - 250,
      uplink: randomLoss(0.05, 40, 10),
      downlink: clean(40, 10),
    });
    assert.ok(without.missing > 0);
    assert.ok(
      withRepair.missing <= Math.max(2, without.missing * 0.2),
      `${withRepair.missing} of ${without.missing} heard across the wrap`,
    );
  });

  for (const scenario of [
    {
      name: 'a round trip longer than the buffer',
      seconds: 8,
      uplink: randomLoss(0.05, 250, 30),
      downlink: randomLoss(0.05, 250, 30),
    },
    {
      name: '30% loss',
      seconds: 8,
      uplink: randomLoss(0.3, 40, 20),
      downlink: randomLoss(0.3, 40, 20),
    },
    {
      name: 'heavy jitter with loss',
      seconds: 8,
      uplink: randomLoss(0.05, 30, 150),
      downlink: randomLoss(0.05, 30, 150),
    },
  ] satisfies Scenario[]) {
    it(`is never worse than plain loss: ${scenario.name}`, async () => {
      for (const seed of [1, 2, 3]) {
        const { without, withRepair } = await compare(scenario, seed);
        assert.ok(
          withRepair.missing <= without.missing,
          `seed ${seed}: ${withRepair.missing} heard missing with repair vs ${without.missing} without; `
            + `only with repair: ${JSON.stringify(withRepair.missed.filter(([index]) => !without.missed.some(([other]) => other === index)))}`,
        );
      }
    });
  }
});
