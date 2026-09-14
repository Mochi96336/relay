import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AudioSession } from '../src/audio-session.js';

const RATE = 48_000;

function pcm(value: number, samples = 960) {
  const buffer = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) buffer.writeInt16LE(value, index * 2);
  return buffer;
}

function frame(generation: number, firstSampleIndex: number, value: number) {
  return { generation, firstSampleIndex, pcm: pcm(value) };
}

test('Backing registration metadata preserves continuation but detects same-id cursor rewind', () => {
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: 20,
    prebufferMs: 0,
    backingGain: 0.65,
    retentionMs: 3_000,
  });
  session.start(0);
  session.ingestMic(frame(2, 0, 222), RATE, 0);
  session.ingestBacking(frame(7, 0, 111), RATE, 100);
  session.ingestBacking(frame(7, 960, 111), RATE, 120);

  assert.equal(session.backingCaptureReplacedBy({
    generation: 7,
    sourceRate: RATE,
    sampleCursor: 1_920,
  }), false, 'same capture reconnect may resume at or ahead of the stored source frontier');
  assert.equal(session.backingCaptureReplacedBy({
    generation: 7,
    sourceRate: RATE,
    sampleCursor: 0,
  }), true, 'rewinding the same numeric capture identity proves a replacement at transport bind');
  assert.equal(session.backingCaptureReplacedBy({
    generation: 8,
    sourceRate: RATE,
    sampleCursor: 1_920,
  }), true);
  assert.equal(session.backingCaptureReplacedBy({
    generation: 7,
    sourceRate: 44_100,
    sampleCursor: 1_920,
  }), true);
});

test('proven Backing replacement retires only Backing and reports restart on first real PCM', () => {
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: 20,
    prebufferMs: 0,
    backingGain: 0.65,
    retentionMs: 3_000,
  });
  session.start(0);
  session.ingestMic(frame(2, 0, 222), RATE, 0);
  session.ingestBacking(frame(7, 0, 111), RATE, 100);
  const mixGeneration = session.generation;

  session.retireBackingCapture();
  assert.equal(session.backingGeneration, null);
  assert.equal(session.micGeneration, 2);
  assert.equal(session.generation, mixGeneration);
  assert.equal(session.readMic(0, 1)[0], 222);

  const replacement = session.ingestBacking(frame(7, 0, 333), RATE, 500);
  assert.equal(replacement.samples.length, 960);
  assert.equal(replacement.captureRestarted, true);
  assert.equal(session.generation, mixGeneration);
  assert.equal(session.micGeneration, 2);

  const continuation = session.ingestBacking(frame(7, 960, 444), RATE, 520);
  assert.equal(continuation.captureRestarted, false, 'bind-time restart fact is one-shot');
});

test('production Backing senders publish capture generation and cursor at registration', () => {
  const stdin = readFileSync(new URL('../src/backing-stdin.ts', import.meta.url), 'utf8');
  const offscreen = readFileSync(new URL('../chrome-tab-audio-probe/offscreen.js', import.meta.url), 'utf8');
  assert.match(stdin, /captureGeneration: generation/);
  assert.match(stdin, /captureSampleCursor: sampleCursor/);
  assert.match(offscreen, /captureGeneration,/);
  assert.match(offscreen, /captureSampleCursor,/);
});

test('server validates capture metadata as a pair and retires only proven replacement PCM', () => {
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(server, /hasCaptureGeneration !== hasCaptureSampleCursor/);
  assert.match(server, /validCaptureGeneration\(payload\.captureGeneration\)/);
  assert.match(server, /validSampleCursor\(payload\.captureSampleCursor\)/);
  assert.match(server, /session\.backingCaptureReplacedBy\(\{/);
  assert.match(server, /retireReplacedCapture: \(\) => session\.retireBackingCapture\(\)/);
  assert.match(server, /captureReplaced,/);
});
