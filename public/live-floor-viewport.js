const MOBILE_QUERY = '(max-width: 759px)';
const OFFSET_PROPERTY = '--live-floor-viewport-offset';
const DEFAULT_SETTLE_MS = 140;
const EPSILON_PX = 1;

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function resolveLiveFloorViewportOffset({
  mobile,
  smallViewportHeight,
  visualViewportHeight,
  visualViewportScale = 1,
  shellHeight,
}) {
  if (!mobile) return 0;
  if (!finiteNumber(smallViewportHeight) || smallViewportHeight <= 0) return 0;
  if (!finiteNumber(visualViewportHeight) || visualViewportHeight <= 0) return 0;
  if (!finiteNumber(shellHeight) || shellHeight <= 0) return 0;
  if (!finiteNumber(visualViewportScale) || Math.abs(visualViewportScale - 1) > 0.01) return 0;

  // Once Live needs real document scrolling, the controls stay in normal flow.
  // Moving an already-overflowing floor would expand scrollable overflow and can
  // feed Safari browser-chrome/scrollability changes back into each other.
  if (shellHeight > smallViewportHeight + EPSILON_PX) return 0;

  // Browser chrome retraction makes the unzoomed visual viewport taller than
  // the stable small viewport. Keyboard presentation does the opposite. Ignore
  // visual viewport panning entirely: offsetTop may change to keep a focused
  // field visible and must never become bottom-floor authority.
  if (visualViewportHeight < smallViewportHeight - EPSILON_PX) return 0;
  return Math.max(0, visualViewportHeight - smallViewportHeight);
}

function measureSmallViewportHeight(documentRef) {
  const probe = documentRef.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = [
    'position: fixed',
    'inset: 0 auto auto 0',
    'width: 0',
    'height: 100svh',
    'visibility: hidden',
    'pointer-events: none',
    'contain: strict',
  ].join(';');
  documentRef.documentElement.append(probe);
  const height = probe.getBoundingClientRect().height;
  probe.remove();
  return height;
}

function viewportHeight(viewport) {
  if (!viewport) return 0;
  const height = Number(viewport.height);
  return Number.isFinite(height) ? height : 0;
}

