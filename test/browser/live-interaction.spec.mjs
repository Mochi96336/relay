import { expect, test } from '@playwright/test';

const LIVE_URL = process.env.RELAY_INTERACTION_URL ?? 'http://127.0.0.1:4173/';

test.use({
  viewport: { width: 390, height: 844 },
  launchOptions: process.env.RELAY_CHROMIUM_PATH
    ? { executablePath: process.env.RELAY_CHROMIUM_PATH }
    : {},
});

async function installProductionDomHarness(page) {
  await page.addInitScript(() => {
    const timeline = {};
    const commands = [];
    const packets = [];
    const sockets = [];
    let captureNode = null;
    const captureNodes = [];
    let recorderReplayDelayMs = 0;
    let startResponseDelayMs = 20;
    let currentTake = {
      type: 'take-status',
      lifecycle: 'idle',
      take: null,
      history: [],
    };
    let revision = 1;
    let holdSocketOpens = false;
    const heldSockets = [];

    function mark(name) {
      if (timeline[name] === undefined) timeline[name] = performance.now();
      return timeline[name];
    }

    function participantId() {
      return typeof window.relayParticipantId === 'string'
        ? window.relayParticipantId
        : 'interaction-singer';
    }

    function participantNickname() {
      return typeof window.relayNickname === 'string'
        ? window.relayNickname
        : 'Interaction Singer';
    }

    function productStatus({ mic = 'free', canStartTake = false } = {}) {
      const owner = mic === 'free' ? null : participantId();
      return {
        type: 'product-status',
        lifecycle: mic === 'live' ? 'live' : mic === 'starting' ? 'preparing' : 'idle',
        health: 'healthy',
        issues: [],
        attention: null,
        room: {
          participantCount: 1,
          mic: {
            state: mic,
            ownerId: owner,
            ownerNickname: owner ? participantNickname() : null,
          },
          song: { state: 'empty', videoId: null, handoffState: 'idle' },
        },
        timing: { state: 'idle' },
        take: {
          lifecycle: currentTake.lifecycle,
          takeId: currentTake.take?.takeId ?? null,
          verdict: null,
        },
        actions: {
          canStartTake,
          startTakeBlockedReason: canStartTake ? null : 'mix-not-active',
          canStopTake: currentTake.lifecycle === 'recording',
          canStartCalibration: false,
          startCalibrationBlockedReason: 'session-not-active',
          startCalibrationMode: null,
        },
      };
    }

    let currentProduct = productStatus();

    function sessionStatus(micOwnerId = null, micConnected = false) {
      return {
        type: 'session-status',
        serverIncarnation: 'interaction-harness',
        revision: revision++,
        participants: [{
          id: participantId(),
          nickname: participantNickname(),
          connected: true,
        }],
        micOwnerId,
        micConnected,
      };
    }

    function deliver(socket, payload) {
      if (socket.readyState !== FakeWebSocket.OPEN) return;
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }));
    }

    function deliverAfter(socket, payload, delayMs) {
      if (delayMs > 0) {
        setTimeout(() => deliver(socket, payload), delayMs);
        return;
      }
      queueMicrotask(() => deliver(socket, payload));
    }

    function broadcast(payload) {
      for (const socket of sockets) deliver(socket, payload);
    }

    function broadcastProduct(payload) {
      currentProduct = payload;
      broadcast(payload);
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
        this.bufferedAmount = 0;
        this.binaryType = 'blob';
        this.kind = 'unknown';
        this.authParticipantId = null;
        this.requestTypes = new Set();
        sockets.push(this);
        queueMicrotask(() => {
          if (holdSocketOpens) {
            heldSockets.push(this);
            return;
          }
          this.open();
        });
      }

      open() {
        if (this.readyState !== FakeWebSocket.CONNECTING) return;
        this.readyState = FakeWebSocket.OPEN;
        this.dispatchEvent(new Event('open'));
      }

      send(data) {
        if (this.readyState !== FakeWebSocket.OPEN) {
          throw new DOMException('WebSocket is not open', 'InvalidStateError');
        }

        if (typeof data !== 'string') {
          const bytes = data instanceof ArrayBuffer ? data : data.buffer;
          const offset = data instanceof ArrayBuffer ? 0 : data.byteOffset;
          const view = new DataView(bytes, offset);
          packets.push({
            socketKind: this.kind,
            magic: view.getUint16(0, true),
            version: view.getUint8(2),
            source: view.getUint8(3),
            generation: view.getUint32(4, true),
            sequence: view.getUint32(8, true),
            sampleCount: view.getUint32(12, true),
            firstSampleIndex: view.getFloat64(16, true),
          });
          if (this.kind !== 'publisher') return;
          mark('T5');
          setTimeout(() => {
            mark('T6');
            mark('T7');
            currentProduct = productStatus({ mic: 'live', canStartTake: true });
            mark('T8');
            setTimeout(() => {
              mark('T9');
              broadcastProduct(currentProduct);
            }, 250);
          }, 4);
          return;
        }

        let message;
        try { message = JSON.parse(data); } catch { return; }
        commands.push({ ...message, socketKind: this.kind, at: performance.now() });
        this.requestTypes.add(message.type);

        if (message.type === 'participant-authenticate') {
          this.authParticipantId = message.participantId ?? null;
          return;
        }

        if (message.type === 'session-status-request') {
          this.kind = 'presence';
          queueMicrotask(() => deliver(this, sessionStatus()));
          return;
        }

        if (message.type === 'take-status-request') {
          this.kind = 'recorder';
          deliverAfter(this, currentTake, recorderReplayDelayMs);
          return;
        }

        if (message.type === 'product-status-request') {
          deliverAfter(this, currentProduct, recorderReplayDelayMs);
          return;
        }

        if (message.type === 'audio-uplink-health' && this.kind === 'publisher') {
          queueMicrotask(() => deliver(this, {
            type: 'audio-uplink-health-ack',
            version: 1,
            captureGeneration: message.captureGeneration,
            healthRequestId: message.healthRequestId,
          }));
          return;
        }

        if (message.type === 'register' && message.role === 'publisher') {
          this.kind = 'publisher';
          mark('T3');
          currentProduct = productStatus({ mic: 'starting', canStartTake: false });
          broadcast(currentProduct);
          broadcast(sessionStatus(participantId(), true));
          queueMicrotask(() => {
            mark('T4');
            deliver(this, {
              type: 'registered',
              role: 'publisher',
              mediaTransport: null,
            });
            queueMicrotask(() => {
              deliver(this, { type: 'mix-settings', micGainDb: 24, songLevel: 100 });
              deliver(this, { type: 'source-status', active: true, vocalFineTuneMs: 0 });
            });
          });
          return;
        }

        if (message.type === 'register' && message.role === 'monitor') {
          this.kind = 'monitor';
          queueMicrotask(() => deliver(this, { type: 'registered', role: 'monitor' }));
          return;
        }

        if (message.type === 'start-take') {
          if (currentTake.lifecycle === 'recording' || currentTake.lifecycle === 'finalizing') {
            deliverAfter(this, {
              type: 'take-command-rejected',
              command: 'start',
              reason: 'take-active',
            }, startResponseDelayMs);
            return;
          }
          currentTake = {
            type: 'take-status',
            lifecycle: 'recording',
            take: {
              takeId: 'interaction-take-1',
              startedAtMs: Date.now(),
            },
            history: [],
          };
          deliverAfter(this, currentTake, startResponseDelayMs);
          return;
        }

        if (message.type === 'stop-take') {
          currentTake = {
            type: 'take-status',
            lifecycle: 'ready',
            take: {
              takeId: 'interaction-take-1',
              startedAtMs: Date.now() - 1_000,
            },
            history: [],
          };
          queueMicrotask(() => deliver(this, currentTake));
        }
      }

      close() {
        if (this.readyState === FakeWebSocket.CLOSED) return;
        this.readyState = FakeWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent('close'));
      }
    }

    class FakeAudioNode {
      connect(target) { return target; }
      disconnect() {}
    }

    class FakeGainNode extends FakeAudioNode {
      constructor() {
        super();
        this.gain = {
          value: 1,
          setTargetAtTime() {},
          setValueAtTime() {},
          exponentialRampToValueAtTime() {},
        };
      }
    }

    class FakeAudioWorkletNode extends FakeAudioNode {
      constructor(_context, name) {
        super();
        const events = new EventTarget();
        this.addEventListener = events.addEventListener.bind(events);
        this.removeEventListener = events.removeEventListener.bind(events);
        this.dispatchEvent = events.dispatchEvent.bind(events);
        this.name = name;
        this.port = {
          onmessage: null,
          postMessage() {},
        };
        if (name === 'capture-processor') {
          captureNode = this;
          captureNode.context = _context;
          captureNodes.push(this);
        }
      }
    }

    class FakeAudioContext extends EventTarget {
      constructor() {
        super();
        this.sampleRate = 48_000;
        this.state = 'running';
        this.createdAtMs = performance.now();
        this.destination = new FakeAudioNode();
        this.audioWorklet = {
          addModule: async (url) => {
            if (String(url).includes('capture-worklet')) mark('T2');
          },
        };
      }

      // Like a real context, the clock runs while the context is running.
      get currentTime() { return (performance.now() - this.createdAtMs) / 1000; }

      async resume() { this.state = 'running'; }
      async close() { this.state = 'closed'; }
      createMediaStreamSource() { return new FakeAudioNode(); }
      createGain() { return new FakeGainNode(); }
      createOscillator() {
        if (window.__failProbeOscillators) throw new Error('test: the speaker is unavailable');
        window.__oscillatorsCreated = (window.__oscillatorsCreated ?? 0) + 1;
        const node = new FakeAudioNode();
        const events = new EventTarget();
        node.frequency = { value: 0 };
        node.addEventListener = events.addEventListener.bind(events);
        node.removeEventListener = events.removeEventListener.bind(events);
        node.start = () => {};
        node.stop = () => queueMicrotask(() => events.dispatchEvent(new Event('ended')));
        return node;
      }
    }

    const track = new EventTarget();
    track.muted = false;
    track.readyState = 'live';
    track.stop = () => {};
    // The input the live track is routed from; tests can move it.
    track.getSettings = () => ({ deviceId: window.__inputDeviceId ?? 'mic-a' });
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    };

    const deviceEvents = new EventTarget();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          await Promise.resolve();
          mark('T1');
          return stream;
        },
        // What the platform lists; tests can change it or make it fail.
        enumerateDevices: async () => {
          if (window.__enumerateDevicesFails) throw new Error('test: enumeration refused');
          return window.__audioInputs ?? [{ kind: 'audioinput', deviceId: 'mic-a' }];
        },
        addEventListener: deviceEvents.addEventListener.bind(deviceEvents),
        removeEventListener: deviceEvents.removeEventListener.bind(deviceEvents),
        dispatchEvent: deviceEvents.dispatchEvent.bind(deviceEvents),
      },
    });

    window.WebSocket = FakeWebSocket;
    window.AudioContext = FakeAudioContext;
    window.webkitAudioContext = FakeAudioContext;
    window.AudioWorkletNode = FakeAudioWorkletNode;

    window.addEventListener('relay-recording-state', (event) => {
      if (event.detail?.canStart !== true) return;
      mark('T10');
      queueMicrotask(() => {
        const strip = document.querySelector('.take-strip');
        const button = document.querySelector('#start-recording');
        if (strip && !strip.hidden && button && !button.hidden && !button.disabled) mark('T11');
      });
    });

    window.__relayInteractionHarness = {
      timeline,
      commands,
      /** AudioPacket headers of every binary frame the page sent. */
      packets,
      mark,
      /** Sends one server message to every open socket, as a Relay broadcast does. */
      broadcast(payload) {
        broadcast(payload);
      },
      /** Sends one server message to the open sockets of one kind. */
      sendTo(kind, payload) {
        for (const candidate of sockets) {
          if (candidate.kind === kind && candidate.readyState === FakeWebSocket.OPEN) deliver(candidate, payload);
        }
      },
      /** Closes the open sockets of one kind, as a dropped connection does. */
      closeSockets(kind) {
        for (const candidate of sockets) {
          if (candidate.kind === kind && candidate.readyState === FakeWebSocket.OPEN) candidate.close();
        }
      },
      emitSilentPcm() {
        if (!captureNode?.port?.onmessage) throw new Error('capture worklet is not ready');
        // As the production worklet posts it: stamped with when its oldest
        // sample was captured. A bare buffer makes the page date it from
        // samples counted, and a timer that falls behind the real-time clock
        // then reads as a backlog and every chunk is dropped.
        captureNode.port.onmessage({ data: {
          type: 'pcm',
          buffer: new ArrayBuffer(1_920),
          capturedAtContextTime: Math.max(0, captureNode.context.currentTime - 0.02),
        } });
      },
      /** The capture worklet's processor throws, as Web Audio reports it. */
      failCaptureProcessor() {
        if (!captureNode) throw new Error('capture worklet is not ready');
        captureNode.dispatchEvent(new Event('processorerror'));
      },
      /** The capture graph's AudioContext clock, in seconds. */
      captureContextTime() {
        if (!captureNode) throw new Error('capture worklet is not ready');
        return captureNode.context.currentTime;
      },
      /** A capture worklet the page has already replaced throws. */
      failRetiredCaptureProcessor() {
        if (captureNodes.length < 2) throw new Error('no capture worklet has been replaced');
        captureNodes[0].dispatchEvent(new Event('processorerror'));
      },
      /** Delivers any message the capture worklet could post. */
      emitCaptureMessage(data) {
        if (!captureNode?.port?.onmessage) throw new Error('capture worklet is not ready');
        captureNode.port.onmessage({ data });
      },
      /** New sockets stay CONNECTING until released, like a slow network. */
      holdSocketOpens() {
        holdSocketOpens = true;
      },
      releaseSocketOpens() {
        holdSocketOpens = false;
        for (const socket of heldSockets.splice(0)) socket.open();
      },
      disconnectDiagnostics() {
        // Technical details is the one page socket that asks for both the
        // YouTube timeline and the calibration status in its snapshot burst.
        const diagnostics = sockets.find((candidate) => candidate.readyState === FakeWebSocket.OPEN
          && candidate.requestTypes.has('youtube-timeline-request')
          && candidate.requestTypes.has('timing-calibration-status-request'));
        if (!diagnostics) throw new Error('Technical details socket is not connected');
        diagnostics.close();
      },
      setStartResponseDelay(ms) {
        startResponseDelayMs = Math.max(0, Number(ms) || 0);
      },
      disconnectRecorder({ mic = 'free', canStartTake = false, replayDelayMs = 160 } = {}) {
        const recorder = [...sockets].reverse().find(
          (candidate) => candidate.kind === 'recorder' && candidate.readyState === FakeWebSocket.OPEN,
        );
        if (!recorder) throw new Error('recorder socket is not connected');
        recorderReplayDelayMs = Math.max(0, Number(replayDelayMs) || 0);
        recorder.close();
        currentProduct = productStatus({ mic, canStartTake });
      },
      publishRecordingHistory() {
        currentTake = {
          ...currentTake,
          history: [{
            takeId: 'interaction-history-1',
            endedAtMs: Date.now() - 1_000,
            songVideoId: null,
            artifact: {
              url: '/takes/11111111-1111-4111-8111-111111111111.wav',
              durationMs: 12_000,
            },
            qualityVerdict: 'clean',
            recovered: false,
          }],
        };
        broadcast(currentTake);
      },
    };
  });
}

