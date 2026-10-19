import { generateProbeReference } from '../../src/calibration-probe.js';

const SAMPLE_RATE = 48_000;

/** The boot probe's notes as 48 kHz PCM, with silence before and after. */
export function probeAudio(leadMs = 20, tailMs = 1_800) {
  const reference = generateProbeReference(SAMPLE_RATE);
  const probe = Buffer.alloc(reference.length * 2);
  for (let i = 0; i < reference.length; i += 1) {
    probe.writeInt16LE(reference[i], i * 2);
  }
  return Buffer.concat([
    Buffer.alloc(Math.round((SAMPLE_RATE * leadMs) / 1000) * 2),
    probe,
    Buffer.alloc(Math.round((SAMPLE_RATE * tailMs) / 1000) * 2),
  ]);
}
