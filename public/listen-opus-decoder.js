/**
 * Decodes Listen's Opus monitor frames (src/monitor-opus.ts) with WebCodecs.
 *
 * Each frame is one independent Opus packet at a known mix position, so the
 * packet's position rides through the decoder as its timestamp and comes back
 * on the decoded AudioData: output needs no bookkeeping of its own. A reset
 * (a gap, a new mix generation, a new transport) retires the decoder instance
 * outright, so nothing it still had in flight can reach playback afterwards.
 */
const MIX_SAMPLE_RATE = 48_000;
const MICROSECONDS_PER_SECOND = 1_000_000;

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

  function open() {
    const instance = new AudioDecoderClass({
      output: (audioData) => {
        try {
          if (decoder !== instance) return;
          const firstSampleIndex = Math.round(
            (audioData.timestamp * MIX_SAMPLE_RATE) / MICROSECONDS_PER_SECOND,
          );
          onPcm(copyChannel(audioData), firstSampleIndex);
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
    instance.configure(LISTEN_OPUS_DECODER_CONFIG);
    decoder = instance;
    return instance;
  }

  function reset() {
    const retired = decoder;
    decoder = null;
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
      const instance = decoder ?? open();
      instance.decode(new EncodedAudioChunkClass({
        type: 'key',
        timestamp: Math.round((frame.firstSampleIndex * MICROSECONDS_PER_SECOND) / MIX_SAMPLE_RATE),
        data: frame.packet,
      }));
    },
    reset,
  };
}
