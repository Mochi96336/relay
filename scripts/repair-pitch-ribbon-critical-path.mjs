import { readFileSync, writeFileSync } from 'node:fs';

function replaceOnce(path, before, after) {
  const source = readFileSync(path, 'utf8');
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${path}: expected one replacement target, found ${count}`);
  writeFileSync(path, source.replace(before, after));
}

replaceOnce(
  'public/capture-worklet.js',
`  flushIfFull() {
    if (this.offset !== this.chunkSize) return;
    const rms = this.levelSampleCount > 0
      ? Math.sqrt(this.levelSquareSum / this.levelSampleCount)
      : 0;
    this.measureF0(rms);
    this.port.postMessage({
      type: 'input-level',
      peakDbfs: amplitudeToDbfs(this.levelPeak),
      rmsDbfs: amplitudeToDbfs(rms),
      spectrumBands: this.measureSpectrumBands(),
      f0Hz: this.f0Hz,
      pitchConfidence: this.pitchConfidence,
      samples: this.levelSampleCount,
    });

    const buffer = this.chunk.buffer;
    this.port.postMessage(buffer, [buffer]);
    this.chunk = new Int16Array(this.chunkSize);
    this.offset = 0;
    this.levelPeak = 0;
    this.levelSquareSum = 0;
    this.levelSampleCount = 0;
  }`,
`  flushIfFull() {
    if (this.offset !== this.chunkSize) return;
    const rms = this.levelSampleCount > 0
      ? Math.sqrt(this.levelSquareSum / this.levelSampleCount)
      : 0;
    const peakDbfs = amplitudeToDbfs(this.levelPeak);
    const rmsDbfs = amplitudeToDbfs(rms);
    const samples = this.levelSampleCount;

    // PCM delivery is the critical path. Transfer the completed chunk before
    // any visual-only FFT/F0 work so pitch analysis cannot delay this uplink.
    const buffer = this.chunk.buffer;
    this.port.postMessage(buffer, [buffer]);
    this.chunk = new Int16Array(this.chunkSize);
    this.offset = 0;
    this.levelPeak = 0;
    this.levelSquareSum = 0;
    this.levelSampleCount = 0;

    this.measureF0(rms);
    this.port.postMessage({
      type: 'input-level',
      peakDbfs,
      rmsDbfs,
      spectrumBands: this.measureSpectrumBands(),
      f0Hz: this.f0Hz,
      pitchConfidence: this.pitchConfidence,
      samples,
    });
  }`,
);

replaceOnce(
  'test/capture-worklet-level.test.ts',
`type CapturedProcessor = {
  process(inputs: unknown[]): boolean;
  port: { messages: unknown[] };
};`,
`type CapturedProcessor = {
  process(inputs: unknown[]): boolean;
  port: { messages: unknown[] };
  measureF0(rms: number): void;
};`,
);

replaceOnce(
  'test/capture-worklet-level.test.ts',
`  assert.equal(processor.port.messages.length, 2);
  const level = processor.port.messages[0] as InputLevel;
  assert.equal(level.type, 'input-level');
  assert.equal(level.samples, 960);
  assert.ok(Math.abs(level.peakDbfs - (-6.020599913279624)) < 0.0001);
  assert.ok(Math.abs(level.rmsDbfs - (-6.020599913279624)) < 0.0001);
  assert.equal(level.spectrumBands.length, 5);
  assert.equal(level.f0Hz, null, 'DC must not be guessed as a pitch');
  assert.equal(level.pitchConfidence, 0);
  assert.equal(Object.prototype.toString.call(processor.port.messages[1]), '[object ArrayBuffer]');`,
`  assert.equal(processor.port.messages.length, 2);
  assert.equal(Object.prototype.toString.call(processor.port.messages[0]), '[object ArrayBuffer]');
  const level = processor.port.messages[1] as InputLevel;
  assert.equal(level.type, 'input-level');
  assert.equal(level.samples, 960);
  assert.ok(Math.abs(level.peakDbfs - (-6.020599913279624)) < 0.0001);
  assert.ok(Math.abs(level.rmsDbfs - (-6.020599913279624)) < 0.0001);
  assert.equal(level.spectrumBands.length, 5);
  assert.equal(level.f0Hz, null, 'DC must not be guessed as a pitch');
  assert.equal(level.pitchConfidence, 0);`,
);

replaceOnce(
  'test/capture-worklet-level.test.ts',
`test('capture spectrum remains frequency-shape evidence, separate from pitch', async () => {`,
`test('capture worklet transfers each PCM chunk before entering F0 visual analysis', async () => {
  const processor = await loadCaptureProcessor();
  const originalMeasureF0 = processor.measureF0.bind(processor);
  processor.measureF0 = (rms) => {
    processor.port.messages.push('f0-analysis');
    originalMeasureF0(rms);
  };

  processor.process([[sine(220, 40)]]);
  assert.equal(Object.prototype.toString.call(processor.port.messages[0]), '[object ArrayBuffer]');
  assert.equal(processor.port.messages[1], 'f0-analysis');
  assert.equal((processor.port.messages[2] as InputLevel).type, 'input-level');
  assert.equal(Object.prototype.toString.call(processor.port.messages[3]), '[object ArrayBuffer]');
  assert.equal(processor.port.messages[4], 'f0-analysis');
  assert.equal((processor.port.messages[5] as InputLevel).type, 'input-level');
});

test('capture spectrum remains frequency-shape evidence, separate from pitch', async () => {`,
);
