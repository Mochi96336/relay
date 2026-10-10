import assert from 'node:assert/strict';
import test from 'node:test';
import { CaptureClockRecovery } from '../public/capture-clock-recovery.js';
const snap = (ms: number, rate = 1, overrides = {}) => ({ nowMs: ms,
  contextTime: ms * rate / 1000, visible: true, contextState: 'running', inputMuted: false, ...overrides });
test('sustained advancing underfed context gets only one replacement per Mic session', () => {
  const recovery = new CaptureClockRecovery();
  assert.equal(recovery.observe(snap(0,.65)),false);
  assert.equal(recovery.observe(snap(5000,.65)),false);
  assert.equal(recovery.observe(snap(10000,.65)),true);
  for(let ms=15000;ms<=60000;ms+=5000) assert.equal(recovery.observe(snap(ms,.65)),false);
  recovery.reset();
  recovery.observe(snap(0,.65)); recovery.observe(snap(5000,.65));
  assert.equal(recovery.observe(snap(10000,.65)),true);
});
test('healthy clocks, brief stalls, frozen clocks and suspended or muted pages do not loop replacements', () => {
  for (const override of [{},{inputMuted:true},{contextState:'suspended'}]) {
    const recovery = new CaptureClockRecovery();
    for(let ms=0;ms<=30000;ms+=5000) assert.equal(recovery.observe(snap(ms,1,override)),false);
  }
  const recovery = new CaptureClockRecovery();
  for(let ms=0;ms<=30000;ms+=5000) assert.equal(recovery.observe(snap(ms,0)),false);
  recovery.reset(); recovery.observe(snap(0));
  assert.equal(recovery.observe(snap(5000,.7)),false);
  assert.equal(recovery.observe(snap(10000)),false);
  assert.equal(recovery.observe(snap(15000)),false);
});

test('a hidden running publisher can recover confirmed clock loss without foregrounding', () => {
  const recovery = new CaptureClockRecovery();
  recovery.observe(snap(0,.65,{visible:false}));
  assert.equal(recovery.observe(snap(5000,.65,{visible:false})),false);
  assert.equal(recovery.observe(snap(10000,.65,{visible:false})),true);
  assert.equal(recovery.observe(snap(15000,.65,{visible:false})),false);
});