async function prepareReadyMic(page) {
  await page.waitForFunction(() => window.relayRecordingState?.connected === true);
  await page.locator('#start-publisher').click();
  await page.waitForFunction(() => Number.isFinite(window.__relayInteractionHarness.timeline.T4));
  await expect(page.locator('#live-state-title')).toHaveText('Starting your mic…');
  await expect(page.locator('#live-state-detail')).toHaveText('Waiting for the first audio frame from this device.');
  await page.evaluate(() => window.__relayInteractionHarness.emitSilentPcm());
  await page.waitForFunction(() => window.relayRecordingState?.canStart === true);
  await expect(page.locator('#live-state-title')).toHaveText('You’re live');
}

test('production DOM: recording stays one row through blocked readiness and morphs to Stop', async ({ page }) => {
  await installProductionDomHarness(page);
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });

  await page.waitForFunction(() => window.relayRecordingState?.connected === true);
  const strip = page.locator('.take-strip');
  const record = page.locator('#start-recording');
  const status = page.locator('#recording-status');
  const stop = page.locator('#stop-recording');
  await expect(strip).toBeVisible();
  await expect(record).toBeHidden();
  await expect(status).toBeVisible();
  await expect(status).toHaveText('Sound is getting ready…');
  const blockedSlot = await strip.boundingBox();
  expect(blockedSlot).not.toBeNull();
  expect(blockedSlot.height).toBeLessThan(50);

  await page.evaluate(() => window.__relayInteractionHarness.mark('T0'));
  await page.locator('#start-publisher').click();
  await page.waitForFunction(() => Number.isFinite(window.__relayInteractionHarness.timeline.T4));

  await expect(page.locator('#live-state-title')).toHaveText('Starting your mic…');
  await expect(page.locator('#live-state-detail')).toHaveText('Waiting for the first audio frame from this device.');
  await expect(strip).toBeVisible();
  await expect(record).toBeHidden();
  await expect(status).toBeVisible();
  const startingSlot = await strip.boundingBox();
  expect(startingSlot).not.toBeNull();
  expect(Math.abs(startingSlot.y - blockedSlot.y)).toBeLessThan(1);
  expect(Math.abs(startingSlot.height - blockedSlot.height)).toBeLessThan(1);

  await page.evaluate(() => window.__relayInteractionHarness.emitSilentPcm());
  await page.waitForFunction(() => Number.isFinite(window.__relayInteractionHarness.timeline.T11));
  await expect(page.locator('#live-state-title')).toHaveText('You’re live');

  const timing = await page.evaluate(() => ({ ...window.__relayInteractionHarness.timeline }));
  for (const point of ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11']) {
    expect(Number.isFinite(timing[point]), `${point} should be recorded`).toBe(true);
  }
  for (let index = 1; index <= 11; index += 1) {
    expect(timing[`T${index}`]).toBeGreaterThanOrEqual(timing[`T${index - 1}`]);
  }
  const relativeTiming = Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => {
      const point = `T${index}`;
      return [point, Number((timing[point] - timing.T0).toFixed(1))];
    }),
  );
  console.log(
    `[relay-p0-timing] ${JSON.stringify(relativeTiming)} `
    + `firstPcmReceivedToRecordMs=${(timing.T11 - timing.T6).toFixed(1)}`,
  );
  expect(timing.T11 - timing.T6).toBeLessThan(300);

  await expect(record).toBeVisible();
  await expect(record).toBeEnabled();
  await expect(record).toHaveText('Record');
  await expect(status).toBeHidden();
  const slotBefore = await strip.boundingBox();
  expect(slotBefore).not.toBeNull();
  expect(slotBefore.height).toBeLessThan(50);
  expect(Math.abs(slotBefore.height - blockedSlot.height)).toBeLessThan(1);

  await record.click();
  await page.waitForFunction(() => window.__relayInteractionHarness.commands.some(
    (command) => command.type === 'start-take' && command.socketKind === 'recorder',
  ));
  await expect(stop).toBeVisible();
  await expect(stop).toBeEnabled();
  await expect(status).toContainText('●');

  const slotAfter = await strip.boundingBox();
  const stopBox = await stop.boundingBox();
  expect(slotAfter).not.toBeNull();
  expect(stopBox).not.toBeNull();
  expect(Math.abs(slotAfter.y - slotBefore.y)).toBeLessThan(1);
  expect(Math.abs(slotAfter.height - slotBefore.height)).toBeLessThan(1);
  expect(Math.abs((stopBox.x + stopBox.width) - (slotAfter.x + slotAfter.width))).toBeLessThan(2);

  await page.evaluate(() => window.__relayInteractionHarness.disconnectRecorder({
    mic: 'live',
    canStartTake: false,
    replayDelayMs: 160,
  }));
  await page.waitForFunction(() => window.relayRecordingState?.connected === false);
  await expect(stop).toBeVisible();
  await expect(stop).toBeDisabled();
  await expect(status).toContainText('Reconnecting…');
  await page.waitForFunction(() => window.relayRecordingState?.connected === true
    && window.relayRecordingState?.takeStatusFresh === false);
  await expect(stop).toBeVisible();
  await expect(stop).toBeDisabled();
  await page.waitForFunction(() => window.relayRecordingState?.takeStatusFresh === true);
  await expect(stop).toBeVisible();
  await expect(stop).toBeEnabled();
});

