const FRAME_MAGIC = 0x4c52; // 'RL' as uint16 LE
const FRAME_VERSION = 1;
const FRAME_HEADER_BYTES = 16;

export const MONITOR_PCM_PACKET_VERSION = FRAME_VERSION;

/**
 * Decode the positioned PCM format negotiated by a monitor socket.
 *
 * This path is deliberately strict. Once a monitor opts in to framed PCM, a
 * malformed packet must never fall back to raw audio or the 16-byte transport
 * header would become audible samples.
 */
export function decodeMonitorPcmFrame(buffer) {
  if (!(buffer instanceof ArrayBuffer)) return null;
  const pcmBytes = buffer.byteLength - FRAME_HEADER_BYTES;
  if (pcmBytes <= 0 || pcmBytes % Int16Array.BYTES_PER_ELEMENT !== 0) return null;

  const view = new DataView(buffer);
  if (
    view.getUint16(0, true) !== FRAME_MAGIC
    || view.getUint8(2) !== FRAME_VERSION
    || view.getUint8(3) !== 0
  ) return null;

  const firstSampleIndex = view.getFloat64(8, true);
  if (!Number.isSafeInteger(firstSampleIndex) || firstSampleIndex < 0) return null;

  return {
    generation: view.getUint32(4, true),
    firstSampleIndex,
    sampleCount: pcmBytes / Int16Array.BYTES_PER_ELEMENT,
    pcm: buffer.slice(FRAME_HEADER_BYTES),
  };
}

/**
 * WebSocket preserves frame order, so monitor continuity only has three live
 * cases after the first packet of a transport:
 *
 * - exact expected sample -> normal continuation
 * - future sample -> server/network gap; abandon queued stale audio and catch up
 * - past sample -> stale/duplicate packet; never move the realtime frontier back
 *
 * The first packet after a socket reconnect may begin anywhere in the current
 * generation. The Listen adapter resets both this tracker and the AudioWorklet
 * queue at that transport boundary, so joining mid-generation is not a gap.
 */
export function createMonitorPcmContinuity() {
  let generation = null;
  let expectedSampleIndex = null;

  function reset() {
    generation = null;
    expectedSampleIndex = null;
  }

  function accept(frame) {
    if (!frame || !Number.isSafeInteger(frame.sampleCount) || frame.sampleCount <= 0) {
      return { action: 'drop', reason: 'malformed' };
    }

    const frameEnd = frame.firstSampleIndex + frame.sampleCount;
    if (!Number.isSafeInteger(frameEnd)) {
      return { action: 'drop', reason: 'malformed' };
    }

    if (generation === null || expectedSampleIndex === null) {
      generation = frame.generation;
      expectedSampleIndex = frameEnd;
      return {
        action: 'accept',
        reset: false,
        reason: 'first',
        gapSamples: 0,
      };
    }

    if (frame.generation !== generation) {
      generation = frame.generation;
      expectedSampleIndex = frameEnd;
      return {
        action: 'accept',
        reset: true,
        reason: 'generation',
        gapSamples: 0,
      };
    }

    if (frame.firstSampleIndex < expectedSampleIndex) {
      return {
        action: 'drop',
        reason: 'stale',
        expectedSampleIndex,
      };
    }

    const gapSamples = frame.firstSampleIndex - expectedSampleIndex;
    expectedSampleIndex = frameEnd;
    return {
      action: 'accept',
      reset: gapSamples > 0,
      reason: gapSamples > 0 ? 'gap' : 'contiguous',
      gapSamples,
    };
  }

  return {
    reset,
    accept,
    snapshot() {
      return { generation, expectedSampleIndex };
    },
  };
}

export function createMonitorPcmReceiver() {
  const continuity = createMonitorPcmContinuity();

  return {
    reset: continuity.reset,
    receive(buffer) {
      const frame = decodeMonitorPcmFrame(buffer);
      if (!frame) return { action: 'drop', reason: 'malformed' };
      return {
        ...continuity.accept(frame),
        frame,
      };
    },
    snapshot: continuity.snapshot,
  };
}
