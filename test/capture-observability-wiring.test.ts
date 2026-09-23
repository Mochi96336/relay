import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('publisher reports browser-applied capture facts and worklet level as uplink diagnostics', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(
    source,
    /captureClippingSnapshot,[\s\S]*captureInputClippingDetected,[\s\S]*captureRecentInputClippingDetected,[\s\S]*captureLevelSnapshot,[\s\S]*captureVoiceProcessingActive,[\s\S]*enforceUnprocessedCapture,[\s\S]*readCaptureSettings/,
  );
  assert.match(source, /enforceUnprocessedCapture\(preparedStream\)/);
  assert.match(source, /captureAppliedSettings = readCaptureSettings\(captureStream\);/);
  assert.match(source, /captureVoiceProcessingActive\(captureAppliedSettings\)/);
  assert.match(source, /captureInputClippingDetected\(clipping\)/);
  assert.match(source, /adjust\.inputClipping/);
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
  assert.match(payload, /captureClipping:\s*captureClippingHealthSnapshot\(\)/);
  assert.doesNotMatch(payload, /start-timing-calibration|micLagMs|confidence/);

  assert.match(source, /captureAppliedSettings = null;/, 'stopping capture must clear applied facts');
});

test('server uses recent clipping only as product quality truth, never timing authority', async () => {
  const serverSource = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const productStart = serverSource.indexOf('function productStatusPayload(');
  const productEnd = serverSource.indexOf('let lastProductStatusJson', productStart);
  assert.ok(productStart >= 0 && productEnd > productStart);
  const product = serverSource.slice(productStart, productEnd);
  assert.match(
    product,
    /micInputClipping:\s*freshMicUplink\?\.captureClipping\?\.recentDetected === true/,
    'fresh browser flat-top evidence may degrade product health',
  );

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
