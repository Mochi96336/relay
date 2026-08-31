from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {count}')
    return text.replace(old, new, 1)


protocol_path = Path('src/relay-command-protocol.ts')
protocol = protocol_path.read_text()
protocol = replace_once(
    protocol,
    "  playbackMicIntent: RelayCommandHandler<TSocket>;\n};\n",
    "  playbackMicIntent: RelayCommandHandler<TSocket>;\n  setVocalFineTune: RelayCommandHandler<TSocket>;\n  setMix: RelayCommandHandler<TSocket>;\n};\n",
    'protocol mix handlers',
)
protocol = replace_once(
    protocol,
    "        case 'playback-mic-intent':\n          handlers.playbackMicIntent(socket, payload);\n          return true;\n        default:\n",
    "        case 'playback-mic-intent':\n          handlers.playbackMicIntent(socket, payload);\n          return true;\n        case 'set-vocal-fine-tune':\n          handlers.setVocalFineTune(socket, payload);\n          return true;\n        case 'set-mix':\n          handlers.setMix(socket, payload);\n          return true;\n        default:\n",
    'protocol mix cases',
)
protocol_path.write_text(protocol)

server_path = Path('src/server.ts')
server = server_path.read_text()
handlers = """  setVocalFineTune: (socket, payload) => {
    if (!requireMicOwnerCommand(socket, 'set-vocal-fine-tune')) return;
    const nextFineTune = Number(payload.valueMs);
    if (Number.isFinite(nextFineTune)) {
      session.setAlignment({
        fineTuneMs: Math.max(-MAX_VOCAL_FINE_TUNE_MS, Math.min(MAX_VOCAL_FINE_TUNE_MS, nextFineTune)),
      });
      broadcastJson(sourceStatusPayload());
      broadcastJson(timingCalibrationStatusPayload());
    }
  },
  setMix: (socket, payload) => {
    if (!requireMicOwnerCommand(socket, 'set-mix')) return;
    const nextGain = Number(payload.micGainDb);
    if (Number.isFinite(nextGain)) {
      session.setMicGainDb(Math.max(0, Math.min(MAX_MIC_GAIN_DB, nextGain)));
    }
    // `songLevel` remains accepted on the old wire shape for compatibility,
    // but Song is now a server-owned 100% reference and cannot be mutated by
    // any client authority.
    broadcastJson(mixSettingsPayload());
  },
"""
server = replace_once(
    server,
    "  playbackMicIntent: (socket) => {\n    const playbackIdentity = playbackTransport.identity(socket);\n    if (!playbackIdentity || playbackIdentity.participantId !== socket.participantId) return;\n    playbackTransport.noteMicIntent(socket, performance.now());\n    sendJson(socket, { type: 'playback-mic-intent-registered' });\n  },\n});\n",
    "  playbackMicIntent: (socket) => {\n    const playbackIdentity = playbackTransport.identity(socket);\n    if (!playbackIdentity || playbackIdentity.participantId !== socket.participantId) return;\n    playbackTransport.noteMicIntent(socket, performance.now());\n    sendJson(socket, { type: 'playback-mic-intent-registered' });\n  },\n" + handlers + "});\n",
    'server mix handler insertion',
)
inline_fine_tune = """    if (payload.type === 'set-vocal-fine-tune') {
      if (!requireMicOwnerCommand(socket, 'set-vocal-fine-tune')) return;
      const nextFineTune = Number(payload.valueMs);
      if (Number.isFinite(nextFineTune)) {
        session.setAlignment({
          fineTuneMs: Math.max(-MAX_VOCAL_FINE_TUNE_MS, Math.min(MAX_VOCAL_FINE_TUNE_MS, nextFineTune)),
        });
        broadcastJson(sourceStatusPayload());
        broadcastJson(timingCalibrationStatusPayload());
      }
      return;
    }

"""
inline_mix = """    if (payload.type === 'set-mix') {
      if (!requireMicOwnerCommand(socket, 'set-mix')) return;
      const nextGain = Number(payload.micGainDb);
      if (Number.isFinite(nextGain)) {
        session.setMicGainDb(Math.max(0, Math.min(MAX_MIC_GAIN_DB, nextGain)));
      }
      // `songLevel` remains accepted on the old wire shape for compatibility,
      // but Song is now a server-owned 100% reference and cannot be mutated by
      // any client authority.
      broadcastJson(mixSettingsPayload());
      return;
    }
"""
server = replace_once(server, inline_fine_tune, '', 'inline fine tune block')
server = replace_once(server, inline_mix, '', 'inline set mix block')
server_path.write_text(server)

