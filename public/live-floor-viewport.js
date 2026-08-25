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
  let lastViewportHeight = viewportHeight(viewport);

  function applyOffset(offset) {
    if (!shell) return 0;
    const safeOffset = Number.isFinite(offset) ? Math.max(0, offset) : 0;
    const rounded = Math.round(safeOffset * 100) / 100;
    shell.style.setProperty(OFFSET_PROPERTY, rounded === 0 ? '0px' : `${rounded}px`);
    return rounded;
  }

  function reconcile() {
    if (!shell || !viewport || !documentRef) return applyOffset(0);
    const smallViewportHeight = measureSmall();
    const shellHeight = shell.getBoundingClientRect().height;
    const offset = resolveLiveFloorViewportOffset({
      mobile: isMobile(),
      smallViewportHeight,
      visualViewportHeight: Number(viewport.height),
      visualViewportScale: Number(viewport.scale ?? 1),
      shellHeight,
    });
    lastViewportHeight = viewportHeight(viewport);
    return applyOffset(offset);
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
    // If browser chrome or the keyboard is taking space back, favor visibility:
    // remove the old downward offset immediately, then wait for a settled value.
    if (nextHeight < lastViewportHeight - EPSILON_PX) applyOffset(0);
    lastViewportHeight = nextHeight;
    scheduleReconcile();
  }

  function handleWindowResize() {
    // Window resize may be orientation or browser chrome. Keep layout stable
    // through the motion and reconcile only after the resize burst settles.
    applyOffset(0);
    scheduleReconcile();
  }

  function handleViewportScrollEnd() {
    cancelScheduledReconcile();
    reconcile();
  }

  function start() {
    if (started) return;
    started = true;
    reconcile();
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
