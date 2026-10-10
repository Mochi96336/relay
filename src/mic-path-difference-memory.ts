/**
 * The Boot Probe path difference each Mic device last measured, so the timing
 * used before (or without) a measurement starts from that device's own path.
 *
 * The path difference is how much later the Mic's audio reaches Relay than the
 * Robot's (BootCalibrationResult). It is mostly the phone's own audio path, so
 * it follows the device: from 2026-09-29 to 2026-10-10 an iPhone's built-in
 * microphone measured a median of +25 ms, a Windows laptop's built-in one
 * -32 ms, and a Bluetooth headset about +300 ms. A device is a participant
 * (per-browser identity, SESSION_MODEL.md) with one input: the same phone with
 * a headset is a different path.
 *
 * Each device keeps its last few measurements and answers with their median, so
 * one bad probe does not become the device's path. Of 107 probes in that
 * period, five measured -500, +605, +755, +1555 and +2045 ms; the rest stayed
 * within -95..+325 ms.
 *
 * Held in memory for the server's lifetime only, like MicGainMemory. A device
 * it does not know gets the room-wide default.
 */

export type MicPathDifferencePrior = {
  pathDifferenceMs: number;
  /** How many of this device's own measurements it is drawn from; 0 means the default. */
  measurements: number;
};

export type MicPathDifferenceMemoryOptions = {
  defaultMs: number;
  /** Measurements kept per device. */
  measurementsPerDevice?: number;
  /** Oldest devices are forgotten past this many. */
  maxDevices?: number;
};

function deviceKey(participantId: string, inputLabel: string | null) {
  return JSON.stringify([participantId, inputLabel ?? '']);
}

export class MicPathDifferenceMemory {
  readonly defaultMs: number;
  readonly measurementsPerDevice: number;
  readonly maxDevices: number;
  /** Insertion order is recency: `remember` moves a device to the end. */
  private readonly devices = new Map<string, number[]>();

  constructor(options: MicPathDifferenceMemoryOptions) {
    if (!Number.isFinite(options.defaultMs)) throw new RangeError('defaultMs must be finite');
    const measurementsPerDevice = options.measurementsPerDevice ?? 5;
    const maxDevices = options.maxDevices ?? 256;
    if (!Number.isInteger(measurementsPerDevice) || measurementsPerDevice < 1) {
      throw new RangeError('measurementsPerDevice must be a positive integer');
    }
    if (!Number.isInteger(maxDevices) || maxDevices < 1) {
      throw new RangeError('maxDevices must be a positive integer');
    }
    this.defaultMs = options.defaultMs;
    this.measurementsPerDevice = measurementsPerDevice;
    this.maxDevices = maxDevices;
  }

  priorFor(participantId: string | null, inputLabel: string | null): MicPathDifferencePrior {
    const measured = participantId === null ? undefined : this.devices.get(deviceKey(participantId, inputLabel));
    if (!measured) return { pathDifferenceMs: this.defaultMs, measurements: 0 };
    const sorted = [...measured].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
    return { pathDifferenceMs: median, measurements: sorted.length };
  }

  remember(participantId: string, inputLabel: string | null, pathDifferenceMs: number) {
    if (!Number.isFinite(pathDifferenceMs)) return;
    const key = deviceKey(participantId, inputLabel);
    const measured = this.devices.get(key) ?? [];
    this.devices.delete(key);
    measured.push(pathDifferenceMs);
    while (measured.length > this.measurementsPerDevice) measured.shift();
    this.devices.set(key, measured);
    while (this.devices.size > this.maxDevices) {
      this.devices.delete(this.devices.keys().next().value!);
    }
  }
}