unit_path = Path('test/relay-command-protocol.test.ts')
unit = unit_path.read_text()
unit = replace_once(
    unit,
    "    playbackMicIntent: (nextSocket, payload) => seen.push({ handler: 'playback-intent', socket: nextSocket, payload }),\n  });\n",
    "    playbackMicIntent: (nextSocket, payload) => seen.push({ handler: 'playback-intent', socket: nextSocket, payload }),\n    setVocalFineTune: (nextSocket, payload) => seen.push({ handler: 'fine-tune', socket: nextSocket, payload }),\n    setMix: (nextSocket, payload) => seen.push({ handler: 'set-mix', socket: nextSocket, payload }),\n  });\n",
    'unit mix handlers',
)
unit = replace_once(
    unit,
    "  const intent = { type: 'playback-mic-intent' };\n\n",
    "  const intent = { type: 'playback-mic-intent' };\n  const fineTune = { type: 'set-vocal-fine-tune', valueMs: 75 };\n  const setMix = { type: 'set-mix', micGainDb: 17 };\n\n",
    'unit mix payloads',
)
unit = replace_once(
    unit,
    "  assert.equal(protocol.dispatch(socket, intent), true);\n\n",
    "  assert.equal(protocol.dispatch(socket, intent), true);\n  assert.equal(protocol.dispatch(socket, fineTune), true);\n  assert.equal(protocol.dispatch(socket, setMix), true);\n\n",
    'unit mix dispatch',
)
unit = replace_once(
    unit,
    "    'playback-intent',\n  ]);\n",
    "    'playback-intent',\n    'fine-tune',\n    'set-mix',\n  ]);\n",
    'unit mix order',
)
unit = replace_once(
    unit,
    "  assert.equal(seen[10]?.payload, intent);\n});\n",
    "  assert.equal(seen[10]?.payload, intent);\n  assert.equal(seen[11]?.payload, fineTune);\n  assert.equal(seen[12]?.payload, setMix);\n});\n",
    'unit mix identity',
)
unit = replace_once(
    unit,
    "    playbackMicIntent: () => { calls += 1; },\n  });\n",
    "    playbackMicIntent: () => { calls += 1; },\n    setVocalFineTune: () => { calls += 1; },\n    setMix: () => { calls += 1; },\n  });\n",
    'unit fallback mix handlers',
)
unit_path.write_text(unit)

contract_path = Path('test/server-command-protocol-routing.test.ts')
contract = contract_path.read_text()
contract = replace_once(
    contract,
    "  assert.match(protocol, /case 'playback-mic-intent'/);\n",
    "  assert.match(protocol, /case 'playback-mic-intent'/);\n  assert.match(protocol, /case 'set-vocal-fine-tune'/);\n  assert.match(protocol, /case 'set-mix'/);\n",
    'contract mix cases',
)
contract = replace_once(
    contract,
    "  assert.doesNotMatch(server, /payload\\.type === 'playback-mic-intent'/);\n",
    "  assert.doesNotMatch(server, /payload\\.type === 'playback-mic-intent'/);\n  assert.doesNotMatch(server, /payload\\.type === 'set-vocal-fine-tune'/);\n  assert.doesNotMatch(server, /payload\\.type === 'set-mix'/);\n",
    'contract mix inline absence',
)
contract = replace_once(
    contract,
    "  assert.match(server, /playbackTransport\\.noteMicIntent\\(socket, performance\\.now\\(\\)\\)/);\n",
    "  assert.match(server, /playbackTransport\\.noteMicIntent\\(socket, performance\\.now\\(\\)\\)/);\n  assert.match(server, /requireMicOwnerCommand\\(socket, 'set-vocal-fine-tune'\\)/);\n  assert.match(server, /session\\.setAlignment\\(\\{/);\n  assert.match(server, /fineTuneMs: Math\\.max\\(-MAX_VOCAL_FINE_TUNE_MS/);\n  assert.match(server, /requireMicOwnerCommand\\(socket, 'set-mix'\\)/);\n  assert.match(server, /session\\.setMicGainDb\\(Math\\.max\\(0, Math\\.min\\(MAX_MIC_GAIN_DB, nextGain\\)\\)\\)/);\n  assert.match(server, /broadcastJson\\(mixSettingsPayload\\(\\)\\)/);\n",
    'contract mix effects',
)
contract_path.write_text(contract)

authority_path = Path('test/command-authority-server.test.ts')
authority = authority_path.read_text()
authority = replace_once(
    authority,
    "    assert.equal(sourceStatus.vocalFineTuneMs, 0, 'rejected fine tune must not mutate mixer state');\n\n    from = other.messages.length;\n    other.send({ type: 'start-timing-calibration' });\n",
    "    assert.equal(sourceStatus.vocalFineTuneMs, 0, 'rejected fine tune must not mutate mixer state');\n\n    from = other.messages.length;\n    ownerControl.send({ type: 'set-vocal-fine-tune', valueMs: 75 });\n    const tunedSourceStatus = await waitForNewMessage(\n      other,\n      from,\n      (message) => message.type === 'source-status' && message.vocalFineTuneMs === 75,\n    );\n    assert.equal(tunedSourceStatus.vocalFineTuneMs, 75);\n\n    from = other.messages.length;\n    other.send({ type: 'start-timing-calibration' });\n",
    'authority fine tune success proof',
)
authority_path.write_text(authority)

if "payload.type === 'set-vocal-fine-tune'" in server:
    raise SystemExit('set-vocal-fine-tune branch still remains inline in server.ts')
if "payload.type === 'set-mix'" in server:
    raise SystemExit('set-mix branch still remains inline in server.ts')
if "case 'set-vocal-fine-tune'" not in protocol or "case 'set-mix'" not in protocol:
    raise SystemExit('mix routing cases were not added to relay-command-protocol.ts')
