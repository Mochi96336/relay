// One binary retransmission request, shared by Relay (encode) and the page
// (decode). It rides the WebTransport session back to the phone so the request
// takes the same direct path as the repeat it asks for, instead of detouring
// through the control WebSocket. The JSON control message stays as the
// fallback; the page answers each attempt of a sequence once, whichever copy
// arrives first.
//
//   offset  size  field
//        0     2  magic 'RQ' (uint16 LE)
//        2     1  version = 1
//        3     1  attempt (0 = first request; Relay retries a lost repeat)
//        4     4  capture generation (uint32 LE)
//        8     2  sequence count (uint16 LE)
//       10   4*n  sequences (uint32 LE)

export const RETRANSMIT_REQUEST_MAGIC = 0x5152;
export const RETRANSMIT_REQUEST_VERSION = 1;
export const RETRANSMIT_REQUEST_HEADER_BYTES = 10;
export const MAX_RETRANSMIT_REQUEST_SEQUENCES = 64;
export const MAX_RETRANSMIT_REQUEST_ATTEMPT = 0xff;

function uint32(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

export function encodeRetransmitRequest(captureGeneration, sequences, attempt = 0) {
  if (!uint32(captureGeneration)) throw new RangeError('captureGeneration must be a uint32');
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > MAX_RETRANSMIT_REQUEST_ATTEMPT) {
    throw new RangeError('attempt must be a uint8');
  }
  if (!Array.isArray(sequences) || sequences.length < 1) {
    throw new RangeError('sequences must be a non-empty array');
  }
  if (sequences.length > MAX_RETRANSMIT_REQUEST_SEQUENCES) {
    throw new RangeError(`at most ${MAX_RETRANSMIT_REQUEST_SEQUENCES} sequences per request`);
  }
  const bytes = new Uint8Array(RETRANSMIT_REQUEST_HEADER_BYTES + sequences.length * 4);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, RETRANSMIT_REQUEST_MAGIC, true);
  view.setUint8(2, RETRANSMIT_REQUEST_VERSION);
  view.setUint8(3, attempt);
  view.setUint32(4, captureGeneration, true);
  view.setUint16(8, sequences.length, true);
  sequences.forEach((sequence, index) => {
    if (!uint32(sequence)) throw new RangeError('sequences must be uint32 values');
    view.setUint32(RETRANSMIT_REQUEST_HEADER_BYTES + index * 4, sequence, true);
  });
  return bytes;
}

/** The request carried by `bytes`, or null for anything else on the path. */
export function decodeRetransmitRequest(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < RETRANSMIT_REQUEST_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint16(0, true) !== RETRANSMIT_REQUEST_MAGIC
    || view.getUint8(2) !== RETRANSMIT_REQUEST_VERSION
  ) return null;
  const count = view.getUint16(8, true);
  if (
    count < 1
    || count > MAX_RETRANSMIT_REQUEST_SEQUENCES
    || bytes.byteLength !== RETRANSMIT_REQUEST_HEADER_BYTES + count * 4
  ) return null;
  const sequences = [];
  for (let index = 0; index < count; index += 1) {
    sequences.push(view.getUint32(RETRANSMIT_REQUEST_HEADER_BYTES + index * 4, true));
  }
  return { captureGeneration: view.getUint32(4, true), sequences, attempt: view.getUint8(3) };
}