test('production DOM: Record and Recordings share a row above Mic and Room sound', async ({ page }) => {
  await installProductionDomHarness(page);
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });
  await prepareReadyMic(page);

  await page.evaluate(() => window.__relayInteractionHarness.publishRecordingHistory());

  const strip = page.locator('.take-strip');
  const record = page.locator('#start-recording');
  const recordings = page.locator('#last-take');
  const mic = page.locator('#mic-live-control');
  const roomSound = page.locator('.local-sound-control');

  await expect(record).toBeVisible();
  await expect(recordings).toBeVisible();
  await expect(mic).toBeVisible();
  await expect(roomSound).toContainText('Room sound');
  await expect(recordings).toHaveClass(/recent-take/);
  await expect(page.locator('#last-take-toggle')).toHaveText('Last take · 0:12');
  await expect(page.locator('.take-history-item span')).toHaveText('0:12');
  await expect(page.locator('.take-history-selected span')).toHaveText('0:12');
  await expect(page.locator('#take-history-panel')).not.toContainText('Clean');
  expect(await recordings.evaluate((node) => node.parentElement?.matches('.take-strip'))).toBe(true);

  const [recordBox, recordingsBox, micBox, roomSoundBox] = await Promise.all([
    record.boundingBox(),
    recordings.boundingBox(),
    mic.boundingBox(),
    roomSound.boundingBox(),
  ]);
  expect(recordBox).not.toBeNull();
  expect(recordingsBox).not.toBeNull();
  expect(micBox).not.toBeNull();
  expect(roomSoundBox).not.toBeNull();
  expect(Math.abs((recordBox.y + recordBox.height / 2) - (recordingsBox.y + recordingsBox.height / 2))).toBeLessThan(2);
  expect(recordBox.x).toBeLessThan(recordingsBox.x);
  expect(recordBox.y + recordBox.height).toBeLessThanOrEqual(micBox.y + 1);
  expect(micBox.y + micBox.height).toBeLessThanOrEqual(roomSoundBox.y + 1);
});

test('production DOM: the local Mic owner can change Mic gain', async ({ page }) => {
  await installProductionDomHarness(page);
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });
  await prepareReadyMic(page);

  const micControl = page.locator('#mic-live-control');
  const micGain = page.locator('#mic-gain');
  await expect(micControl).toHaveAttribute('open', '');
  await expect(micGain).toBeVisible();
  await expect(micGain).toBeEnabled();
  await expect(page.locator('.voice-input-evidence .evidence-heading')).toBeHidden();
  await page.waitForLoadState('load');
  await expect(page.locator('#mic-gain-advice')).toHaveCount(0);
  await expect(page.locator('#use-mic-gain-suggestion')).toHaveCount(0);
  await micGain.focus();
  await micGain.press('Home');

  await expect(micGain).toHaveValue('0');
  await page.waitForFunction(() => window.__relayInteractionHarness.commands.some(
    (command) => command.type === 'set-mix' && command.micGainDb === 0,
  ));

  await page.keyboard.press('Escape');
  await expect(micControl).toHaveAttribute('open', '');
  await expect(micGain).toBeVisible();
});

