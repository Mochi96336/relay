import { readFile, writeFile } from 'node:fs/promises';

const path = new URL('../test/ui-authority-freshness.test.ts', import.meta.url);
let source = await readFile(path, 'utf8');
const before = String.raw`    /message\.type === 'audio-uplink-health-ack'[\s\S]*publisherCommandLiveness\.noteAck\(ackGeneration, performance\.now\(\)\)[\s\S]*refreshPublisherCommandChannel\(\)/,`;
const after = String.raw`    /message\.type === 'audio-uplink-health-ack'[\s\S]*publisherHealthCorrelation\.consume\([\s\S]*requestSentAtMs[\s\S]*publisherCommandLiveness\.noteAck\(ackGeneration, ackAtMs, requestSentAtMs\)[\s\S]*refreshPublisherCommandChannel\(\)/,`;

if (source.includes(after)) {
  console.log('authority source contract already patched');
  process.exit(0);
}
const first = source.indexOf(before);
const last = source.lastIndexOf(before);
if (first < 0 || first !== last) {
  throw new Error('expected exactly one legacy publisher ACK authority assertion');
}
source = source.slice(0, first) + after + source.slice(first + before.length);
await writeFile(path, source);
console.log('authority source contract patched');
