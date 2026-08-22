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
    const sockets = [];
    let captureNode = null;
    let recorderReplayDelayMs = 0;
    let startResponseDelayMs = 20;
    let currentTake = {
      type: 'take-status',
      lifecycle: 'idle',
      take: null,
      history: [],
    };
    let revision = 1;

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
        sockets.push(this);
        queueMicrotask(() => {
          if (this.readyState !== FakeWebSocket.CONNECTING) return;
          this.readyState = FakeWebSocket.OPEN;
          this.dispatchEvent(new Event('open'));
        });
      }

      send(data) {
        if (this.readyState !== FakeWebSocket.OPEN) {
          throw new DOMException('WebSocket is not open', 'InvalidStateError');
        }

        if (typeof data !== 'string') {
          if (this.kind !== 'publisher') return;
          mark('T5');
          setTimeout(() => {
            mark('T6');
            mark('T7');
            currentProduct = productStatus({ mic: 'live', canStartTake: true });
            mark('T8');
            // Model the production ProductStatus cadence. The browser receives
            // no optimistic state: the authoritative transition is broadcast
            // only at the next 250 ms status opportunity.
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
            // Production registration replays these as separate authoritative
            // messages after `registered`. Registration opens the command
            // channel, but controls remain stale until both snapshots arrive.
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
        this.name = name;
        this.port = {
          onmessage: null,
          postMessage() {},
        };
        if (name === 'capture-processor') captureNode = this;
      }
    }

    class FakeAudioContext extends EventTarget {
      constructor() {
        super();
        this.sampleRate = 48_000;
        this.state = 'running';
        this.currentTime = 0;
        this.destination = new FakeAudioNode();
        this.audioWorklet = {
          addModule: async (url) => {
            if (String(url).includes('capture-worklet')) mark('T2');
          },
        };
      }

      async resume() { this.state = 'running'; }
      async close() { this.state = 'closed'; }
      createMediaStreamSource() { return new FakeAudioNode(); }
      createGain() { return new FakeGainNode(); }
      createOscillator() {
        const node = new FakeAudioNode();
        node.frequency = { value: 0 };
        node.start = () => {};
        node.stop = () => {};
        return node;
      }
    }

    const track = new EventTarget();
    track.muted = false;
    track.stop = () => {};
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    };

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          await Promise.resolve();
          mark('T1');
          return stream;
        },
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
      mark,
      emitSilentPcm() {
        if (!captureNode?.port?.onmessage) throw new Error('capture worklet is not ready');
        captureNode.port.onmessage({ data: new ArrayBuffer(1_920) });
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
  await expect(page.locator('#live-state-detail')).toHaveText('Waiting for the first audio frame from this phone.');
  await page.evaluate(() => window.__relayInteractionHarness.emitSilentPcm());
  await page.waitForFunction(() => window.relayRecordingState?.canStart === true);
  await expect(page.locator('#live-state-title')).toHaveText('You’re live');
}

