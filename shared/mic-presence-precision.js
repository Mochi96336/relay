/**
 * Room Mic presence is display telemetry: a level, five band heights, a pitch
 * and its confidence, redrawn about twelve times a second on every page. The
 * phone measured them as full float64, and those digits were about a third of
 * each packet, both on the singer's uplink and in the broadcast to every
 * listener. These are finer than any step the presence display can show.
 */
function round(value, decimals) {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

export function micPresenceDisplayValues({ rmsDbfs, spectrumBands, f0Hz, pitchConfidence }) {
  return {
    rmsDbfs: round(rmsDbfs, 1),
    spectrumBands: spectrumBands.map((band) => round(band, 3)),
    f0Hz: f0Hz === null ? null : round(f0Hz, 1),
    pitchConfidence: round(pitchConfidence, 2),
  };
}
