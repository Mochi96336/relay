const TERMINAL_STATES = new Set([-1, 0]);

// Loading at the exact duration leaves YouTube in ENDED, while handoff proof
// represents a terminal room as PAUSED at the same position. Start a fraction
// before the end so the existing state-change handler can observe real media,
// pause it, and prove the replacement clock without rewinding perceptibly.
export const TERMINAL_HANDOFF_LEAD_SECONDS = 0.25;

export function handoffPreparationPosition(targetTime, desiredState) {
  const position = Number(targetTime);
  if (!Number.isFinite(position)) return 0;
  const safePosition = Math.max(0, position);
  return TERMINAL_STATES.has(Number(desiredState))
    ? Math.max(0, safePosition - TERMINAL_HANDOFF_LEAD_SECONDS)
    : safePosition;
}
