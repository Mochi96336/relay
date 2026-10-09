import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('publisher reports browser-applied capture facts and worklet level as uplink diagnostics', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(
    source,
    /captureClippingSnapshot,[\s\S]*captureLevelSnapshot,[\s\S]*enforceUnprocessedCapture,[\s\S]*readCaptureSettings/,
  );
  assert.match(source, /enforceUnprocessedCapture\(preparedStream\)/);
  assert.match(source, /captureAppliedSettings = readCaptureSettings\(captureStream\);/);
  assert.match(
    source,
    /addEventListener\('configurationchange', refreshCaptureConfiguration\)/,
    'browser capture-unit changes must refresh the applied processing truth',
  );
  assert.match(
    source,
    /refreshCaptureConfiguration[\s\S]*enforceUnprocessedCapture\(captureStream\)[\s\S]*captureAppliedSettings = readCaptureSettings\(captureStream\)[\s\S]*sendAudioUplinkHealth\(\)/,
  );

  const payloadStart = source.indexOf('function audioUplinkHealthPayload(');
  const payloadEnd = source.indexOf('function sendAudioUplinkHealth()', payloadStart);
  assert.ok(payloadStart >= 0 && payloadEnd > payloadStart, 'uplink health payload boundary is missing');
  const payload = source.slice(payloadStart, payloadEnd);
  assert.match(payload, /capture:\s*captureAppliedSettings/);
  assert.match(payload, /captureLevel:\s*captureLevelSnapshot\(latestLocalMicLevel\)/);
  assert.match(payload, /\.\.\.uplinkEvidenceReport\(latestLocalMicLevel\)/);
  assert.doesNotMatch(payload, /start-timing-calibration|micLagMs|confidence/);

  assert.match(source, /noteCaptureClipping\(clipping\)/, 'each level window reaches the clipping evidence');
  assert.match(
    source,
    /\} else \{\s*noteUplinkHealthSent\(healthRequestId, sentAtMs\);/,
    'sent health must retain its clipping revision until Relay acknowledges it',
  );
  assert.match(
    source,
    /audio-uplink-health-ack'[\s\S]*publisherCommandLiveness\.noteAck[\s\S]*settleCaptureClippingHealth\(healthRequestId\)/,
    'only an accepted correlated health ACK may settle the clipping interval',
  );
  assert.match(
    source,
    /function resetPublisherHealthRequestCorrelation\(\)[\s\S]*publisherCommandLiveness\.reset\(\);[\s\S]*forgetUnsettledUplinkHealth\(\);/,
    'command authority reset must retire clipping request ids whose ACKs can no longer be accepted',
  );
  assert.equal(
    (source.match(/resetPublisherHealthRequestCorrelation\(\);/g) ?? []).length,
    4,
    'socket adoption, close, replacement and stop must share the same health-correlation reset',
  );
  assert.equal(
    (source.match(/publisherCommandLiveness\.reset\(\);/g) ?? []).length,
    1,
    'raw command-liveness reset must exist only inside the shared correlation helper',
  );

  assert.match(source, /captureAppliedSettings = null;/, 'stopping capture must clear applied facts');
});

test('server uses recent clipping only as product quality truth, never timing authority', async () => {
  // That fresh flat-top evidence degrades product health is a ProductStatus
  // projection rule, tested as behaviour in relay-status-projection.test.ts.
  const serverSource = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');

  const takeQualityStart = serverSource.indexOf('function takeQualityFrameState(');
  const takeQualityEnd = serverSource.indexOf('function micUplinkHealthPayload(', takeQualityStart);
  assert.ok(takeQualityStart >= 0 && takeQualityEnd > takeQualityStart);
  assert.doesNotMatch(
    serverSource.slice(takeQualityStart, takeQualityEnd),
    /capture(?:Level|Clipping)/,
    'input clipping must not silently become mixed-frame Take quality or timing authority',
  );

  const calibrationApplyStart = serverSource.indexOf('function syncAppliedCalibration(');
  const calibrationApplyEnd = serverSource.indexOf('function sourceStatusPayload(', calibrationApplyStart);
  assert.ok(calibrationApplyStart >= 0 && calibrationApplyEnd > calibrationApplyStart);
  assert.doesNotMatch(
    serverSource.slice(calibrationApplyStart, calibrationApplyEnd),
    /capture(?:Level|Clipping)/,
    'capture diagnostics must not steer calibration application',
  );
});
