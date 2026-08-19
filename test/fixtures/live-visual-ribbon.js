(() => {
  const samples = [
    { rmsDbfs: -38, spectrumBands: [0.15, .32, .72, .55, .18], f0Hz: 110, pitchConfidence: .92 },
    { rmsDbfs: -31, spectrumBands: [0.10, .38, .88, .62, .22], f0Hz: 123, pitchConfidence: .94 },
    { rmsDbfs: -24, spectrumBands: [0.14, .50, .94, .75, .28], f0Hz: 147, pitchConfidence: .96 },
    { rmsDbfs: -29, spectrumBands: [0.10, .44, .80, .72, .33], f0Hz: 165, pitchConfidence: .93 },
    { rmsDbfs: -18, spectrumBands: [0.18, .60, 1.00, .66, .24], f0Hz: 196, pitchConfidence: .97 },
    { rmsDbfs: -26, spectrumBands: [0.12, .48, .82, .58, .18], f0Hz: 220, pitchConfidence: .95 },
    { rmsDbfs: -16, spectrumBands: [0.20, .66, .96, .54, .15], f0Hz: 262, pitchConfidence: .97 },
    { rmsDbfs: -27, spectrumBands: [0.12, .54, .78, .46, .11], f0Hz: 330, pitchConfidence: .94 },
    { rmsDbfs: -20, spectrumBands: [0.16, .70, .90, .48, .12], f0Hz: 392, pitchConfidence: .96 },
    { rmsDbfs: -33, spectrumBands: [0.10, .42, .62, .36, .08], f0Hz: 440, pitchConfidence: .93 },
  ];

  function syncFixturePresentation() {
    if (document.body.dataset.playbackRole === 'holder') {
      document.querySelector('#song-observer')?.removeAttribute('hidden');
    }

    const publisher = document.querySelector('#start-publisher');
    if (publisher) publisher.textContent = '拿 Mic';
  }

  syncFixturePresentation();

  import('/mic-presence.js').then(() => {
    const publishEvidence = () => {
      for (const sample of samples) {
        window.dispatchEvent(new CustomEvent('relay-room-mic-presence', {
          detail: {
            active: true,
            ownerId: 'visual-fixture',
            captureGeneration: 1,
            rmsDbfs: sample.rmsDbfs,
            spectrumBands: sample.spectrumBands,
            f0Hz: sample.f0Hz,
            pitchConfidence: sample.pitchConfidence,
          },
        }));
      }
    };

    // Remote production evidence deliberately expires after 320 ms. Keep the
    // deterministic fixture publishing the same truthful measured sequence
    // while Playwright waits, so screenshots exercise the real renderer rather
    // than an expired tail.
    publishEvidence();
    setInterval(publishEvidence, 120);
    syncFixturePresentation();
  });
})();
