export const DEFAULT_PCM_STALL_MS = 1_500;
export const DEFAULT_HIDDEN_DISCONTINUITY_MS = 250;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeSnapshot(snapshot = {}) {
  return {
    nowMs: finite(snapshot.nowMs),
    visible: snapshot.visible !== false,
    contextState: String(snapshot.contextState ?? 'closed'),
    contextTime: finite(snapshot.contextTime),
    sampleCursor: Math.max(0, finite(snapshot.sampleCursor)),
  };
}

export class MicCaptureRecoveryWatchdog {
  constructor({
    stallAfterMs = DEFAULT_PCM_STALL_MS,
    hiddenDiscontinuityMs = DEFAULT_HIDDEN_DISCONTINUITY_MS,
  } = {}) {
    this.stallAfterMs = Math.max(1, finite(stallAfterMs, DEFAULT_PCM_STALL_MS));
    this.hiddenDiscontinuityMs = Math.max(
      0,
      finite(hiddenDiscontinuityMs, DEFAULT_HIDDEN_DISCONTINUITY_MS),
    );
    this.reset();
  }

  reset() {
    this.active = false;
    this.recovering = false;
    this.recoveryReason = null;
    this.recoveryContextTime = 0;
    this.recoverySampleCursor = 0;
    this.lastContextTime = 0;
    this.lastSampleCursor = 0;
    this.lastSampleProgressAtMs = 0;
    this.hiddenSnapshot = null;
    this.rebuildRequested = false;
    this.rebuildBudgetSpent = false;
    this.inputGapActive = false;
  }

  start(snapshot, reason = 'startup') {
    const current = normalizeSnapshot(snapshot);
    this.active = true;
    this.lastContextTime = current.contextTime;
    this.lastSampleCursor = current.sampleCursor;
    this.lastSampleProgressAtMs = current.nowMs;
    this.hiddenSnapshot = null;
    this.rebuildRequested = false;
    this.rebuildBudgetSpent = false;
    this.beginRecovery(current, reason);
  }

  stop() {
    this.reset();
  }

  beginRecovery(snapshot, reason = 'recovery') {
    if (!this.active) return;
    const current = normalizeSnapshot(snapshot);
    this.recovering = true;
    this.recoveryReason = reason;
    this.recoveryContextTime = current.contextTime;
    this.recoverySampleCursor = current.sampleCursor;
    this.lastContextTime = current.contextTime;
    this.lastSampleCursor = current.sampleCursor;
    this.lastSampleProgressAtMs = current.nowMs;
  }

  claimRebuild() {
    if (this.rebuildRequested || this.rebuildBudgetSpent) return false;
    this.rebuildRequested = true;
    this.rebuildBudgetSpent = true;
    return true;
  }

  noteHidden(snapshot) {
    if (!this.active) return;
    const current = normalizeSnapshot(snapshot);
    this.hiddenSnapshot = current;
    this.beginRecovery(current, 'background');
  }

  noteForeground(snapshot) {
    if (!this.active) return { discontinuity: false, rebuild: false };
    const current = normalizeSnapshot(snapshot);
    const hidden = this.hiddenSnapshot;
    this.hiddenSnapshot = null;

    // A sustained worklet input gap is already positive capture-failure
    // evidence. Hidden pages defer rebuilding, but foregrounding must consume
    // that existing authority immediately rather than wait for another 400
    // render-quanta report.
    let discontinuity = this.inputGapActive;
    if (hidden) {
      const hiddenForMs = Math.max(0, current.nowMs - hidden.nowMs);
      // Hidden capture can advance briefly and then stall for seconds. Comparing
      // only the hide/foreground cursors would treat that as continuous and
      // splice later PCM onto the old sample generation. `observe()` records
      // every real sample advance (including while hidden), so freshness of the
      // last progress is the continuity evidence we actually need here.
      const stalledForMs = Math.max(0, current.nowMs - this.lastSampleProgressAtMs);
      discontinuity = discontinuity || (
        hiddenForMs >= this.hiddenDiscontinuityMs
        && stalledForMs >= this.hiddenDiscontinuityMs
      );
    }

    this.beginRecovery(current, 'foreground');
    return {
      discontinuity,
      rebuild: discontinuity && this.claimRebuild(),
    };
  }

