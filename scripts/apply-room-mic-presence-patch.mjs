import { readFile, writeFile } from 'node:fs/promises';

const path = new URL('../src/server.ts', import.meta.url);
let source = await readFile(path, 'utf8');

function replaceOnce(before, after, label) {
  const count = source.split(before).length - 1;
  if (count === 0 && source.includes(after)) return;
  if (count !== 1) throw new Error(`${label}: expected exactly one patch point, found ${count}`);
  source = source.replace(before, after);
}

replaceOnce(
  "import { parseAudioUplinkHealth, type AudioUplinkHealth } from './audio-uplink-health.js';\nimport { monitorBacklogBudgetBytes, monitorFrameWouldExceedBacklog } from './monitor-backpressure.js';",
  "import { parseAudioUplinkHealth, type AudioUplinkHealth } from './audio-uplink-health.js';\nimport { parseMicPresenceTelemetry } from './mic-presence-telemetry.js';\nimport { monitorBacklogBudgetBytes, monitorFrameWouldExceedBacklog } from './monitor-backpressure.js';",
  'Mic presence parser import',
);

replaceOnce(
  "  telemetryRejectedReason?: string;\n  infrastructureAuthenticated?: boolean;",
  "  telemetryRejectedReason?: string;\n  micPresenceTelemetryAt?: number;\n  infrastructureAuthenticated?: boolean;",
  'RelaySocket Mic presence rate-limit state',
);

const healthHandler = `    if (payload.type === 'audio-uplink-health') {\n      if (socket !== publisher || socket.role !== 'publisher' || socket.audioPacketVersion !== 2) return;\n      const health = parseAudioUplinkHealth(payload);\n      if (!health || socket.captureGeneration === undefined || health.captureGeneration !== socket.captureGeneration) return;\n      micUplinkHealth = health;\n      micUplinkHealthAt = performance.now();\n      return;\n    }\n`;

const presenceHandler = `${healthHandler}\n    if (payload.type === 'mic-presence-telemetry') {\n      const presence = parseMicPresenceTelemetry(payload);\n      const nowMs = performance.now();\n      if (\n        !presence\n        || !socket.participantId\n        || socket.participantId !== participants.micOwnerId\n        || socket.participantId !== micMediaOwnerId\n        || micMediaGeneration === null\n        || !micStreaming(nowMs)\n      ) return;\n\n      // Presence is display telemetry, not media authority. Any authenticated\n      // socket for the current Mic owner may report it, but the server binds the\n      // packet to the canonical media generation and rate-limits broadcast.\n      if (\n        Number.isFinite(socket.micPresenceTelemetryAt)\n        && nowMs - socket.micPresenceTelemetryAt! < 60\n      ) return;\n      socket.micPresenceTelemetryAt = nowMs;\n      broadcastJson({\n        type: 'room-mic-presence',\n        version: 1,\n        ownerId: micMediaOwnerId,\n        captureGeneration: micMediaGeneration,\n        rmsDbfs: presence.rmsDbfs,\n        spectrumBands: presence.spectrumBands,\n      });\n      return;\n    }\n`;

replaceOnce(healthHandler, presenceHandler, 'room Mic presence handler');

await writeFile(path, source);
