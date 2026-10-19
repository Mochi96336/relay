import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TakeLibrary } from '../src/take-library.js';
import { prepareTakeStorage, type TakeStoragePolicy } from '../src/take-storage.js';
import { wav } from './support/take-wav.js';

const policy: TakeStoragePolicy = { maxBytes: 0, maxAgeMs: 0, minFreeBytes: 0 };

function takeId(index: number) {
  return `66666666-6666-4666-8666-66666666666${index}`;
}

function emptyEvents() {
  return {
    'mic-transport-disconnected': 0,
    'mic-transport-connected': 0,
    'mic-capture-restarted': 0,
    'backing-transport-disconnected': 0,
    'backing-transport-connected': 0,
    'backing-transport-replaced': 0,
    'backing-capture-restarted': 0,
    'robot-source-disconnected': 0,
    'robot-source-connected': 0,
    'robot-source-replaced': 0,
    'mic-owner-changed': 0,
    'server-shutdown': 0,
  };
}

function v1Evidence() {
  return {
    sampleRate: 48_000,
    recordedSamples: 4_800,
    recordedDurationMs: 100,
    micGapSamples: 0,
    micGapMs: 0,
    backingGapSamples: 0,
    backingGapMs: 0,
    micStarvedFrames: 0,
    backingStarvedFrames: 0,
    micStarvedSamples: 0,
    backingStarvedSamples: 0,
    micStarvedMs: 0,
    backingStarvedMs: 0,
    clippedSamples: 0,
    clippedMs: 0,
    limitedSamples: 0,
    limitedMs: 0,
    unheaderedSamples: 0,
    unheadered: false,
    micUnavailableSamples: 0,
    micUnavailableMs: 0,
    backingUnavailableSamples: 0,
    backingUnavailableMs: 0,
    networkEstimateSamples: 0,
    networkEstimateMs: 0,
    calibrationStaleSamples: 0,
    calibrationStaleMs: 0,
    alignmentClampedSamples: 0,
    alignmentClampedMs: 0,
    robotDeltaMissingSamples: 0,
    robotDeltaMissingMs: 0,
    events: emptyEvents(),
  };
}

function quality(
  policyVersion:
    | 'take-quality-v1'
    | 'take-quality-v2'
    | 'take-quality-v3'
    | 'take-quality-v4'
    | 'take-quality-v5'
    | 'take-quality-v6',
) {
  const evidence: Record<string, unknown> = v1Evidence();
  if (policyVersion !== 'take-quality-v1') {
    evidence.timingDivergedSamples = 0;
    evidence.timingDivergedMs = 0;
    evidence.peakTimingDivergenceMs = 0;
  }
  if (
    policyVersion === 'take-quality-v3'
    || policyVersion === 'take-quality-v4'
    || policyVersion === 'take-quality-v5'
    || policyVersion === 'take-quality-v6'
  ) {
    evidence.timingDivergenceToleranceMs = 150;
  }
  if (policyVersion === 'take-quality-v4' || policyVersion === 'take-quality-v5'
    || policyVersion === 'take-quality-v6') {
    evidence.micInputClippedSamples = 0;
    evidence.micInputClippedMs = 0;
  }
  if (policyVersion === 'take-quality-v5' || policyVersion === 'take-quality-v6') {
    evidence.events = {
      ...(evidence.events as Record<string, number>),
      'mic-input-gap': 0,
    };
  }
  return {
    policyVersion,
    verdict: 'clean',
    evidence,
    issues: [],
  };
}