test('production DOM: one desktop Change song click survives a transient playback-role refresh', async ({ page }) => {
  await installProductionDomHarness(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });

  const publishPlayback = (role, videoId, handoffState = 'idle') => page.evaluate(
    ({ nextRole, nextVideoId, nextHandoffState }) => {
      window.dispatchEvent(new CustomEvent('relay:playback-view', {
        detail: {
          role: nextRole,
          room: {
            videoId: nextVideoId,
            videoTitle: 'Interaction song',
            handoffState: nextHandoffState,
          },
          timeline: {
            videoId: nextVideoId,
            state: 1,
            handoffState: nextHandoffState,
            serverTime: 10,
            duration: 120,
          },
        },
      }));
    },
    { nextRole: role, nextVideoId: videoId, nextHandoffState: handoffState },
  );

  await publishPlayback('holder', 'abcdefghijk');
  const change = page.locator('#change-youtube');
  const form = page.locator('.youtube-form');

  await expect(change).toHaveText('Change song');
  await change.click();
  await expect(form).toBeVisible();
  await expect(change).toHaveText('Done');
  await expect(page.locator('#youtube-url')).toBeFocused();

  await publishPlayback('preparing', 'abcdefghijk', 'preparing');
  await expect(form).toBeHidden();
  await publishPlayback('holder', 'abcdefghijk');
  await expect(form).toBeVisible();
  await expect(change).toHaveText('Done');

  await publishPlayback('holder', 'lmnopqrstuv');
  await expect(form).toBeHidden();
  await expect(change).toHaveText('Change song');
});

test('production DOM: recorder reconnect swaps Record for status until fresh authority', async ({ page }) => {
  await installProductionDomHarness(page);
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });
  await prepareReadyMic(page);

  const record = page.locator('#start-recording');
  const status = page.locator('#recording-status');
  await expect(record).toBeVisible();
  await expect(record).toBeEnabled();

  await page.evaluate(() => window.__relayInteractionHarness.disconnectRecorder({
    mic: 'free',
    canStartTake: false,
    replayDelayMs: 180,
  }));
  await page.waitForFunction(() => window.relayRecordingState?.connected === false);
  await expect(record).toBeHidden();
  await expect(status).toBeVisible();
  await expect(status).toHaveText('Reconnecting…');

  await page.waitForFunction(() => window.relayRecordingState?.connected === true
    && window.relayRecordingState?.productStatusFresh === false
    && window.relayRecordingState?.takeStatusFresh === false);
  await expect(record).toBeHidden();
  await expect(status).toHaveText('Reconnecting…');

  await page.waitForFunction(() => window.relayRecordingState?.productStatusFresh === true
    && window.relayRecordingState?.takeStatusFresh === true);
  await expect(record).toBeHidden();
  await expect(status).toHaveText('Sound is getting ready…');
});

test('production DOM: rapid Record taps emit exactly one Start command', async ({ page }) => {
  await installProductionDomHarness(page);
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });
  await prepareReadyMic(page);

  await page.evaluate(() => window.__relayInteractionHarness.setStartResponseDelay(160));
  const record = page.locator('#start-recording');
  await record.dblclick({ delay: 10 });
  await page.waitForTimeout(220);

  await expect(page.locator('#stop-recording')).toBeVisible();
  await expect(page.locator('#recording-status')).toContainText('●');
  const state = await page.evaluate(() => window.relayRecordingState);
  expect(state?.commandError ?? null).toBeNull();

  const startCommands = await page.evaluate(() => window.__relayInteractionHarness.commands.filter(
    (command) => command.type === 'start-take' && command.socketKind === 'recorder',
  ).length);
  expect(startCommands).toBe(1);
});

test('production DOM: People and More close with Escape without regressing System', async ({ page }) => {
  await installProductionDomHarness(page);
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });

  const people = page.locator('.people-menu');
  const more = page.locator('#room-more');
  const system = page.locator('#system-panel');

  await page.locator('.people-menu > summary').click();
  expect(await people.evaluate((node) => node.open)).toBe(true);
  await page.keyboard.press('Escape');
  expect(await people.evaluate((node) => node.open)).toBe(false);

  await page.locator('#room-more > summary').click();
  expect(await more.evaluate((node) => node.open)).toBe(true);
  await page.keyboard.press('Escape');
  expect(await more.evaluate((node) => node.open)).toBe(false);

  await page.locator('#room-more > summary').click();
  await page.locator('#open-system').click();
  expect(await system.evaluate((node) => node.open)).toBe(true);
  expect(await more.evaluate((node) => node.open)).toBe(false);
  await page.keyboard.press('Escape');
  expect(await system.evaluate((node) => node.open)).toBe(false);
});

test('production DOM: a locale switch keeps the Technical details connection state', async ({ page }) => {
  await installProductionDomHarness(page);
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => window.relayI18n.setLocale('en', { persist: false }));

  await page.locator('#room-more > summary').click();
  await page.locator('#open-system').click();
  await page.locator('#diagnostics-panel > summary').click();
  const state = page.locator('#diagnostics-state');
  const setLocale = (locale) => page.evaluate((next) => window.relayI18n.setLocale(next, { persist: false }), locale);

  // OPEN: the socket stays connected across the switch in both directions.
  await expect(state).toHaveText('Connected');
  await setLocale('zh-Hant');
  await expect(state).toHaveText('已連線');
  await setLocale('en');
  await expect(state).toHaveText('Connected');

  // RECONNECTING: the socket dropped and the retry has not started yet.
  await page.evaluate(() => {
    window.__relayInteractionHarness.holdSocketOpens();
    window.__relayInteractionHarness.disconnectDiagnostics();
  });
  await expect(state).toHaveText('Reconnecting…');
  await setLocale('zh-Hant');
  await expect(state).toHaveText('重新連線中…');

  // CONNECTING: the retry socket exists but has not opened.
  await expect(state).toHaveText('更新中…', { timeout: 3_000 });
  await setLocale('en');
  await expect(state).toHaveText('Refreshing…');

  await page.evaluate(() => window.__relayInteractionHarness.releaseSocketOpens());
  await expect(state).toHaveText('Connected');
  await setLocale('zh-Hant');
  await expect(state).toHaveText('已連線');
});

async function setRange(page, selector, value) {
  await page.locator(selector).evaluate((element, next) => {
    element.value = String(next);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

test('production DOM: an echoed Mic gain does not move the slider the singer is holding', async ({ page }) => {
  await installProductionDomHarness(page);
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });
  await prepareReadyMic(page);

  // The phone keeps capturing while the singer adjusts, which is what keeps
  // its control channel fresh.
  await page.evaluate(() => {
    window.__keepCapturing = setInterval(() => window.__relayInteractionHarness.emitSilentPcm(), 20);
  });
  const micGain = page.locator('#mic-gain');
  await expect(micGain).toBeEnabled();
  await micGain.focus();
  await setRange(page, '#mic-gain', 10);
  await page.waitForFunction(() => window.__relayInteractionHarness.commands.some(
    (command) => command.type === 'set-mix' && command.micGainDb === 10,
  ));

  // Another client's setting arrives while this singer still has the slider,
  // both right after the change and after holding it longer than the
  // post-change grace.
  await page.evaluate(() => window.__relayInteractionHarness.broadcast({
    type: 'mix-settings', micGainDb: 30, songLevel: 100,
  }));
  await page.waitForTimeout(100);
  await expect(micGain).toHaveValue('10');
  await page.waitForTimeout(2_100);
  await page.evaluate(() => window.__relayInteractionHarness.broadcast({
    type: 'mix-settings', micGainDb: 30, songLevel: 100,
  }));
  await page.waitForTimeout(100);
  await expect(micGain).toHaveValue('10');

  // Once they have let go, the room's value is the one shown.
  await micGain.blur();
  await page.waitForTimeout(2_100);
  await page.evaluate(() => window.__relayInteractionHarness.broadcast({
    type: 'mix-settings', micGainDb: 30, songLevel: 100,
  }));
  await expect(micGain).toHaveValue('30');
});

test('production DOM: a Mic gain the Relay cannot take goes back to the confirmed value', async ({ page }) => {
  await installProductionDomHarness(page);
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });
  await prepareReadyMic(page);

  await page.evaluate(() => window.__relayInteractionHarness.broadcast({
    type: 'mix-settings', micGainDb: 20, songLevel: 100,
  }));
  const micGain = page.locator('#mic-gain');
  await expect(micGain).toHaveValue('20');

  await page.evaluate(() => window.__relayInteractionHarness.closeSockets('publisher'));
  const sentBefore = await page.evaluate(() => window.__relayInteractionHarness.commands
    .filter((command) => command.type === 'set-mix').length);
  await setRange(page, '#mic-gain', 5);

  await expect(micGain).toHaveValue('20');
  const sentAfter = await page.evaluate(() => window.__relayInteractionHarness.commands
    .filter((command) => command.type === 'set-mix').length);
  expect(sentAfter).toBe(sentBefore);
});

