import assert from 'node:assert/strict';
import test from 'node:test';

import { BackingPcmFramer } from '../src/backing-pcm-framer.js';

/** Little-endian Int16 PCM whose sample n is 1000 + n: misalignment is visible. */
function rampBytes(firstSample: number, count: number) {
  const bytes = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i += 1) bytes.writeInt16LE(1000 + firstSample + i, i * 2);
  return bytes;
}

function samples(frame: Buffer) {
  const values: number[] = [];
  for (let offset = 0; offset < frame.byteLength; offset += 2) values.push(frame.readInt16LE(offset));
  return values;
}

test('an odd-length chunk during the startup flush does not misalign later PCM', () => {
  const framer = new BackingPcmFramer({ frameBytes: 8, startupFlushMs: 250 });
  const stream = rampBytes(0, 40);

  // The flush swallows 13 bytes: six samples and the first byte of the seventh.
  assert.deepEqual(framer.push(stream.subarray(0, 13), 0), { frames: [], flushEndedAfterBytes: null });
  const after = framer.push(stream.subarray(13), 300);

  assert.equal(after.flushEndedAfterBytes, 13);
  // Sample 7's orphaned high byte is dropped; framing resumes at sample 8.
  assert.deepEqual(after.frames.map(samples), [
    [1007, 1008, 1009, 1010],
    [1011, 1012, 1013, 1014],
    [1015, 1016, 1017, 1018],
    [1019, 1020, 1021, 1022],
    [1023, 1024, 1025, 1026],
    [1027, 1028, 1029, 1030],
    [1031, 1032, 1033, 1034],
    [1035, 1036, 1037, 1038],
  ]);
  assert.deepEqual(samples(framer.takeTail()!), [1039]);
});

test('an even-length flush keeps every later sample', () => {
  const framer = new BackingPcmFramer({ frameBytes: 4, startupFlushMs: 250 });
  const stream = rampBytes(0, 6);
  framer.push(stream.subarray(0, 4), 0);
  const after = framer.push(stream.subarray(4), 250);
  assert.equal(after.flushEndedAfterBytes, 4);
  assert.deepEqual(after.frames.map(samples), [[1002, 1003], [1004, 1005]]);
});

test('steady-state framing carries a sample split across chunks', () => {
  const framer = new BackingPcmFramer({ frameBytes: 6, startupFlushMs: 0 });
  const stream = rampBytes(0, 7);
  const frames: number[][] = [];
  for (const [start, end] of [[0, 1], [1, 5], [5, 11], [11, 14]]) {
    const pushed = framer.push(stream.subarray(start, end), 0);
    assert.equal(pushed.flushEndedAfterBytes, null);
    frames.push(...pushed.frames.map(samples));
  }
  assert.deepEqual(frames, [[1000, 1001, 1002], [1003, 1004, 1005]]);
  assert.deepEqual(samples(framer.takeTail()!), [1006]);
  assert.equal(framer.takeTail(), null);
});

test('the shutdown tail never includes half a sample', () => {
  const framer = new BackingPcmFramer({ frameBytes: 8, startupFlushMs: 0 });
  framer.push(rampBytes(0, 3).subarray(0, 5), 0);
  assert.deepEqual(samples(framer.takeTail()!), [1000, 1001]);
});

test('frame size must be whole samples', () => {
  assert.throws(() => new BackingPcmFramer({ frameBytes: 7, startupFlushMs: 0 }), /even/);
  assert.throws(() => new BackingPcmFramer({ frameBytes: 8, startupFlushMs: -1 }), /non-negative/);
});
