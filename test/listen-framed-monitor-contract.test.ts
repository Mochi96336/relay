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
    /import \{ createStreamingResampler \} from '\.\/streaming-resampler\.js';/,
    'Listen must use the stateful positioned resampler instead of packet-local interpolation',
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
  assert.match(
    messageSection,
    /if \(finishAudioInterruptionEvidence\(\)\) \{[\s\S]*restartMonitorAtLiveEdge\(\);[\s\S]*return;/,
    'a recovered PCM frame must settle interruption evidence before it can reach the AudioWorklet',
  );
  assert.match(
    messageSection,
    /if \(received\.reset\) \{[\s\S]*listenResampler\.reset\(\)[\s\S]*type: 'reset', deClick: true[\s\S]*\}/,
    'a forward gap or generation boundary must fence resampler history before discarding queued stale audio',
  );
  assert.match(messageSection, /int16ToFloat32\(received\.frame\.pcm\)/,
    'the transport header must be stripped before PCM conversion');
  assert.match(
    messageSection,
    /listenResampler\.resample\(pcm, \{[\s\S]*sourceRate: sourceSampleRate,[\s\S]*targetRate: audioContext\.sampleRate,[\s\S]*firstSampleIndex: received\.frame\.firstSampleIndex,[\s\S]*\}\)/,
    'Listen resampling must stay anchored to the positioned monitor frame clock',
  );
  assert.doesNotMatch(source, /function linearResample\(/,
    'packet-local resampling must not remain beside the streaming resampler');
  assert.doesNotMatch(messageSection, /int16ToFloat32\(event\.data\)/,
    'framed bytes must never fall back to raw PCM');

  const recoveryIndex = messageSection.indexOf('if (finishAudioInterruptionEvidence())');
  const resetIndex = messageSection.indexOf('if (received.reset) {');
  const pcmIndex = messageSection.indexOf('int16ToFloat32(received.frame.pcm)');
  const pushIndex = messageSection.indexOf('playbackNode.port.postMessage(samples.buffer');
  assert.ok(
    recoveryIndex >= 0 && resetIndex > recoveryIndex && pcmIndex > resetIndex && pushIndex > pcmIndex,
    'interruption evidence and catch-up must settle before the recovered frame is converted and pushed',
  );
});

test('transport boundaries reset both positioned continuity and the AudioWorklet queue', async () => {
  const source = await readFile(new URL('../public/listen.js', import.meta.url), 'utf8');
  const resetSection = section(
    source,
    'function resetPlaybackTemporalState(deClick = false)',
    'function abandonTransportConnection(deClickPlayback = false)',
  );
  const abandonSection = section(
    source,
    'function abandonTransportConnection(deClickPlayback = false)',
    'function closeTransport()',
  );
  const closeSection = section(source, 'function closeTransport()', 'function scheduleReconnect()');
  const connectSection = section(source, 'async function connect()', '/**\n   * Requests a resume');

  assert.match(
    resetSection,
    /monitorPcmReceiver\.reset\(\)[\s\S]*listenResampler\.reset\(\)[\s\S]*postMessage\(\{ type: 'reset', deClick \}\)/,
    'one helper must clear positioned continuity, resampler history and queued worklet audio together while preserving the requested de-click policy',
  );
  assert.match(abandonSection, /transportEpoch \+= 1;[\s\S]*resetPlaybackTemporalState\(deClickPlayback\)/,
    'abandoning a transport connection must invalidate its epoch and forward the audible reset policy');
  assert.match(closeSection, /transportEnabled = false;[\s\S]*abandonTransportConnection\(audioRendering\(\)\)/,
    'an audible explicit transport close must discard queued PCM with the worklet de-click path');
  assert.match(
    connectSection,
    /resetPlaybackTemporalState\(audioRendering\(\)\)[\s\S]*sendParticipantAuthentication\(next\)/,
    'a reconnect can land while the old stream is still audible, so its reset de-clicks while rendering',
  );
});