test('production DOM: Mic readiness arms Record, Record morphs to Stop in the same slot', async ({ page }) => {
  await installProductionDomHarness(page);
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });

  await page.waitForFunction(() => window.relayRecordingState?.connected === true);
  await expect(page.locator('.take-strip')).toBeHidden();

  await page.evaluate(() => window.__relayInteractionHarness.mark('T0'));
  await page.locator('#start-publisher').click();
  await page.waitForFunction(() => Number.isFinite(window.__relayInteractionHarness.timeline.T4));

  // Publisher ownership alone is not recording readiness. Until a real PCM
  // frame reaches the server model, there is no disabled placeholder action.
  await expect(page.locator('#live-state-title')).toHaveText('Starting your mic…');
  await expect(page.locator('#live-state-detail')).toHaveText('Waiting for the first audio frame from this phone.');
  await expect(page.locator('.take-strip')).toBeHidden();

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

  const strip = page.locator('.take-strip');
  const record = page.locator('#start-recording');
  const stop = page.locator('#stop-recording');
  await expect(record).toBeVisible();
  await expect(record).toBeEnabled();
  const slotBefore = await strip.boundingBox();
  expect(slotBefore).not.toBeNull();

  await record.click();
  await page.waitForFunction(() => window.__relayInteractionHarness.commands.some(
    (command) => command.type === 'start-take' && command.socketKind === 'recorder',
  ));
  await expect(stop).toBeVisible();
  await expect(stop).toBeEnabled();
  await expect(page.locator('#recording-status')).toContainText('●');

  const slotAfter = await strip.boundingBox();
  const stopBox = await stop.boundingBox();
  expect(slotAfter).not.toBeNull();
  expect(stopBox).not.toBeNull();
  expect(Math.abs(slotAfter.y - slotBefore.y)).toBeLessThan(1);
  expect(Math.abs(slotAfter.height - slotBefore.height)).toBeLessThan(1);
  expect(Math.abs((stopBox.x + stopBox.width) - (slotAfter.x + slotAfter.width))).toBeLessThan(2);

  // Disconnecting the recorder must immediately remove Stop; the recording
  // lifecycle may remain visible, but stale socket state cannot leave an action
  // clickable. A fresh TakeStatus replay restores Stop after reconnect.
  await page.evaluate(() => window.__relayInteractionHarness.disconnectRecorder({
    mic: 'live',
    canStartTake: false,
    replayDelayMs: 160,
  }));
  await page.waitForFunction(() => window.relayRecordingState?.connected === false);
  await expect(stop).toBeHidden();
  await page.waitForFunction(() => window.relayRecordingState?.connected === true
    && window.relayRecordingState?.takeStatusFresh === false);
  await expect(stop).toBeHidden();
  await page.waitForFunction(() => window.relayRecordingState?.takeStatusFresh === true);
  await expect(stop).toBeVisible();
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

  // Desktop playback handoff snapshots can briefly leave holder while the
  // same song remains authoritative. That refresh must not consume a click.
  await publishPlayback('preparing', 'abcdefghijk', 'preparing');
  await expect(form).toBeHidden();
  await publishPlayback('holder', 'abcdefghijk');
  await expect(form).toBeVisible();
  await expect(change).toHaveText('Done');

  // A genuinely different song ends the local edit session.
  await publishPlayback('holder', 'lmnopqrstuv');
  await expect(form).toBeHidden();
  await expect(change).toHaveText('Change song');
});

test('production DOM: recorder reconnect cannot replay stale Record authority', async ({ page }) => {
  await installProductionDomHarness(page);
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });
  await prepareReadyMic(page);

  const record = page.locator('#start-recording');
  await expect(record).toBeVisible();
  await expect(record).toBeEnabled();

  await page.evaluate(() => window.__relayInteractionHarness.disconnectRecorder({
    mic: 'free',
    canStartTake: false,
    replayDelayMs: 180,
  }));
  await page.waitForFunction(() => window.relayRecordingState?.connected === false);
  await expect(record).toBeHidden();

  // This is the old bug window: the new socket is OPEN, but its authoritative
  // replays have intentionally not arrived yet. Record must stay absent instead
  // of reusing canStartTake=true from the previous socket generation.
  await page.waitForFunction(() => window.relayRecordingState?.connected === true
    && window.relayRecordingState?.productStatusFresh === false
    && window.relayRecordingState?.takeStatusFresh === false);
  await expect(record).toBeHidden();

  await page.waitForFunction(() => window.relayRecordingState?.productStatusFresh === true
    && window.relayRecordingState?.takeStatusFresh === true);
  await expect(record).toBeHidden();
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

test('production DOM: More and System are reachable only through real clicks', async ({ page }) => {
  await installProductionDomHarness(page);
  await page.route('https://www.youtube.com/**', (route) => route.abort());
  await page.goto(LIVE_URL, { waitUntil: 'domcontentloaded' });

  const more = page.locator('#room-more');
  const system = page.locator('#system-panel');

  await page.locator('#room-more > summary').click();
  expect(await more.evaluate((node) => node.open)).toBe(true);

  await page.locator('#open-system').click();
  expect(await system.evaluate((node) => node.open)).toBe(true);
  expect(await more.evaluate((node) => node.open)).toBe(false);

  await page.locator('#close-system').click();
  expect(await system.evaluate((node) => node.open)).toBe(false);
});
