from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: {label}: expected one match, found {count}')
    target.write_text(text.replace(old, new, 1))


replace_once(
    'src/server.ts',
    """const MIC_TRANSPORT_GRACE_MS = envMs('RELAY_MIC_TRANSPORT_GRACE_MS', 5_000);\nconst AUDIO_TRANSPORT_CONFIG = loadAudioTransportConfig();\n""",
    """const MIC_TRANSPORT_GRACE_MS = envMs('RELAY_MIC_TRANSPORT_GRACE_MS', 5_000);\nconst MIC_FIRST_FRAME_TIMEOUT_MS = envMs('RELAY_MIC_FIRST_FRAME_TIMEOUT_MS', 3_000);\nconst AUDIO_TRANSPORT_CONFIG = loadAudioTransportConfig();\n""",
    'add bounded server first-frame deadline',
)

replace_once(
    'src/server.ts',
    """let lastMicFrameAt = -Infinity;\nlet lastMicFrameOwnerId: string | null = null;\nlet lastMicFrameGeneration: number | null = null;\nlet lastBackingFrameAt = -Infinity;\n\nfunction resetMicFlowEvidence() {\n  lastMicFrameAt = -Infinity;\n  lastMicFrameOwnerId = micMediaOwnerId;\n  lastMicFrameGeneration = micMediaGeneration;\n}\n""",
    """let lastMicFrameAt = -Infinity;\nlet lastMicFrameOwnerId: string | null = null;\nlet lastMicFrameGeneration: number | null = null;\nlet micFirstFrameWaitStartedAt = -Infinity;\nlet lastBackingFrameAt = -Infinity;\n\nfunction resetMicFlowEvidence(nowMs = performance.now()) {\n  lastMicFrameAt = -Infinity;\n  lastMicFrameOwnerId = micMediaOwnerId;\n  lastMicFrameGeneration = micMediaGeneration;\n  micFirstFrameWaitStartedAt = micMediaOwnerId === null ? -Infinity : nowMs;\n}\n""",
    'remember when the current Mic capture began waiting for PCM',
)

replace_once(
    'src/server.ts',
    """function micFlowObserved() {\n  return Number.isFinite(lastMicFrameAt)\n    && lastMicFrameOwnerId === micMediaOwnerId\n    && lastMicFrameGeneration === micMediaGeneration;\n}\n\nfunction micStreaming(nowMs = performance.now()) {\n""",
    """function micFlowObserved() {\n  return Number.isFinite(lastMicFrameAt)\n    && lastMicFrameOwnerId === micMediaOwnerId\n    && lastMicFrameGeneration === micMediaGeneration;\n}\n\nfunction micStartupTimedOut(nowMs = performance.now()) {\n  return micMediaConnected()\n    && !micFlowObserved()\n    && Number.isFinite(micFirstFrameWaitStartedAt)\n    && nowMs - micFirstFrameWaitStartedAt >= MIC_FIRST_FRAME_TIMEOUT_MS;\n}\n\nfunction micStreaming(nowMs = performance.now()) {\n""",
    'derive server startup timeout from current media authority',
)

replace_once(
    'src/server.ts',
    """    micConnected: micMediaConnected(),\n    micStreaming: micStreaming(nowMs),\n    micFlowObserved: micFlowObserved(),\n    robotSourceConnected: activeRobotSource?.readyState === WebSocket.OPEN,\n""",
    """    micConnected: micMediaConnected(),\n    micStreaming: micStreaming(nowMs),\n    micFlowObserved: micFlowObserved(),\n    micStartupTimedOut: micStartupTimedOut(nowMs),\n    robotSourceConnected: activeRobotSource?.readyState === WebSocket.OPEN,\n""",
    'publish first-frame timeout in canonical readiness snapshot',
)

replace_once(
    'src/readiness.ts',
    """  /** Current Mic owner/capture has produced at least one PCM frame. */\n  micFlowObserved?: boolean;\n  robotSourceConnected: boolean;\n""",
    """  /** Current Mic owner/capture has produced at least one PCM frame. */\n  micFlowObserved?: boolean;\n  /** Current connected Mic capture exceeded its first-frame startup deadline. */\n  micStartupTimedOut?: boolean;\n  robotSourceConnected: boolean;\n""",
    'add Mic startup timeout readiness fact',
)

replace_once(
    'src/readiness.ts',
    """      mic: {\n        connected: input.micConnected,\n        streaming: input.micStreaming,\n        flowObserved: input.micFlowObserved ?? input.micStreaming,\n      },\n""",
    """      mic: {\n        connected: input.micConnected,\n        streaming: input.micStreaming,\n        flowObserved: input.micFlowObserved ?? input.micStreaming,\n        startupTimedOut: input.micStartupTimedOut === true,\n      },\n""",
    'retain startup timeout in canonical snapshot',
)

replace_once(
    'src/room-domain.ts',
    """  connected: boolean;\n  flowObserved: boolean;\n  streaming: boolean;\n};\n""",
    """  connected: boolean;\n  flowObserved: boolean;\n  startupTimedOut?: boolean;\n  streaming: boolean;\n};\n""",
    'extend Mic domain facts with startup timeout',
)

