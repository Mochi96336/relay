import { expect, test } from '@playwright/test';

const LIVE_URL = process.env.RELAY_INTERACTION_URL ?? 'http://127.0.0.1:4173/';

test.use({ viewport: { width: 390, height: 844 } });

async function installBrowserAudioHarness(page) {
  await page.addInitScript(() => {
    const sockets = [];
    const harness = {
      sockets,
      playbackNode: null,
      contexts: [],
      gains: [],
      emitMonitorBinary(byteLength = 64) {
        const socket = [...sockets].reverse().find(
          (candidate) => candidate.role === 'monitor' && candidate.readyState === FakeWebSocket.OPEN,
        );
        if (!socket) throw new Error('monitor socket is not ready');
        socket.dispatchEvent(new MessageEvent('message', { data: new ArrayBuffer(byteLength) }));
      },
      emitHealth(overrides = {}) {
        if (!this.playbackNode?.port?.onmessage) throw new Error('playback worklet is not ready');
        this.playbackNode.port.onmessage({
          data: {
            type: 'health',
            queuedMs: 160,
            targetPrebufferMs: 100,
            jitterTargetMs: 80,
            arrivalJitterMs: 2,
            arrivalDeviationMs: 3,
            underruns: 0,
            droppedMs: 0,
            starvedMs: 0,
            playing: true,
            ...overrides,
          },
        });
      },
    };
    window.__listenerDebugBrowserHarness = harness;

    class FakeAudioNode {
      connect(target) { return target; }
      disconnect() {}
    }

    class FakeAudioParam {
      constructor(value = 1) { this.value = value; }
      setTargetAtTime(value) { this.value = value; }
      cancelScheduledValues() {}
      setValueAtTime(value) { this.value = value; }
    }

    class FakeGainNode extends FakeAudioNode {
      constructor() {
        super();
        this.gain = new FakeAudioParam(1);
        harness.gains.push(this);
      }
    }

    class FakeAudioSession extends EventTarget {
      constructor() {
        super();
        this.type = 'playback';
        this.state = 'active';
      }
    }

    Object.defineProperty(navigator, 'audioSession', {
      configurable: true,
      value: new FakeAudioSession(),
    });

    class FakeAudioContext extends EventTarget {
      constructor() {
        super();
        this.sampleRate = 48_000;
        this.state = 'suspended';
        this.currentTime = 0;
        this.destination = new FakeAudioNode();
        this.audioWorklet = { addModule: async () => {} };
        harness.contexts.push(this);
      }

      async resume() {
        if (this.state === 'closed') throw new Error('closed');
        if (this.state !== 'running') {
          this.state = 'running';
          this.currentTime += 0.01;
          this.dispatchEvent(new Event('statechange'));
        }
      }

      async suspend() {
        if (this.state === 'closed') throw new Error('closed');
        if (this.state !== 'suspended') {
          this.state = 'suspended';
          this.dispatchEvent(new Event('statechange'));
        }
      }

      async close() {
        this.state = 'closed';
        this.dispatchEvent(new Event('statechange'));
      }

      getOutputTimestamp() {
        return {
          contextTime: this.currentTime,
          performanceTime: performance.now(),
        };
      }

      createGain() { return new FakeGainNode(); }
    }

    class FakeAudioWorkletNode extends FakeAudioNode {
      constructor(_context, name) {
        super();
        this.name = name;
        this.port = {
          onmessage: null,
          postMessage() {},
        };
        if (name === 'playback-processor') harness.playbackNode = this;
      }
    }

    class FakeWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor(url) {
        super();
        this.url = String(url);
        this.readyState = FakeWebSocket.CONNECTING;
        this.binaryType = 'blob';
        this.bufferedAmount = 0;
        this.role = 'unknown';
        sockets.push(this);
        queueMicrotask(() => {
          if (this.readyState !== FakeWebSocket.CONNECTING) return;
          this.readyState = FakeWebSocket.OPEN;
          this.dispatchEvent(new Event('open'));
        });
      }

      send(data) {
        if (typeof data !== 'string') return;
        try {
          const message = JSON.parse(data);
          if (message.type === 'register') this.role = message.role ?? 'unknown';
        } catch {}
      }

      close(code = 1000, reason = '') {
        if (this.readyState === FakeWebSocket.CLOSED) return;
        this.readyState = FakeWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent('close', { code, reason }));
      }
    }

    window.AudioContext = FakeAudioContext;
    window.webkitAudioContext = FakeAudioContext;
    window.AudioWorkletNode = FakeAudioWorkletNode;
    window.WebSocket = FakeWebSocket;
  });
}

