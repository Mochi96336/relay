/** Titles describe the reported cause, rather than expanding a broad issue code. */
/** @type {Record<string, string>} */
const codeTitles = {
  'audio-unavailable': 'system.attention.audio-unavailable',
  'robot-audio-unavailable': 'system.attention.robot-audio-unavailable',
  'robot-route-invalid': 'system.attention.robot-route-invalid',
  'robot-player-unavailable': 'system.attention.robot-player-unavailable',
  'song-clock-unavailable': 'system.attention.song-clock-unavailable',
  'mic-reconnecting': 'system.attention.mic-reconnecting',
  'mic-audio-stalled': 'system.attention.mic-audio-stalled',
  'mic-input-clipping': 'system.attention.mic-input-clipping',
  'mic-too-loud': 'system.attention.mic-too-loud',
  'mic-too-quiet': 'system.attention.mic-too-quiet',
  'timing-recovering': 'system.attention.timing-recovering',
  'timing-clamped': 'system.attention.timing-clamped',
  'take-failed': 'system.attention.take-failed',
};

/** @type {Record<string, string>} */
const causeTitles = {
  'backing-not-ready': 'system.attention.backing-preparing',
  'robot-source-unavailable': 'system.attention.robot-source-disconnected',
  'robot-video-unplayable': 'system.attention.robot-video-unplayable',
  'mic-uplink-delayed': 'system.attention.mic-delayed',
  'mic-timeline-behind': 'system.attention.mic-delayed',
  'mic-audio-intermittent': 'system.attention.mic-intermittent',
  'timing-calibrating': 'system.attention.timing-calibrating',
  'timing-fallback': 'system.attention.timing-estimate',
  'timing-stale': 'system.attention.timing-recovering',
  'timing-probe-unheard': 'system.attention.timing-estimate',
};

/** @param {{code?: unknown, cause?: unknown, recovery?: unknown} | null | undefined} issue */
export function productIssueTitleKey(issue) {
  if (issue?.code === 'timing-recovering' && issue.recovery === 'recalibrate-after-take'
      && ['timing-fallback', 'timing-probe-unheard'].includes(String(issue.cause))) {
    return 'system.attention.timing-estimated';
  }
  const cause = typeof issue?.cause === 'string' ? issue.cause : '';
  const code = typeof issue?.code === 'string' ? issue.code : '';
  return causeTitles[cause] ?? codeTitles[code] ?? 'system.attention';
}