replace_once(
    'src/room-domain.ts',
    """  if (!facts.connected) return 'reconnecting';\n  if (!facts.flowObserved) return 'starting';\n  if (facts.streaming) return 'live';\n""",
    """  if (!facts.connected) return 'reconnecting';\n  if (!facts.flowObserved) return facts.startupTimedOut ? 'interrupted' : 'starting';\n  if (facts.streaming) return 'live';\n""",
    'bound the starting product state',
)

replace_once(
    'src/product-view-model.ts',
    """    connected: mic.connected,\n    flowObserved: mic.flowObserved,\n    streaming: mic.streaming,\n  });\n""",
    """    connected: mic.connected,\n    flowObserved: mic.flowObserved,\n    startupTimedOut: mic.startupTimedOut,\n    streaming: mic.streaming,\n  });\n""",
    'feed startup timeout into canonical Mic state',
)

replace_once(
    'src/remote-status.ts',
    """  // \"No longer\" requires evidence that this Mic capture has actually flowed.\n  // A newly acquired Mic before its first frame is starting, not broken.\n  if (components.mic.connected && components.mic.flowObserved && !components.mic.streaming) {\n    faults.push('microphone is connected but no longer sending audio');\n  }\n""",
    """  // A newly acquired Mic gets a short first-frame grace. Once that bounded\n  // startup window expires, \"starting\" is no longer a truthful operator state.\n  if (components.mic.connected && components.mic.startupTimedOut) {\n    faults.push('microphone is connected but did not send its first audio frame in time');\n  } else if (components.mic.connected && components.mic.flowObserved && !components.mic.streaming) {\n    faults.push('microphone is connected but no longer sending audio');\n  }\n""",
    'surface first-frame timeout as an operator fault',
)

replace_once(
    'test/room-domain.test.ts',
    """  assert.equal(deriveRoomMicState({\n    ownerId: 'participant-a',\n    connected: true,\n    flowObserved: false,\n    streaming: false,\n  }), 'starting');\n\n  assert.equal(deriveRoomMicState({\n    ownerId: 'participant-a',\n    connected: true,\n    flowObserved: true,\n""",
    """  assert.equal(deriveRoomMicState({\n    ownerId: 'participant-a',\n    connected: true,\n    flowObserved: false,\n    streaming: false,\n  }), 'starting');\n\n  assert.equal(deriveRoomMicState({\n    ownerId: 'participant-a',\n    connected: true,\n    flowObserved: false,\n    startupTimedOut: true,\n    streaming: false,\n  }), 'interrupted');\n\n  assert.equal(deriveRoomMicState({\n    ownerId: 'participant-a',\n    connected: true,\n    flowObserved: true,\n""",
    'pin starting to interrupted deadline transition',
)

replace_once(
    'test/remote-status.test.ts',
    """  micStreaming: false,\n  micFlowObserved: false,\n  robotSourceConnected: false,\n""",
    """  micStreaming: false,\n  micFlowObserved: false,\n  micStartupTimedOut: false,\n  robotSourceConnected: false,\n""",
    'make remote status startup grace explicit',
)

replace_once(
    'test/remote-status.test.ts',
    """  test('a Mic that flowed and then stalled is a fault', () => {\n""",
    """  test('a Mic that never produced its first frame becomes a fault after startup grace', () => {\n    const result = status({\n      micConnected: true,\n      micStreaming: false,\n      micFlowObserved: false,\n      micStartupTimedOut: true,\n    });\n    assert.equal(result.ok, false);\n    assert.equal(result.state, 'fault');\n    assert.deepEqual(result.faults, [\n      'microphone is connected but did not send its first audio frame in time',\n    ]);\n  });\n\n  test('a Mic that flowed and then stalled is a fault', () => {\n""",
    'test operator first-frame timeout',
)

Path('test/mic-first-frame-deadline.test.ts').write_text("""import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nimport test from 'node:test';\n\nconst server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');\n\ntest('server bounds connected Mic startup and feeds the canonical readiness snapshot', () => {\n  assert.match(server, /RELAY_MIC_FIRST_FRAME_TIMEOUT_MS', 3_000/);\n  assert.match(server, /let micFirstFrameWaitStartedAt = -Infinity/);\n  assert.match(\n    server,\n    /function resetMicFlowEvidence\\(nowMs = performance\\.now\\(\\)\\)[\\s\\S]{0,300}micFirstFrameWaitStartedAt = micMediaOwnerId === null \\? -Infinity : nowMs/\n  );\n  assert.match(\n    server,\n    /function micStartupTimedOut\\(nowMs = performance\\.now\\(\\)\\)[\\s\\S]{0,400}micMediaConnected\\(\\)[\\s\\S]{0,200}!micFlowObserved\\(\\)[\\s\\S]{0,200}MIC_FIRST_FRAME_TIMEOUT_MS/\n  );\n  assert.match(server, /micStartupTimedOut: micStartupTimedOut\\(nowMs\\)/);\n});\n""")
