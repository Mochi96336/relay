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
  return { firstSampleIndex, sampleCount: 960, packet: new Uint8Array([1, 2, 3]).buffer };
}

test('a sample gap preserves codec history and original positions despite continuous WebCodecs timestamps', () => {
  const { FakeAudioDecoder, instances } = fakeDecoderClass();
  const positions: number[] = [];
  const decoder = createListenOpusDecoder({
    onPcm: (_pcm, start) => positions.push(start), onError: assert.fail,
    AudioDecoderClass: FakeAudioDecoder, EncodedAudioChunkClass: FakeEncodedAudioChunk,
  });
  decoder.decode(frameAt(0));
  instances[0].emit(0);
  decoder.decode(frameAt(1920));
  // Chromium keeps output timestamps continuous across an encoded input gap.
  instances[0].init.output(new FakeAudioData(20_000, 960, 0.5));
  assert.equal(instances.length, 1, 'a playback gap is not an encoder restart');
  assert.deepEqual(positions, [0, 1920]);
});

test('a live-edge jump discards pending old output while still consuming its codec history', () => {
  const { FakeAudioDecoder, instances } = fakeDecoderClass();
  const positions: number[] = [];
  const decoder = createListenOpusDecoder({
    onPcm: (_pcm, start) => positions.push(start), onError: assert.fail,
    AudioDecoderClass: FakeAudioDecoder, EncodedAudioChunkClass: FakeEncodedAudioChunk,
  });
  decoder.decode(frameAt(0));
  decoder.decode(frameAt(960));
  decoder.decode(frameAt(9600));
  instances[0].emit(0); instances[0].emit(1); instances[0].emit(2);
  assert.deepEqual(positions, [9600], 'in-flight audio from before the queue reset cannot play afterwards');
});

test('split and combined decoder outputs retain each packet\'s positioned sample span', () => {
  const { FakeAudioDecoder, instances } = fakeDecoderClass();
  const spans: [number, number][] = [];
  const decoder = createListenOpusDecoder({
    onPcm: (pcm, start) => spans.push([start, pcm.length]), onError: assert.fail,
    AudioDecoderClass: FakeAudioDecoder, EncodedAudioChunkClass: FakeEncodedAudioChunk,
  });
  decoder.decode(frameAt(10)); decoder.decode(frameAt(970));
  instances[0].init.output(new FakeAudioData(0, 480, 0.5));
  instances[0].init.output(new FakeAudioData(10_000, 1440, 0.5));
  assert.deepEqual(spans, [[10, 480], [490, 480], [970, 960]]);
});

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

test('a decoder that stops producing PCM has a bounded pending history and retires cleanly', () => {
  const { FakeAudioDecoder, instances } = fakeDecoderClass();
  const errors: string[] = [];
  const decoder = createListenOpusDecoder({
    onPcm: () => assert.fail('retired output'), onError: error => errors.push(error.message),
    AudioDecoderClass: FakeAudioDecoder, EncodedAudioChunkClass: FakeEncodedAudioChunk,
  });
  for (let i = 0; i <= 50; i++) decoder.decode(frameAt(i * 960));
  assert.deepEqual(errors, ['Listen Opus decoder fell behind live audio']);
  assert.equal(instances[0].state, 'closed');
  const stale = instances[0].emit(0);
  assert.equal(stale.closed, true);
});

test('a synchronous configure failure closes the allocated decoder', () => {
  const { FakeAudioDecoder, instances } = fakeDecoderClass();
  class Unconfigurable extends FakeAudioDecoder {
    configure() { throw new Error('configure refused'); }
  }
  const errors: string[] = [];
  const decoder = createListenOpusDecoder({
    onPcm: () => assert.fail('no PCM'), onError: error => errors.push(error.message),
    AudioDecoderClass: Unconfigurable, EncodedAudioChunkClass: FakeEncodedAudioChunk,
  });
  decoder.decode(frameAt(0));
  assert.deepEqual(errors, ['configure refused']);
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