test('production DOM: the Mic owner can nudge the vocal timing', async ({ page }) => {
  await installProductionDomHarness(page);
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });

  const fineTune = page.locator('#vocal-fine-tune');
  await expect(fineTune).toBeDisabled();
  await prepareReadyMic(page);
  await expect(fineTune).toBeEnabled();

  await setRange(page, '#vocal-fine-tune', -25);
  await page.waitForFunction(() => window.__relayInteractionHarness.commands.some(
    (command) => command.type === 'set-vocal-fine-tune' && command.valueMs === -25,
  ));
  await expect(page.locator('#vocal-fine-tune-value')).toHaveText('-25 ms');
});

function healthReports(page) {
  return page.evaluate(() => window.__relayInteractionHarness.commands
    .filter((command) => command.type === 'audio-uplink-health')
    .map(({ captureGeneration, healthRequestId, capturedSamples, controlReconnects }) => (
      { captureGeneration, healthRequestId, capturedSamples, controlReconnects }
    )));
}

test('production DOM: uplink health counts the capture it reports on', async ({ page }) => {
  await installProductionDomHarness(page);
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });
  await prepareReadyMic(page);

  // prepareReadyMic emitted one 960-sample frame; 49 more make one second.
  await page.evaluate(() => {
    for (let frame = 0; frame < 49; frame += 1) window.__relayInteractionHarness.emitSilentPcm();
  });
  await page.waitForFunction(() => window.__relayInteractionHarness.commands.some(
    (command) => command.type === 'audio-uplink-health' && command.capturedSamples === 48_000,
  ), null, { timeout: 5_000 });

  const reports = await healthReports(page);
  expect(new Set(reports.map((report) => report.captureGeneration)).size).toBe(1);
  for (let index = 1; index < reports.length; index += 1) {
    expect(reports[index].healthRequestId).toBeGreaterThan(reports[index - 1].healthRequestId);
    expect(reports[index].capturedSamples).toBeGreaterThanOrEqual(reports[index - 1].capturedSamples);
  }
});

test('production DOM: uplink health reports a dropped control connection', async ({ page }) => {
  await installProductionDomHarness(page);
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });
  await prepareReadyMic(page);
  await page.waitForFunction(() => window.__relayInteractionHarness.commands.some(
    (command) => command.type === 'audio-uplink-health',
  ), null, { timeout: 5_000 });
  expect((await healthReports(page)).at(-1).controlReconnects).toBe(0);

  await page.evaluate(() => {
    window.__keepCapturing = setInterval(() => window.__relayInteractionHarness.emitSilentPcm(), 20);
    window.__relayInteractionHarness.closeSockets('publisher');
  });
  await page.waitForFunction(() => window.__relayInteractionHarness.commands.some(
    (command) => command.type === 'audio-uplink-health' && command.controlReconnects === 1,
  ), null, { timeout: 10_000 });
});

function inputLevel(windowMaxConsecutiveRailSamples, lifetimeMax) {
  return {
    type: 'input-level',
    peakDbfs: windowMaxConsecutiveRailSamples > 0 ? 0 : -12,
    rmsDbfs: -18,
    spectrumBands: [0, 0, 0, 0, 0],
    f0Hz: null,
    pitchConfidence: 0,
    railSamples: lifetimeMax,
    maxConsecutiveRailSamples: lifetimeMax,
    windowMaxConsecutiveRailSamples,
  };
}

test('production DOM: uplink health reports a clipped window once, until the Relay has it', async ({ page }) => {
  await installProductionDomHarness(page);
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });
  await prepareReadyMic(page);
  // A live phone keeps capturing; without frames the capture watchdog rebuilds
  // the capture, and a new capture starts its clipping evidence afresh.
  await page.evaluate(() => {
    window.__keepCapturing = setInterval(() => window.__relayInteractionHarness.emitSilentPcm(), 20);
  });
  const recent = () => page.evaluate(() => window.__relayInteractionHarness.commands
    .filter((command) => command.type === 'audio-uplink-health')
    .map((command) => command.captureClipping?.recentDetected));

  await page.evaluate((level) => window.__relayInteractionHarness.emitCaptureMessage(level), inputLevel(0, 0));
  await page.waitForFunction(() => window.__relayInteractionHarness.commands.some(
    (command) => command.type === 'audio-uplink-health' && command.captureClipping?.recentDetected === false,
  ), null, { timeout: 5_000 });

  // One flat-topped window.
  const before = (await recent()).length;
  await page.evaluate((level) => window.__relayInteractionHarness.emitCaptureMessage(level), inputLevel(8, 8));
  await page.evaluate((level) => window.__relayInteractionHarness.emitCaptureMessage(level), inputLevel(0, 8));
  await page.waitForFunction((from) => window.__relayInteractionHarness.commands
    .filter((command) => command.type === 'audio-uplink-health')
    .slice(from)
    .some((command) => command.captureClipping?.recentDetected === true), before, { timeout: 5_000 });

  // The Relay acknowledged that report; with no new clipping the next one is clean.
  const reported = (await recent()).length;
  await page.waitForFunction((from) => window.__relayInteractionHarness.commands
    .filter((command) => command.type === 'audio-uplink-health')
    .slice(from)
    .some((command) => command.captureClipping?.recentDetected === false), reported, { timeout: 5_000 });
});

function probeReplies(page) {
  return page.evaluate(() => window.__relayInteractionHarness.commands
    .filter((command) => command.type === 'calibration-probe-played' || command.type === 'calibration-probe-failed')
    .map(({ type, requestId, generation, target }) => ({ type, requestId, generation, target })));
}

test('production DOM: the phone plays a Mic timing probe and says which one', async ({ page }) => {
  await installProductionDomHarness(page);
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });
  await prepareReadyMic(page);
  await page.evaluate(() => {
    window.__keepCapturing = setInterval(() => window.__relayInteractionHarness.emitSilentPcm(), 20);
  });
  await page.waitForFunction(() => window.__relayInteractionHarness.commands.some(
    (command) => command.type === 'audio-uplink-health',
  ), null, { timeout: 5_000 });
  const generation = await page.evaluate(() => window.__relayInteractionHarness.commands
    .findLast((command) => command.type === 'audio-uplink-health').captureGeneration);

  await page.evaluate(() => window.__relayInteractionHarness.broadcast({
    type: 'play-calibration-probe', target: 'mic', requestId: 41, leadMs: 20,
  }));
  await page.waitForFunction(() => window.__relayInteractionHarness.commands.some(
    (command) => command.type === 'calibration-probe-played' && command.requestId === 41,
  ), null, { timeout: 5_000 });
  expect(await probeReplies(page)).toEqual([
    { type: 'calibration-probe-played', requestId: 41, generation, target: 'mic' },
  ]);
});

test('production DOM: the phone leaves backing probes and malformed probes alone', async ({ page }) => {
  await installProductionDomHarness(page);
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });
  await prepareReadyMic(page);
  await page.evaluate(() => {
    window.__keepCapturing = setInterval(() => window.__relayInteractionHarness.emitSilentPcm(), 20);
  });

  // The backing leg is the Robot's to play; a phone reply there could be
  // mistaken for the Robot's.
  await page.evaluate(() => {
    window.__relayInteractionHarness.broadcast({ type: 'play-calibration-probe', target: 'backing', requestId: 7, leadMs: 20 });
    window.__relayInteractionHarness.broadcast({ type: 'play-calibration-probe', target: 'mic', requestId: -1, leadMs: 20 });
  });
  await page.waitForTimeout(600);
  expect(await probeReplies(page)).toEqual([]);
});

test('production DOM: a newer probe request replaces one still being prepared', async ({ page }) => {
  await installProductionDomHarness(page);
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });
  await prepareReadyMic(page);
  await page.evaluate(() => {
    window.__keepCapturing = setInterval(() => window.__relayInteractionHarness.emitSilentPcm(), 20);
  });

  await page.evaluate(() => {
    window.__relayInteractionHarness.broadcast({ type: 'play-calibration-probe', target: 'mic', requestId: 5, leadMs: 20 });
    window.__relayInteractionHarness.broadcast({ type: 'play-calibration-probe', target: 'mic', requestId: 6, leadMs: 20 });
  });
  await page.waitForFunction(() => window.__relayInteractionHarness.commands.some(
    (command) => command.type === 'calibration-probe-played' && command.requestId === 6,
  ), null, { timeout: 5_000 });
  await page.waitForTimeout(300);
  expect((await probeReplies(page)).map((reply) => reply.requestId)).toEqual([6]);
  // Overlapping probe waveforms are not valid calibration evidence: only the
  // newer request's three notes were ever scheduled.
  expect(await page.evaluate(() => window.__oscillatorsCreated)).toBe(3);
});

