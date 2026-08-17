from pathlib import Path

server_path = Path('src/server.ts')
text = server_path.read_text()


def replace_exact(label: str, old: str, new: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    text = text.replace(old, new, 1)
    print(f'patched server: {label}')


def replace_file_exact(path_name: str, label: str, old: str, new: str) -> None:
    path = Path(path_name)
    contents = path.read_text()
    count = contents.count(old)
    if count != 1:
        raise SystemExit(f'{path_name} / {label}: expected exactly one match, found {count}')
    path.write_text(contents.replace(old, new, 1))
    print(f'patched {path_name}: {label}')


replace_exact(
    'mic transition application imports',
    "import { CalibrationSession, type CalibrationContext } from './calibration-session.js';\nimport { buildRelayObservationStatusV1 } from './observation-status.js';",
    "import { CalibrationSession, type CalibrationContext } from './calibration-session.js';\nimport { applyMicOwnerTransitionEffects } from './mic-owner-transition-application.js';\nimport type { MicOwnerTransitionEffects } from './mic-owner-transition.js';\nimport { buildRelayObservationStatusV1 } from './observation-status.js';",
)

replace_exact(
    'remote status import',
    "import { buildReadiness } from './readiness.js';\nimport {\n  ParticipantSession,",
    "import { buildReadiness } from './readiness.js';\nimport { deriveRemoteStatusHealth } from './remote-status.js';\nimport {\n  ParticipantSession,",
)

replace_exact(
    'transport grace expiry effects',
    """    const released = participants.releaseMic(expectedOwnerId);
    if (!released.ok) return;
    clearMicMediaAuthority();
    takeController.noteQualityEvent('mic-owner-changed');
    cancelPendingRoomSongCommand('mic-owner-released');
    invalidateMicTiming('Microphone transport did not reconnect before its grace period expired.');
    broadcastSessionStatus();""",
    """    const released = participants.releaseMic(expectedOwnerId, 'transport-expired');
    if (!released.ok) return;
    clearMicMediaAuthority();
    applyRoomMicOwnerEffects(released.effects);
    broadcastSessionStatus();""",
)

handoff_block = """function beginPreparedSongHandoff(participantId: string, nowMs = performance.now()) {
  const target = selectPlaybackHandoffTarget(participantId, nowMs);
  if (!target) return false;
  const plan = youtubeTimeline.beginHandoff(target, participants.micOwnerId, nowMs);
  if (!plan) return false;
  sendHandoffPlan('song-handoff-prepare', plan);
  broadcastJson(youtubeTimeline.statusPayload(nowMs));
  broadcastJson(youtubeTimeline.roomStatusPayload(nowMs));
  return true;
}
"""

replace_exact(
    'mic transition application adapter',
    handoff_block,
    handoff_block + """
function applyRoomMicOwnerEffects(
  effects: MicOwnerTransitionEffects,
  nowMs = performance.now(),
  publishFullHandoffStatus = true,
) {
  return applyMicOwnerTransitionEffects(effects, {
    noteQualityEvent(event) {
      takeController.noteQualityEvent(event);
    },
    cancelRoomSongCommand(reason) {
      cancelPendingRoomSongCommand(reason, nowMs);
    },
    cancelSongHandoff() {
      return youtubeTimeline.cancelHandoff();
    },
    publishSongHandoffCancellation() {
      if (publishFullHandoffStatus) broadcastJson(youtubeTimeline.statusPayload(nowMs));
      broadcastJson(youtubeTimeline.roomStatusPayload(nowMs));
    },
    invalidateTiming(reason) {
      invalidateMicTiming(reason);
    },
    prepareSongHandoff(participantId) {
      beginPreparedSongHandoff(participantId, nowMs);
    },
  });
}
""",
)

replace_exact(
    'remote status facts',
    """  const readiness = readinessPayload(nowMs);
  const components = readiness.components;
  const backingConnected = components.backing.connected;
  const micConnected = components.mic.connected;
  const backingStreaming = components.backing.streaming;
  const micStreaming = components.mic.streaming;
  const micFlowSeen = components.mic.flowObserved;
  const routeMode = components.route.mode;
  const robotRoute = routeMode === 'robot';
  const robotSourceConnected = components.robotSource.connected;
  const deltaFresh = components.player.offsetFresh;
""",
    """  const readiness = readinessPayload(nowMs);
  const components = readiness.components;
  const health = deriveRemoteStatusHealth(readiness);
  const backingConnected = components.backing.connected;
  const micConnected = components.mic.connected;
  const backingStreaming = components.backing.streaming;
  const micStreaming = components.mic.streaming;
  const robotRoute = components.route.mode === 'robot';
  const robotSourceConnected = components.robotSource.connected;
  const deltaFresh = components.player.offsetFresh;
""",
)

replace_exact(
    'remote status inline health policy',
    """  const faults: string[] = [];
  if (backingConnected && !backingStreaming) faults.push('backing source is connected but no longer sending audio');
  // \"No longer\" is a claim about a stream that once existed. A microphone that
  // has been taken but has not produced its first frame yet is starting, not
  // failing - the phone is still resolving permission, opening the capture and
  // filling its first buffers. Reporting that as a fault told an operator the
  // opposite of what was happening, and it is the ordinary state of every take
  // for its first moments. `flowObserved` is what separates the two, and the
  // product view already draws that line: `starting` before the first frame,
  // `interrupted` after one stops arriving.
  if (micConnected && micFlowSeen && !micStreaming) {
    faults.push('microphone is connected but no longer sending audio');
  }
  if (routeMode !== 'idle' && !backingConnected) {
    faults.push(`${routeMode} route has no backing source`);
  }
  if (robotRoute && !robotSourceConnected) faults.push('robot route has no source page');

  const warnings: string[] = [];
  if (robotRoute && robotSourceConnected && !deltaFresh) {
    warnings.push('robot player delta is stale; alignment fell back to the network estimate');
  }
  if (components.calibration.stale) warnings.push('timing calibration no longer matches the current capture');

  const idle = !backingConnected && !micConnected && !robotSourceConnected;
  const state = faults.length > 0 ? 'fault'
    : idle ? 'idle'
      : warnings.length > 0 ? 'degraded'
        : 'live';

""",
    '',
)

replace_exact(
    'remote status projected health',
    """    ok: faults.length === 0,
    state,
    faults,
    warnings,""",
    """    ok: health.ok,
    state: health.state,
    faults: health.faults,
    warnings: health.warnings,""",
)

replace_exact(
    'presence expiry effects',
    """  const presenceSweep = participants.sweep(Date.now());
  if (presenceSweep.releasedMicOwnerId) {
    takeController.noteQualityEvent('mic-owner-changed');
    cancelMicTransportGrace();
    clearMicMediaAuthority();
    cancelPendingRoomSongCommand('mic-owner-released', nowMs);
    if (youtubeTimeline.cancelHandoff()) broadcastJson(youtubeTimeline.roomStatusPayload(nowMs));
    invalidateMicTiming('Microphone owner left the Relay session.');
  }
  if (presenceSweep.changed) broadcastSessionStatus();""",
    """  const presenceSweep = participants.sweep(Date.now());
  if (presenceSweep.micOwnerEffects) {
    cancelMicTransportGrace();
    clearMicMediaAuthority();
    applyRoomMicOwnerEffects(presenceSweep.micOwnerEffects, nowMs, false);
  }
  if (presenceSweep.changed) broadcastSessionStatus();""",
)

replace_exact(
    'explicit release effects',
    """    if (payload.type === 'release-mic') {
      if (!socket.participantId) return;
      const result = participants.releaseMic(socket.participantId);
      if (!result.ok) return;

      takeController.noteQualityEvent('mic-owner-changed');
      cancelMicTransportGrace();
      cancelPendingRoomSongCommand('mic-owner-released');
      if (youtubeTimeline.cancelHandoff()) {
        broadcastJson(youtubeTimeline.statusPayload());
        broadcastJson(youtubeTimeline.roomStatusPayload());
      }
      if (publisher?.participantId === socket.participantId) {
        revokePublisherTransport('You released the microphone.');
      } else if (micMediaOwnerId === socket.participantId) {
        clearMicMediaAuthority();
      }
      invalidateMicTiming('Microphone was released.');
      broadcastSessionStatus();
      sendJson(socket, { type: 'mic-released' });
      return;
    }""",
    """    if (payload.type === 'release-mic') {
      if (!socket.participantId) return;
      const result = participants.releaseMic(socket.participantId);
      if (!result.ok) return;

      cancelMicTransportGrace();
      if (publisher?.participantId === socket.participantId) {
        revokePublisherTransport('You released the microphone.');
      } else if (micMediaOwnerId === socket.participantId) {
        clearMicMediaAuthority();
      }
      applyRoomMicOwnerEffects(result.effects);
      broadcastSessionStatus();
      sendJson(socket, { type: 'mic-released' });
      return;
    }""",
)

# A Take is a timing snapshot. The active alignment is frozen for the complete
# recording/finalizing boundary; new calibration evidence may be collected only
# after that boundary, never applied underneath an already-open artifact.
replace_exact(
    'freeze applied calibration during Take',
    """function syncAppliedCalibration() {
  const active = session.alignment.calibratedMicLagMs;
""",
    """function syncAppliedCalibration() {
  if (takeBlocksCalibration()) return false;
  const active = session.alignment.calibratedMicLagMs;
""",
)

replace_exact(
    'freeze boot delta reapply during Take',
    """function maybeReapplyBootCalibration(nowMs: number) {
  if (!robotProbeTimingActive() || calibrationKind !== 'boot-probe') return;
""",
    """function maybeReapplyBootCalibration(nowMs: number) {
  if (takeBlocksCalibration()) return;
  if (!robotProbeTimingActive() || calibrationKind !== 'boot-probe') return;
""",
)

# AudioPacket v2 registrations name the exact next sequence the capture will
# send. Same-process reconnects keep the existing receiver, while a brand-new
# Relay process can start at the continuing phone's current frontier instead of
# waiting forever for sequence zero from a capture that never restarted.
replace_exact(
    'publisher initial sequence validation',
    """      const captureGeneration = validCaptureGeneration(payload.captureGeneration);
      const audioPacketVersion = validAudioPacketVersion(payload.audioPacketVersion);
      if (!audioPacketVersion) {
        sendJson(socket, { type: 'error', message: 'Unsupported audio packet version.' });
        return;
      }
      if (audioPacketVersion === 2 && captureGeneration === null) {
        sendJson(socket, {
          type: 'error',
          message: 'AudioPacket v2 requires a capture generation in publisher registration.',
        });
        return;
      }
""",
    """      const captureGeneration = validCaptureGeneration(payload.captureGeneration);
      const initialSequence = payload.initialSequence === undefined
        ? 0
        : validCaptureGeneration(payload.initialSequence);
      const audioPacketVersion = validAudioPacketVersion(payload.audioPacketVersion);
      if (!audioPacketVersion) {
        sendJson(socket, { type: 'error', message: 'Unsupported audio packet version.' });
        return;
      }
      if (audioPacketVersion === 2 && captureGeneration === null) {
        sendJson(socket, {
          type: 'error',
          message: 'AudioPacket v2 requires a capture generation in publisher registration.',
        });
        return;
      }
      if (audioPacketVersion === 2 && initialSequence === null) {
        sendJson(socket, {
          type: 'error',
          message: 'AudioPacket v2 requires a valid initial sequence in publisher registration.',
        });
        return;
      }
""",
)

replace_exact(
    'publisher receiver initial sequence',
    """            receiver: {
              source: 'mic',
              generation: captureGeneration!,
              ...AUDIO_TRANSPORT_CONFIG,
            },""",
    """            receiver: {
              source: 'mic',
              generation: captureGeneration!,
              initialSequence: initialSequence!,
              ...AUDIO_TRANSPORT_CONFIG,
            },""",
)

server_path.write_text(text)
print('server authority/recovery patch complete')

# Keep the generic receiver strict by default. Restart recovery is an explicit
# control-plane contract (`initialSequence`), not permission for an arbitrary
# first media packet to redefine the sequence origin.
replace_file_exact(
    'src/audio-packet-receiver.ts',
    'initial sequence documentation',
    """  /**
   * First sequence authorized for this receiver. When omitted, the first valid
   * packet establishes the sequence origin; this is required after a Relay
   * process restart because the continuing phone capture does not reset its
   * sequence counter.
   */
  initialSequence?: number;""",
    """  /** First sequence authorized for this receiver. Defaults to zero. */
  initialSequence?: number;""",
)
replace_file_exact(
    'src/audio-packet-receiver.ts',
    'restart comment boundary',
    """ *
 * If no in-process continuity snapshot exists and the caller did not provide an
 * explicit initial sequence, the first valid packet establishes the frontier.
 * That is the only sequence authority available after a Relay process restart:
 * the phone deliberately keeps its capture generation, sequence and sample
 * timeline across WebSocket reconnects.
 *
 * Reorder deadlines use the caller's monotonic media clock.""",
    """ *
 * Reorder deadlines use the caller's monotonic media clock.""",
)
replace_file_exact(
    'src/audio-packet-receiver.ts',
    'strict default frontier',
    "this.expectedSequence = initialSequence === undefined ? null : initialSequence >>> 0;",
    "this.expectedSequence = (initialSequence ?? 0) >>> 0;",
)
replace_file_exact(
    'src/audio-packet-receiver.ts',
    'no arbitrary first packet origin',
    """    if (!candidate) {
      if (this.expectedSequence === null) this.expectedSequence = packet.sequence;
      this.rememberContinuity();
      return;
    }""",
    """    if (!candidate) {
      this.rememberContinuity();
      return;
    }""",
)
replace_file_exact(
    'src/audio-packet-receiver.ts',
    'candidate rejection keeps configured origin',
    """    } else {
      continuitySnapshots.delete(continuityKey(this.source, this.generation));
      if (this.expectedSequence === null) this.expectedSequence = packet.sequence;
    }
""",
    """    } else {
      continuitySnapshots.delete(continuityKey(this.source, this.generation));
    }
""",
)

replace_file_exact(
    'public/app.js',
    'publisher registration sequence frontier',
    """    sampleRate: audioContext.sampleRate,
    captureGeneration: captureGeneration >>> 0,
    audioPacketVersion: AUDIO_PACKET_VERSION,
""",
    """    sampleRate: audioContext.sampleRate,
    captureGeneration: captureGeneration >>> 0,
    initialSequence: capturePacketSequence >>> 0,
    audioPacketVersion: AUDIO_PACKET_VERSION,
""",
)

replace_file_exact(
    'public/app.js',
    'publisher AudioContext recovery helper',
    """function canKeepPublishing() {
  return publisherActive && Boolean(mediaStream) && Boolean(audioContext);
}
""",
    """async function recoverPublisherAudioContext(reason = 'Audio input resumed.') {
  const context = audioContext;
  if (!publisherActive || !context || context.state === 'running' || context.state === 'closed') return;
  if (document.visibilityState === 'hidden') return;

  try {
    await context.resume();
    if (publisherActive && audioContext === context && context.state === 'running') {
      setStatus('Microphone live', reason);
    }
  } catch (error) {
    console.warn('microphone AudioContext recovery failed', error);
    if (publisherActive && audioContext === context) {
      setStatus('Microphone paused', 'Tap the page to let the browser resume audio capture.');
    }
  }
}

function canKeepPublishing() {
  return publisherActive && Boolean(mediaStream) && Boolean(audioContext);
}
""",
)

replace_file_exact(
    'public/app.js',
    'publisher AudioContext state recovery',
    """  audioContext = new AudioContext({ latencyHint: 'interactive' });
  await audioContext.audioWorklet.addModule('/capture-worklet.js');
  await audioContext.resume();

  setPublisherActive(true);
""",
    """  audioContext = new AudioContext({ latencyHint: 'interactive' });
  await audioContext.audioWorklet.addModule('/capture-worklet.js');
  await audioContext.resume();

  const captureContext = audioContext;
  captureContext.addEventListener('statechange', () => {
    if (
      publisherActive
      && audioContext === captureContext
      && captureContext.state !== 'running'
      && captureContext.state !== 'closed'
      && document.visibilityState !== 'hidden'
    ) {
      void recoverPublisherAudioContext('Audio input recovered after an interruption.');
    }
  });

  setPublisherActive(true);
""",
)

replace_file_exact(
    'public/app.js',
    'track mute and unmute recovery',
    """  track?.addEventListener('ended', () => {
    if (!publisherActive) return;
    stop(false, { releaseMic: true })
      .then(() => {
        dispatchRelayEvent('relay-microphone-ended', { reason: 'input-ended' });
        setStatus('Microphone stopped', 'The audio input ended. Press Microphone again to restart it.');
      })
      .catch(console.error);
  });

  const source = audioContext.createMediaStreamSource(mediaStream);""",
    """  track?.addEventListener('ended', () => {
    if (!publisherActive) return;
    stop(false, { releaseMic: true })
      .then(() => {
        dispatchRelayEvent('relay-microphone-ended', { reason: 'input-ended' });
        setStatus('Microphone stopped', 'The audio input ended. Press Microphone again to restart it.');
      })
      .catch(console.error);
  });
  track?.addEventListener('mute', () => {
    if (!publisherActive) return;
    setStatus('Microphone interrupted', 'The operating system temporarily muted the audio input.');
    dispatchRelayEvent('relay-microphone-input-muted');
  });
  track?.addEventListener('unmute', () => {
    if (!publisherActive) return;
    dispatchRelayEvent('relay-microphone-input-unmuted');
    void recoverPublisherAudioContext('Audio input is available again.');
  });

  const source = audioContext.createMediaStreamSource(mediaStream);""",
)

replace_file_exact(
    'public/app.js',
    'page lifecycle Mic recovery',
    """window.addEventListener('relay-locale-changed', () => {
  renderGainAdvice();
  updateCalibrateButton();
});

calibrateButton.addEventListener('click', () => {""",
    """window.addEventListener('relay-locale-changed', () => {
  renderGainAdvice();
  updateCalibrateButton();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void recoverPublisherAudioContext('Audio input resumed after returning to Relay.');
  }
});
window.addEventListener('pageshow', () => {
  void recoverPublisherAudioContext('Audio input resumed after returning to Relay.');
});

calibrateButton.addEventListener('click', () => {""",
)

replace_file_exact(
    'public/listen.js',
    'unity-safe Listen gain',
    """    // A curved local volume control preserves useful headroom for quiet phone
    // speakers without exposing the old engineering dB control in Live UI.
    return ((percent / 100) ** 1.5) * 8;""",
    """    // The server mix is already full-scale limited. Local Listen volume may
    // attenuate it, but must never amplify an already-clamped mix into clipping.
    return (percent / 100) ** 1.5;""",
)

replace_file_exact(
    'public/listen.js',
    'authoritative mix sample rate',
    "sourceSampleRate = Number(message.sampleRate ?? message.mixSampleRate) || MIX_SAMPLE_RATE;",
    "sourceSampleRate = Number(message.mixSampleRate ?? message.sampleRate) || MIX_SAMPLE_RATE;",
)

replace_file_exact(
    'public/listen.js',
    'Listen running-state rendering',
    """          : audioContext
            ? 'audible'
            : 'ready';""",
    """          : audioContext?.state === 'running'
            ? 'audible'
            : 'ready';""",
)

replace_file_exact(
    'public/listen.js',
    'Listen AudioContext recovery helper',
    """  function handleMessage(message) {
    if (message.type === 'source-status') {
      sourceSampleRate = Number(message.mixSampleRate ?? message.sampleRate) || MIX_SAMPLE_RATE;
    }
  }

  async function connect() {""",
    """  function handleMessage(message) {
    if (message.type === 'source-status') {
      sourceSampleRate = Number(message.mixSampleRate ?? message.sampleRate) || MIX_SAMPLE_RATE;
    }
  }

  async function recoverAudioContext(copy = t('listen.resumed')) {
    const context = audioContext;
    if (!context || effectiveMuted() || context.state === 'running' || context.state === 'closed') return;
    if (document.visibilityState === 'hidden') return;

    try {
      await context.resume();
      if (audioContext === context && context.state === 'running' && !effectiveMuted()) {
        reconcile(copy);
      }
    } catch (error) {
      console.warn('Listen AudioContext recovery failed', error);
      render(t('listen.retry'));
    }
  }

  async function connect() {""",
)

replace_file_exact(
    'public/listen.js',
    'Listen context state listener',
    """      const context = new AudioContext({ latencyHint: 'interactive' });
      audioContext = context;
      // Consume the user's first interaction immediately. Fetching the worklet
      // before resume can lose transient autoplay permission on mobile.
      await context.resume();
      await context.audioWorklet.addModule('/playback-worklet.js');
""",
    """      const context = new AudioContext({ latencyHint: 'interactive' });
      audioContext = context;
      context.addEventListener('statechange', () => {
        if (audioContext !== context || effectiveMuted() || context.state === 'closed') return;
        if (context.state === 'running') {
          reconcile();
        } else if (document.visibilityState !== 'hidden') {
          closeTransport();
          render(t('listen.retry'));
          void recoverAudioContext();
        }
      });
      // Consume the user's first interaction immediately. Fetching the worklet
      // before resume can lose transient autoplay permission on mobile.
      await context.resume();
      await context.audioWorklet.addModule('/playback-worklet.js');
""",
)

replace_file_exact(
    'public/listen.js',
    'Listen reconcile suspended context',
    """    if (!audioContext || !playbackNode || !gainNode) {
      render(copy || t('listen.firstInteraction'));
      return;
    }
    if (transportEnabled) {""",
    """    if (!audioContext || !playbackNode || !gainNode) {
      render(copy || t('listen.firstInteraction'));
      return;
    }
    if (audioContext.state !== 'running') {
      closeTransport();
      render(copy || t('listen.retry'));
      void recoverAudioContext(copy || t('listen.resumed'));
      return;
    }
    if (transportEnabled) {""",
)

replace_file_exact(
    'public/listen.js',
    'Listen page lifecycle recovery',
    """  window.addEventListener('beforeunload', () => {
    closeTransport();
    if (audioContext) {
      try { audioContext.close(); } catch {}
    }
  }, { once: true });

  window.addEventListener('relay-locale-changed', () => render());""",
    """  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void recoverAudioContext();
  });
  window.addEventListener('pageshow', () => void recoverAudioContext());

  window.addEventListener('beforeunload', () => {
    closeTransport();
    if (audioContext) {
      try { audioContext.close(); } catch {}
    }
  }, { once: true });

  window.addEventListener('relay-locale-changed', () => render());""",
)

replace_file_exact(
    'test/probe-server-lifecycle.test.ts',
    'valid correlation floor',
    "RELAY_CALIBRATION_PROBE_MIN_CORRELATION: '-1',",
    "RELAY_CALIBRATION_PROBE_MIN_CORRELATION: '0',",
)
replace_file_exact(
    'test/probe-server-lifecycle.test.ts',
    'correlation test comment',
    """    // Push the Mic frontier beyond the complete analysis window. Correlation is
    // allowed down to -1 in this lifecycle test because the detector itself has
    // its own deterministic signal tests; here we are testing request ownership.""",
    """    // Push the Mic frontier beyond the complete analysis window. A zero
    // threshold is the lowest valid runtime configuration; detector quality has
    // separate deterministic signal tests, while this case tests request ownership.""",
)

replace_file_exact(
    'test/audio-packet-server.test.ts',
    'registerV2 initial sequence argument',
    """function registerV2(client: RelayClient, generation: number) {
  client.send({
    type: 'register',
    role: 'publisher',
    sampleRate: RATE,
    captureGeneration: generation,
    audioPacketVersion: 2,
  });
}""",
    """function registerV2(client: RelayClient, generation: number, initialSequence = 0) {
  client.send({
    type: 'register',
    role: 'publisher',
    sampleRate: RATE,
    captureGeneration: generation,
    initialSequence,
    audioPacketVersion: 2,
  });
}""",
)

replace_file_exact(
    'test/audio-packet-server.test.ts',
    'server restart sequence frontier integration',
    """test('v2 media stays ordered and capture-authoritative across websocket reconnects', async () => {""",
    """test('v2 registration can resume a capture from a non-zero sequence frontier', async () => {
  const server = await startRelay({
    RELAY_AUTO_CALIBRATE: '0',
    RELAY_HEARTBEAT_MS: '60000',
  });
  try {
    const monitor = await RelayClient.connect(server);
    monitor.send({ type: 'register', role: 'monitor' });
    await monitor.waitForType('registered');

    const publisher = await RelayClient.connect(server, participantQuery('participant-restart', 'Restart'));
    registerV2(publisher, 77, 42);
    await publisher.waitForType('registered');
    publisher.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 77, sequence: 42, firstSampleIndex: 84, pcm: pcm(42),
    }));

    const stats = await waitForReceiverStats(server, (value) => value.emittedPackets >= 1);
    assert.equal(stats.emittedPackets, 1, 'a restarted Relay accepts the continuing capture frontier');
    assert.equal(stats.futurePackets, 0);

    publisher.close();
    monitor.close();
  } finally {
    await server.stop();
  }
});

test('v2 media stays ordered and capture-authoritative across websocket reconnects', async () => {""",
)

print('browser/media/test recovery patch complete')