  noteGraphRebuilt(snapshot) {
    if (!this.active) return;
    // The physical graph replacement completed, so the in-flight request is
    // clear. Its action budget stays spent until fresh real PCM from this
    // replacement graph proves recovery; otherwise old-graph PCM racing the
    // replacement could accidentally rearm another generation advance.
    this.rebuildRequested = false;
    this.rebuildBudgetSpent = true;
    // input-gap evidence is graph-scoped. A replacement worklet starts a new
    // observation generation and must earn recovery from its own fresh PCM.
    this.inputGapActive = false;
    this.beginRecovery(snapshot, 'graph-rebuild');
  }

  noteGraphRebuildFailed() {
    // The destructive replacement attempt already spent this fault epoch's
    // action budget. Clear only the in-flight fence: returning the budget here
    // would allow a persistent graph-construction failure to churn generations.
    this.rebuildRequested = false;
  }

  noteInputGap(snapshot, { recovered = false } = {}) {
    if (!this.active) return { rebuild: false, recovered: false, reason: null };
    const current = normalizeSnapshot(snapshot);

    if (recovered) {
      const wasActive = this.inputGapActive;
      this.inputGapActive = false;
      return { rebuild: false, recovered: wasActive, reason: null };
    }

    if (!this.inputGapActive) {
      this.inputGapActive = true;
      this.beginRecovery(current, 'input-gap');
    }

    const rebuild = current.visible
      && current.contextState === 'running'
      && this.claimRebuild();

    return {
      rebuild,
      recovered: false,
      reason: rebuild ? 'input-gap' : null,
    };
  }

  status() {
    return {
      active: this.active,
      recovering: this.recovering,
      recoveryReason: this.recoveryReason,
      rebuildRequested: this.rebuildRequested,
      rebuildBudgetSpent: this.rebuildBudgetSpent,
      inputGapActive: this.inputGapActive,
    };
  }

  observe(snapshot, { freshPcm = false } = {}) {
    const current = normalizeSnapshot(snapshot);
    if (!this.active) {
      return { resume: false, rebuild: false, recovered: false };
    }

    const contextAdvanced = current.contextTime > this.lastContextTime;
    const sampleAdvanced = current.sampleCursor > this.lastSampleCursor;
    // Once the worklet has positively reported a sustained source gap, its
    // silence padding is timeline continuity, not microphone liveness.
    const sourceProgress = !this.inputGapActive && (sampleAdvanced || freshPcm);
    if (sourceProgress) this.lastSampleProgressAtMs = current.nowMs;

    let recovered = false;
    if (
      this.recovering
      && !this.inputGapActive
      // A rebuild decision schedules graph replacement asynchronously. PCM
      // from the graph being retired is not evidence about its replacement.
      && !this.rebuildRequested
      && freshPcm
      && current.contextTime > this.recoveryContextTime
      && current.sampleCursor > this.recoverySampleCursor
    ) {
      this.recovering = false;
      this.recoveryReason = null;
      this.rebuildRequested = false;
      this.rebuildBudgetSpent = false;
      recovered = true;
    }

    const resume = current.visible
      && (current.contextState === 'suspended' || current.contextState === 'interrupted');

    const stalledForMs = Math.max(0, current.nowMs - this.lastSampleProgressAtMs);
    // Suspended/interrupted is a resume problem, not proof that rebuilding the
    // worklet will help. Rebuild automatically only after the browser reports
    // a running context while the PCM/sample cursor still fails to move.
    const rebuild = current.visible
      && current.contextState === 'running'
      && !sampleAdvanced
      && stalledForMs >= this.stallAfterMs
      && this.claimRebuild();
    this.lastContextTime = current.contextTime;
    this.lastSampleCursor = current.sampleCursor;

    return {
      resume,
      rebuild,
      recovered,
      contextAdvanced,
      sampleAdvanced,
      stalledForMs,
    };
  }
}