export function createLiveFloorViewportController(options = {}) {
  const windowRef = options.windowRef ?? globalThis.window;
  const documentRef = options.documentRef ?? globalThis.document;
  const shell = options.shell ?? documentRef?.querySelector?.('.live-shell') ?? null;
  const viewport = options.viewport ?? windowRef?.visualViewport ?? null;
  const settleMs = Number.isFinite(options.settleMs) ? options.settleMs : DEFAULT_SETTLE_MS;
  const isMobile = options.isMobile ?? (() => windowRef?.matchMedia?.(MOBILE_QUERY).matches === true);
  const measureSmall = options.measureSmallViewportHeight
    ?? (() => measureSmallViewportHeight(documentRef));
  const setTimer = options.setTimeout ?? windowRef?.setTimeout?.bind(windowRef) ?? globalThis.setTimeout;
  const clearTimer = options.clearTimeout ?? windowRef?.clearTimeout?.bind(windowRef) ?? globalThis.clearTimeout;
  const ResizeObserverCtor = options.ResizeObserver ?? windowRef?.ResizeObserver ?? null;
  const observeShell = options.observeShell !== false;

  let started = false;
  let timer = null;
  let shellObserver = null;
  let smallViewportHeight = 0;
  let lastViewportHeight = viewportHeight(viewport);
  let sawSmallViewport = false;
  let positiveMotionAuthorized = false;

  function applyOffset(offset) {
    if (!shell) return 0;
    const safeOffset = Number.isFinite(offset) ? Math.max(0, offset) : 0;
    const rounded = Math.round(safeOffset * 100) / 100;
    shell.style.setProperty(OFFSET_PROPERTY, rounded === 0 ? '0px' : `${rounded}px`);
    return rounded;
  }

  function sampleSmallViewportHeight() {
    if (!documentRef) return 0;
    const measured = Number(measureSmall());
    return Number.isFinite(measured) && measured > 0 ? measured : 0;
  }

  function reconcile() {
    if (!shell || !viewport || !documentRef) return applyOffset(0);
    const measuredSmallViewportHeight = sampleSmallViewportHeight();
    if (measuredSmallViewportHeight > 0) smallViewportHeight = measuredSmallViewportHeight;
    const shellHeight = shell.getBoundingClientRect().height;
    const resolvedOffset = resolveLiveFloorViewportOffset({
      mobile: isMobile(),
      smallViewportHeight,
      visualViewportHeight: Number(viewport.height),
      visualViewportScale: Number(viewport.scale ?? 1),
      shellHeight,
    });
    lastViewportHeight = viewportHeight(viewport);
    return applyOffset(positiveMotionAuthorized ? resolvedOffset : 0);
  }

  function cancelScheduledReconcile() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function scheduleReconcile() {
    cancelScheduledReconcile();
    timer = setTimer(() => {
      timer = null;
      reconcile();
    }, settleMs);
  }

  function handleViewportMotion() {
    const nextHeight = viewportHeight(viewport);
    const previousHeight = lastViewportHeight;

    // A shrinking viewport always wins immediately. It may be browser chrome or
    // the keyboard taking space back; neither may leave a stale downward offset.
    if (nextHeight < previousHeight - EPSILON_PX) {
      applyOffset(0);
      positiveMotionAuthorized = false;
      sawSmallViewport = smallViewportHeight > 0
        && nextHeight <= smallViewportHeight + EPSILON_PX;
    } else {
      if (smallViewportHeight > 0 && nextHeight <= smallViewportHeight + EPSILON_PX) {
        sawSmallViewport = true;
      }
      // Do not trust a large VisualViewport value observed during initial page
      // bootstrap. Downward motion is authorized only after this controller has
      // seen the safe small viewport and then observed real viewport growth.
      if (nextHeight > previousHeight + EPSILON_PX && sawSmallViewport) {
        positiveMotionAuthorized = true;
      }
    }

    lastViewportHeight = nextHeight;
    scheduleReconcile();
  }

  function handleWindowResize() {
    // Orientation/window resize starts a new viewport epoch. Favor the stable
    // small viewport until fresh post-resize growth evidence arrives.
    applyOffset(0);
    positiveMotionAuthorized = false;
    sawSmallViewport = false;
    smallViewportHeight = 0;
    lastViewportHeight = viewportHeight(viewport);
    scheduleReconcile();
  }

  function handleViewportScrollEnd() {
    cancelScheduledReconcile();
    reconcile();
  }

  function start() {
    if (started) return;
    started = true;

    // Startup is intentionally conservative. Safari may briefly expose a visual
    // viewport that extends behind browser chrome before its URL bar settles.
    // Keep the floor on 100svh until post-start growth proves chrome retraction.
    applyOffset(0);
    smallViewportHeight = sampleSmallViewportHeight();
    lastViewportHeight = viewportHeight(viewport);
    sawSmallViewport = smallViewportHeight > 0
      && lastViewportHeight <= smallViewportHeight + EPSILON_PX;
    positiveMotionAuthorized = false;

    viewport?.addEventListener?.('resize', handleViewportMotion, { passive: true });
    viewport?.addEventListener?.('scroll', handleViewportMotion, { passive: true });
    viewport?.addEventListener?.('scrollend', handleViewportScrollEnd, { passive: true });
    windowRef?.addEventListener?.('resize', handleWindowResize, { passive: true });
    windowRef?.addEventListener?.('orientationchange', handleWindowResize, { passive: true });

    if (observeShell && shell && ResizeObserverCtor) {
      shellObserver = new ResizeObserverCtor(() => {
        cancelScheduledReconcile();
        reconcile();
      });
      shellObserver.observe(shell);
    }
  }

  function dispose() {
    if (!started) return;
    started = false;
    cancelScheduledReconcile();
    viewport?.removeEventListener?.('resize', handleViewportMotion);
    viewport?.removeEventListener?.('scroll', handleViewportMotion);
    viewport?.removeEventListener?.('scrollend', handleViewportScrollEnd);
    windowRef?.removeEventListener?.('resize', handleWindowResize);
    windowRef?.removeEventListener?.('orientationchange', handleWindowResize);
    shellObserver?.disconnect?.();
    shellObserver = null;
    applyOffset(0);
  }

  return {
    start,
    reconcile,
    dispose,
  };
}

export function installLiveFloorViewport(options = {}) {
  const controller = createLiveFloorViewportController(options);
  controller.start();
  return controller;
}
