import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MONITOR_PCM_PACKET_VERSION,
  createMonitorPcmReceiver,
  decodeMonitorPcmFrame,
} from '../public/monitor-pcm-continuity.js';

const HEADER_BYTES = 16;
const FRAME_SAMPLES = 960;

function framed(
  generation: number,
  firstSampleIndex: number,
  sampleCount = FRAME_SAMPLES,
  overrides: { version?: number; flags?: number; trailingByte?: boolean } = {},
) {
  const trailing = overrides.trailingByte ? 1 : 0;
  const buffer = new ArrayBuffer(HEADER_BYTES + sampleCount * Int16Array.BYTES_PER_ELEMENT + trailing);
  const view = new DataView(buffer);
  view.setUint16(0, 0x4c52, true);
  view.setUint8(2, overrides.version ?? MONITOR_PCM_PACKET_VERSION);
  view.setUint8(3, overrides.flags ?? 0);
  view.setUint32(4, generation, true);
  view.setFloat64(8, firstSampleIndex, true);
  return buffer;
}

test('monitor frame decoder strips the transport header and preserves mix position', () => {
  const frame = decodeMonitorPcmFrame(framed(7, 12_480));
  assert.ok(frame);
  assert.equal(frame.generation, 7);
  assert.equal(frame.firstSampleIndex, 12_480);
  assert.equal(frame.sampleCount, FRAME_SAMPLES);
  assert.equal(frame.pcm.byteLength, FRAME_SAMPLES * Int16Array.BYTES_PER_ELEMENT);
});

test('the first packet may join an existing generation at any sample index', () => {
  const receiver = createMonitorPcmReceiver();
  const first = receiver.receive(framed(4, 96_000));

  assert.equal(first.action, 'accept');
  assert.equal(first.reset, false);
  assert.equal(first.reason, 'first');
  assert.deepEqual(receiver.snapshot(), {
    generation: 4,
    expectedSampleIndex: 96_000 + FRAME_SAMPLES,
  });
});

test('contiguous positioned PCM advances without resetting playback', () => {
  const receiver = createMonitorPcmReceiver();
  receiver.receive(framed(2, 0));
  const next = receiver.receive(framed(2, FRAME_SAMPLES));

  assert.equal(next.action, 'accept');
  assert.equal(next.reset, false);
  assert.equal(next.reason, 'contiguous');
  assert.equal(next.gapSamples, 0);
});

test('a forward sample-index gap requests realtime catch-up from the newest frame', () => {
  const receiver = createMonitorPcmReceiver();
  receiver.receive(framed(2, 0));
  const afterDrop = receiver.receive(framed(2, FRAME_SAMPLES * 2));

  assert.equal(afterDrop.action, 'accept');
  assert.equal(afterDrop.reset, true);
  assert.equal(afterDrop.reason, 'gap');
  assert.equal(afterDrop.gapSamples, FRAME_SAMPLES);
  assert.deepEqual(receiver.snapshot(), {
    generation: 2,
    expectedSampleIndex: FRAME_SAMPLES * 3,
  });
});

test('a stale or duplicate frame is dropped without moving the realtime frontier backward', () => {
  const receiver = createMonitorPcmReceiver();
  receiver.receive(framed(9, 10_000));
  receiver.receive(framed(9, 10_000 + FRAME_SAMPLES));

  const stale = receiver.receive(framed(9, 10_000));
  assert.equal(stale.action, 'drop');
  assert.equal(stale.reason, 'stale');
  assert.deepEqual(receiver.snapshot(), {
    generation: 9,
    expectedSampleIndex: 10_000 + FRAME_SAMPLES * 2,
  });
});

test('a new mix generation resets queued audio before accepting its first frame', () => {
  const receiver = createMonitorPcmReceiver();
  receiver.receive(framed(5, 20_000));

  const replacement = receiver.receive(framed(6, 0));
  assert.equal(replacement.action, 'accept');
  assert.equal(replacement.reset, true);
  assert.equal(replacement.reason, 'generation');
  assert.equal(replacement.gapSamples, 0);
});

test('transport reset makes reconnect mid-generation a fresh anchor instead of a fake gap', () => {
  const receiver = createMonitorPcmReceiver();
  receiver.receive(framed(3, 0));
  receiver.reset();

  const reconnect = receiver.receive(framed(3, 200_000));
  assert.equal(reconnect.action, 'accept');
  assert.equal(reconnect.reset, false);
  assert.equal(reconnect.reason, 'first');
});

test('malformed negotiated frames are dropped rather than falling back to raw PCM', () => {
  const receiver = createMonitorPcmReceiver();

  assert.deepEqual(receiver.receive(framed(1, 0, FRAME_SAMPLES, { version: 9 })), {
    action: 'drop',
    reason: 'malformed',
  });
  assert.deepEqual(receiver.receive(framed(1, 0, FRAME_SAMPLES, { flags: 1 })), {
    action: 'drop',
    reason: 'malformed',
  });
  assert.deepEqual(receiver.receive(framed(1, 0, FRAME_SAMPLES, { trailingByte: true })), {
    action: 'drop',
    reason: 'malformed',
  });
  assert.deepEqual(receiver.receive(new ArrayBuffer(8)), {
    action: 'drop',
    reason: 'malformed',
  });
});
