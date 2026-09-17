import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('phone command liveness uses request-correlated health ACK age', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(
    source,
    /import \{ PublisherHealthRequestCorrelation \} from '\.\/publisher-health-correlation\.js';/,
    'the publisher page must use the bounded request-correlation helper',
  );
  assert.match(
    source,
    /const publisherHealthCorrelation = new PublisherHealthRequestCorrelation\(\);/,
  );
  assert.match(
    source,
    /function audioUplinkHealthPayload\(healthRequestId\)[\s\S]*healthRequestId,/,
    'each health report must carry its browser-generated correlation token',
  );
  assert.match(
    source,
    /function sendAudioUplinkHealth\(\)[\s\S]*const currentSocket = socket;[\s\S]*const generation = captureGeneration >>> 0;[\s\S]*const sessionEpoch = publisherSessionEpoch;[\s\S]*const sentAtMs = performance\.now\(\);[\s\S]*publisherHealthCorrelation\.issue\(\{[\s\S]*socket: currentSocket,[\s\S]*sessionEpoch,[\s\S]*generation,[\s\S]*sentAtMs,[\s\S]*\}\)/,
    'health correlation must snapshot physical socket, session, generation, and browser monotonic send time',
  );
  assert.match(
    source,
    /audioTransport\.sendControlJson\(audioUplinkHealthPayload\(healthRequestId\)\)[\s\S]*if \(!result\.sent\) publisherHealthCorrelation\.forget\(healthRequestId\);/,
    'only successfully submitted health reports may remain pending for ACK authority',
  );
  assert.match(
    source,
    /message\.type === 'audio-uplink-health-ack'[\s\S]*const healthRequestId = message\.healthRequestId;[\s\S]*const ackAtMs = performance\.now\(\);[\s\S]*Number\.isInteger\(healthRequestId\)[\s\S]*healthRequestId > 0xffff_ffff/,
    'ACK correlation tokens must be validated as uint32 before authority lookup',
  );
  assert.match(
    source,
    /publisherHealthCorrelation\.consume\(\{[\s\S]*requestId: healthRequestId,[\s\S]*socket,[\s\S]*sessionEpoch,[\s\S]*generation: ackGeneration,[\s\S]*\}\)/,
    'ACK must resolve only against the current physical socket/session/capture request',
  );
  assert.match(
    source,
    /requestSentAtMs === null[\s\S]*publisherCommandLiveness\.noteAck\(ackGeneration, ackAtMs, requestSentAtMs\)/,
    'command freshness must be aged from the correlated request send time, not ACK arrival',
  );
});
