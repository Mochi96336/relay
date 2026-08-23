import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('publisher reports browser-applied capture facts and worklet level as uplink diagnostics', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(
    source,
    /import \{ captureLevelSnapshot, readCaptureSettings \} from '\.\/capture-observability\.js';/,
  );
  assert.match(source, /captureAppliedSettings = readCaptureSettings\(captureStream\);/);

  const payloadStart = source.indexOf('function audioUplinkHealthPayload()');
  const payloadEnd = source.indexOf('function sendAudioUplinkHealth()', payloadStart);
  assert.ok(payloadStart >= 0 && payloadEnd > payloadStart, 'uplink health payload boundary is missing');
  const payload = source.slice(payloadStart, payloadEnd);
  assert.match(payload, /capture:\s*captureAppliedSettings/);
  assert.match(payload, /captureLevel:\s*captureLevelSnapshot\(latestLocalMicLevel\)/);
  assert.doesNotMatch(payload, /start-timing-calibration|micLagMs|confidence/);

  assert.match(source, /captureAppliedSettings = null;/, 'stopping capture must clear applied facts');
});