test('production DOM: a probe the phone cannot play is reported as failed, with why', async ({ page }) => {
  await installProductionDomHarness(page);
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });
  await prepareReadyMic(page);
  await page.evaluate(() => {
    window.__keepCapturing = setInterval(() => window.__relayInteractionHarness.emitSilentPcm(), 20);
    window.__failProbeOscillators = true;
  });

  await page.evaluate(() => window.__relayInteractionHarness.broadcast({
    type: 'play-calibration-probe', target: 'mic', requestId: 12, leadMs: 20,
  }));
  await page.waitForFunction(() => window.__relayInteractionHarness.commands.some(
    (command) => command.type === 'calibration-probe-failed' && command.requestId === 12,
  ), null, { timeout: 5_000 });
  const failed = await page.evaluate(() => window.__relayInteractionHarness.commands
    .find((command) => command.type === 'calibration-probe-failed'));
  expect(failed.reason).toBe('test: the speaker is unavailable');
  expect((await probeReplies(page)).length).toBe(1);
});

async function livePhone(page) {
  await installProductionDomHarness(page);
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window.__microphoneEnded = [];
    window.addEventListener('relay-microphone-ended', (event) => window.__microphoneEnded.push(event.detail.reason));
  });
  await prepareReadyMic(page);
  await page.evaluate(() => {
    window.__keepCapturing = setInterval(() => {
      try { window.__relayInteractionHarness.emitSilentPcm(); } catch {}
    }, 20);
  });
}

function countOf(page, type) {
  return page.evaluate((wanted) => window.__relayInteractionHarness.commands
    .filter((command) => command.type === wanted).length, type);
}

test('production DOM: a command the Relay refuses puts the control back and says who has the Mic', async ({ page }) => {
  await livePhone(page);
  await page.evaluate(() => window.__relayInteractionHarness.broadcast({
    type: 'mix-settings', micGainDb: 20, songLevel: 100,
  }));
  const micGain = page.locator('#mic-gain');
  await expect(micGain).toHaveValue('20');
  await setRange(page, '#mic-gain', 5);
  await micGain.blur();

  await page.evaluate(() => window.__relayInteractionHarness.sendTo('publisher', {
    type: 'command-rejected', command: 'set-mix', reason: 'not-mic-owner', owner: { nickname: 'Bob' },
  }));
  await expect(micGain).toHaveValue('20');
  await expect(micGain).toBeDisabled();
  await expect(page.locator('#status')).toHaveText('Mix is controlled by the singer');
  await expect(page.locator('#details')).toHaveText('Bob has the mic and controls this.');
});

for (const [type, reason, title] of [
  ['mic-revoked', 'revoked', 'Microphone handed off'],
  ['publisher-superseded', 'superseded', 'Microphone moved to another tab'],
  ['mic-busy', 'busy', 'Microphone is in use'],
]) {
  test(`production DOM: ${type} ends this phone's microphone session`, async ({ page }) => {
    await livePhone(page);
    await page.waitForFunction(() => window.__relayInteractionHarness.commands.some(
      (command) => command.type === 'audio-uplink-health',
    ), null, { timeout: 5_000 });

    await page.evaluate((payload) => window.__relayInteractionHarness.sendTo('publisher', payload), {
      type, message: undefined, owner: { nickname: 'Bob' },
    });
    await page.waitForFunction((wanted) => window.__microphoneEnded.includes(wanted), reason, { timeout: 5_000 });
    await expect(page.locator('#status')).toHaveText(title);

    // An ended session stops reporting on a capture it no longer has.
    const reports = await countOf(page, 'audio-uplink-health');
    await page.waitForTimeout(2_500);
    expect(await countOf(page, 'audio-uplink-health')).toBe(reports);
  });
}

test('production DOM: a protocol error is shown and does not make the phone reconnect', async ({ page }) => {
  await livePhone(page);
  const registrations = await page.evaluate(() => window.__relayInteractionHarness.commands
    .filter((command) => command.type === 'register' && command.role === 'publisher').length);

  await page.evaluate(() => window.__relayInteractionHarness.sendTo('publisher', {
    type: 'error', message: 'Invalid playback transport identity.',
  }));
  await expect(page.locator('#status')).toHaveText('Error');
  await expect(page.locator('#details')).toHaveText('Invalid playback transport identity.');
  await page.waitForTimeout(1_500);
  expect(await page.evaluate(() => window.__relayInteractionHarness.commands
    .filter((command) => command.type === 'register' && command.role === 'publisher').length)).toBe(registrations);
  expect(await page.evaluate(() => window.__microphoneEnded)).toEqual([]);
});

test('production DOM: an echoed vocal timing does not move the slider the singer is holding', async ({ page }) => {
  await livePhone(page);
  const fineTune = page.locator('#vocal-fine-tune');
  await expect(fineTune).toBeEnabled();
  await fineTune.focus();
  await setRange(page, '#vocal-fine-tune', 30);
  await page.evaluate(() => window.__relayInteractionHarness.sendTo('publisher', {
    type: 'source-status', active: true, vocalFineTuneMs: -40,
  }));
  await page.waitForTimeout(100);
  await expect(fineTune).toHaveValue('30');

  await fineTune.blur();
  await page.waitForTimeout(2_100);
  await page.evaluate(() => window.__relayInteractionHarness.sendTo('publisher', {
    type: 'source-status', active: true, vocalFineTuneMs: -40,
  }));
  await expect(fineTune).toHaveValue('-40');
  await expect(page.locator('#vocal-fine-tune-value')).toHaveText('-40 ms');
});

function publisherRegistrations(page) {
  return page.evaluate(() => window.__relayInteractionHarness.commands
    .filter((command) => command.type === 'register' && command.role === 'publisher')
    .map(({ sampleRate, captureGeneration, initialSequence, audioPacketVersion }) => (
      { sampleRate, captureGeneration, initialSequence, audioPacketVersion }
    )));
}

test('production DOM: a dropped control connection comes back with the same capture', async ({ page }) => {
  await livePhone(page);
  const [first] = await publisherRegistrations(page);
  expect(first).toMatchObject({ sampleRate: 48_000, audioPacketVersion: 2 });
  expect(Number.isInteger(first.captureGeneration)).toBe(true);

  await page.evaluate(() => window.__relayInteractionHarness.closeSockets('publisher'));
  await page.waitForFunction(() => window.__relayInteractionHarness.commands
    .filter((command) => command.type === 'register' && command.role === 'publisher').length === 2,
  null, { timeout: 10_000 });

  // The capture never stopped, so the Relay is told it is the same one: a new
  // generation would be a capture restart and re-anchor the Mic timeline.
  const [, again] = await publisherRegistrations(page);
  expect(again.captureGeneration).toBe(first.captureGeneration);
  expect(again.initialSequence).toBeGreaterThan(first.initialSequence);
});

test('production DOM: the publisher subscribes to its broadcasts before it registers', async ({ page }) => {
  await livePhone(page);
  const [before, register] = await page.evaluate(() => {
    const commands = window.__relayInteractionHarness.commands;
    const index = commands.findIndex((command) => command.type === 'register' && command.role === 'publisher');
    return [commands[index - 1], commands[index]];
  });
  expect(register.role).toBe('publisher');
  // Relay sends a publisher socket only what it asked for, so the subscription
  // has to be in place before registration starts the publisher broadcasts.
  expect(before.type).toBe('broadcast-subscribe');
  expect(before.types).toEqual(expect.arrayContaining([
    'mix-settings', 'timing-calibration-status', 'play-calibration-probe', 'mix-health', 'audio-retransmit-request',
  ]));
});

