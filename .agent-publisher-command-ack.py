from pathlib import Path

app_path = Path('public/app.js')
app = app_path.read_text()


def replace_once(old: str, new: str, label: str) -> None:
    global app
    count = app.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    app = app.replace(old, new, 1)


replace_once(
    "import { authorityState } from './authority-freshness.js';\n",
    "import { authorityState } from './authority-freshness.js';\nimport { PublisherCommandLiveness } from './publisher-command-liveness.js';\n",
    'liveness import',
)
replace_once(
    "const micLifecycle = new MicLifecycleTransaction();\nlet liveMixActive = false;\n",
    "const micLifecycle = new MicLifecycleTransaction();\nconst publisherCommandLiveness = new PublisherCommandLiveness();\nlet publishedPublisherCommandChannelFresh = false;\nlet liveMixActive = false;\n",
    'liveness instance',
)
replace_once(
    "function sendAudioUplinkHealth() {\n  if (!publisherActive || socket?.readyState !== WebSocket.OPEN) return false;\n  return audioTransport.sendControlJson(audioUplinkHealthPayload()).sent;\n}\n",
    "function sendAudioUplinkHealth() {\n  maintainPublisherCommandChannel();\n  if (!publisherActive || socket?.readyState !== WebSocket.OPEN) return false;\n  return audioTransport.sendControlJson(audioUplinkHealthPayload()).sent;\n}\n",
    'health maintenance',
)

old_authority = """function publisherCommandAuthority(serverAllowed = true) {
  return authorityState({
    authorityFresh: publisherAuthorityFresh
      && publisherMixSettingsFresh
      && publisherSourceStatusFresh,
    lastKnownSnapshot: lastKnownControlSnapshot,
    commandChannelFresh: socket?.readyState === WebSocket.OPEN,
    authorized: publisherActive,
    serverAllowed,
  });
}

function publishPublisherCommandAuthority() {
  const detail = publisherCommandAuthority();
  window.relayCommandAuthority = detail;
  dispatchRelayEvent('relay-command-authority', detail);
  return detail;
}
"""
new_authority = """function publisherCommandChannelFresh(nowMs = performance.now()) {
  return socket?.readyState === WebSocket.OPEN
    && publisherCommandLiveness.status(nowMs).fresh;
}

function publisherCommandAuthority(serverAllowed = true) {
  return authorityState({
    authorityFresh: publisherAuthorityFresh
      && publisherMixSettingsFresh
      && publisherSourceStatusFresh,
    lastKnownSnapshot: lastKnownControlSnapshot,
    commandChannelFresh: publisherCommandChannelFresh(),
    authorized: publisherActive,
    serverAllowed,
  });
}

function publishPublisherCommandAuthority() {
  const detail = publisherCommandAuthority();
  publishedPublisherCommandChannelFresh = detail.commandChannelFresh;
  window.relayCommandAuthority = detail;
  dispatchRelayEvent('relay-command-authority', detail);
  return detail;
}

function refreshPublisherCommandChannel() {
  const fresh = publisherCommandChannelFresh();
  if (fresh === publishedPublisherCommandChannelFresh) return fresh;
  publishPublisherCommandAuthority();
  updateSingerControls();
  return fresh;
}

function maintainPublisherCommandChannel() {
  const state = publisherCommandLiveness.status(performance.now());
  if (
    state.reconnect
    && publisherActive
    && socket?.readyState === WebSocket.OPEN
  ) {
    publishPublisherCommandAuthority();
    updateSingerControls();
    setStatus(
      'Reconnecting microphone…',
      'Relay control acknowledgement stopped; restarting the control connection.',
    );
    const staleSocket = socket;
    try {
      staleSocket.close(4000, 'publisher command ack stale');
    } catch {
      try { staleSocket.close(); } catch {}
    }
    return false;
  }
  return refreshPublisherCommandChannel();
}
"""
replace_once(old_authority, new_authority, 'authority block')

