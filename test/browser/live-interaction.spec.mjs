import { expect, test } from '@playwright/test';

const LIVE_URL = process.env.RELAY_INTERACTION_URL ?? 'http://127.0.0.1:4173/';

test.use({ viewport: { width: 390, height: 844 } });

async function installProductionDomHarness(page) {
  await page.addInitScript(() => {
    const timeline = {};
    const commands = [];
    const sockets = [];
    let captureNode = null;
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
          queueMicrotask(() => deliver(this, currentTake));
          return;
        }

        if (message.type === 'product-status-request') {
          queueMicrotask(() => deliver(this, currentProduct));
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
          });
          return;
        }

        if (message.type === 'register' && message.role === 'monitor') {
          this.kind = 'monitor';
          queueMicrotask(() => deliver(this, { type: 'registered', role: 'monitor' }));
          return;
        }

        if (message.type === 'start-take') {
          currentTake = {
            type: 'take-status',
            lifecycle: 'recording',
            take: {
              takeId: 'interaction-take-1',
              startedAtMs: Date.now(),
            },
            history: [],
          };
          queueMicrotask(() => deliver(this, currentTake));
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
    };
  });
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
  await expect(page.locator('.take-strip')).toBeHidden();

  await page.evaluate(() => window.__relayInteractionHarness.emitSilentPcm());
  await page.waitForFunction(() => Number.isFinite(window.__relayInteractionHarness.timeline.T11));

  const timing = await page.evaluate(() => ({ ...window.__relayInteractionHarness.timeline }));
  for (const point of ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11']) {
    expect(Number.isFinite(timing[point]), `${point} should be recorded`).toBe(true);
  }
  for (let index = 1; index <= 11; index += 1) {
    expect(timing[`T${index}`]).toBeGreaterThanOrEqual(timing[`T${index - 1}`]);
  }
  expect(timing.T11 - timing.T6).toBeLessThan(300);

  const record = page.locator('#start-recording');
  await expect(record).toBeVisible();
  await expect(record).toBeEnabled();
  const slotBefore = await page.locator('.take-strip').boundingBox();
  expect(slotBefore).not.toBeNull();

  await record.click();
  await page.waitForFunction(() => window.__relayInteractionHarness.commands.some(
    (command) => command.type === 'start-take' && command.socketKind === 'recorder',
  ));
  await expect(page.locator('#stop-recording')).toBeVisible();
  await expect(page.locator('#stop-recording')).toBeEnabled();
  await expect(page.locator('#recording-status')).toContainText('●');

  const slotAfter = await page.locator('.take-strip').boundingBox();
  expect(slotAfter).not.toBeNull();
  expect(Math.abs(slotAfter.y - slotBefore.y)).toBeLessThan(1);
  expect(Math.abs(slotAfter.height - slotBefore.height)).toBeLessThan(1);
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
