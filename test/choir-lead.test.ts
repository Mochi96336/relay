import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChoirLead } from '../src/choir-lead.js';

const settled = (lead: ChoirLead, reportedMs: number, anchors = 4) => {
  for (let i = 0; i < anchors; i++) lead.anchor(reportedMs);
};

test('a B far behind the room is moved ahead to just under zero lag, once', () => {
  const lead = new ChoirLead();
  // 2026-10-31: B's YouTube-time lag was 1505 ms; the mixer absorbs 200.
  settled(lead, 0);
  assert.equal(lead.update(1505), 1610);
  assert.equal(lead.leadMs, 1610);
  // B has not moved yet: the same measurement must not move it again.
  assert.equal(lead.update(1505), null);
  settled(lead, 0);
  assert.equal(lead.update(1505), null, 'anchors at the old lead never count');
  assert.equal(lead.mismatched, true);
  // B moved: its lag is now about the target, inside the band.
  settled(lead, 1610, 3);
  assert.equal(lead.update(-95), null, 'three anchors are not yet settled');
  lead.anchor(1610);
  assert.equal(lead.update(-95), null);
  assert.equal(lead.appliedMs, 1610);
  assert.equal(lead.mismatched, false);
});

test('the lead moves only outside the band, and never below zero', () => {
  const lead = new ChoirLead();
  settled(lead, 0);
  for (const lag of [100, 0, -100, -600]) assert.equal(lead.update(lag), null, `${lag} is inside`);
  assert.equal(lead.update(-900), null, 'already at no lead');
  assert.equal(lead.update(160), 260);
  settled(lead, 260);
  assert.equal(lead.update(-900), 0, 'far ahead: back toward the room');
  settled(lead, 0);
  assert.equal(lead.update(Number.NaN), null);
  assert.equal(lead.update(null), null);
});

test('a reset starts B at the room again', () => {
  const lead = new ChoirLead();
  settled(lead, 0);
  lead.update(900);
  lead.reset();
  assert.equal(lead.leadMs, 0);
  assert.equal(lead.appliedMs, 0);
  assert.equal(lead.update(900), null, 'a reset needs settled anchors again');
});
