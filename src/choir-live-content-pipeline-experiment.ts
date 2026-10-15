import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import type { ChoirFreshCaptureTicket } from './choir-fresh-room-handshake-experiment.js';
import type { ChoirWorkerContentSnapshot } from './choir-deadline-room-experiment.js';
import type { ChoirRoomRestartCoordinatorExperiment } from './choir-room-restart-coordinator-experiment.js';

type Coordinator = Pick<ChoirRoomRestartCoordinatorExperiment,
  'prepareFreshWorkerContent' | 'acceptFreshWorkerContent'>;

type WorkerReply =
  | { id: number; ok: true; micLagMs: number; confidence: number }
  | { id: number; ok: false; reason: string };

type InFlight = {
  id: number;
  ticket: ChoirFreshCaptureTicket;
  proof: ChoirWorkerContentSnapshot;
  timeout: ReturnType<typeof setTimeout>;
};

/**
 * Only active when Choir's TWO experimental flags are enabled.
 * Never writes to N=1 MixBus, monitor, Take, or ordinary calibration.
 *
 * A SINGLE isolated worker prevents six-second Content FFT/correlation from
 * blocking Relay's 5ms mixer tick. One job at a time, no queue, strict time
 * and resource limits, plus a per-attempt cooldown. All worker results are
 * untrusted until coordinator rechecks the complete live authority witness.
 */
export class ChoirLiveContentPipelineExperiment {
  private worker: Worker | null = null;
  private inFlight: InFlight | null = null;
  private nextJobId = 1;
  private nextAttemptAtMs = 0;
  private failureStreak = 0;
  private closed = false;
  private readonly workTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly now: () => number;
  readonly stats = { submitted: 0, applied: 0, rejected: 0, timedOut: 0 };
  /** Bounded diagnostic of the last worker failure; never contains PCM. */
  lastFailureReason: string | null = null;

  constructor(
    private readonly coordinator: Coordinator,
    options: {
      now?: () => number;
      workTimeoutMs?: number;
      retryDelayMs?: number;
    } = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    this.workTimeoutMs = options.workTimeoutMs ?? 1_800;
    this.retryDelayMs = options.retryDelayMs ?? 2_500;
    if (!Number.isFinite(this.workTimeoutMs) || this.workTimeoutMs < 100
      || this.workTimeoutMs > 2_400
      || !Number.isFinite(this.retryDelayMs) || this.retryDelayMs < 250
      || this.retryDelayMs > 60_000)
      throw new RangeError('Invalid bounded Choir Content worker policy');
  }

  /** Called by the server's existing low-frequency authority tick. */
  tick(nowMs: number): boolean {
    if (this.closed || this.inFlight || !Number.isFinite(nowMs)
      || nowMs < this.nextAttemptAtMs) return false;
    this.nextAttemptAtMs = nowMs + 250;
    const job = this.coordinator.prepareFreshWorkerContent(nowMs);
    if (!job) return false;
    this.nextAttemptAtMs = nowMs + this.retryDelayMs;
    const worker = this.getWorker();
    if (!worker) return false;
    const id = this.nextJobId++;
    const timeout = setTimeout(() => this.expire(id), this.workTimeoutMs);
    timeout.unref?.();
    this.inFlight = { id, ticket: job.ticket, proof: job.proof, timeout };
    this.stats.submitted++;
    try {
      // Both PCM arrays are private, newly copied Content histories. Transfer
      // the buffers to avoid another two copies in the main audio thread.
      worker.postMessage({
        id, sampleRate: 48_000, mic: job.proof.mic, backing: job.proof.backing,
      }, [job.proof.mic.buffer as ArrayBuffer, job.proof.backing.buffer as ArrayBuffer]);
      return true;
    } catch (error) {
      this.lastFailureReason = `post-message: ${error instanceof Error ? error.message : String(error)}`;
      this.rejectActive(true);
      return false;
    }
  }

  /** Room retirement immediately frees the obsolete worker, even without PCM. */
  cancelRoom(roomEpoch: number) {
    if (this.inFlight?.ticket.roomEpoch !== roomEpoch) return;
    this.rejectActive(true, false);
    this.failureStreak = 0;
    this.nextAttemptAtMs = this.now() + 250;
  }

  private getWorker(): Worker | null {
    if (this.worker) return this.worker;
    try {
      const worker = new Worker(
        new URL('./choir-content-analysis-worker.mjs', import.meta.url),
        {
          // The worker explicitly registers its own TS loader before
          // importing the analyzer; no inherited test-runner flags are needed.
          execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 24 },
        },
      );
      worker.unref();
      worker.on('message', (reply: WorkerReply) => {
        if (this.worker !== worker) return;
        const active = this.inFlight;
        if (!active || !reply || reply.id !== active.id) return;
        clearTimeout(active.timeout);
        this.inFlight = null;
        let applied = false;
        let acceptanceFailed = false;
        try {
          applied = reply.ok && Number.isFinite(reply.micLagMs)
            && Number.isFinite(reply.confidence)
            && this.coordinator.acceptFreshWorkerContent(
              active.ticket, active.proof,
              { micLagMs: reply.micLagMs, confidence: reply.confidence },
              this.now(),
            );
        } catch (error) {
          // A callback failure cannot escape the worker event handler into
          // the Relay N=1 process. Fail closed and retry with backoff.
          this.lastFailureReason = `commit-exception: ${error instanceof Error ? error.message : String(error)}`;
          acceptanceFailed = true;
        }
        if (applied) {
          this.stats.applied++;
          this.lastFailureReason = null;
          this.failureStreak = 0;
          this.nextAttemptAtMs = this.now() + 250;
        } else {
          if (!acceptanceFailed)
            this.lastFailureReason = reply.ok
              ? 'stale-or-denied-commit'
              : `analyzer: ${reply.reason}`;
          this.stats.rejected++;
          this.delayAfterFailure();
        }
      });
      worker.on('error', (error) => {
        if (this.worker !== worker) return;
        this.lastFailureReason = `worker-error: ${error instanceof Error ? error.message : String(error)}`;
        this.rejectActive(true);
      });
      worker.on('exit', (code) => {
        if (this.worker !== worker) return;
        this.lastFailureReason = `worker-exit: ${code}`;
        this.rejectActive(true);
      });
      this.worker = worker;
      return worker;
    } catch (error) {
      this.lastFailureReason = `worker-create: ${error instanceof Error ? error.message : String(error)}`;
      this.stats.rejected++;
      return null;
    }
  }

  private expire(id: number) {
    if (this.inFlight?.id !== id) return;
    this.stats.timedOut++;
    this.lastFailureReason = 'worker-timeout';
    this.rejectActive(true);
  }

  private delayAfterFailure() {
    this.failureStreak = Math.min(5, this.failureStreak + 1);
    const delay = Math.min(30_000,
      this.retryDelayMs * (2 ** (this.failureStreak - 1)));
    this.nextAttemptAtMs = this.now() + delay;
  }

  private rejectActive(restartWorker: boolean, penalize = true) {
    const active = this.inFlight;
    if (active) {
      clearTimeout(active.timeout);
      this.inFlight = null;
      this.stats.rejected++;
      if (penalize) this.delayAfterFailure();
    }
    if (restartWorker && this.worker) {
      const previous = this.worker;
      this.worker = null;
      void previous.terminate().catch(() => {});
    }
  }

  close() {
    this.closed = true;
    this.rejectActive(true, false);
  }

  get isBusy() { return this.inFlight !== null; }
}
