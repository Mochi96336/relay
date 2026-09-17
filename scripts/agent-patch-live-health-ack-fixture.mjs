import { readFile, writeFile } from 'node:fs/promises';

const path = new URL('../test/browser/live-interaction.spec.mjs', import.meta.url);
let source = await readFile(path, 'utf8');
const before = `          queueMicrotask(() => deliver(this, {\n            type: 'audio-uplink-health-ack',\n            version: 1,\n            captureGeneration: message.captureGeneration,\n          }));`;
const after = `          queueMicrotask(() => deliver(this, {\n            type: 'audio-uplink-health-ack',\n            version: 1,\n            captureGeneration: message.captureGeneration,\n            healthRequestId: message.healthRequestId,\n          }));`;

if (source.includes(after)) {
  console.log('live health ACK fixture already patched');
  process.exit(0);
}
const first = source.indexOf(before);
const last = source.lastIndexOf(before);
if (first < 0 || first !== last) {
  throw new Error('expected exactly one live publisher health ACK fixture seam');
}
source = source.slice(0, first) + after + source.slice(first + before.length);
await writeFile(path, source);
console.log('live health ACK fixture patched');
