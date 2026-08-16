export type RobotPlayerRecoveryState = {
  hasTimeline: boolean;
  phonePlaying: boolean;
  playerError: boolean;
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
