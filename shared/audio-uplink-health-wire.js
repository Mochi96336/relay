// Compact health v1: field order is a wire contract. Append fields; never reorder.
// A presence bitmap preserves omitted fields versus explicit null/false/zero.
// Only server-observed fields travel; browser-only transport counters stay local.
const schemas = {
  health: ['captureGeneration', 'captureGenerationReason', 'healthRequestId',
    'capturedAtPerformanceMs', 'captureClock', 'capturedSamples', 'inputGapSamples',
    'inputGapActive', 'inputMuted', 'capture', 'captureLevel', 'captureClipping',
    'captureDispatch', 'droppedSamples', 'controlReconnects', 'transport'],
  captureClock: ['contextSeconds', 'originContextSeconds', 'lastChunkContextSeconds',
    'lastChunkSampleIndex', 'lastChunkObservedAtMs', 'sampleRate'],
  capture: ['echoCancellation', 'noiseSuppression', 'autoGainControl',
    'audioSessionType', 'inputLabel', 'device'],
  captureLevel: ['peakDbfs', 'rmsDbfs'],
  captureClipping: ['railSamples', 'maxConsecutiveRailSamples', 'recentDetected'],
  captureDispatch: ['lagMs', 'maxLagMs', 'backlogMs', 'backlogActive'],
  droppedSamples: ['total', 'disconnected', 'congested', 'packetTooLarge', 'captureBacklog'],
  transport: ['path', 'maxPacketBytes', 'minWebTransportMaxPacketBytes',
    'maxWebTransportMaxPacketBytes', 'datagramPacketBytesCeiling', 'datagramQueuePackets',
    'webTransportLastFailure', 'datagramOutgoingMaxAgeMs', 'mediaRecoveryDegraded',
    'webTransportAttempts', 'webTransportConnections', 'webTransportDemotions',
    'webTransportPacketsSubmitted', 'webTransportCongestedRejects',
    'webTransportPacketTooLargeRejects', 'webTransportSendFailures',
    'webTransportBacklogQueued', 'webTransportBacklogExpired', 'retransmitBufferPackets',
    'retransmittedPackets', 'webTransportRetries', 'retransmitDatagramRequests',
    'webSocketPacketsSent', 'webSocketCongestedRejects', 'webSocketDisconnectedRejects',
    'webSocketSendFailures', 'codec', 'codecBitrate', 'codecBitrateReason', 'recovery'],
  recovery: ['sequence', 'action', 'reason', 'phase', 'webTransportDemotionUsed',
    'webSocketReplacementUsed', 'ackRoundTripMs', 'controlSilenceMs', 'audioBacklogMs',
    'queueAgeMs', 'mixPlayable', 'mixHeadroomMs', 'pendingHealth', 'unmatchedHealthAcks', 'events'],
  event: ['sequence', 'action', 'reason', 'ageMs'],
};

function pack(value, name) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid health object');
  let mask = 0;
  const values = [];
  schemas[name].forEach((key, index) => {
    if (value[key] === undefined) return;
    mask += 2 ** index;
    const child = key === 'events'
      ? value[key].map(event => pack(event, 'event'))
      : schemas[key] ? pack(value[key], key) : value[key];
    values.push(child);
  });
  return [mask, ...values];
}

function unpack(value, name) {
  if (value === null) return null;
  if (!Array.isArray(value) || !Number.isSafeInteger(value[0])
    || value[0] < 0 || value[0] >= 2 ** schemas[name].length) throw new Error('Invalid health bitmap');
  const result = {};
  let cursor = 1;
  schemas[name].forEach((key, index) => {
    if (Math.floor(value[0] / 2 ** index) % 2 === 0) return;
    if (cursor >= value.length) throw new Error('Missing health field');
    const child = value[cursor++];
    if (key === 'events') {
      if (!Array.isArray(child) || child.length > 8) throw new Error('Invalid health events');
      result[key] = child.map(event => unpack(event, 'event'));
    } else result[key] = schemas[key] ? unpack(child, key) : child;
  });
  if (cursor !== value.length) throw new Error('Extra health fields');
  return result;
}

export function encodeAudioUplinkHealth(health) {
  return JSON.stringify({ type: 'audio-uplink-health', version: 1, compact: 1, data: pack(health, 'health') });
}

export function decodeAudioUplinkHealth(value) {
  if (!value || typeof value !== 'object' || !('compact' in value)) return value;
  if (value.type !== 'audio-uplink-health' || value.version !== 1 || value.compact !== 1) return null;
  try { return { type: value.type, version: 1, ...unpack(value.data, 'health') }; }
  catch { return null; }
}