function metadata(id: string, qualityValue: unknown = quality('take-quality-v5')) {
  const bytes = wav();
  return {
    version: 1,
    take: {
      takeId: id,
      startedAtMs: 1_000,
      endedAtMs: 1_100,
      startedByParticipantId: 'participant-a',
      stoppedByParticipantId: 'participant-b',
      stopReason: 'user',
      song: {
        videoId: 'video-a',
        revision: 4,
        state: 1,
        serverTime: 12.5,
        playbackRate: 1,
      },
      artifact: {
        fileName: `${id}.wav`,
        url: `/takes/${id}.wav`,
        mimeType: 'audio/wav',
        sizeBytes: bytes.byteLength,
        sampleRate: 48_000,
        channels: 1,
        bitsPerSample: 16,
        sampleCount: 4_800,
        durationMs: 100,
      },
      mixSampleRange: {
        generation: 7,
        startSampleIndex: 9_600,
        endSampleIndex: 14_400,
        sampleCount: 4_800,
      },
      quality: qualityValue,
      recovered: false,
    },
  };
}

async function writeCrashCandidate(directory: string, id: string, payload: unknown) {
  await writeFile(path.join(directory, `${id}.wav`), wav());
  await writeFile(
    path.join(directory, `${id}.json.part`),
    `${JSON.stringify(payload)}\n`,
    'utf8',
  );
  const prepared = prepareTakeStorage(directory, policy);
  assert.equal(prepared.removedPartialFiles, 0);
}

async function recover(directory: string, id: string) {
  const library = new TakeLibrary({ directory });
  library.prepare();
  return library.get(id);
}