test('production DOM: a capture that stops delivering audio is rebuilt as a new capture', async ({ page }) => {
  await installProductionDomHarness(page);
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window.__captureGenerations = [];
    window.addEventListener('relay-microphone-capture-generation', (event) => window.__captureGenerations.push(event.detail));
  });
  await prepareReadyMic(page);
  const [first] = await publisherRegistrations(page);

  // No more frames after the first: the capture has stalled.
  await page.waitForFunction(() => window.__relayInteractionHarness.commands
    .filter((command) => command.type === 'register' && command.role === 'publisher').length >= 2,
  null, { timeout: 15_000 });
  const [, rebuilt] = await publisherRegistrations(page);
  expect(rebuilt.captureGeneration).toBe((first.captureGeneration + 1) >>> 0);
  expect(rebuilt.initialSequence).toBe(0);
  const generations = await page.evaluate(() => window.__captureGenerations);
  expect(generations.at(-1).captureGeneration).toBe(rebuilt.captureGeneration);
});

test('production DOM: a capture that keeps delivering audio is left alone', async ({ page }) => {
  await livePhone(page);
  const [first] = await publisherRegistrations(page);
  await page.waitForTimeout(4_000);
  const registrations = await publisherRegistrations(page);
  expect(registrations).toHaveLength(1);
  expect(registrations[0].captureGeneration).toBe(first.captureGeneration);
});

test('production DOM: taking over the Mic names the owner it expects to replace', async ({ page }) => {
  await installProductionDomHarness(page);
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.relayRecordingState?.connected === true);

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('relay-request-microphone', {
    detail: { takeoverExpectedOwnerId: 'participant-bob' },
  })));
  await page.waitForFunction(() => window.__relayInteractionHarness.commands.some(
    (command) => command.type === 'register' && command.role === 'publisher',
  ), null, { timeout: 5_000 });
  const register = await page.evaluate(() => window.__relayInteractionHarness.commands
    .find((command) => command.type === 'register' && command.role === 'publisher'));
  expect(register.takeoverExpectedOwnerId).toBe('participant-bob');
});

test('production DOM: releasing the Mic tells the Relay and ends the session', async ({ page }) => {
  await livePhone(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('relay-release-microphone')));
  await page.waitForFunction(() => window.__microphoneEnded.includes('released'), null, { timeout: 5_000 });
  expect(await countOf(page, 'release-mic')).toBe(1);
  await expect(page.locator('#status')).toHaveText('Microphone released');
});

test('production DOM: retrying a damaged Mic keeps the Mic instead of releasing it', async ({ page }) => {
  await livePhone(page);
  const [first] = await publisherRegistrations(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('relay-retry-microphone')));
  await page.waitForFunction(() => window.__relayInteractionHarness.commands
    .filter((command) => command.type === 'register' && command.role === 'publisher').length >= 2,
  null, { timeout: 10_000 });
  expect(await countOf(page, 'release-mic')).toBe(0);
  const [, again] = await publisherRegistrations(page);
  expect(again.captureGeneration).not.toBe(first.captureGeneration);
});

test('production DOM: a backgrounded phone does not play a timing probe', async ({ page }) => {
  await livePhone(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.__relayInteractionHarness.broadcast({ type: 'play-calibration-probe', target: 'mic', requestId: 77, leadMs: 20 });
  });
  await page.waitForTimeout(600);
  expect(await probeReplies(page)).toEqual([]);
  expect(await page.evaluate(() => window.__oscillatorsCreated ?? 0)).toBe(0);
});

test('production DOM: going to the background drops a probe that had not played yet', async ({ page }) => {
  await livePhone(page);
  // The request arrives, then the page is hidden before the AudioContext has
  // resumed: that probe is no longer this page's to answer at all.
  await page.evaluate(() => {
    window.__relayInteractionHarness.broadcast({ type: 'play-calibration-probe', target: 'mic', requestId: 78, leadMs: 20 });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(600);
  expect(await probeReplies(page)).toEqual([]);
});

test('production DOM: the phone frames its audio as AudioPacket v2 on one continuous timeline', async ({ page }) => {
  await livePhone(page);
  // Past startup, where packets captured before the media path is chosen may
  // be kept for repair rather than sent.
  await page.waitForTimeout(1_000);
  const [registration] = await publisherRegistrations(page);
  const packets = await page.evaluate(() => window.__relayInteractionHarness.packets
    .filter((packet) => packet.socketKind === 'publisher').slice(-10));
  expect(packets).toHaveLength(10);

  for (const packet of packets) {
    expect(packet).toMatchObject({
      magic: 0x4c52, version: 2, source: 1, generation: registration.captureGeneration,
    });
  }
  for (let index = 1; index < packets.length; index += 1) {
    expect(packets[index].sequence).toBe(packets[index - 1].sequence + 1);
    expect(packets[index].firstSampleIndex)
      .toBe(packets[index - 1].firstSampleIndex + packets[index - 1].sampleCount);
  }
});

test('production DOM: audio lost while the connection is down leaves a hole in the timeline', async ({ page }) => {
  await livePhone(page);
  await page.waitForFunction(() => window.__relayInteractionHarness.packets
    .filter((packet) => packet.socketKind === 'publisher').length >= 5, null, { timeout: 5_000 });

  // The replacement connection takes a while to open; audio captured
  // meanwhile cannot be sent.
  await page.evaluate(() => {
    window.__relayInteractionHarness.holdSocketOpens();
    window.__relayInteractionHarness.closeSockets('publisher');
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__relayInteractionHarness.releaseSocketOpens());
  await page.waitForFunction(() => window.__relayInteractionHarness.commands
    .filter((command) => command.type === 'register' && command.role === 'publisher').length === 2,
  null, { timeout: 10_000 });
  await page.waitForFunction(() => window.__relayInteractionHarness.commands.some(
    (command) => command.type === 'audio-uplink-health' && command.droppedSamples?.disconnected > 0,
  ), null, { timeout: 5_000 });
  await page.waitForTimeout(300);

  const packets = await page.evaluate(() => window.__relayInteractionHarness.packets
    .filter((packet) => packet.socketKind === 'publisher'));
  const health = await page.evaluate(() => window.__relayInteractionHarness.commands
    .findLast((command) => command.type === 'audio-uplink-health'));
  // The capture timeline jumps over exactly the audio that did not go out
  // (as the health report counts it), so later audio is never pulled earlier.
  // Packets kept for repair are part of that audio and still spend their
  // sequence numbers, so the Relay can see them missing and ask for them.
  let skippedSamples = 0;
  let keptSamples = 0;
  for (let index = 1; index < packets.length; index += 1) {
    const previous = packets[index - 1];
    skippedSamples += packets[index].firstSampleIndex - (previous.firstSampleIndex + previous.sampleCount);
    keptSamples += (packets[index].sequence - previous.sequence - 1) * previous.sampleCount;
  }
  expect(health.droppedSamples.disconnected).toBeGreaterThan(0);
  expect(skippedSamples).toBe(health.droppedSamples.disconnected);
  expect(keptSamples).toBeGreaterThan(0);
  expect(keptSamples).toBeLessThanOrEqual(skippedSamples);
});

test('production DOM: a missing Mic input is reported at once and rebuilds the capture', async ({ page }) => {
  await livePhone(page);
  await page.waitForFunction(() => window.__relayInteractionHarness.commands.some(
    (command) => command.type === 'audio-uplink-health',
  ), null, { timeout: 5_000 });
  const [first] = await publisherRegistrations(page);

  const reportedAt = await page.evaluate(() => {
    window.__relayInteractionHarness.emitCaptureMessage({
      type: 'input-gap', samples: 4_800, quanta: 37, recovered: false,
    });
    return performance.now();
  });
  await page.waitForFunction(() => window.__relayInteractionHarness.commands.some(
    (command) => command.type === 'audio-uplink-health' && command.inputGapActive === true,
  ), null, { timeout: 2_000 });
  const report = await page.evaluate(() => window.__relayInteractionHarness.commands
    .find((command) => command.type === 'audio-uplink-health' && command.inputGapActive === true));
  // Straight away, not at the next one-second health tick, so the Relay can
  // fail the Mic closed at once.
  expect(report.at - reportedAt).toBeLessThan(200);
  expect(report.inputGapSamples).toBe(4_800);
  expect(report.captureGeneration).toBe(first.captureGeneration);

  // A missing input channel is positive evidence the capture is broken.
  await page.waitForFunction(() => window.__relayInteractionHarness.commands
    .filter((command) => command.type === 'register' && command.role === 'publisher').length >= 2,
  null, { timeout: 5_000 });
  const [, rebuilt] = await publisherRegistrations(page);
  expect(rebuilt.captureGeneration).toBe((first.captureGeneration + 1) >>> 0);
});

test('production DOM: exact digital silence is not counted as a missing Mic input', async ({ page }) => {
  await livePhone(page);
  const [first] = await publisherRegistrations(page);
  await page.evaluate(() => window.__relayInteractionHarness.emitCaptureMessage({
    type: 'input-gap', reason: 'digital-silence', samples: 4_800, quanta: 37, recovered: false,
  }));
  await page.waitForTimeout(1_500);
  const health = await page.evaluate(() => window.__relayInteractionHarness.commands
    .findLast((command) => command.type === 'audio-uplink-health'));
  expect(health.inputGapSamples).toBe(0);
  expect(health.inputGapActive).toBe(false);
  // A headset noise gate can render exact zeros on a healthy track: no rebuild.
  expect(await publisherRegistrations(page)).toEqual([first]);
});

async function deviceChange(page, { inputDeviceId, audioInputs, enumerateFails } = {}) {
  await page.evaluate(({ inputDeviceId, audioInputs, enumerateFails }) => {
    if (inputDeviceId !== undefined) window.__inputDeviceId = inputDeviceId;
    if (audioInputs !== undefined) window.__audioInputs = audioInputs;
    if (enumerateFails !== undefined) window.__enumerateDevicesFails = enumerateFails;
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  }, { inputDeviceId, audioInputs, enumerateFails });
}

test('production DOM: the same track moved to another input is a new capture, not a lost Mic', async ({ page }) => {
  await livePhone(page);
  const [first] = await publisherRegistrations(page);
  // Earphones plugged in: the browser routes the live track from mic-a to mic-b.
  await deviceChange(page, {
    inputDeviceId: 'mic-b',
    audioInputs: [{ kind: 'audioinput', deviceId: 'mic-a' }, { kind: 'audioinput', deviceId: 'mic-b' }],
  });
  await page.waitForFunction(() => window.__relayInteractionHarness.commands
    .filter((command) => command.type === 'register' && command.role === 'publisher').length >= 2,
  null, { timeout: 5_000 });
  const [, rebuilt] = await publisherRegistrations(page);
  expect(rebuilt.captureGeneration).toBe((first.captureGeneration + 1) >>> 0);
  expect(await page.evaluate(() => window.__microphoneEnded)).toEqual([]);
});

test('production DOM: an input that really disappeared ends the session but keeps the Mic', async ({ page }) => {
  await livePhone(page);
  await deviceChange(page, { audioInputs: [{ kind: 'audioinput', deviceId: 'mic-other' }] });
  await page.waitForFunction(() => window.__microphoneEnded.includes('input-device-removed'), null, { timeout: 5_000 });
  await expect(page.locator('#status')).toHaveText('Microphone interrupted');
  // Pulled-out hardware is not the singer giving up the room's Mic.
  expect(await countOf(page, 'release-mic')).toBe(0);
});

test('production DOM: an empty or failed device list is not taken as a removed input', async ({ page }) => {
  await livePhone(page);
  const [first] = await publisherRegistrations(page);
  await deviceChange(page, { audioInputs: [] });
  await page.waitForTimeout(400);
  await deviceChange(page, { audioInputs: [{ kind: 'audioinput', deviceId: 'mic-a' }], enumerateFails: true });
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__microphoneEnded)).toEqual([]);
  expect(await publisherRegistrations(page)).toEqual([first]);
});

test('production DOM: another input appearing leaves the live Mic alone', async ({ page }) => {
  await livePhone(page);
  const [first] = await publisherRegistrations(page);
  await deviceChange(page, {
    audioInputs: [{ kind: 'audioinput', deviceId: 'mic-a' }, { kind: 'audioinput', deviceId: 'usb-mic' }],
  });
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__microphoneEnded)).toEqual([]);
  expect(await publisherRegistrations(page)).toEqual([first]);
});

