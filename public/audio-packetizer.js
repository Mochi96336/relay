export function splitPcmForPacketLimit(pcm, packetByteLimit, headerBytes) {
  if (!(pcm instanceof ArrayBuffer)) {
    throw new TypeError('PCM must be an ArrayBuffer');
  }
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
    throw new RangeError('PCM must contain one or more complete Int16 samples');
  }
  if (!Number.isInteger(headerBytes) || headerBytes < 0) {
    throw new RangeError('headerBytes must be a non-negative integer');
  }

  const limit = Number(packetByteLimit);
  if (!Number.isFinite(limit)) {
    return [{ pcm, sampleOffset: 0 }];
  }
  if (!Number.isInteger(limit) || limit <= headerBytes) {
    throw new RangeError('packetByteLimit leaves no room for PCM');
  }

  const maxPcmBytes = Math.floor((limit - headerBytes) / 2) * 2;
  if (maxPcmBytes < 2) {
    throw new RangeError('packetByteLimit leaves no room for an Int16 sample');
  }

  const segments = [];
  for (let byteOffset = 0; byteOffset < pcm.byteLength; byteOffset += maxPcmBytes) {
    const end = Math.min(pcm.byteLength, byteOffset + maxPcmBytes);
    segments.push({
      pcm: pcm.slice(byteOffset, end),
      sampleOffset: byteOffset / 2,
    });
  }
  return segments;
}