test('malformed present rich fields fail closed to WAV-only recovery', async (t) => {
  const mutations: Array<[string, (payload: ReturnType<typeof metadata>) => void]> = [
    ['stop reason', (payload) => { payload.take.stopReason = 'teleported' as never; }],
    ['song', (payload) => { payload.take.song = 'garbage' as never; }],
    ['quality', (payload) => { payload.take.quality = 'garbage'; }],
    ['recovered flag', (payload) => { payload.take.recovered = 'nope' as never; }],
  ];

  for (const [label, mutate] of mutations) {
    await t.test(label, async () => {
      const index = mutations.findIndex(([name]) => name === label) + 1;
      const id = takeId(index);
      const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-rich-invalid-'));
      try {
        const payload = metadata(id);
        mutate(payload);
        await writeCrashCandidate(directory, id, payload);
        const entry = await recover(directory, id);

        assert.ok(entry);
        assert.equal(entry.recovered, true);
        assert.equal(entry.stopReason, null);
        assert.equal(entry.song, null);
        assert.equal(entry.quality, null);
        assert.equal(entry.mixSampleRange, null);
        assert.equal((await readdir(directory)).includes(`${id}.json.part`), false);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test('archived v1 to v5 quality assessments remain valid without reassessment', async (t) => {
  for (const [index, version] of [
    [5, 'take-quality-v1'],
    [6, 'take-quality-v2'],
    [8, 'take-quality-v3'],
    [4, 'take-quality-v4'],
    [1, 'take-quality-v5'],
  ] as const) {
    await t.test(version, async () => {
      const id = takeId(index);
      const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-rich-archive-'));
      try {
        await writeCrashCandidate(directory, id, metadata(id, quality(version)));
        const entry = await recover(directory, id);

        assert.ok(entry?.quality);
        assert.equal(entry.recovered, false);
        assert.equal(
          (entry.quality as unknown as { policyVersion: string }).policyVersion,
          version,
        );
        assert.equal(entry.quality.verdict, 'clean');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test('missing legacy rich fields normalize without rejecting an otherwise valid sidecar', async () => {
  const id = takeId(7);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-rich-legacy-'));
  try {
    const payload = metadata(id);
    const legacy = structuredClone(payload) as {
      version: number;
      take: Record<string, unknown>;
    };
    delete legacy.take.stopReason;
    delete legacy.take.song;
    delete legacy.take.mixSampleRange;
    delete legacy.take.quality;
    delete legacy.take.recovered;

    await writeCrashCandidate(directory, id, legacy);
    const entry = await recover(directory, id);

    assert.ok(entry);
    assert.equal(entry.recovered, false);
    assert.equal(entry.stopReason, null);
    assert.equal(entry.song, null);
    assert.equal(entry.mixSampleRange, null);
    assert.equal(entry.quality, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('quality v4 requires explicit Mic input clipping evidence', async () => {
  const id = takeId(4);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-rich-v4-clipping-'));
  try {
    const malformed = quality('take-quality-v4');
    delete (malformed.evidence as Record<string, unknown>).micInputClippedSamples;
    await writeCrashCandidate(directory, id, metadata(id, malformed));
    const entry = await recover(directory, id);

    assert.ok(entry);
    assert.equal(entry.recovered, true);
    assert.equal(entry.quality, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('quality v5 requires explicit Mic input-gap event evidence', async () => {
  const id = takeId(3);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-rich-v5-input-gap-'));
  try {
    const malformed = quality('take-quality-v5');
    delete ((malformed.evidence as Record<string, unknown>).events as Record<string, unknown>)['mic-input-gap'];
    await writeCrashCandidate(directory, id, metadata(id, malformed));
    const entry = await recover(directory, id);

    assert.ok(entry);
    assert.equal(entry.recovered, true);
    assert.equal(entry.quality, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("quality v6 keeps the second singer's part, and its issue codes do not exist before v6", async (t) => {
  const secondSinger = (version: 'take-quality-v5' | 'take-quality-v6') => {
    const value = quality(version);
    Object.assign(value.evidence, {
      secondaryAudibleSamples: 48_000, secondaryAudibleMs: 1_000,
      secondaryGapSamples: 0, secondaryGapMs: 0,
      secondaryStarvedSamples: 14_400, secondaryStarvedMs: 300,
    });
    return {
      ...value,
      verdict: 'degraded',
      issues: [{
        code: 'second-mic-starvation', severity: 'critical', value: 300, unit: 'ms',
        message: "The mixer recorded the second singer's samples beyond its live source frontier.",
      }],
    };
  };
  for (const [index, version, kept] of [
    [2, 'take-quality-v6', true],
    [3, 'take-quality-v5', false],
  ] as const) {
    await t.test(version, async () => {
      const id = takeId(index);
      const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-rich-second-singer-'));
      try {
        await writeCrashCandidate(directory, id, metadata(id, secondSinger(version)));
        const entry = await recover(directory, id);
        assert.ok(entry);
        if (kept) {
          assert.ok(entry.quality);
          assert.equal(entry.quality.verdict, 'degraded');
          assert.equal(entry.quality.evidence.secondaryStarvedMs, 300);
        } else {
          assert.equal(entry.quality, null, 'v5 has no second-singer issue codes');
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test('invalid archived quality policy versions fail closed', async () => {
  const id = takeId(9);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-rich-policy-'));
  try {
    const invalid = quality('take-quality-v5') as Record<string, unknown>;
    invalid.policyVersion = 'take-quality-v7';
    await writeCrashCandidate(directory, id, metadata(id, invalid));
    const entry = await recover(directory, id);

    assert.ok(entry);
    assert.equal(entry.recovered, true);
    assert.equal(entry.quality, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('normalization is durable after promotion', async () => {
  const id = takeId(0);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-rich-normalize-'));
  try {
    const payload = metadata(id);
    const legacy = structuredClone(payload) as {
      version: number;
      take: Record<string, unknown>;
    };
    delete legacy.take.recovered;
    await writeCrashCandidate(directory, id, legacy);
    const entry = await recover(directory, id);
    assert.ok(entry);
    assert.equal(entry.recovered, false);

    const persisted = JSON.parse(
      await readFile(path.join(directory, `${id}.json`), 'utf8'),
    ) as { take: { recovered?: unknown } };
    // Promotion is an atomic rename of the historical bytes; normalization is
    // an in-memory compatibility rule, not a silent archival rewrite.
    assert.equal(persisted.take.recovered, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
