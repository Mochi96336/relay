#!/usr/bin/env node
/**
 * Voice/song balance of recorded Takes, read from their stems.
 *
 *   node scripts/take-balance.mjs [--dir takes] [--timeline] [takeId ...]
 *   node scripts/take-balance.mjs --remix <takeId> [--voice-db 0] [--backing-db 0] [--out file.wav]
 *
 * Without Take IDs, every Take that has stems is reported. `--timeline`
 * adds the voice and song short-term loudness every 5 s. `--remix` renders
 * the Take again from its stems with the given gains (dB), clamped like the
 * mixer's backstop, so a balance can be heard before it is tried live.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { IntegratedLoudness, LoudnessMeter } from '../shared/loudness-meter.js';

const VOCAL_ACTIVE_MOMENTARY_LUFS = -40;
const BACKING_PRESENT_SHORT_TERM_LUFS = -60;

function parseArgs(argv) {
  const options = { dir: 'takes', timeline: false, remix: null, voiceDb: 0, backingDb: 0, out: null, takeIds: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir') options.dir = argv[++i];
    else if (arg === '--timeline') options.timeline = true;
    else if (arg === '--remix') options.remix = argv[++i];
    else if (arg === '--voice-db') options.voiceDb = Number(argv[++i]);
    else if (arg === '--backing-db') options.backingDb = Number(argv[++i]);
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else options.takeIds.push(arg);
  }
  return options;
}

function readWav(file) {
  const buffer = readFileSync(file);
  let offset = 12;
  let sampleRate = 48_000;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ') sampleRate = buffer.readUInt32LE(offset + 12);
    if (id === 'data') {
      const pcm = buffer.subarray(offset + 8, offset + 8 + length);
      return { sampleRate, samples: new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2)) };
    }
    offset += 8 + length + (length & 1);
  }
  throw new Error(`${file}: no data chunk`);
}

function writeWav(file, sampleRate, samples) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(samples.byteLength, 40);
  writeFileSync(file, Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]));
}

function stems(dir, takeId) {
  const voice = readWav(path.join(dir, 'stems', `${takeId}-voice.wav`));
  const backing = readWav(path.join(dir, 'stems', `${takeId}-backing.wav`));
  return { sampleRate: voice.sampleRate, voice: voice.samples, backing: backing.samples };
}

function analyse({ sampleRate, voice, backing }, timeline) {
  const meters = { voice: new LoudnessMeter(sampleRate), backing: new LoudnessMeter(sampleRate) };
  const integrated = { voice: new IntegratedLoudness(), backing: new IntegratedLoudness(), singing: new IntegratedLoudness() };
  const differences = [];
  const rows = [];
  let blocks = 0;
  const length = Math.min(voice.length, backing.length);
  for (let i = 0; i < length; i += 1) {
    meters.voice.push(voice[i] / 32768);
    if (!meters.backing.push(backing[i] / 32768)) continue;
    blocks += 1;
    integrated.voice.add(meters.voice.momentaryMeanSquare);
    integrated.backing.add(meters.backing.momentaryMeanSquare);
    const momentary = meters.voice.momentaryLufs;
    const singing = momentary !== null && momentary > VOCAL_ACTIVE_MOMENTARY_LUFS;
    if (singing) integrated.singing.add(meters.voice.momentaryMeanSquare);
    const v = meters.voice.shortTermLufs;
    const b = meters.backing.shortTermLufs;
    if (blocks % 10 === 0 && singing && v !== null && b !== null && Number.isFinite(v) && b > BACKING_PRESENT_SHORT_TERM_LUFS) {
      differences.push(v - b);
    }
    if (timeline && blocks % 50 === 0) rows.push([blocks / 10, v, b]);
  }
  differences.sort((a, b) => a - b);
  const at = (q) => (differences.length ? differences[Math.min(differences.length - 1, Math.floor(q * differences.length))] : null);
  return {
    seconds: length / sampleRate,
    voiceLufs: integrated.voice.lufs,
    singingVoiceLufs: integrated.singing.lufs,
    singingSeconds: integrated.singing.blockCount / 10,
    backingLufs: integrated.backing.lufs,
    vocalToBacking: { p10: at(0.1), p50: at(0.5), p90: at(0.9) },
    rows,
  };
}

const fmt = (value, width = 6) => (value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(1)).padStart(width);

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(2, 13).join('\n'));
    return;
  }

  if (options.remix) {
    const take = stems(options.dir, options.remix);
    const voiceGain = 10 ** (options.voiceDb / 20);
    const backingGain = 10 ** (options.backingDb / 20);
    const out = new Int16Array(Math.min(take.voice.length, take.backing.length));
    for (let i = 0; i < out.length; i += 1) {
      const value = Math.max(-1, Math.min(1, (take.voice[i] * voiceGain + take.backing[i] * backingGain) / 32768));
      out[i] = Math.round(value < 0 ? value * 32768 : value * 32767);
    }
    const file = options.out ?? `${options.remix}.remix-v${options.voiceDb}-b${options.backingDb}.wav`;
    writeWav(file, take.sampleRate, out);
    console.log(`wrote ${file}`);
    return;
  }

  const stemDir = path.join(options.dir, 'stems');
  const takeIds = options.takeIds.length > 0
    ? options.takeIds
    : [...new Set(readdirSync(stemDir).map((name) => /^(.+)-voice\.wav$/.exec(name)?.[1]).filter(Boolean))];
  console.log('take       secs  singing  voice(sing)  song   voice−song p10/p50/p90');
  for (const takeId of takeIds) {
    const result = analyse(stems(options.dir, takeId), options.timeline);
    const { p10, p50, p90 } = result.vocalToBacking;
    console.log(`${takeId.slice(0, 8)} ${fmt(result.seconds, 6)} ${fmt(result.singingSeconds, 7)} ${fmt(result.singingVoiceLufs, 11)} ${fmt(result.backingLufs)}   ${fmt(p10)} ${fmt(p50)} ${fmt(p90)}`);
    for (const [second, voice, backing] of result.rows) {
      console.log(`    ${fmt(second, 5)}s  voice ${fmt(voice)}  song ${fmt(backing)}`);
    }
  }
}

main();
