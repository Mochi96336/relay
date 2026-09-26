import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LISTEN_OPUS_DECODER_CONFIG,
  createListenOpusDecoder,
  listenOpusDecodingSupported,
} from '../public/listen-opus-decoder.js';

type Init = { output: (data: FakeAudioData) => void; error: (error: Error) => void };

class FakeAudioData {
  closed = false;
  format = 'f32';
  constructor(readonly timestamp: number, readonly numberOfFrames: number, readonly fill: number) {}
  copyTo(target: Float32Array, options: { planeIndex: number; format?: string }) {
    assert.equal(options.planeIndex, 0);
    target.fill(this.fill);
  }
  close() {
    this.closed = true;
  }
}

class FakeEncodedAudioChunk {
  readonly type: string;
  readonly timestamp: number;
  readonly data: ArrayBuffer;
  constructor(init: { type: string; timestamp: number; data: ArrayBuffer }) {
    assert.ok(Number.isInteger(init.timestamp), 'WebCodecs timestamps are whole microseconds');
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.data = init.data;
  }
}

function fakeDecoderClass() {
  const instances: FakeAudioDecoder[] = [];
  class FakeAudioDecoder {
    state = 'unconfigured';
    config: unknown = null;
    readonly chunks: FakeEncodedAudioChunk[] = [];
    constructor(readonly init: Init) {
      instances.push(this);
    }
    configure(config: unknown) {
      this.config = config;
      this.state = 'configured';
    }
    decode(chunk: FakeEncodedAudioChunk) {
      this.chunks.push(chunk);
    }
    close() {
      this.state = 'closed';
    }
    /** Delivers what a real decoder would, for the chunk at `index`. */
    emit(index: number, fill = 0.5) {
      const data = new FakeAudioData(this.chunks[index].timestamp, 960, fill);
      this.init.output(data);
      return data;
    }
    static async isConfigSupported(config: unknown) {
      return { supported: JSON.stringify(config) === JSON.stringify(LISTEN_OPUS_DECODER_CONFIG) };
    }
  }
  return { FakeAudioDecoder, instances };
}

function frameAt(firstSampleIndex: number) {
  return { firstSampleIndex, packet: new Uint8Array([1, 2, 3]).buffer };
}

test('decoded Opus comes back at the mix position it was sent for', () => {
  const { FakeAudioDecoder, instances } = fakeDecoderClass();
  const decoded: [number, number][] = [];
  const decoder = createListenOpusDecoder({
    onPcm: (pcm, firstSampleIndex) => decoded.push([firstSampleIndex, pcm.length]),
    onError: () => assert.fail('no error expected'),
    AudioDecoderClass: FakeAudioDecoder,
    EncodedAudioChunkClass: FakeEncodedAudioChunk,
  });
  // Far into a long session: positions must survive the microsecond round trip.
  const start = 48_000 * 60 * 60 * 5 + 7;
  decoder.decode(frameAt(start));
  decoder.decode(frameAt(start + 960));
  assert.equal(instances.length, 1);
  assert.deepEqual(instances[0].config, LISTEN_OPUS_DECODER_CONFIG);
  const data = instances[0].emit(0);
  instances[0].emit(1);
  assert.deepEqual(decoded, [[start, 960], [start + 960, 960]]);
  assert.equal(data.closed, true, 'every AudioData is closed');
});

test('a reset retires audio still in the decoder', () => {
  const { FakeAudioDecoder, instances } = fakeDecoderClass();
  const decoded: number[] = [];
  const decoder = createListenOpusDecoder({
    onPcm: (_pcm, firstSampleIndex) => decoded.push(firstSampleIndex),
    onError: () => assert.fail('no error expected'),
    AudioDecoderClass: FakeAudioDecoder,
    EncodedAudioChunkClass: FakeEncodedAudioChunk,
  });
  decoder.decode(frameAt(0));
  decoder.reset();
  assert.equal(instances[0].state, 'closed');
  const stale = instances[0].emit(0);
  assert.deepEqual(decoded, [], 'output from before the reset never reaches playback');
  assert.equal(stale.closed, true);

  decoder.decode(frameAt(96_000));
  assert.equal(instances.length, 2, 'the next frame opens a fresh decoder');
  instances[1].emit(0);
  assert.deepEqual(decoded, [96_000]);
});

test('a decoder error is reported once and the next frame starts over', () => {
  const { FakeAudioDecoder, instances } = fakeDecoderClass();
  const errors: string[] = [];
  const decoder = createListenOpusDecoder({
    onPcm: () => {},
    onError: (error) => errors.push(error.message),
    AudioDecoderClass: FakeAudioDecoder,
    EncodedAudioChunkClass: FakeEncodedAudioChunk,
  });
  decoder.decode(frameAt(0));
  instances[0].init.error(new Error('bad packet'));
  instances[0].init.error(new Error('again'));
  assert.deepEqual(errors, ['bad packet']);
  assert.equal(instances[0].state, 'closed');
});

test('Opus is offered only where WebCodecs can decode it', async () => {
  const { FakeAudioDecoder } = fakeDecoderClass();
  assert.equal(await listenOpusDecodingSupported({
    AudioDecoderClass: FakeAudioDecoder,
    EncodedAudioChunkClass: FakeEncodedAudioChunk,
  }), true);
  assert.equal(await listenOpusDecodingSupported({
    AudioDecoderClass: undefined,
    EncodedAudioChunkClass: FakeEncodedAudioChunk,
  }), false);
  class Unsupported {
    static async isConfigSupported() {
      return { supported: false };
    }
  }
  assert.equal(await listenOpusDecodingSupported({
    AudioDecoderClass: Unsupported,
    EncodedAudioChunkClass: FakeEncodedAudioChunk,
  }), false);
  class Throws {
    static async isConfigSupported() {
      throw new TypeError('no opus');
    }
  }
  assert.equal(await listenOpusDecodingSupported({
    AudioDecoderClass: Throws,
    EncodedAudioChunkClass: FakeEncodedAudioChunk,
  }), false);
});
