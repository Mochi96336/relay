/** A song position as m:ss; --:-- for anything that is not one (Number(null) is 0, not a position). */
export function formatTime(seconds) {
  const value = seconds === null || seconds === undefined || seconds === '' ? NaN : Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '--:--';
  const whole = Math.floor(value);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** A Take's duration as m:ss, from milliseconds. */
export function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round(Number(durationMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
