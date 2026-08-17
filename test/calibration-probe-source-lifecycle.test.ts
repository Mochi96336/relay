import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('robot backing probe loses authority before a late AudioContext resume can enter the mix', async () => {
  const source = await readFile(new URL('../public/source.js', import.meta.url), 'utf8');

  assert.match(source, /let activeBackingProbeRequestId = null/);
  assert.match(source, /activeBackingProbeRequestId = requestId;[\s\S]*playBackingProbe\(requestId/,
    'each backing request must install an explicit local authority token');
  assert.match(source, /await context\.resume\(\);[\s\S]*activeBackingProbeRequestId !== requestId/,
    'a late resume must re-check the request before scheduling backing-path oscillators');
  assert.match(source, /message\.probePhase !== 'backing-requested'[\s\S]*activeBackingProbeRequestId = null/,
    'canonical server probe phase must retire timed-out or advanced backing requests');
  assert.match(source, /function parkSupersededRobot\(\)[\s\S]*activeBackingProbeRequestId = null/,
    'source replacement must retire any old backing probe');
  assert.match(source, /next\.addEventListener\('close'[\s\S]*activeBackingProbeRequestId = null/,
    'losing the source-control socket must retire the pending backing probe');
});