test('production DOM: a failed capture processor is rebuilt as a new capture', async ({ page }) => {
  await livePhone(page);
  const [first] = await publisherRegistrations(page);
  await page.evaluate(() => window.__relayInteractionHarness.failCaptureProcessor());
  await page.waitForFunction(() => window.__relayInteractionHarness.commands
    .filter((command) => command.type === 'register' && command.role === 'publisher').length >= 2,
  null, { timeout: 5_000 });
  const [, rebuilt] = await publisherRegistrations(page);
  expect(rebuilt.captureGeneration).toBe((first.captureGeneration + 1) >>> 0);
  expect(await page.evaluate(() => window.__microphoneEnded)).toEqual([]);
});

test('production DOM: a processor that fails again before fresh audio ends the session but keeps the Mic', async ({ page }) => {
  await installProductionDomHarness(page);
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window.__microphoneEnded = [];
    window.addEventListener('relay-microphone-ended', (event) => window.__microphoneEnded.push(event.detail.reason));
  });
  await prepareReadyMic(page);

  await page.evaluate(() => window.__relayInteractionHarness.failCaptureProcessor());
  await page.waitForFunction(() => window.__relayInteractionHarness.commands
    .filter((command) => command.type === 'register' && command.role === 'publisher').length >= 2,
  null, { timeout: 5_000 });
  // The replacement fails too, before it has delivered any audio: one rebuild
  // is the budget, so this one needs the singer's Retry.
  await page.evaluate(() => window.__relayInteractionHarness.failCaptureProcessor());
  await page.waitForFunction(() => window.__microphoneEnded.includes('processor-error-repeated'), null, { timeout: 5_000 });
  await expect(page.locator('#status')).toHaveText('Microphone interrupted');
  expect(await countOf(page, 'release-mic')).toBe(0);
  expect(await publisherRegistrations(page)).toHaveLength(2);
});

test('production DOM: an error from a capture processor that was already replaced changes nothing', async ({ page }) => {
  await livePhone(page);
  await page.evaluate(() => window.__relayInteractionHarness.failCaptureProcessor());
  await page.waitForFunction(() => window.__relayInteractionHarness.commands
    .filter((command) => command.type === 'register' && command.role === 'publisher').length >= 2,
  null, { timeout: 5_000 });

  await page.evaluate(() => window.__relayInteractionHarness.failRetiredCaptureProcessor());
  await page.waitForTimeout(500);
  expect(await publisherRegistrations(page)).toHaveLength(2);
  expect(await page.evaluate(() => window.__microphoneEnded)).toEqual([]);
});

test('production DOM: audio the page delivers too late is not sent and leaves its hole in place', async ({ page }) => {
  await livePhone(page);
  // The page's AudioContext has to have run longer than the stall below, and
  // the page shows at most one uplink warning per 2 s counted from page load.
  await page.waitForFunction(() => (
    window.__relayInteractionHarness.captureContextTime() > 1.5 && performance.now() > 2_100
  ), null, { timeout: 5_000 });
  const sent = await page.evaluate(() => {
    clearInterval(window.__keepCapturing);
    const harness = window.__relayInteractionHarness;
    const now = () => harness.captureContextTime();
    const chunk = (capturedAtContextTime) => harness.emitCaptureMessage({
      type: 'pcm', buffer: new ArrayBuffer(1_920), capturedAtContextTime,
    });
    const publisherPackets = () => harness.packets.filter((packet) => packet.socketKind === 'publisher');
    chunk(now());
    const before = publisherPackets().length;
    // A main-thread stall: this chunk was captured a second ago.
    chunk(now() - 1);
    const afterStale = publisherPackets().length;
    chunk(now());
    return { before, afterStale, packets: publisherPackets().slice(before - 1) };
  });
  expect(sent.afterStale).toBe(sent.before);
  const [lastFresh, nextFresh] = sent.packets;
  expect(nextFresh.firstSampleIndex - lastFresh.firstSampleIndex).toBe(2 * 960);

  await expect(page.locator('#status')).toHaveText('Microphone capture caught up to live audio');
  await page.waitForFunction(() => window.__relayInteractionHarness.commands.some((command) => (
    command.type === 'audio-uplink-health' && command.droppedSamples?.captureBacklog === 960
  )), null, { timeout: 5_000 });
});
