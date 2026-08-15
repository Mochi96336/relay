const params = new URLSearchParams(location.search);

if (params.get('robot') === '1') {
  const armButton = document.querySelector('#arm-source');
  const captureState = document.querySelector('#capture-state');

  const rewriteCaptureHint = () => {
    if (!captureState) return;
    if (captureState.textContent?.includes('click the Relay extension icon')) {
      captureState.textContent = 'Capture not connected · waiting for the robot backing bridge.';
    }
  };

  if (captureState) {
    new MutationObserver(rewriteCaptureHint).observe(captureState, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    rewriteCaptureHint();
  }

  // source.js owns the real arm behavior. Robot mode only supplies the local
  // deployment decision that no operator will be standing at this browser.
  // Chromium is launched with --autoplay-policy=no-user-gesture-required, so
  // this programmatic click does not pretend to be a browser user activation.
  const timer = setInterval(() => {
    if (!armButton || armButton.disabled) return;
    armButton.click();
    clearInterval(timer);
  }, 100);

  window.addEventListener('beforeunload', () => clearInterval(timer), { once: true });
}
