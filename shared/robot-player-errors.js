// YouTube IFrame player errors that say the video itself cannot be played by
// this player, so no reload, retry or wait will change the outcome:
//   2   invalid video id
//   100 video unavailable (removed or private)
//   101 / 150 the owner does not allow embedded playback
// A region-restricted video reports 150 too. On 2026-10-04 the Robot host's
// Chromium got 150 for a video blocked in Taiwan that played in Europe.
const UNPLAYABLE_YOUTUBE_ERRORS = new Set([2, 100, 101, 150]);

export function youtubeErrorMeansUnplayable(code) {
  return UNPLAYABLE_YOUTUBE_ERRORS.has(Number(code));
}
