(() => {
  const samples = [
    { rmsDbfs: -38, spectrumBands: [0.15, .32, .72, .55, .18] },
    { rmsDbfs: -31, spectrumBands: [0.10, .38, .88, .62, .22] },
    { rmsDbfs: -24, spectrumBands: [0.14, .50, .94, .75, .28] },
    { rmsDbfs: -29, spectrumBands: [0.10, .44, .80, .72, .33] },
    { rmsDbfs: -18, spectrumBands: [0.18, .60, 1.00, .66, .24] },
    { rmsDbfs: -26, spectrumBands: [0.12, .48, .82, .58, .18] },
    { rmsDbfs: -16, spectrumBands: [0.20, .66, .96, .54, .15] },
    { rmsDbfs: -27, spectrumBands: [0.12, .54, .78, .46, .11] },
    { rmsDbfs: -20, spectrumBands: [0.16, .70, .90, .48, .12] },
    { rmsDbfs: -33, spectrumBands: [0.10, .42, .62, .36, .08] },
  ];

  // The production holder reuses the compact room-song metadata above the
  // real YouTube control surface. The deterministic fixture mirrors that
  // product state before screenshots are captured.
  if (document.body.dataset.playbackRole === 'holder') {
    const observer = document.querySelector('#song-observer');
    if (observer) observer.hidden = false;
  }

  import('/mic-presence.js').then(() => {
    for (const sample of samples) {
      window.dispatchEvent(new CustomEvent('relay-room-mic-presence', {
        detail: {
          active: true,
          ownerId: 'visual-fixture',
          captureGeneration: 1,
          rmsDbfs: sample.rmsDbfs,
          spectrumBands: sample.spectrumBands,
        },
      }));
    }
  });
})();
