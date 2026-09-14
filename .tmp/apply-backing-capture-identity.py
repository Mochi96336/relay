from pathlib import Path
import re


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one exact match, found {count}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1))


def sub_once(path: str, pattern: str, repl: str) -> None:
    p = Path(path)
    text = p.read_text()
    updated, count = re.subn(pattern, repl, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f'{path}: expected one regex match, found {count}: {pattern[:120]!r}')
    p.write_text(updated)


# AudioSession: bind-time Backing replacement authority stays source-local and
# is consumed by the first real replacement PCM, exactly like the Mic seam.
replace_once(
    'src/audio-session.ts',
    '  /** A media capture was replaced at publisher bind; consumed by its first real PCM. */\n  private micCaptureRestartPending = false;\n',
    '  /** A media capture was replaced at publisher bind; consumed by its first real PCM. */\n  private micCaptureRestartPending = false;\n  /** A Backing capture was proven replaced at registration; consumed by its first real PCM. */\n  private backingCaptureRestartPending = false;\n',
)

p = Path('src/audio-session.ts')
text = p.read_text()
needle = '    this.micCaptureRestartPending = false;\n'
if text.count(needle) != 2:
    raise SystemExit(f'src/audio-session.ts: expected stop/reset pending assignments twice, found {text.count(needle)}')
text = text.replace(needle, needle + '    this.backingCaptureRestartPending = false;\n')
p.write_text(text)

replace_once(
    'src/audio-session.ts',
    '  /** The same frontier for the captured song. See `micTotalSamples`. */\n  get backingTotalSamples() {\n    return this.backing.totalSamples;\n  }\n\n',
    '''  /** The same frontier for the captured song. See `micTotalSamples`. */\n  get backingTotalSamples() {\n    return this.backing.totalSamples;\n  }\n\n  /**\n   * Classifies a metadata-capable Backing registration against the capture\n   * clock already retained by this mix. A reconnect may be ahead because the\n   * sender keeps its source clock running while transport is down; only a\n   * rewind, generation change or source-rate change proves replacement.\n   */\n  backingCaptureReplacedBy(input: {\n    generation: number;\n    sourceRate: number;\n    sampleCursor: number;\n  }) {\n    const established = this.backing.totalSamples > 0\n      || this.backing.generation !== null\n      || this.backing.sourceRate !== null\n      || this.backing.sourceFrontier !== null;\n    if (!established) return false;\n\n    return this.backing.generation !== input.generation\n      || this.backing.sourceRate !== input.sourceRate\n      || this.backing.sourceFrontier === null\n      || input.sampleCursor < this.backing.sourceFrontier;\n  }\n\n''',
)

replace_once(
    'src/audio-session.ts',
    '''  ingestBacking(\n    frame: PcmFrame,\n    sourceRate: number | null,\n    nowMs = performance.now(),\n    trackSourceClock = false,\n  ) {\n    return this.ingest(\n      this.backing,\n      frame,\n      sourceRate,\n      nowMs,\n      trackSourceClock,\n      true,\n    );\n  }\n''',
    '''  ingestBacking(\n    frame: PcmFrame,\n    sourceRate: number | null,\n    nowMs = performance.now(),\n    trackSourceClock = false,\n  ) {\n    const result = this.ingest(\n      this.backing,\n      frame,\n      sourceRate,\n      nowMs,\n      trackSourceClock,\n      true,\n    );\n    const pendingCaptureRestart = this.backingCaptureRestartPending && result.samples.length > 0;\n    if (pendingCaptureRestart) this.backingCaptureRestartPending = false;\n    return {\n      ...result,\n      captureRestarted: result.captureRestarted || pendingCaptureRestart,\n    };\n  }\n''',
)

