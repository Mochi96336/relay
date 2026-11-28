import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TakeStemRecorder, type TakeStemPolicy } from '../src/take-stems.js';

const RATE = 48_000;
const FRAME = 960;
const TAKE = '0b6a2f4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const OTHER = '1c7b3a5f-2d3e-4f60-9b0c-1d2e3f4a5b6c';

const open: TakeStemPolicy = { enabled: true, maxBytes: 0, maxAgeMs: 0, minFreeBytes: 0 };

function fixture(policy: Partial<TakeStemPolicy> = {}) {
  const takeDir = mkdtempSync(path.join(tmpdir(), 'relay-stems-'));
  const events: Record<string, unknown>[] = [];
  const recorder = () => new TakeStemRecorder({
    takeDir, sampleRate: RATE, policy: { ...open, ...policy }, log: (event) => events.push(event),
  });
  return { takeDir, stems: path.join(takeDir, 'stems'), events, recorder, cleanup: () => rmSync(takeDir, { recursive: true, force: true }) };
}

function tone(first: number, hz: number, dbfs: number) {
  const buffer = Buffer.alloc(FRAME * 2);
  const amplitude = 10 ** (dbfs / 20) * 32767;
  for (let i = 0; i < FRAME; i += 1) {
    buffer.writeInt16LE(Math.round(amplitude * Math.sin((2 * Math.PI * hz * (first + i)) / RATE)), i * 2);
  }
  return buffer;
}

function sum(a: Buffer, b: Buffer) {
  const out = Buffer.alloc(a.byteLength);
  for (let i = 0; i < a.byteLength; i += 2) out.writeInt16LE(a.readInt16LE(i) + b.readInt16LE(i), i);
  return out;
}

function record(recorder: TakeStemRecorder, takeId: string, seconds: number) {
  const voices: Buffer[] = [];
  for (let first = 0; first < RATE * seconds; first += FRAME) {
    const voice = tone(first, 440, -20);
    const backing = tone(first, 997, -30);
    voices.push(voice);
    recorder.append(takeId, sum(voice, backing), { voice, backing });
  }
  return Buffer.concat(voices);
}

test('stems hold exactly the frames given and a loudness summary beside them', async () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.takeDir, `${TAKE}.wav`), '');
    const recorder = f.recorder();
    const voice = record(recorder, TAKE, 5);
    recorder.settle(null);
    await recorder.shutdown();

    const wav = readFileSync(path.join(f.stems, `${TAKE}-voice.wav`));
    assert.deepEqual(wav.subarray(44), voice);
    assert.ok(existsSync(path.join(f.stems, `${TAKE}-backing.wav`)));
    const summary = JSON.parse(readFileSync(path.join(f.stems, `${TAKE}.loudness.json`), 'utf8'));
    assert.equal(summary.takeId, TAKE);
    assert.equal(summary.sampleCount, voice.byteLength / 2);
    // 440 Hz reads a little under 997 Hz through K-weighting; both tones are steady.
    assert.ok(Math.abs(summary.integratedLufs.backing - -33.0) < 0.2, JSON.stringify(summary));
    assert.ok(summary.integratedLufs.voice > -24 && summary.integratedLufs.voice < -22.5, JSON.stringify(summary));
    assert.ok(summary.singingSeconds >= 4);
    assert.ok(Math.abs(summary.vocalToBackingDb.p50 - (summary.integratedLufs.voice - summary.integratedLufs.backing)) < 0.3);
    assert.ok(f.events.some((event) => event.event === 'finalized'));
  } finally {
    f.cleanup();
  }
});

test('a new Take finishes the previous stems; a stem whose Take is gone is pruned', async () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.takeDir, `${OTHER}.wav`), '');
    const recorder = f.recorder();
    record(recorder, TAKE, 1);
    record(recorder, OTHER, 1);
    recorder.settle(null);
    await recorder.shutdown();
    const names = readdirSync(f.stems).sort();
    assert.deepEqual(names, [`${OTHER}-backing.wav`, `${OTHER}-voice.wav`, `${OTHER}.loudness.json`]);
    assert.ok(f.events.some((event) => event.event === 'pruned'));
  } finally {
    f.cleanup();
  }
});

test('a still-recording Take keeps its stems while settle names it', async () => {
  const f = fixture();
  try {
    const recorder = f.recorder();
    record(recorder, TAKE, 1);
    recorder.settle(TAKE);
    assert.equal(recorder.recordingTakeId, TAKE);
    // The stream opens its file asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(existsSync(path.join(f.stems, `${TAKE}-voice.wav.part`)));
    await recorder.shutdown();
  } finally {
    f.cleanup();
  }
});

test('startup clears interrupted stems and those past their age', () => {
  const f = fixture({ maxAgeMs: 24 * 60 * 60 * 1000 });
  try {
    mkdirSync(f.stems, { recursive: true });
    for (const takeId of [TAKE, OTHER]) writeFileSync(path.join(f.takeDir, `${takeId}.wav`), '');
    writeFileSync(path.join(f.stems, `${TAKE}-voice.wav.part`), 'x');
    writeFileSync(path.join(f.stems, `${OTHER}-voice.wav`), 'x');
    writeFileSync(path.join(f.stems, `${TAKE}-backing.wav`), 'x');
    const old = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(path.join(f.stems, `${OTHER}-voice.wav`), old, old);
    f.recorder();
    assert.deepEqual(readdirSync(f.stems), [`${TAKE}-backing.wav`]);
  } finally {
    f.cleanup();
  }
});

test('the total budget removes the oldest stems first', () => {
  const f = fixture({ maxBytes: 150 });
  try {
    mkdirSync(f.stems, { recursive: true });
    for (const [takeId, ageS] of [[TAKE, 100], [OTHER, 10]] as const) {
      writeFileSync(path.join(f.takeDir, `${takeId}.wav`), '');
      const file = path.join(f.stems, `${takeId}-voice.wav`);
      writeFileSync(file, Buffer.alloc(100));
      const at = Date.now() / 1000 - ageS;
      utimesSync(file, at, at);
    }
    f.recorder();
    assert.deepEqual(readdirSync(f.stems), [`${OTHER}-voice.wav`]);
  } finally {
    f.cleanup();
  }
});

test('no stems when turned off or when the disk is below the reserve; the Take is not involved', async () => {
  for (const policy of [{ enabled: false }, { minFreeBytes: Number.MAX_SAFE_INTEGER }]) {
    const f = fixture(policy);
    try {
      const recorder = f.recorder();
      record(recorder, TAKE, 1);
      recorder.settle(null);
      await recorder.shutdown();
      assert.ok(!existsSync(f.stems) || readdirSync(f.stems).length === 0, JSON.stringify(policy));
      if (policy.minFreeBytes) assert.ok(f.events.some((event) => event.event === 'skipped' && event.reason === 'free-space'));
    } finally {
      f.cleanup();
    }
  }
});
