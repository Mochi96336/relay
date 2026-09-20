import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('Chrome offscreen turns stale local PCM into a positioned hole', async () => {
  const source = await readFile(
    path.resolve('chrome-tab-audio-probe/offscreen.js'),
    'utf8',
  );

  assert.match(
    source,
    /import \{ classifyTabCaptureDispatch \} from '\.\/capture-dispatch\.js';/,
  );
  assert.match(
    source,
    /captureNode\.port\.postMessage\(\{ type: 'capture-protocol', pcmEnvelope: true \}\)/,
    'new offscreen must explicitly opt into timestamped PCM',
  );

  const cursorAdvance = source.indexOf('captureSampleCursor += samples.length;');
  const classify = source.indexOf('const dispatch = classifyTabCaptureDispatch({');
  const staleDrop = source.indexOf('if (dispatch.stale) {');
  const relaySend = source.indexOf('relaySocket.send(framePcm(buffer, captureGeneration, firstSampleIndex));');

  assert.ok(cursorAdvance >= 0);
  assert.ok(classify > cursorAdvance, 'sample time must advance before age classification');
  assert.ok(staleDrop > classify);
  assert.ok(relaySend > staleDrop, 'stale capture must return before Relay framing');
});

test('Chrome extension keeps capture backlog separate from WebSocket congestion', async () => {
  const source = await readFile(
    path.resolve('chrome-tab-audio-probe/service-worker.js'),
    'utf8',
  );

  assert.match(source, /message\.type === 'capture-backlog'/);
  assert.match(source, /capture backlog: dropped/);
  assert.match(source, /uplink congestion: dropped/);
});
