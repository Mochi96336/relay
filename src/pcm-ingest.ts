import type { PcmFrame } from './pcm-frame.js';
import {
  resamplePcm, RESAMPLE_TAIL_SAMPLES, stretchPcmSpanByOne,
  type PcmTimeline,
} from './pcm-timeline.js';

/**
 * Shared source-agnostic PCM placement engine for Mic and Robot/Backing.
 * The room supplies its clock only when a new capture anchor is necessary.
 * Singer-specific restart/trim policies are injected by that MicTrack.
 *
 * No mixer, media authority, room state, song timeline, or transport identity
 * is owned here. The existing IngestResult contract remains unchanged.
 */
export type PcmIngestResult = {
  samples: Int16Array;
  start: number;
  captureRestarted: boolean;
};

export type CapturePacketTrim = {
  samples: Int16Array;
  sourceAlignedSampleOffset: number;
  firstSourceSample: number;
  sourceSampleCount: number;
  sourceRate: number;
  contiguous: boolean;
};

export type PcmIngestInput = {
  timeline: PcmTimeline;
  frame: PcmFrame;
  sourceRate: number | null;
  mixRate: number;
  roomSampleNow: () => number;
  trackSourceClock?: boolean;
  sourceRateDefinesCapture?: boolean;
  onCaptureClockChanged?: () => void;
  trimSourcePacket?: (input: CapturePacketTrim) => Int16Array;
};

/** Robot captured-source drift is measured against the room's output clock. */
const BACKING_CLOCK_ERROR_ALPHA = 0.002;
const BACKING_CLOCK_DEADBAND_MS = 2;