async function startListener(page, query = 'audioDebug=1') {
  await page.goto(`${LIVE_URL}__listener-debug.html?${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__relayListenerDiagnostics));
  await page.dispatchEvent('body', 'pointerdown');
  await page.waitForFunction(() => {
    const snapshot = window.__relayListenerDiagnostics?.snapshot?.();
    return snapshot?.contextState === 'running' && snapshot?.monitorConnectionCount >= 1;
  });
  await page.evaluate(() => {
    window.__listenerDebugBrowserHarness.emitMonitorBinary();
    window.__listenerDebugBrowserHarness.emitHealth();
  });
}

test('listener debug flight recorder sees a healthy internal playback path', async ({ page }) => {
  await installBrowserAudioHarness(page);
  await startListener(page);

  const snapshot = await page.evaluate(() => window.__relayListenerDiagnostics.snapshot());
  expect(snapshot.contextState).toBe('running');
  expect(snapshot.monitorSocketState).toBe('open');
  expect(snapshot.monitorFrameCount).toBeGreaterThanOrEqual(1);
  expect(snapshot.workletHealth.playing).toBe(true);
  expect(snapshot.audioSession).toEqual({ supported: true, type: 'playback', state: 'active' });
  expect(snapshot.outputTimestamp.contextTime).toBe(snapshot.contextTime);
  expect(snapshot.evidence).toBe('internally-healthy');
});

test('listener debug records clock progress, AudioSession changes and Mic boundaries', async ({ page }) => {
  await installBrowserAudioHarness(page);
  await startListener(page);

  const progressed = await page.evaluate(() => {
    const context = window.__listenerDebugBrowserHarness.contexts.at(-1);
    window.__relayListenerDiagnostics.snapshot();
    context.currentTime += 0.25;
    return window.__relayListenerDiagnostics.snapshot();
  });
  expect(progressed.contextTimeDeltaMs).toBeCloseTo(250, 5);
  expect(progressed.outputContextTimeDeltaMs).toBeCloseTo(250, 5);
  expect(progressed.outputPerformanceTimeDeltaMs).toBeGreaterThanOrEqual(0);

  await page.evaluate(() => {
    navigator.audioSession.state = 'interrupted';
    navigator.audioSession.dispatchEvent(new Event('statechange'));
    window.dispatchEvent(new CustomEvent('relay-microphone-started'));
    navigator.audioSession.type = 'playback';
    navigator.audioSession.state = 'active';
    window.dispatchEvent(new CustomEvent('relay-microphone-ended', {
      detail: { reason: 'released' },
    }));
  });

  const dump = await page.evaluate(() => window.__relayListenerDiagnostics.dump());
  const sessionChange = dump.events.find((entry) => entry.type === 'audio-session-statechange');
  expect(sessionChange.detail.state).toBe('interrupted');
  const micStarted = dump.events.find((entry) => entry.type === 'mic-started');
  expect(micStarted.detail.audioSession.state).toBe('interrupted');
  const micEnded = dump.events.find((entry) => entry.type === 'mic-ended');
  expect(micEnded.detail.reason).toBe('released');
  expect(micEnded.detail.audioSession).toEqual({ supported: true, type: 'playback', state: 'active' });
});

test('listener debug faults exercise starvation, reconnect, interruption and silent output', async ({ page }) => {
  await installBrowserAudioHarness(page);
  await startListener(page);

  await page.evaluate(() => {
    window.__relayListenerDiagnostics.faults.dropPcm(500);
    window.__listenerDebugBrowserHarness.emitMonitorBinary(96);
  });
  let eventTypes = await page.evaluate(
    () => window.__relayListenerDiagnostics.dump().events.map((entry) => entry.type),
  );
  expect(eventTypes).toContain('fault-pcm-dropped');

  const beforeConnections = await page.evaluate(
    () => window.__relayListenerDiagnostics.snapshot().monitorConnectionCount,
  );
  await page.evaluate(() => window.__relayListenerDiagnostics.faults.disconnectMonitor());
  await page.waitForFunction((before) => (
    window.__relayListenerDiagnostics.snapshot().monitorConnectionCount > before
  ), beforeConnections, { timeout: 2_500 });

  await page.evaluate(() => window.__relayListenerDiagnostics.faults.interruptAudio(80));
  await page.waitForFunction(() => window.__relayListenerDiagnostics.snapshot().contextState === 'suspended');
  await page.waitForFunction(() => window.__relayListenerDiagnostics.snapshot().contextState === 'running', null, {
    timeout: 1_000,
  });

  await page.evaluate(() => window.__relayListenerDiagnostics.faults.silenceOutput(80));
  expect(await page.evaluate(() => window.__listenerDebugBrowserHarness.gains.at(-1)?.gain.value)).toBe(0);
  await page.waitForTimeout(120);
  expect(await page.evaluate(() => window.__listenerDebugBrowserHarness.gains.at(-1)?.gain.value)).toBeGreaterThan(0);

  eventTypes = await page.evaluate(
    () => window.__relayListenerDiagnostics.dump().events.map((entry) => entry.type),
  );
  expect(eventTypes).toContain('fault-monitor-disconnect');
  expect(eventTypes).toContain('fault-audio-interrupt-start');
  expect(eventTypes).toContain('fault-audio-interrupt-release');
  expect(eventTypes).toContain('fault-output-silence-start');
  expect(eventTypes).toContain('fault-output-silence-release');
});

test('listener silence report uploads the local flight recorder without leaking the Relay key', async ({ page }) => {
  let uploaded = null;
  let requestUrl = null;
  await page.route('**/api/debug/listener-incidents**', async (route) => {
    requestUrl = route.request().url();
    uploaded = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, incidentId: 'incident-test' }),
    });
  });

  await installBrowserAudioHarness(page);
  await startListener(page, 'audioDebug=1&key=secret-test-key');

  const reportButton = page.locator('[data-relay-listener-incident="1"]');
  await expect(reportButton).toBeVisible();
  await reportButton.click();
  await expect(reportButton).toHaveText('已回報');

  expect(requestUrl).not.toBeNull();
  const endpoint = new URL(requestUrl);
  expect(endpoint.pathname).toBe('/api/debug/listener-incidents');
  expect(endpoint.searchParams.get('audioDebug')).toBe('1');
  expect(endpoint.searchParams.get('key')).toBe('secret-test-key');

  expect(uploaded.reason).toBe('user-reported-silent');
  expect(uploaded.page.pathname).toBe('/__listener-debug.html');
  expect(uploaded.flight.snapshots.length).toBeGreaterThan(0);
  expect(uploaded.flight.snapshots.at(-1).audioSession.type).toBe('playback');
  expect(uploaded.flight.snapshots.at(-1).outputTimestamp).not.toBeNull();
  expect(uploaded.flight.events.map((entry) => entry.type)).toContain('user-reported-silent');
  expect(JSON.stringify(uploaded)).not.toContain('secret-test-key');

  const eventTypes = await page.evaluate(
    () => window.__relayListenerDiagnostics.dump().events.map((entry) => entry.type),
  );
  expect(eventTypes).toContain('listener-incident-uploaded');
});
