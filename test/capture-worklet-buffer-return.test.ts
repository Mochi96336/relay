import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

type CapturedProcessor = {
  process(inputs: unknown[]): boolean;
  port: {
    messages: unknown[];
    onmessage?: ((event: { data: unknown }) => void) | null;
  };
};

type PcmMessage = { type: 'pcm'; buffer: ArrayBuffer };

async function loadCaptureProcessor() {
  const source = await readFile(path.resolve('public/capture-worklet.js'), 'utf8');
  let RegisteredProcessor: (new () => CapturedProcessor) | null = null;

  class FakeAudioWorkletProcessor {
    port = {
      messages: [] as unknown[],
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (message: unknown) => {
        this.port.messages.push(message);
      },
    };
  }

  const context = vm.createContext({
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    sampleRate: 48_000,
    currentTime: 1,
    registerProcessor: (_name: string, processor: new () => CapturedProcessor) => {
      RegisteredProcessor = processor;
    },
  });
  vm.runInContext(source, context);
  if (!RegisteredProcessor) throw new Error('capture-processor was not registered');
  const processor = new (RegisteredProcessor as new () => CapturedProcessor)();
  processor.port.onmessage?.({ data: { type: 'capture-protocol', pcmEnvelope: true } });
  // A transferred buffer arrives in the worklet's own realm.
  const workletArrayBuffer = (byteLength: number) => (
    vm.runInContext(`new ArrayBuffer(${byteLength})`, context) as ArrayBuffer
  );
  return { processor, workletArrayBuffer };
}

function pcmMessages(processor: CapturedProcessor) {
  return processor.port.messages.filter((message) => (
    (message as { type?: string }).type === 'pcm'
  )) as PcmMessage[];
}

/** One 20 ms chunk at 48 kHz, every sample set to `value`. */
function renderChunk(processor: CapturedProcessor, value: number) {
  for (let quantum = 0; quantum < 960 / 128 + 1; quantum += 1) {
    processor.process([[new Float32Array(128).fill(value)]]);
  }
}

test('a buffer the page returns is reused for a later chunk, fully rewritten', async () => {
  const { processor } = await loadCaptureProcessor();
  renderChunk(processor, 0.25);
  const [first] = pcmMessages(processor);
  assert.equal(first.buffer.byteLength, 960 * 2);

  processor.port.onmessage?.({ data: { type: 'pcm-buffer-return', buffer: first.buffer } });
  renderChunk(processor, -0.5);
  renderChunk(processor, -0.5);

  const [, second, third] = pcmMessages(processor);
  // The spare chunk already being filled is flushed first; the returned
  // buffer carries the one after it.
  assert.notEqual(second.buffer, first.buffer);
  assert.equal(third.buffer, first.buffer);
  const reused = new Int16Array(third.buffer);
  assert.ok(reused.every((sample) => sample === Math.round(-0.5 * 0x8000)));
});

test('a returned buffer of the wrong size or type is not reused', async () => {
  const { processor, workletArrayBuffer } = await loadCaptureProcessor();
  renderChunk(processor, 0.1);
  const wrongSize = workletArrayBuffer(100);
  processor.port.onmessage?.({ data: { type: 'pcm-buffer-return', buffer: wrongSize } });
  processor.port.onmessage?.({ data: { type: 'pcm-buffer-return', buffer: new Uint8Array(1920) } });
  renderChunk(processor, 0.1);
  renderChunk(processor, 0.1);
  for (const message of pcmMessages(processor)) {
    assert.equal(message.buffer.byteLength, 1920);
    assert.notEqual(message.buffer, wrongSize);
  }
});

test('the pool stays bounded however many buffers come back', async () => {
  const { processor, workletArrayBuffer } = await loadCaptureProcessor();
  const returned = Array.from({ length: 20 }, () => workletArrayBuffer(1920));
  for (const buffer of returned) {
    processor.port.onmessage?.({ data: { type: 'pcm-buffer-return', buffer } });
  }
  for (let chunk = 0; chunk < 20; chunk += 1) renderChunk(processor, 0.1);
  const reused = pcmMessages(processor).filter((message) => returned.includes(message.buffer));
  assert.equal(reused.length, 8);
});

test('the page returns each chunk buffer only after framing its PCM', async () => {
  const app = await readFile(path.resolve('public/app.js'), 'utf8');
  const handler = app.slice(
    app.indexOf('function handleCaptureWorkletMessage('),
    app.indexOf('function installCaptureGraph('),
  );
  assert.match(
    app,
    /graph\.capture\.port\.postMessage\(\{ type: 'pcm-buffer-return', buffer \}, \[buffer\]\)/,
  );
  // Stale chunks go back without being sent; sent chunks only after the loop.
  assert.match(handler, /recordUplinkDrop\(pcm\.byteLength \/ 2, 'capture-backlog'\);\s*returnCaptureBuffer\(graph, pcm\);\s*return;/);
  assert.match(handler, /while \(pending\.length > 0\) \{[\s\S]*\r?\n  \}\r?\n  returnCaptureBuffer\(graph, pcm\);\r?\n\}/);
  assert.equal(handler.match(/returnCaptureBuffer\(/g)?.length, 2);
});