export function ingestPcmTimeline(input: PcmIngestInput): PcmIngestResult {
  const {
    timeline, frame, sourceRate, mixRate, roomSampleNow,
    trackSourceClock = false, sourceRateDefinesCapture = false,
    onCaptureClockChanged, trimSourcePacket,
  } = input;
    if (!sourceRate) {
      return { samples: new Int16Array(0), start: timeline.totalSamples, captureRestarted: false };
    }

    const sourceSampleCount = Math.floor(frame.pcm.byteLength / 2);
    if (sourceSampleCount <= 0) {
      return {
        samples: new Int16Array(0),
        start: timeline.totalSamples,
        captureRestarted: false,
      };
    }
    // Preserve capture-clock anchoring by the source interval's nominal target
    // span, not by how many samples the streaming resampler can emit before it
    // receives the next interpolation endpoint. An upsampled packet may defer
    // one target sample without that sample ceasing to belong to this 20 ms
    // capture interval.
    const nominalResampledSampleCount = sourceRate === mixRate
      ? sourceSampleCount
      : Math.max(1, Math.round((sourceSampleCount * mixRate) / sourceRate));

    let captureRestarted = false;
    let start: number;
    const positioned = frame.firstSampleIndex !== null;
    const hadCaptureClock = timeline.sourceRate !== null;
    const generationChanged = positioned && timeline.generation !== frame.generation;
    const sourceRateChanged = positioned
      && sourceRateDefinesCapture
      && hadCaptureClock
      && !generationChanged
      && timeline.sourceRate !== sourceRate;
    const captureClockChanged = positioned && (generationChanged || sourceRateChanged);
    const sourceContinuous = positioned
      && !captureClockChanged
      && timeline.sourceFrontier === frame.firstSampleIndex;
    const resampled = resamplePcm(
      frame.pcm,
      sourceRate,
      mixRate,
      positioned ? frame.firstSampleIndex : null,
      sourceContinuous ? timeline.resampleTail : [],
      sourceContinuous ? timeline.resampleNextTargetSample : null,
    );
    let samples = resampled.samples;
    let sourceAlignedSampleOffset = resampled.sourceAlignedSampleOffset;
    if (samples.length === 0 && !positioned) {
      return { samples, start: timeline.totalSamples, captureRestarted: false };
    }

    if (!positioned) {
      // No header: the only thing left to do is append at the frontier, which
      // is the old lossy behaviour. Flag it so the UI can say the client is
      // stale rather than letting it degrade invisibly. Its source position is
      // unknowable, so it also breaks positioned resampler continuity.
      timeline.unheadered = true;
      timeline.resampleTail = [];
      timeline.resampleNextTargetSample = null;
      start = timeline.totalSamples;
    } else {
      // Each frame states its own position, so rounding never accumulates and a
      // missing frame leaves a hole of exactly the right length instead of
      // pulling everything after it earlier.
      const streamStart = resampled.targetStart
        ?? Math.ceil((frame.firstSampleIndex! * mixRate) / sourceRate);

      captureRestarted = hadCaptureClock && captureClockChanged;
      if (captureClockChanged) {
        // A fresh capture clock. Anchor it to the session clock; the previous
        // capture's samples keep their own place and simply age out. Mic source
        // rate is part of that clock identity because firstSampleIndex is
        // expressed in source-rate samples even when a client incorrectly
        // reuses its wire generation after rebuilding the capture graph.
        timeline.generation = frame.generation;
        timeline.sourceRate = sourceRate;
        timeline.originOffset = Math.max(
          0,
          roomSampleNow() - nominalResampledSampleCount,
        ) - streamStart;
        timeline.clockErrorSamples = 0;
        timeline.sourceFrontier = null;
        // The new capture is anchored to the current mix clock, so it starts
        // with healthy headroom and owes nothing to the deficit the correction
        // was covering. Carrying that forward would hold the read head a second
        // behind fresh audio and unwind only at the slew rate - most of a song.
        // Track-specific restart state is owned by the calling source. This
        // callback runs AFTER the timeline's generation has advanced, exactly
        // where AudioSession previously reset Mic trim and frontier.
        onCaptureClockChanged?.();
      } else if (timeline.sourceRate === null) {
        timeline.sourceRate = sourceRate;
      }

      start = streamStart + timeline.originOffset;

      if (trackSourceClock && sourceContinuous && start === timeline.totalSamples) {
        const predictedEnd = start + samples.length;
        const rawError = Math.max(0, roomSampleNow() - predictedEnd);
        timeline.clockErrorSamples += BACKING_CLOCK_ERROR_ALPHA
          * (rawError - timeline.clockErrorSamples);

        const deadbandSamples = Math.max(
          1,
          Math.round((BACKING_CLOCK_DEADBAND_MS * mixRate) / 1000),
        );
        const correction = timeline.clockErrorSamples > deadbandSamples ? 1 : 0;

        if (correction > 0 && samples.length > sourceAlignedSampleOffset) {
          // Keep any deferred previous-frame interpolation prefix byte-for-byte
          // intact. Only the portion attributable to this source frame is the
          // clock-trim authority for this correction.
          const prefix = samples.subarray(0, sourceAlignedSampleOffset);
          const currentFrame = samples.subarray(sourceAlignedSampleOffset);
          const stretchedCurrentFrame = stretchPcmSpanByOne(currentFrame);
          const stretched = new Int16Array(samples.length + 1);
          stretched.set(prefix, 0);
          stretched.set(stretchedCurrentFrame, sourceAlignedSampleOffset);
          samples = stretched;
          timeline.originOffset += 1;
          timeline.clockErrorSamples -= 1;
          timeline.clockCorrectionSamples += 1;
          start = timeline.totalSamples;
        }
      }

      if (trimSourcePacket) {
        // Mic-owned trim or another caller-supplied source correction.
        // The common ingest path never guesses which stream is authoritative.
        samples = trimSourcePacket({
          samples,
          sourceAlignedSampleOffset,
          firstSourceSample: frame.firstSampleIndex!,
          sourceSampleCount,
          sourceRate,
          contiguous: sourceContinuous && start === timeline.totalSamples,
        });
      }
      const sourceEnd = frame.firstSampleIndex! + sourceSampleCount;
      const previousSourceFrontier = timeline.sourceFrontier;
      const advancesSourceFrontier = captureClockChanged
        || previousSourceFrontier === null
        || sourceEnd > previousSourceFrontier;
      timeline.sourceFrontier = captureClockChanged || previousSourceFrontier === null
        ? sourceEnd
        : Math.max(previousSourceFrontier, sourceEnd);
      if (advancesSourceFrontier) {
        const carried = sourceContinuous ? timeline.resampleTail : [];
        const own: number[] = [];
        for (let index = Math.max(0, sourceSampleCount - RESAMPLE_TAIL_SAMPLES); index < sourceSampleCount; index += 1) {
          own.push(frame.pcm.readInt16LE(index * 2));
        }
        timeline.resampleTail = [...carried, ...own].slice(-RESAMPLE_TAIL_SAMPLES);
        timeline.resampleNextTargetSample = resampled.nextTargetSample;
      }
    }

    if (start < timeline.totalSamples) {
      // Transport ordering is no longer an AudioSession contract. The packet
      // receiver normally prevents late overlap, but this boundary still must
      // not relocate old audio to "now" if a caller violates it. Keep only a
      // genuinely new tail; a fully late packet contributes nothing.
      const overlap = timeline.totalSamples - start;
      if (overlap >= samples.length) {
        return {
          samples: new Int16Array(0),
          start: timeline.totalSamples,
          captureRestarted,
        };
      }
      samples = samples.slice(overlap);
      sourceAlignedSampleOffset = Math.max(0, sourceAlignedSampleOffset - overlap);
      start = timeline.totalSamples;
    } else if (start > timeline.totalSamples && timeline.chunks.length > 0) {
      timeline.gapSamples += start - timeline.totalSamples;
    }

    if (samples.length === 0) return { samples, start, captureRestarted };
    timeline.chunks.push({ start, samples, positioned });
    timeline.totalSamples = start + samples.length;

    // Frame-scoped consumers combine this return value with the current wire
    // frame metadata. Keep a completed deferred prefix on the timeline, but do
    // not attribute that prefix to the new frame whose source clock starts later.
    const consumerOffset = Math.min(samples.length, sourceAlignedSampleOffset);
    return {
      samples: samples.subarray(consumerOffset),
      start: start + consumerOffset,
      captureRestarted,
    };
  }