replace_once(
    'src/audio-session.ts',
    '''  retireMicCapture() {\n    this.clearTimeline(this.mic);\n    this.resetMicFrontierTracking();\n    this.micCaptureRestartPending = true;\n  }\n\n  clearMic() {\n''',
    '''  retireMicCapture() {\n    this.clearTimeline(this.mic);\n    this.resetMicFrontierTracking();\n    this.micCaptureRestartPending = true;\n  }\n\n  /**\n   * Retires only the captured-song clock once registration metadata has proven\n   * that the new Backing transport cannot be a continuation of the old capture.\n   * The shared mix epoch and Mic history remain intact.\n   */\n  retireBackingCapture() {\n    this.clearTimeline(this.backing);\n    this.backingCaptureRestartPending = true;\n  }\n\n  clearMic() {\n''',
)

# Activation seam: once the server has proven capture replacement, retire old
# Backing PCM synchronously before transport replacement / first new frame.
replace_once(
    'src/relay-backing-activation-coordinator.ts',
    '''export type RelayBackingActivationInput<TSocket> = {\n  socket: TSocket;\n  sampleRate: number;\n  robot: boolean;\n};\n''',
    '''export type RelayBackingActivationInput<TSocket> = {\n  socket: TSocket;\n  sampleRate: number;\n  robot: boolean;\n  captureReplaced: boolean;\n};\n''',
)
replace_once(
    'src/relay-backing-activation-coordinator.ts',
    '''  previousBacking: () => TSocket | null;\n  clearRobotContentTransition: () => void;\n  noteQualityEvent: (\n''',
    '''  previousBacking: () => TSocket | null;\n  clearRobotContentTransition: () => void;\n  retireReplacedCapture: () => void;\n  noteQualityEvent: (\n''',
)
replace_once(
    'src/relay-backing-activation-coordinator.ts',
    '''      dependencies.clearRobotContentTransition();\n      if (previousBacking && previousBacking !== input.socket) {\n''',
    '''      dependencies.clearRobotContentTransition();\n      if (input.captureReplaced) dependencies.retireReplacedCapture();\n      if (previousBacking && previousBacking !== input.socket) {\n''',
)

# Server: optional capture identity is a pair. Legacy senders that omit both
# retain old compatibility; metadata-capable senders are classified before bind.
replace_once(
    'src/server.ts',
    '''function validCaptureGeneration(value: unknown) {\n  const generation = Number(value);\n  if (!Number.isInteger(generation) || generation < 0 || generation > 0xffff_ffff) return null;\n  return generation >>> 0;\n}\n''',
    '''function validCaptureGeneration(value: unknown) {\n  const generation = Number(value);\n  if (!Number.isInteger(generation) || generation < 0 || generation > 0xffff_ffff) return null;\n  return generation >>> 0;\n}\n\nfunction validSampleCursor(value: unknown) {\n  const cursor = Number(value);\n  if (!Number.isSafeInteger(cursor) || cursor < 0) return null;\n  return cursor;\n}\n''',
)
replace_once(
    'src/server.ts',
    '''  previousBacking: () => backingRuntime.socket,\n  clearRobotContentTransition: () => clearRobotContentTransition(),\n  noteQualityEvent: (event) => takeController.noteQualityEvent(event),\n''',
    '''  previousBacking: () => backingRuntime.socket,\n  clearRobotContentTransition: () => clearRobotContentTransition(),\n  retireReplacedCapture: () => session.retireBackingCapture(),\n  noteQualityEvent: (event) => takeController.noteQualityEvent(event),\n''',
)
replace_once(
    'src/server.ts',
    '''    const sampleRate = validSampleRate(payload.sampleRate);\n    if (!sampleRate) {\n      sendJson(socket, { type: 'error', message: 'Invalid backing sample rate.' });\n      return;\n    }\n\n    commitSocketRole(socket, 'backing');\n\n    backingActivationCoordinator.activate({\n      socket,\n      sampleRate,\n      robot: payload.robot === true,\n    });\n''',
    '''    const sampleRate = validSampleRate(payload.sampleRate);\n    if (!sampleRate) {\n      sendJson(socket, { type: 'error', message: 'Invalid backing sample rate.' });\n      return;\n    }\n\n    const hasCaptureGeneration = Object.prototype.hasOwnProperty.call(payload, 'captureGeneration');\n    const hasCaptureSampleCursor = Object.prototype.hasOwnProperty.call(payload, 'captureSampleCursor');\n    if (hasCaptureGeneration !== hasCaptureSampleCursor) {\n      sendJson(socket, {\n        type: 'error',\n        message: 'Backing capture identity requires generation and sample cursor together.',\n      });\n      return;\n    }\n\n    let captureReplaced = false;\n    if (hasCaptureGeneration) {\n      const captureGeneration = validCaptureGeneration(payload.captureGeneration);\n      const captureSampleCursor = validSampleCursor(payload.captureSampleCursor);\n      if (captureGeneration === null || captureSampleCursor === null) {\n        sendJson(socket, { type: 'error', message: 'Invalid backing capture identity.' });\n        return;\n      }\n      captureReplaced = session.backingCaptureReplacedBy({\n        generation: captureGeneration,\n        sourceRate: sampleRate,\n        sampleCursor: captureSampleCursor,\n      });\n    }\n\n    commitSocketRole(socket, 'backing');\n\n    backingActivationCoordinator.activate({\n      socket,\n      sampleRate,\n      robot: payload.robot === true,\n      captureReplaced,\n    });\n''',
)

