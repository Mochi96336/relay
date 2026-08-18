export const MIC_PRESENCE_BAR_COUNT: number;
export const MIC_PRESENCE_MIN_DBFS: number;
export const MIC_PRESENCE_MAX_DBFS: number;

export function rmsDbfsToPresence(rmsDbfs: number): number;
export function nextPresenceHistory(history: number[], rmsDbfs: number, count?: number): number[];
export function presenceHeightPx(level: number): number;
