import { readFile, writeFile } from 'node:fs/promises';

const path = new URL('../public/app.js', import.meta.url);
let source = await readFile(path, 'utf8');
let changed = false;

function replaceExact(label, before, after, marker) {
  if (source.includes(marker)) return;
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);
  if (first < 0 || first !== last) {
    throw new Error(`${label}: expected exactly one production seam`);
  }
  source = source.slice(0, first) + after + source.slice(first + before.length);
  changed = true;
}

replaceExact(
  'correlation import',
  "import { PublisherCommandLiveness } from './publisher-command-liveness.js';\n",
  "import { PublisherCommandLiveness } from './publisher-command-liveness.js';\nimport { PublisherHealthRequestCorrelation } from './publisher-health-correlation.js';\n",
  "import { PublisherHealthRequestCorrelation } from './publisher-health-correlation.js';",
);

replaceExact(
  'correlation instance',
  'const publisherCommandLiveness = new PublisherCommandLiveness();\n',
  'const publisherCommandLiveness = new PublisherCommandLiveness();\nconst publisherHealthCorrelation = new PublisherHealthRequestCorrelation();\n',
  'const publisherHealthCorrelation = new PublisherHealthRequestCorrelation();',
);

replaceExact(
  'health payload correlation',
  `function audioUplinkHealthPayload() {\n  return {\n    type: 'audio-uplink-health',\n    version: 1,\n    captureGeneration: captureGeneration >>> 0,\n`,
  `function audioUplinkHealthPayload(healthRequestId) {\n  return {\n    type: 'audio-uplink-health',\n    version: 1,\n    captureGeneration: captureGeneration >>> 0,\n    healthRequestId,\n`,
  'function audioUplinkHealthPayload(healthRequestId)',
);

replaceExact(
  'health send correlation',
  `function sendAudioUplinkHealth() {\n  maintainPublisherCommandChannel();\n  if (!publisherActive || socket?.readyState !== WebSocket.OPEN) return false;\n  return audioTransport.sendControlJson(audioUplinkHealthPayload()).sent;\n}\n`,
  `function sendAudioUplinkHealth() {\n  maintainPublisherCommandChannel();\n  const currentSocket = socket;\n  if (!publisherActive || currentSocket?.readyState !== WebSocket.OPEN) return false;\n  const generation = captureGeneration >>> 0;\n  const sessionEpoch = publisherSessionEpoch;\n  const sentAtMs = performance.now();\n  const healthRequestId = publisherHealthCorrelation.issue({\n    socket: currentSocket,\n    sessionEpoch,\n    generation,\n    sentAtMs,\n  });\n  const result = audioTransport.sendControlJson(audioUplinkHealthPayload(healthRequestId));\n  if (!result.sent) publisherHealthCorrelation.forget(healthRequestId);\n  return result.sent;\n}\n`,
  'const healthRequestId = publisherHealthCorrelation.issue({',
);

replaceExact(
  'health ack correlation',
  `  if (message.type === 'audio-uplink-health-ack') {\n    const ackGeneration = message.captureGeneration;\n    if (\n      message.version !== 1\n      || !Number.isInteger(ackGeneration)\n      || ackGeneration < 0\n      || ackGeneration > 0xffff_ffff\n      || (ackGeneration >>> 0) !== (expectedGeneration >>> 0)\n      || !isCurrentPublisherCapture(sessionEpoch, expectedGeneration)\n      || !publisherCommandLiveness.noteAck(ackGeneration, performance.now())\n    ) return;\n    refreshPublisherCommandChannel();\n    return;\n  }\n`,
  `  if (message.type === 'audio-uplink-health-ack') {\n    const ackGeneration = message.captureGeneration;\n    const healthRequestId = message.healthRequestId;\n    const ackAtMs = performance.now();\n    if (\n      message.version !== 1\n      || !Number.isInteger(ackGeneration)\n      || ackGeneration < 0\n      || ackGeneration > 0xffff_ffff\n      || !Number.isInteger(healthRequestId)\n      || healthRequestId < 0\n      || healthRequestId > 0xffff_ffff\n      || (ackGeneration >>> 0) !== (expectedGeneration >>> 0)\n      || !isCurrentPublisherCapture(sessionEpoch, expectedGeneration)\n    ) return;\n    const requestSentAtMs = publisherHealthCorrelation.consume({\n      requestId: healthRequestId,\n      socket,\n      sessionEpoch,\n      generation: ackGeneration,\n    });\n    if (\n      requestSentAtMs === null\n      || !publisherCommandLiveness.noteAck(ackGeneration, ackAtMs, requestSentAtMs)\n    ) return;\n    refreshPublisherCommandChannel();\n    return;\n  }\n`,
  'const requestSentAtMs = publisherHealthCorrelation.consume({',
);

if (!changed) {
  console.log('publisher ACK-age patch already applied');
  process.exit(0);
}

await writeFile(path, source);
console.log('publisher ACK-age patch applied');