# Both production Backing senders already own the capture clock and cursor.
replace_once(
    'src/backing-stdin.ts',
    '''        role: 'backing',\n        sampleRate: SAMPLE_RATE,\n        robot: ROBOT_BACKING,\n''',
    '''        role: 'backing',\n        sampleRate: SAMPLE_RATE,\n        robot: ROBOT_BACKING,\n        captureGeneration: generation,\n        captureSampleCursor: sampleCursor,\n''',
)
replace_once(
    'chrome-tab-audio-probe/offscreen.js',
    '''        role: 'backing',\n        sampleRate: audioContext.sampleRate,\n''',
    '''        role: 'backing',\n        sampleRate: audioContext.sampleRate,\n        captureGeneration,\n        captureSampleCursor,\n''',
)

# Existing coordinator fixture must expose the new ordering dependency and fact.
replace_once(
    'test/relay-backing-activation-coordinator.test.ts',
    "    clearRobotContentTransition: () => events.push('clear-boundary'),\n    noteQualityEvent: (event) => events.push(`quality:${event}`),\n",
    "    clearRobotContentTransition: () => events.push('clear-boundary'),\n    retireReplacedCapture: () => events.push('retire-capture'),\n    noteQualityEvent: (event) => events.push(`quality:${event}`),\n",
)
p = Path('test/relay-backing-activation-coordinator.test.ts')
text = p.read_text()
text, count = re.subn(
    r"coordinator\.activate\(\{ socket: ('(?:new|same)'), sampleRate: ([0-9_]+), robot: (true|false) \}\);",
    r"coordinator.activate({ socket: \1, sampleRate: \2, robot: \3, captureReplaced: false });",
    text,
)
if count != 3:
    raise SystemExit(f'activation test: expected three activate calls, found {count}')
text += '''\n\ntest('proven Backing capture replacement retires old PCM before transport retirement and bind', () => {\n  const { coordinator, events } = coordinatorFixture({\n    previous: 'old',\n    active: true,\n    activeRobot: false,\n  });\n\n  coordinator.activate({\n    socket: 'new',\n    sampleRate: 48_000,\n    robot: false,\n    captureReplaced: true,\n  });\n\n  assert.ok(events.indexOf('retire-capture') > events.indexOf('clear-boundary'));\n  assert.ok(events.indexOf('retire-capture') < events.indexOf('retire:old->new'));\n  assert.ok(events.indexOf('retire-capture') < events.indexOf('bind:new:48000:false'));\n});\n'''
p.write_text(text)

