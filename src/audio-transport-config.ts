export type AudioTransportConfig = {
  reorderWindowPackets: number;
  reorderDeadlineMs: number;
  maxForwardJumpPackets: number;
};

export const DEFAULT_AUDIO_TRANSPORT_CONFIG: Readonly<AudioTransportConfig> = Object.freeze({
  reorderWindowPackets: 8,
  reorderDeadlineMs: 40,
  maxForwardJumpPackets: 256,
});

const HALF_SEQUENCE_SPACE = 0x8000_0000;

function optionalInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  { minimum, maximum }: { minimum: number; maximum?: number },
) {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (raw.trim() === '') throw new Error(`${name} must not be empty.`);

  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || (maximum !== undefined && value > maximum)) {
    const range = maximum === undefined ? `>= ${minimum}` : `between ${minimum} and ${maximum}`;
    throw new Error(`${name} must be an integer ${range}; received ${JSON.stringify(raw)}.`);
  }
  return value;
}

/**
 * Parse and validate all AudioPacket receiver tuning before the server starts.
 * Explicitly invalid deployment values fail fast instead of silently falling
 * back to defaults and changing transport behavior behind the operator's back.
 */
export function loadAudioTransportConfig(
  env: NodeJS.ProcessEnv = process.env,
): AudioTransportConfig {
  const reorderWindowPackets = optionalInteger(
    env,
    'RELAY_AUDIO_REORDER_WINDOW_PACKETS',
    DEFAULT_AUDIO_TRANSPORT_CONFIG.reorderWindowPackets,
    { minimum: 0, maximum: HALF_SEQUENCE_SPACE - 1 },
  );
  const reorderDeadlineMs = optionalInteger(
    env,
    'RELAY_AUDIO_REORDER_DEADLINE_MS',
    DEFAULT_AUDIO_TRANSPORT_CONFIG.reorderDeadlineMs,
    { minimum: 0 },
  );
  const maxForwardJumpPackets = optionalInteger(
    env,
    'RELAY_AUDIO_MAX_FORWARD_JUMP_PACKETS',
    DEFAULT_AUDIO_TRANSPORT_CONFIG.maxForwardJumpPackets,
    { minimum: 1, maximum: HALF_SEQUENCE_SPACE - 1 },
  );

  if (reorderWindowPackets > maxForwardJumpPackets) {
    throw new Error(
      'RELAY_AUDIO_REORDER_WINDOW_PACKETS cannot exceed '
      + 'RELAY_AUDIO_MAX_FORWARD_JUMP_PACKETS.',
    );
  }

  return {
    reorderWindowPackets,
    reorderDeadlineMs,
    maxForwardJumpPackets,
  };
}
