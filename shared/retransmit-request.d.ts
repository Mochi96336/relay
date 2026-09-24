export const RETRANSMIT_REQUEST_MAGIC: number;
export const RETRANSMIT_REQUEST_VERSION: number;
export const RETRANSMIT_REQUEST_HEADER_BYTES: number;
export const MAX_RETRANSMIT_REQUEST_SEQUENCES: number;

export function encodeRetransmitRequest(captureGeneration: number, sequences: number[]): Uint8Array;
export function decodeRetransmitRequest(
  bytes: unknown,
): { captureGeneration: number; sequences: number[] } | null;
