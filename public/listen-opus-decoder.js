/**
 * Decodes Listen's Opus monitor frames (src/monitor-opus.ts) with WebCodecs.
 *
 * Opus packets share prediction history. A playback gap must keep that history,
 * even while abandoning old queued sound. WebCodecs may return continuous
 * timestamps across input gaps, so the admitted sample spans, not AudioData's
 * timestamp, own output placement. A new stream/transport retires the decoder
 * outright; late callbacks can never consume its replacement's positions.
 */
const MIX_SAMPLE_RATE = 48_000;
const MICROSECONDS_PER_SECOND = 1_000_000;
const MAX_PENDING_SAMPLES = MIX_SAMPLE_RATE;

export const LISTEN_OPUS_DECODER_CONFIG = Object.freeze({
  codec: 'opus',
  sampleRate: MIX_SAMPLE_RATE,
  numberOfChannels: 1,
});

/** Whether this browser can decode Listen's Opus frames. Never rejects. */
export async function listenOpusDecodingSupported({
  AudioDecoderClass = globalThis.AudioDecoder,
  EncodedAudioChunkClass = globalThis.EncodedAudioChunk,
} = {}) {
  if (typeof AudioDecoderClass !== 'function' || typeof EncodedAudioChunkClass !== 'function') {
    return false;
  }
  try {
    const support = await AudioDecoderClass.isConfigSupported(LISTEN_OPUS_DECODER_CONFIG);
    return support?.supported === true;
  } catch {
    return false;
  }
}

function copyChannel(audioData) {
  const pcm = new Float32Array(audioData.numberOfFrames);
  try {
    audioData.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
  } catch (error) {
    // A browser without copyTo format conversion: mono interleaved f32 is
    // already the single channel's samples.
    if (audioData.format !== 'f32' && audioData.format !== 'f32-planar') throw error;
    audioData.copyTo(pcm, { planeIndex: 0 });
  }
  return pcm;
}

export function createListenOpusDecoder({
  onPcm,
  onError,
  AudioDecoderClass = globalThis.AudioDecoder,
  EncodedAudioChunkClass = globalThis.EncodedAudioChunk,
}) {
  let decoder = null;
  let pending = [];
  let pendingSamples = 0;
  let submittedEnd = null;
  let audibleFrom = 0;

  function open() {
    const instance = new AudioDecoderClass({
      output: (audioData) => {
        try {
          if (decoder !== instance) return;
          const pcm = copyChannel(audioData);
          let offset = 0;
          // Outputs may split or combine input packets. Consume their spans
          // in codec order, dropping only playback before the latest gap.
          while (offset < pcm.length && decoder === instance) {
            const span = pending[0];
            if (!span) throw new Error('Listen Opus output has no admitted position');
            const count = Math.min(pcm.length - offset, span.remaining);
            const first = span.firstSampleIndex;
            span.firstSampleIndex += count;
            span.remaining -= count;
            pendingSamples -= count;
            if (span.remaining === 0) pending.shift();
            const skip = Math.max(0, audibleFrom - first);
            if (skip < count) onPcm(pcm.subarray(offset + skip, offset + count), first + skip);
            offset += count;
          }
        } catch (error) {
          if (decoder === instance) fail(error);
        } finally {
          audioData.close();
        }
      },
      error: (error) => {
        if (decoder === instance) fail(error);
      },
    });
    decoder = instance;
    instance.configure(LISTEN_OPUS_DECODER_CONFIG);
    return instance;
  }

  function reset() {
    const retired = decoder;
    decoder = null;
    pending = [];
    pendingSamples = 0;
    submittedEnd = null;
    audibleFrom = 0;
    if (retired && retired.state !== 'closed') {
      try { retired.close(); } catch {}
    }
  }

  function fail(error) {
    reset();
    onError(error);
  }

  return {
    decode(frame) {
      try {
        if (!Number.isSafeInteger(frame.firstSampleIndex) || frame.firstSampleIndex < 0
          || !Number.isSafeInteger(frame.sampleCount) || frame.sampleCount <= 0
          || !Number.isSafeInteger(frame.firstSampleIndex + frame.sampleCount)
          || (submittedEnd !== null && frame.firstSampleIndex < submittedEnd))
          throw new Error('Invalid Listen Opus sample span');
        if (pendingSamples + frame.sampleCount > MAX_PENDING_SAMPLES)
          throw new Error('Listen Opus decoder fell behind live audio');
        const instance = decoder ?? open();
        if (submittedEnd !== null && frame.firstSampleIndex > submittedEnd)
          audibleFrom = frame.firstSampleIndex;
        submittedEnd = frame.firstSampleIndex + frame.sampleCount;
        pending.push({ firstSampleIndex: frame.firstSampleIndex, remaining: frame.sampleCount });
        pendingSamples += frame.sampleCount;
        instance.decode(new EncodedAudioChunkClass({
          type: 'key',
          timestamp: Math.round((frame.firstSampleIndex * MICROSECONDS_PER_SECOND) / MIX_SAMPLE_RATE),
          data: frame.packet,
        }));
      } catch (error) {
        fail(error);
      }
    },
    reset,
  };
}
