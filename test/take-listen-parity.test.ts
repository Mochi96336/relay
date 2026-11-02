import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AudioSession } from '../src/audio-session.js';
import { takeFrameBoundaryAtOrAfter } from '../src/take-boundary.js';
import { createTakeCommandHandlers } from '../src/take-command-handlers.js';
import { TakeController } from '../src/take-controller.js';

for (const prebufferMs of [0, 600]) for (const correction of ['walk', 'jump', 'secondary-walk', 'secondary-jump'] as const) {
  test(`Take preserves Listen PCM through a ${correction}, with ${prebufferMs} ms prebuffer`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-take-listen-'));
    const controller = new TakeController({ directory, sampleRate: 48_000,
      storagePolicy: { maxBytes: 0, maxAgeMs: 0, minFreeBytes: 0 },
      onStorageError: error => { throw error; },
    });
    try {
      const pcm = Buffer.alloc(48_000 * 10 * 2);
      for (let i = 0; i < pcm.length / 2; i++) {
        pcm.writeInt16LE(Math.round(8_000 * Math.sin(2 * Math.PI * 503 * i / 48_000)), i * 2);
      }
      const makeAudio = () => {
        const audio = new AudioSession({ sampleRate: 48_000, frameMs: 20, prebufferMs,
          retentionMs: 3_000, backingGain: .65 });
        audio.setMicGainDb(0); audio.setMicExpected(true); audio.start(0);
        audio.setAlignment({ calibratedMicLagMs: -200 });
        audio.ingestMic({ generation: 1, firstSampleIndex: 0, pcm }, 48_000, 0);
        if (correction.startsWith('secondary')) {
          audio.attachSecondaryMic();
          audio.setSecondaryMicGainDb(0);
          audio.setSecondaryMicLag(-200);
          audio.ingestSecondaryMic({ generation: 1, firstSampleIndex: 0, pcm }, 48_000, 0);
        }
        return audio;
      };
      const listening = makeAudio(), recording = makeAudio();
      const commandAt = prebufferMs + 60 * 20;
      const boundary = takeFrameBoundaryAtOrAfter({ generation: recording.generation,
        sessionSampleIndex: recording.sessionSampleAt(commandAt), frameSamples: 960,
        sampleRate: 48_000, nowMs: commandAt });
      const replies: Record<string, unknown>[] = [];
      const commands = createTakeCommandHandlers({ controller,
        admission: () => ({ canStartTake: true, startTakeBlockedReason: null }),
        frameBoundary: () => boundary,
        songAt: () => ({ videoId: null, revision: null, state: null, serverTime: null, playbackRate: null }),
        timingAtStart: () => ({ appliedCalibrationKind: 'content', estimateSource: null, calibrationError: null }),
        send: (_socket, message) => { replies.push(message); },
        clock: { wallTime: () => commandAt, monotonicTime: () => commandAt },
      });
      const recorded: Buffer[] = [];
      let changedInsideTake = false;
      let previousHeard: number | null = null;
      for (let frame = 0; frame < 400; frame++) {
        if (frame === 60) {
          for (const audio of [listening, recording]) {
            if (correction === 'walk') audio.slewCalibratedMicLagTo(-190);
            else if (correction === 'jump') audio.setAlignment({ calibratedMicLagMs: -170 });
            else audio.setSecondaryMicLag(correction === 'secondary-walk' ? -190 : -170);
          }
          commands.startTake({ participantId: 'singer' });
          assert.equal(replies[0]?.type, 'take-command-accepted');
        }
        let reference!: Buffer;
        const nowMs = prebufferMs + frame * 20;
        listening.drain(mixed => { reference = mixed; }, nowMs, 1);
        recording.drain((mixed, evidence, position) => {
          assert.deepEqual(mixed, reference, `recording changed frame ${frame}`);
          if (controller.append(mixed, { timingMode: 'acoustic-calibration', calibrationStale: false,
            alignmentClamped: false, robotRoute: false, robotDeltaFresh: true,
            timingDivergenceMs: null }, evidence, position)) {
            recorded.push(Buffer.from(reference));
            const heard = correction.startsWith('secondary')
              ? recording.secondaryMic!.heardAdvanceMs : recording.heardMicAdvanceMs;
            if (previousHeard !== null && previousHeard !== heard) changedInsideTake = true;
            previousHeard = heard;
          }
        }, nowMs, 1);
        assert.deepEqual(recording.micReadHeadStatus, listening.micReadHeadStatus);
      }
      assert.equal(changedInsideTake, true, 'normal live corrections must continue during the Take');
      assert.ok(recorded.length > 100);
      await controller.shutdown();
      assert.equal(controller.statusPayload().lifecycle, 'ready');
      const artifact = controller.listHistory()[0]!.artifact;
      const wav = await readFile(path.join(directory, artifact.fileName));
      assert.deepEqual(wav.subarray(44), Buffer.concat(recorded), 'WAV must contain the exact Listen frames');
    } finally {
      await controller.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
