import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const bridgeSource = readFileSync(new URL('../src/backing-stdin.ts', import.meta.url), 'utf8');

test('Robot backing boundary is answered from the PCM socket capture cursor', () => {
  assert.match(bridgeSource, /message\.type === 'backing-sample-boundary-request'/);
  assert.match(bridgeSource, /type: 'backing-sample-boundary'/);
  assert.match(bridgeSource, /generation,\s*firstSampleIndex: sampleCursor,/s);
  assert.doesNotMatch(bridgeSource, /firstSampleIndex:\s*(Date|performance)\./);
});

test('Robot song clock follows the PCM it timestamps, and only when that PCM was sent', () => {
  const sendPcm = bridgeSource.slice(bridgeSource.indexOf('function sendPcm('), bridgeSource.indexOf('function consume('));
  const frameSent = sendPcm.indexOf('socket.send(frame);');
  const clockSent = sendPcm.indexOf("type: 'backing-song-clock'");
  assert.ok(frameSent > 0 && clockSent > 0, 'sendPcm sends both');
  // Sent first, the clock named a sample the server did not hold yet, and
  // the refresh it triggered lapsed the sample/song fallback every 250 ms.
  assert.ok(frameSent < clockSent, 'the clock is sent after its frame');
  const dropped = sendPcm.indexOf('droppedFrames += 1;');
  assert.ok(dropped > 0 && sendPcm.indexOf('return;', dropped) < clockSent, 'a dropped frame returns before any clock');
  assert.match(sendPcm, /sampleIndex: firstSampleIndex \+ pcm\.byteLength \/ 2/);
});
