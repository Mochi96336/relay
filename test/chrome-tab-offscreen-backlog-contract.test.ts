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

test('Chrome offscreen drops song chunks beyond 200 ms of socket backlog, like the other PCM uplinks', async () => {
  const source = await readFile(
    path.resolve('chrome-tab-audio-probe/offscreen.js'),
    'utf8',
  );
  assert.doesNotMatch(source, /512 \* 1024/, 'a byte ceiling allowed seconds of stale song');

  const start = source.indexOf('const REALTIME_BACKLOG_MS');
  const end = source.indexOf('function relayWsUrl');
  assert.ok(start >= 0 && end > start);
  const wouldExceed = new Function(
    `${source.slice(start, end)}; return realtimeFrameWouldExceedBacklog;`,
  )() as (bufferedAmount: number, frameBytes: number, sampleRate?: number) => boolean;

  const frameBytes = 16 + 960 * 2;
  assert.equal(wouldExceed(0, frameBytes, 48_000), false);
  assert.equal(wouldExceed(19_200 - frameBytes, frameBytes, 48_000), false, '200 ms of PCM16 fits');
  assert.equal(wouldExceed(19_200 - frameBytes + 1, frameBytes, 48_000), true);
  assert.equal(wouldExceed(17_000, frameBytes, 96_000), false, 'the budget is time, not bytes');
  assert.equal(wouldExceed(0, 64_000, 48_000), false, 'one oversized frame still goes out on an idle socket');

  const guard = source.indexOf('if (realtimeFrameWouldExceedBacklog(');
  const relaySend = source.indexOf('relaySocket.send(framePcm(buffer, captureGeneration, firstSampleIndex));');
  assert.ok(guard >= 0 && relaySend > guard, 'every song chunk passes the realtime budget before it is sent');
});
