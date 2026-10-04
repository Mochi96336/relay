import assert from 'node:assert/strict';
import test from 'node:test';

import { MicInputClipping } from '../src/mic-input-clipping.js';

function railFrame(firstSampleIndex: number, values: number[]) {
  const pcm = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => pcm.writeInt16LE(value, index * 2));
  return { generation: 1, firstSampleIndex, pcm };
}

test('four samples on the rail make a clipping range, three do not', () => {
  const clipping = new MicInputClipping();
  const toSession = (sourceSample: number) => sourceSample + 1_000;
  clipping.observe(railFrame(0, [0, 32_767, -32_768, 32_766, 0]), toSession, null);
  assert.equal(clipping.empty, true);

  clipping.observe(railFrame(10, [32_767, 32_767, 32_767, 32_767, 32_767, 0]), toSession, null);
  assert.equal(clipping.empty, false);
  assert.equal(clipping.at(1_009), false);
  assert.equal(clipping.at(1_010), true);
  assert.equal(clipping.at(1_014), true);
  assert.equal(clipping.at(1_015), false);
  assert.deepEqual([...clipping.mask(1_008, 9)!], [0, 0, 1, 1, 1, 1, 1, 0, 0]);

  clipping.shift(100);
  assert.equal(clipping.at(1_110), true);
  clipping.trimBefore(2_000);
  assert.equal(clipping.empty, true);
  assert.equal(clipping.mask(0, 4), null);
});

test('a rail run outliving its range must prove itself again', () => {
  const clipping = new MicInputClipping();
  const toSession = (sourceSample: number) => sourceSample;
  // Still on the rail when the frame ends: the run stays open.
  clipping.observe(railFrame(0, [32_767, 32_767, 32_767, 32_767, 32_767]), toSession, null);
  clipping.trimBefore(100);
  assert.equal(clipping.empty, true);
  // Retention dropped the range the open run owned, so three more rail
  // samples are not yet a new range.
  clipping.observe(railFrame(5, [32_767, 32_767, 32_767]), toSession, null);
  assert.equal(clipping.empty, true);
  clipping.observe(railFrame(8, [32_767]), toSession, null);
  assert.equal(clipping.empty, false);
});
