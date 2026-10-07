/**
 * Capture restart seams in mix-rate session-timeline coordinates.
 *
 * Mic reads retain seams because the read head can revisit them in either
 * direction. A forward-only Backing read consumes seams after passing them.
 * The caller owns that choice, source edges and limiter reset timing.
 */
export class CaptureRestartBoundaries {
  private readonly samples: number[] = [];

  get size() {
    return this.samples.length;
  }

  queue(sample: number) {
    const last = this.samples.at(-1);
    if (last === sample) return;
    if (last === undefined || sample > last) {
      this.samples.push(sample);
      return;
    }

    // Preserve the existing last-only duplicate rule and ordered insertion.
    const index = this.samples.findIndex((candidate) => candidate > sample);
    if (index < 0) this.samples.push(sample);
    else this.samples.splice(index, 0, sample);
  }

  clear() {
    this.samples.length = 0;
  }

  rebase(shift: number) {
    for (let index = 0; index < this.samples.length; index += 1) {
      this.samples[index]! += shift;
    }
  }

  trimBefore(cutoff: number) {
    while (this.samples.length > 0 && this.samples[0]! < cutoff) {
      this.samples.shift();
    }
  }

  has(sample: number) {
    return this.samples.includes(sample);
  }

  /** The old crossfade leg only owns a forward interval: (from, to]. */
  firstForwardCrossing(from: number, to: number): number | null {
    return this.samples.find((sample) => from < sample && sample <= to) ?? null;
  }

  /** First seam on the actual read trajectory, retaining it for later visits. */
  firstCrossing(from: number, to: number): number | null {
    if (to > from) return this.firstForwardCrossing(from, to);
    if (to < from) {
      for (let index = this.samples.length - 1; index >= 0; index -= 1) {
        const sample = this.samples[index]!;
        if (to < sample && sample <= from) return sample;
      }
    }
    return null;
  }

  /** Retires all due seams for a forward-only source. */
  consumeThrough(sample: number) {
    let due = false;
    while (this.samples.length > 0 && sample >= this.samples[0]!) {
      this.samples.shift();
      due = true;
    }
    return due;
  }
}
