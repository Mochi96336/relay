import { existsSync, mkdirSync, readdirSync, rmSync, statSync, statfsSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { IntegratedLoudness, LoudnessMeter } from '../shared/loudness-meter.js';
import type { MixFrameStems } from './audio-session.js';
import { WavTakeWriter } from './wav-take-writer.js';

/**
 * Voice and song stems beside each Take, for analysis only.
 *
 * A Take is the mixed room, one channel: whether a singer was buried or the
 * song too loud cannot be read back out of it. The stems are each source's
 * share of that same mix, frame for frame, so a balance question can be
 * answered from a real session and a different mix can be rendered offline
 * before it is tried live.
 *
 * Never authority over the Take: a stem that cannot be written is dropped and
 * logged, the Take goes on. Files live in `<takeDir>/stems/`, which the Take
 * library and its retention never read, so stems keep their own retention.
 */

const GIB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const STEM_FILE = new RegExp(`^(${UUID})(?:-(?:voice|backing)\\.wav(?:\\.part)?|\\.loudness\\.json(?:\\.part)?)$`, 'i');
const PART_FILE = /\.part$/;

/** A voice this loud is singing, not the song leaking into a quiet Mic. A first guess the stems will refine. */
export const VOCAL_ACTIVE_MOMENTARY_LUFS = -40;
/** Below this the song is a gap or a fade, not something a voice is balanced against. */
const BACKING_PRESENT_SHORT_TERM_LUFS = -60;

export type TakeStemPolicy = {
  enabled: boolean;
  maxBytes: number;
  maxAgeMs: number;
  /** Free space a stem never takes: the Take's own reserve plus room for the Take. */
  minFreeBytes: number;
};

function envNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function takeStemPolicyFromEnv(): TakeStemPolicy {
  return {
    enabled: process.env.RELAY_TAKE_STEMS !== '0',
    maxBytes: Math.floor(envNumber('RELAY_TAKE_STEM_MAX_GIB', 4) * GIB),
    maxAgeMs: envNumber('RELAY_TAKE_STEM_RETENTION_DAYS', 7) * DAY_MS,
    minFreeBytes: Math.floor(envNumber('RELAY_TAKE_STEM_MIN_FREE_GIB', 2) * GIB),
  };
}

export type TakeLoudnessSummary = {
  version: 1;
  takeId: string;
  sampleCount: number;
  /** Gated BS.1770 integrated loudness of each stem and of the mix; null when silent throughout. */
  integratedLufs: { voice: number | null; backing: number | null; mix: number | null };
  /** Voice loudness over only the seconds it was singing. */
  singingVoiceLufs: number | null;
  /** Seconds the voice was singing while the song played. */
  singingSeconds: number;
  /** Voice minus song short-term loudness, sampled each second the voice sang over the song. */
  vocalToBackingDb: { p10: number; p50: number; p90: number } | null;
};

type Active = {
  takeId: string;
  voice: WavTakeWriter;
  backing: WavTakeWriter;
  meters: { voice: LoudnessMeter; backing: LoudnessMeter; mix: LoudnessMeter };
  integrated: { voice: IntegratedLoudness; backing: IntegratedLoudness; mix: IntegratedLoudness };
  singingVoice: IntegratedLoudness;
  blocks: number;
  differences: number[];
  failed: boolean;
};

export class TakeStemRecorder {
  readonly directory: string;
  private active: Active | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    takeDir: string;
    sampleRate: number;
    policy?: TakeStemPolicy;
    log?: (event: Record<string, unknown>) => void;
  }) {
    this.directory = path.join(options.takeDir, 'stems');
    if (!this.policy.enabled) return;
    try {
      mkdirSync(this.directory, { recursive: true });
      // A stem still `.part` at startup was being written when the Relay
      // stopped; the Take it belonged to was finalized or discarded without it.
      for (const name of readdirSync(this.directory)) {
        if (PART_FILE.test(name)) rmSync(path.join(this.directory, name), { force: true });
      }
      this.pruneSync();
    } catch (error) {
      this.log({ event: 'storage-error', error: errorMessage(error) });
    }
  }

  private get policy() {
    return this.options.policy ?? takeStemPolicyFromEnv();
  }

  private log(event: Record<string, unknown>) {
    (this.options.log ?? ((value) => console.log('[take-stems]', JSON.stringify(value))))(event);
  }

  get recordingTakeId() {
    return this.active?.takeId ?? null;
  }

  /** The same frame the Take just wrote, with each source's share of it. */
  append(takeId: string, frame: Buffer, stems: MixFrameStems) {
    if (this.active && this.active.takeId !== takeId) this.finish();
    if (!this.active) {
      if (!this.start(takeId)) return;
    }
    const active = this.active!;
    if (active.failed) return;
    try {
      active.voice.append(stems.voice);
      active.backing.append(stems.backing);
    } catch (error) {
      this.fail(active, error);
      return;
    }
    this.measure(active, frame, stems);
  }

  /** Called after each mixed frame with the Take still recording, if any. */
  settle(recordingTakeId: string | null) {
    if (this.active && this.active.takeId !== recordingTakeId) this.finish();
  }

  async shutdown() {
    this.finish();
    await this.chain;
  }

  private start(takeId: string) {
    const policy = this.policy;
    if (!policy.enabled) return false;
    try {
      const filesystem = statfsSync(this.options.takeDir);
      const freeBytes = filesystem.bavail * filesystem.bsize;
      if (freeBytes < policy.minFreeBytes) {
        this.log({ event: 'skipped', takeId, reason: 'free-space', freeBytes, minFreeBytes: policy.minFreeBytes });
        return false;
      }
      const writer = (suffix: string) => new WavTakeWriter({
        directory: this.directory,
        takeId: `${takeId}-${suffix}`,
        sampleRate: this.options.sampleRate,
        // Two stems share what the reserve leaves.
        maxDataBytes: Math.max(4, freeBytes - policy.minFreeBytes) / 2,
        onError: (error) => queueMicrotask(() => {
          if (this.active?.takeId === takeId) this.fail(this.active, error);
        }),
      });
      const sampleRate = this.options.sampleRate;
      this.active = {
        takeId,
        voice: writer('voice'),
        backing: writer('backing'),
        meters: {
          voice: new LoudnessMeter(sampleRate),
          backing: new LoudnessMeter(sampleRate),
          mix: new LoudnessMeter(sampleRate),
        },
        integrated: { voice: new IntegratedLoudness(), backing: new IntegratedLoudness(), mix: new IntegratedLoudness() },
        singingVoice: new IntegratedLoudness(),
        blocks: 0,
        differences: [],
        failed: false,
      };
      return true;
    } catch (error) {
      this.log({ event: 'failed', takeId, error: errorMessage(error) });
      return false;
    }
  }

  private measure(active: Active, frame: Buffer, stems: MixFrameStems) {
    const { meters, integrated } = active;
    const samples = frame.byteLength / 2;
    for (let i = 0; i < samples; i += 1) {
      meters.voice.push(stems.voice.readInt16LE(i * 2) / 32768);
      meters.backing.push(stems.backing.readInt16LE(i * 2) / 32768);
      if (!meters.mix.push(frame.readInt16LE(i * 2) / 32768)) continue;

      // All three meters complete their 100 ms blocks on the same sample.
      integrated.voice.add(meters.voice.momentaryMeanSquare);
      integrated.backing.add(meters.backing.momentaryMeanSquare);
      integrated.mix.add(meters.mix.momentaryMeanSquare);
      active.blocks += 1;

      const voiceMomentary = meters.voice.momentaryLufs;
      const singing = voiceMomentary !== null && voiceMomentary > VOCAL_ACTIVE_MOMENTARY_LUFS;
      if (singing) active.singingVoice.add(meters.voice.momentaryMeanSquare);
      if (active.blocks % 10 !== 0 || !singing) continue;
      const voiceShortTerm = meters.voice.shortTermLufs;
      const backingShortTerm = meters.backing.shortTermLufs;
      if (
        voiceShortTerm !== null && backingShortTerm !== null
        && Number.isFinite(voiceShortTerm) && backingShortTerm > BACKING_PRESENT_SHORT_TERM_LUFS
      ) {
        active.differences.push(voiceShortTerm - backingShortTerm);
      }
    }
  }

  private fail(active: Active, error: unknown) {
    if (active.failed) return;
    active.failed = true;
    this.log({ event: 'failed', takeId: active.takeId, error: errorMessage(error) });
    this.chain = this.chain.then(async () => {
      await Promise.all([active.voice.abort(), active.backing.abort()]).catch(() => {});
    });
  }

  private finish() {
    const active = this.active;
    this.active = null;
    if (!active || active.failed) return;
    this.chain = this.chain.then(async () => {
      try {
        const [voice] = await Promise.all([active.voice.finalize(), active.backing.finalize()]);
        const summary = summarize(active, voice.sampleCount);
        const jsonPath = path.join(this.directory, `${active.takeId}.loudness.json`);
        await writeFile(`${jsonPath}.part`, `${JSON.stringify(summary, null, 2)}\n`);
        await rename(`${jsonPath}.part`, jsonPath);
        this.log({ event: 'finalized', ...summary });
      } catch (error) {
        this.log({ event: 'failed', takeId: active.takeId, error: errorMessage(error) });
        await Promise.all([active.voice.abort(), active.backing.abort()]).catch(() => {});
      }
      try {
        this.pruneSync();
      } catch (error) {
        this.log({ event: 'storage-error', error: errorMessage(error) });
      }
    });
  }

  /**
   * Stems follow their Take out (a Take pruned or discarded leaves no reason
   * to keep them), then age and a total budget of their own, oldest first.
   */
  private pruneSync(nowMs = Date.now()) {
    const policy = this.policy;
    const groups = new Map<string, { files: string[]; bytes: number; mtimeMs: number }>();
    for (const name of readdirSync(this.directory)) {
      const match = STEM_FILE.exec(name);
      if (!match || PART_FILE.test(name)) continue;
      const takeId = match[1].toLowerCase();
      if (takeId === this.active?.takeId) continue;
      const info = statSync(path.join(this.directory, name));
      const group = groups.get(takeId) ?? { files: [], bytes: 0, mtimeMs: 0 };
      group.files.push(name);
      group.bytes += info.size;
      group.mtimeMs = Math.max(group.mtimeMs, info.mtimeMs);
      groups.set(takeId, group);
    }

    const removals = new Set<string>();
    for (const [takeId, group] of groups) {
      const takeKept = existsSync(path.join(this.options.takeDir, `${takeId}.wav`))
        || existsSync(path.join(this.options.takeDir, `${takeId}.wav.part`));
      if (!takeKept || (policy.maxAgeMs > 0 && nowMs - group.mtimeMs > policy.maxAgeMs)) removals.add(takeId);
    }
    if (policy.maxBytes > 0) {
      let bytes = [...groups].reduce((total, [takeId, group]) => total + (removals.has(takeId) ? 0 : group.bytes), 0);
      for (const [takeId, group] of [...groups].sort((a, b) => a[1].mtimeMs - b[1].mtimeMs)) {
        if (bytes <= policy.maxBytes) break;
        if (removals.has(takeId)) continue;
        removals.add(takeId);
        bytes -= group.bytes;
      }
    }
    for (const takeId of removals) {
      for (const name of groups.get(takeId)!.files) rmSync(path.join(this.directory, name), { force: true });
    }
    if (removals.size > 0) this.log({ event: 'pruned', takeIds: [...removals] });
  }
}

function summarize(active: Active, sampleCount: number): TakeLoudnessSummary {
  const round = (value: number | null) => (value === null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10);
  const sorted = [...active.differences].sort((a, b) => a - b);
  const at = (fraction: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] * 10) / 10;
  return {
    version: 1,
    takeId: active.takeId,
    sampleCount,
    integratedLufs: {
      voice: round(active.integrated.voice.lufs),
      backing: round(active.integrated.backing.lufs),
      mix: round(active.integrated.mix.lufs),
    },
    singingVoiceLufs: round(active.singingVoice.lufs),
    singingSeconds: Math.round(active.singingVoice.blockCount / 10),
    vocalToBackingDb: sorted.length === 0 ? null : { p10: at(0.1), p50: at(0.5), p90: at(0.9) },
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