# New regression: transport metadata distinguishes a real rewind from the
# legitimate same-capture reconnect that keeps its cursor moving forward.
Path('test/backing-capture-registration.test.ts').write_text(r'''import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { AudioSession } from '../src/audio-session.js';

const RATE = 48_000;

function pcm(value: number, samples = 960) {
  const buffer = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) buffer.writeInt16LE(value, index * 2);
  return buffer;
}

function frame(generation: number, firstSampleIndex: number, value: number) {
  return { generation, firstSampleIndex, pcm: pcm(value) };
}

test('Backing registration metadata preserves continuation but detects same-id cursor rewind', () => {
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: 20,
    prebufferMs: 0,
    backingGain: 0.65,
    retentionMs: 3_000,
  });
  session.start(0);
  session.ingestMic(frame(2, 0, 222), RATE, 0);
  session.ingestBacking(frame(7, 0, 111), RATE, 100);
  session.ingestBacking(frame(7, 960, 111), RATE, 120);

  assert.equal(session.backingCaptureReplacedBy({
    generation: 7,
    sourceRate: RATE,
    sampleCursor: 1_920,
  }), false, 'same capture reconnect may resume at or ahead of the stored source frontier');
  assert.equal(session.backingCaptureReplacedBy({
    generation: 7,
    sourceRate: RATE,
    sampleCursor: 0,
  }), true, 'rewinding the same numeric capture identity proves a replacement at transport bind');
  assert.equal(session.backingCaptureReplacedBy({
    generation: 8,
    sourceRate: RATE,
    sampleCursor: 1_920,
  }), true);
  assert.equal(session.backingCaptureReplacedBy({
    generation: 7,
    sourceRate: 44_100,
    sampleCursor: 1_920,
  }), true);
});

test('proven Backing replacement retires only Backing and reports restart on first real PCM', () => {
  const session = new AudioSession({
    sampleRate: RATE,
    frameMs: 20,
    prebufferMs: 0,
    backingGain: 0.65,
    retentionMs: 3_000,
  });
  session.start(0);
  session.ingestMic(frame(2, 0, 222), RATE, 0);
  session.ingestBacking(frame(7, 0, 111), RATE, 100);
  const mixGeneration = session.generation;

  session.retireBackingCapture();
  assert.equal(session.backingGeneration, null);
  assert.equal(session.micGeneration, 2);
  assert.equal(session.generation, mixGeneration);
  assert.equal(session.readMic(0, 1)[0], 222);

  const replacement = session.ingestBacking(frame(7, 0, 333), RATE, 500);
  assert.equal(replacement.samples.length, 960);
  assert.equal(replacement.captureRestarted, true);
  assert.equal(session.generation, mixGeneration);
  assert.equal(session.micGeneration, 2);

  const continuation = session.ingestBacking(frame(7, 960, 444), RATE, 520);
  assert.equal(continuation.captureRestarted, false, 'bind-time restart fact is one-shot');
});

test('production Backing senders publish capture generation and cursor at registration', () => {
  const stdin = readFileSync(new URL('../src/backing-stdin.ts', import.meta.url), 'utf8');
  const offscreen = readFileSync(new URL('../chrome-tab-audio-probe/offscreen.js', import.meta.url), 'utf8');
  assert.match(stdin, /captureGeneration: generation/);
  assert.match(stdin, /captureSampleCursor: sampleCursor/);
  assert.match(offscreen, /captureGeneration,/);
  assert.match(offscreen, /captureSampleCursor,/);
});

test('server validates capture metadata as a pair and retires only proven replacement PCM', () => {
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(server, /hasCaptureGeneration !== hasCaptureSampleCursor/);
  assert.match(server, /validCaptureGeneration\(payload\.captureGeneration\)/);
  assert.match(server, /validSampleCursor\(payload\.captureSampleCursor\)/);
  assert.match(server, /session\.backingCaptureReplacedBy\(\{/);
  assert.match(server, /retireReplacedCapture: \(\) => session\.retireBackingCapture\(\)/);
  assert.match(server, /captureReplaced,/);
});
''')

print('backing capture identity patch applied')