replace_once(
    "  if (message.type === 'command-rejected') {\n",
    """  if (message.type === 'audio-uplink-health-ack') {
    const ackGeneration = message.captureGeneration;
    if (
      message.version !== 1
      || !Number.isInteger(ackGeneration)
      || ackGeneration < 0
      || ackGeneration > 0xffff_ffff
      || (ackGeneration >>> 0) !== (expectedGeneration >>> 0)
      || !isCurrentPublisherCapture(sessionEpoch, expectedGeneration)
      || !publisherCommandLiveness.noteAck(ackGeneration, performance.now())
    ) return;
    refreshPublisherCommandChannel();
    return;
  }

  if (message.type === 'command-rejected') {
""",
    'ACK handler',
)
replace_once(
    "function adoptSocket(ws) {\n  const previous = socket;\n  socket = ws;\n  resetPublisherCommandFreshness();\n",
    "function adoptSocket(ws) {\n  const previous = socket;\n  socket = ws;\n  publisherCommandLiveness.reset();\n  resetPublisherCommandFreshness();\n",
    'socket adoption reset',
)
replace_once(
    "  ws.send(JSON.stringify(registration));\n  audioTransport.bind(ws, { sampleRate: audioContext.sampleRate });\n  publisherControlConnections += 1;\n",
    "  ws.send(JSON.stringify(registration));\n  audioTransport.bind(ws, { sampleRate: audioContext.sampleRate });\n  publisherCommandLiveness.begin(expectedGeneration, performance.now());\n  refreshPublisherCommandChannel();\n  publisherControlConnections += 1;\n",
    'socket liveness begin',
)
replace_once(
    "    audioTransport.unbind(ws);\n    socket = null;\n    resetPublisherCommandFreshness();\n",
    "    audioTransport.unbind(ws);\n    socket = null;\n    publisherCommandLiveness.reset();\n    resetPublisherCommandFreshness();\n",
    'socket close reset',
)
replace_once(
    "    audioTransport.unbind(previous);\n    socket = null;\n    resetPublisherCommandFreshness();\n",
    "    audioTransport.unbind(previous);\n    socket = null;\n    publisherCommandLiveness.reset();\n    resetPublisherCommandFreshness();\n",
    'generation restart reset',
)
replace_once(
    "  socket = null;\n  resetPublisherCommandFreshness();\n  mediaStream = null;\n",
    "  socket = null;\n  publisherCommandLiveness.reset();\n  resetPublisherCommandFreshness();\n  mediaStream = null;\n",
    'stop reset',
)
app_path.write_text(app)

Path('public/publisher-command-liveness.js').write_text("""export const DEFAULT_PUBLISHER_COMMAND_ACK_FRESH_MS = 3_000;
export const DEFAULT_PUBLISHER_COMMAND_RECONNECT_MS = 4_000;

function uint32(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 0xffff_ffff
    ? number >>> 0
    : null;
}

export class PublisherCommandLiveness {
  constructor({
    freshMs = DEFAULT_PUBLISHER_COMMAND_ACK_FRESH_MS,
    reconnectMs = DEFAULT_PUBLISHER_COMMAND_RECONNECT_MS,
  } = {}) {
    if (!Number.isFinite(freshMs) || freshMs <= 0) {
      throw new Error('Publisher command freshMs must be positive.');
    }
    if (!Number.isFinite(reconnectMs) || reconnectMs <= freshMs) {
      throw new Error('Publisher command reconnectMs must be greater than freshMs.');
    }
    this.freshMs = freshMs;
    this.reconnectMs = reconnectMs;
    this.reset();
  }

  reset() {
    this.generation = null;
    this.startedAtMs = -Infinity;
    this.lastAckAtMs = -Infinity;
  }

  begin(generation, nowMs) {
    const normalizedGeneration = uint32(generation);
    if (normalizedGeneration === null) throw new Error('Publisher command generation must be a uint32.');
    if (!Number.isFinite(nowMs)) throw new Error('Publisher command begin time must be finite.');
    this.generation = normalizedGeneration;
    this.startedAtMs = nowMs;
    this.lastAckAtMs = -Infinity;
  }

  noteAck(generation, nowMs) {
    const normalizedGeneration = uint32(generation);
    if (
      this.generation === null
      || normalizedGeneration === null
      || normalizedGeneration !== this.generation
      || !Number.isFinite(nowMs)
    ) return false;
    this.lastAckAtMs = nowMs;
    return true;
  }

  status(nowMs) {
    if (!Number.isFinite(nowMs)) throw new Error('Publisher command observation time must be finite.');
    if (this.generation === null || !Number.isFinite(this.startedAtMs)) {
      return { fresh: false, reconnect: false, ackAgeMs: null };
    }
    const acknowledged = Number.isFinite(this.lastAckAtMs);
    const referenceAt = acknowledged ? this.lastAckAtMs : this.startedAtMs;
    const ageMs = Math.max(0, nowMs - referenceAt);
    return {
      fresh: acknowledged && ageMs < this.freshMs,
      reconnect: ageMs >= this.reconnectMs,
      ackAgeMs: acknowledged ? Math.round(ageMs) : null,
    };
  }
}
""")

