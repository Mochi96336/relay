import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countUplinkDrop,
  forgetUnsettledUplinkHealth,
  noteCaptureClipping,
  noteCaptureDispatch,
  noteUplinkHealthSent,
  resetUplinkEvidence,
  settleCaptureClippingHealth,
  uplinkEvidenceReport,
} from '../public/uplink-evidence.js';
import { captureClippingSnapshot } from '../public/capture-observability.js';

function level(windowMaxConsecutiveRailSamples: number) {
  return { railSamples: 10, maxConsecutiveRailSamples: 6, windowMaxConsecutiveRailSamples };
}
const CLIPPED = level(5);
const CLEAN = level(0);

function windowSeen(windowLevel: ReturnType<typeof level>) {
  noteCaptureClipping(captureClippingSnapshot(windowLevel));
}

function recentClipping() {
  return uplinkEvidenceReport(CLEAN).captureClipping?.recentDetected;
}

test('dropped audio is counted by reason', () => {
  resetUplinkEvidence();
  countUplinkDrop(960, 'disconnected');
  countUplinkDrop(480, 'congested');
  countUplinkDrop(240, 'packet-too-large');
  countUplinkDrop(960, 'capture-backlog');
  countUplinkDrop(0, 'congested');
  countUplinkDrop(Number.NaN, 'congested');

  assert.deepEqual(uplinkEvidenceReport(null).droppedSamples, {
    total: 2_640, disconnected: 960, congested: 480, packetTooLarge: 240, captureBacklog: 960,
  });
});

test('how late chunks reach the page is reported, and an unmeasurable chunk changes nothing', () => {
  resetUplinkEvidence();
  noteCaptureDispatch({ measurable: false, lagMs: null, stale: false });
  assert.equal(uplinkEvidenceReport(null).captureDispatch, null);

  noteCaptureDispatch({ measurable: true, lagMs: 512.4, stale: true });
  assert.equal(uplinkEvidenceReport(null).captureDispatch?.backlogActive, true);
  noteCaptureDispatch({ measurable: true, lagMs: 20.6, stale: false });
  assert.deepEqual(uplinkEvidenceReport(null).captureDispatch, {
    lagMs: 21, maxLagMs: 512, backlogMs: 400, backlogActive: false,
  });
});

test('a worklet without window clipping evidence reports no recent clipping either way', () => {
  resetUplinkEvidence();
  noteCaptureClipping(captureClippingSnapshot({ railSamples: 10, maxConsecutiveRailSamples: 6 }));
  assert.equal(recentClipping(), undefined);
  windowSeen(CLEAN);
  assert.equal(recentClipping(), false);
});

test('clipping stays reported until the Relay acknowledges a report that carried it', () => {
  resetUplinkEvidence();
  windowSeen(CLIPPED);
  windowSeen(CLEAN);
  assert.equal(recentClipping(), true, 'a clean window does not erase a clipped one');

  noteUplinkHealthSent(1, 1_000);
  assert.equal(recentClipping(), true, 'sent is not acknowledged');
  assert.equal(settleCaptureClippingHealth(1), true);
  assert.equal(recentClipping(), false);
});

test('a late acknowledgement does not clear clipping that happened after its report left', () => {
  resetUplinkEvidence();
  windowSeen(CLIPPED);
  noteUplinkHealthSent(1, 1_000);
  windowSeen(CLIPPED);
  assert.equal(settleCaptureClippingHealth(1), true);
  assert.equal(recentClipping(), true);

  noteUplinkHealthSent(2, 2_000);
  assert.equal(settleCaptureClippingHealth(2), true);
  assert.equal(recentClipping(), false);
});

test('acknowledging a report retires the older ones still waiting', () => {
  resetUplinkEvidence();
  windowSeen(CLIPPED);
  noteUplinkHealthSent(1, 1_000);
  noteUplinkHealthSent(2, 2_000);
  assert.equal(settleCaptureClippingHealth(2), true);
  assert.equal(settleCaptureClippingHealth(1), false);
  assert.equal(settleCaptureClippingHealth(99), false, 'never sent');
});

test('reports from a connection that is gone can no longer settle anything, and the evidence stays', () => {
  resetUplinkEvidence();
  windowSeen(CLIPPED);
  noteUplinkHealthSent(1, 1_000);
  forgetUnsettledUplinkHealth();
  assert.equal(settleCaptureClippingHealth(1), false);
  assert.equal(recentClipping(), true);
});

test('a new capture starts with no evidence', () => {
  resetUplinkEvidence();
  countUplinkDrop(960, 'capture-backlog');
  noteCaptureDispatch({ measurable: true, lagMs: 600, stale: true });
  windowSeen(CLIPPED);
  noteUplinkHealthSent(1, 1_000);

  resetUplinkEvidence();
  const report = uplinkEvidenceReport(CLEAN);
  assert.deepEqual(report.droppedSamples, {
    total: 0, disconnected: 0, congested: 0, packetTooLarge: 0, captureBacklog: 0,
  });
  assert.equal(report.captureDispatch, null);
  assert.equal(report.captureClipping?.recentDetected, undefined);
  assert.equal(settleCaptureClippingHealth(1), false);
});
