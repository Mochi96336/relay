export type AudioTransportConfig = {
  reorderWindowPackets: number;
  reorderDeadlineMs: number;
  maxForwardJumpPackets: number;
  /**
   * Longest a lost Mic packet may hold the ordered stream while its
   * retransmission is requested. The mix still withdraws the hold whenever its
   * own headroom runs short, so this is a ceiling, not a fixed added delay:
   * the mix reads the Mic at a fixed position, so holding never delays what
   * the room hears. The default matches the default live prebuffer, letting
   * the available headroom rather than this number decide. 0 disables
   * retransmission requests.
   */
  retransmitHoldMs?: number;
  /** Reorder window while a retransmission hold is active, in packets. */
  retransmitWindowPackets?: number;
};

export const DEFAULT_AUDIO_TRANSPORT_CONFIG: Readonly<Required<AudioTransportConfig>> = Object.freeze({
  reorderWindowPackets: 8,
  reorderDeadlineMs: 40,
  maxForwardJumpPackets: 256,
  retransmitHoldMs: 400,
  retransmitWindowPackets: 48,
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

  const retransmitHoldMs = optionalInteger(
    env,
    'RELAY_AUDIO_RETRANSMIT_HOLD_MS',
    DEFAULT_AUDIO_TRANSPORT_CONFIG.retransmitHoldMs,
    { minimum: 0 },
  );
  // The default follows a smaller configured forward bound; only an explicit
  // contradictory value is an operator error.
  const retransmitWindowPackets = optionalInteger(
    env,
    'RELAY_AUDIO_RETRANSMIT_WINDOW_PACKETS',
    Math.min(DEFAULT_AUDIO_TRANSPORT_CONFIG.retransmitWindowPackets, maxForwardJumpPackets),
    { minimum: 0, maximum: HALF_SEQUENCE_SPACE - 1 },
  );

  if (reorderWindowPackets > maxForwardJumpPackets) {
    throw new Error(
      'RELAY_AUDIO_REORDER_WINDOW_PACKETS cannot exceed '
      + 'RELAY_AUDIO_MAX_FORWARD_JUMP_PACKETS.',
    );
  }

  if (retransmitWindowPackets > maxForwardJumpPackets) {
    throw new Error(
      'RELAY_AUDIO_RETRANSMIT_WINDOW_PACKETS cannot exceed '
      + 'RELAY_AUDIO_MAX_FORWARD_JUMP_PACKETS.',
    );
  }

  return {
    reorderWindowPackets,
    reorderDeadlineMs,
    maxForwardJumpPackets,
    retransmitHoldMs,
    retransmitWindowPackets,
  };
}