Path('test/publisher-command-liveness.test.ts').write_text("""import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PUBLISHER_COMMAND_ACK_FRESH_MS,
  DEFAULT_PUBLISHER_COMMAND_RECONNECT_MS,
  PublisherCommandLiveness,
} from '../public/publisher-command-liveness.js';

test('publisher command channel stays stale until a current-generation ACK', () => {
  const liveness = new PublisherCommandLiveness();
  liveness.begin(7, 1_000);
  assert.deepEqual(liveness.status(1_000), { fresh: false, reconnect: false, ackAgeMs: null });
  assert.equal(liveness.status(1_000 + DEFAULT_PUBLISHER_COMMAND_RECONNECT_MS).reconnect, true);
});

test('current-generation ACK expires before reconnect deadline', () => {
  const liveness = new PublisherCommandLiveness();
  liveness.begin(11, 500);
  assert.equal(liveness.noteAck(11, 1_000), true);
  assert.equal(liveness.status(1_000 + DEFAULT_PUBLISHER_COMMAND_ACK_FRESH_MS - 1).fresh, true);
  assert.equal(liveness.status(1_000 + DEFAULT_PUBLISHER_COMMAND_ACK_FRESH_MS).fresh, false);
  assert.equal(liveness.status(1_000 + DEFAULT_PUBLISHER_COMMAND_RECONNECT_MS).reconnect, true);
});

test('wrong-generation ACK cannot revive a replacement capture', () => {
  const liveness = new PublisherCommandLiveness();
  liveness.begin(21, 1_000);
  assert.equal(liveness.noteAck(20, 1_100), false);
  assert.equal(liveness.status(1_100).fresh, false);
  assert.equal(liveness.noteAck(21, 1_200), true);
  assert.equal(liveness.status(1_200).fresh, true);
  liveness.begin(22, 1_300);
  assert.equal(liveness.noteAck(21, 1_400), false);
  assert.equal(liveness.status(1_400).fresh, false);
});

test('reset revokes command freshness without creating a reconnect', () => {
  const liveness = new PublisherCommandLiveness();
  liveness.begin(3, 100);
  liveness.noteAck(3, 150);
  liveness.reset();
  assert.deepEqual(liveness.status(100_000), { fresh: false, reconnect: false, ackAgeMs: null });
});
""")

test_path = Path('test/ui-authority-freshness.test.ts')
source = test_path.read_text()
anchor = """  assert.match(
    publisherSource,
    /authorityFresh: publisherAuthorityFresh\\s*&& publisherMixSettingsFresh\\s*&& publisherSourceStatusFresh/,
  );
"""
addition = anchor + """  assert.match(publisherSource, /commandChannelFresh: publisherCommandChannelFresh\\(\\)/);
  assert.doesNotMatch(
    publisherSource,
    /commandChannelFresh: socket\\?\\.readyState === WebSocket\\.OPEN/,
    'OPEN alone must never be publisher command freshness',
  );
  assert.match(
    publisherSource,
    /message\\.type === 'audio-uplink-health-ack'[\\s\\S]*publisherCommandLiveness\\.noteAck\\(ackGeneration, performance\\.now\\(\\)\\)[\\s\\S]*refreshPublisherCommandChannel\\(\\)/,
  );
  assert.match(
    publisherSource,
    /publisherCommandLiveness\\.begin\\(expectedGeneration, performance\\.now\\(\\)\\)/,
  );
  assert.match(
    publisherSource,
    /function sendAudioUplinkHealth\\(\\) \\{[\\s\\S]*maintainPublisherCommandChannel\\(\\)/,
  );
  assert.match(
    publisherSource,
    /state\\.reconnect[\\s\\S]*staleSocket\\.close\\(4000, 'publisher command ack stale'\\)/,
  );
"""
if source.count(anchor) != 1:
    raise SystemExit('ui authority anchor mismatch')
test_path.write_text(source.replace(anchor, addition, 1))
