export type RobotPlayerRecoveryState = {
  hasTimeline: boolean;
  phonePlaying: boolean;
  playerError: boolean;
  /** The YouTube error code behind `playerError`, when the page shows one. */
  playerErrorCode?: number | null;
  playerLoaded: boolean;
  errorAgeMs: number;
  notReadyAgeMs: number;
  stalledForMs: number;
};

export type RobotPlayerRecoveryReason =
  | 'youtube-player-error'
  | 'youtube-player-not-ready'
  | 'youtube-player-stalled';

export function decideRobotPlayerRecovery(
  state: RobotPlayerRecoveryState,
): RobotPlayerRecoveryReason | null;

export function trimReloadHistory(history: number[], nowMs: number): number[];
export function reloadBudgetAvailable(history: number[], nowMs: number): boolean;
export function playerLoadedFromMirrorState(text: unknown): boolean;
export function playerErrorCodeFromState(text: unknown): number | null;
