import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function section(source: string, startText: string, endText: string) {
  const start = source.indexOf(startText);
  assert.ok(start >= 0, `${startText} is missing`);
  const end = source.indexOf(endText, start + startText.length);
  assert.ok(end > start, `${endText} is missing after ${startText}`);
  return source.slice(start, end);
}

test('Listen explicitly negotiates positioned monitor PCM', async () => {
  const source = await readFile(new URL('../public/listen.js', import.meta.url), 'utf8');

  assert.match(
    source,
    /import \{[\s\S]*MONITOR_PCM_PACKET_VERSION,[\s\S]*createMonitorPcmReceiver,[\s\S]*\} from '\.\/monitor-pcm-continuity\.js';/,
  );
  assert.match(
    source,
    /type: 'register',[\s\S]*role: 'monitor',[\s\S]*monitorPacketVersion: MONITOR_PCM_PACKET_VERSION/,
    'Listen must opt in explicitly so legacy raw monitor clients remain compatible',
  );
});

test('Listen catches up on explicit timeline gaps before enqueueing the newest frame', async () => {
  const source = await readFile(new URL('../public/listen.js', import.meta.url), 'utf8');
  const messageSection = section(
    source,
    "next.addEventListener('message'",
    "next.addEventListener('close'",
  );

  assert.match(messageSection, /monitorPcmReceiver\.receive\(event\.data\)/);
  assert.match(messageSection, /if \(received\.action !== 'accept'\) return/,
    'stale or malformed negotiated packets must never reach playback');
  assert.match(messageSection, /if \(received\.reset\) playbackNode\.port\.postMessage\(\{ type: 'reset' \}\)/,
    'a forward gap or generation boundary must discard queued stale audio');
  assert.match(messageSection, /int16ToFloat32\(received\.frame\.pcm\)/,
    'the transport header must be stripped before PCM conversion');
  assert.doesNotMatch(messageSection, /int16ToFloat32\(event\.data\)/,
    'framed bytes must never fall back to raw PCM');

  const resetIndex = messageSection.indexOf("if (received.reset) playbackNode.port.postMessage({ type: 'reset' });");
  const pcmIndex = messageSection.indexOf('int16ToFloat32(received.frame.pcm)');
  const pushIndex = messageSection.indexOf('playbackNode.port.postMessage(samples.buffer');
  assert.ok(resetIndex >= 0 && pcmIndex > resetIndex && pushIndex > pcmIndex,
    'catch-up must clear the stale queue before the newest positioned audio is converted and pushed');
});

test('transport boundaries reset both positioned continuity and the AudioWorklet queue', async () => {
  const source = await readFile(new URL('../public/listen.js', import.meta.url), 'utf8');
  const resetSection = section(source, 'function resetPlaybackTemporalState()', 'function abandonTransportConnection()');
  const abandonSection = section(source, 'function abandonTransportConnection()', 'function closeTransport()');
  const closeSection = section(source, 'function closeTransport()', 'function scheduleReconnect()');
  const connectSection = section(source, 'async function connect()', '/**\n   * Requests a resume');

  assert.match(resetSection, /monitorPcmReceiver\.reset\(\)[\s\S]*type: 'reset'/,
    'one helper must clear positioned continuity and queued worklet audio together');
  assert.match(abandonSection, /transportEpoch \+= 1;[\s\S]*resetPlaybackTemporalState\(\)/,
    'abandoning a transport connection must invalidate its epoch and temporal state');
  assert.match(closeSection, /transportEnabled = false;[\s\S]*abandonTransportConnection\(\)/,
    'an explicit transport close must revoke transport intent before abandoning the connection');
  assert.match(connectSection, /resetPlaybackTemporalState\(\)[\s\S]*sendParticipantAuthentication\(next\)/,
    'a reconnect may join mid-generation and therefore needs a fresh continuity anchor before registration');
});
