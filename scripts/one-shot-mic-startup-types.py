from pathlib import Path

Path('public/mic-startup.d.ts').write_text("""export const MIC_STARTUP_TIMEOUT_MS: number;

export class MicStartupCancelledError extends Error {
  readonly code: 'mic-startup-cancelled';
  constructor(message?: string);
}

export class MicStartupTimeoutError extends Error {
  readonly code: 'mic-startup-timeout';
  readonly stage: string;
  constructor(stage: string);
}

export type MicStartupAttempt = object;

export type MicStartupGateOptions = {
  timeoutMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

export class MicStartupGate {
  constructor(options?: MicStartupGateOptions);
  begin(): MicStartupAttempt;
  isCurrent(attempt: MicStartupAttempt | null | undefined): boolean;
  cancel(attempt?: MicStartupAttempt | null, reason?: Error): boolean;
  complete(attempt: MicStartupAttempt): boolean;
  wait<T>(
    attempt: MicStartupAttempt,
    operation: T | PromiseLike<T>,
    options?: {
      stage?: string;
      dispose?: (value: T) => void | Promise<void>;
    },
  ): Promise<T>;
}
""")
