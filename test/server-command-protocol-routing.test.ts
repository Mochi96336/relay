import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { functionCode, parseTypeScriptSource, variableInitializerCode } from './support/source-contract.js';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const protocol = readFileSync(new URL('../src/relay-command-protocol.ts', import.meta.url), 'utf8');
const songOrchestration = readFileSync(new URL('../src/relay-song-orchestration.ts', import.meta.url), 'utf8');
const songSource = parseTypeScriptSource(new URL('../src/relay-song-orchestration.ts', import.meta.url), songOrchestration);
const serverSource = parseTypeScriptSource(new URL('../src/server.ts', import.meta.url), server);

test('server delegates the extracted low-risk control-plane messages through the command protocol seam', () => {
  assert.match(server, /createRelayCommandProtocol<RelaySocket>/);
  assert.match(server, /commandProtocol\.dispatch\(socket, payload\)/);
  assert.match(protocol, /case 'start-take'/);
  assert.match(protocol, /case 'stop-take'/);
  assert.match(protocol, /case 'release-mic'/);
  assert.match(protocol, /case 'room-song-command'/);
  assert.match(protocol, /case 'room-song-command-failed'/);
  assert.match(protocol, /case 'song-handoff-ready'/);
  assert.match(protocol, /case 'song-handoff-failed'/);
  assert.match(protocol, /case 'participant-rename'/);
  assert.match(protocol, /case 'acquire-mic'/);
  assert.match(protocol, /case 'force-acquire-mic'/);
  assert.match(protocol, /case 'playback-mic-intent'/);
  assert.match(protocol, /case 'playback-hello'/);
  assert.match(protocol, /case 'youtube-telemetry'/);
  assert.match(protocol, /case 'set-vocal-fine-tune'/);
  assert.match(protocol, /case 'set-mix'/);
  assert.match(protocol, /case 'start-timing-calibration'/);
  assert.match(protocol, /case 'audio-uplink-health'/);
  assert.match(protocol, /case 'mic-presence-telemetry'/);

  assert.doesNotMatch(server, /payload\.type === 'start-take'/);
  assert.doesNotMatch(server, /payload\.type === 'stop-take'/);
  assert.doesNotMatch(server, /payload\.type === 'release-mic'/);
  assert.doesNotMatch(server, /payload\.type === 'room-song-command'/);
  assert.doesNotMatch(server, /payload\.type === 'room-song-command-failed'/);
  assert.doesNotMatch(server, /payload\.type === 'song-handoff-ready'/);
  assert.doesNotMatch(server, /payload\.type === 'song-handoff-failed'/);
  assert.doesNotMatch(server, /payload\.type === 'participant-rename'/);
  assert.doesNotMatch(server, /payload\.type === 'acquire-mic'/);
  assert.doesNotMatch(server, /payload\.type === 'force-acquire-mic'/);
  assert.doesNotMatch(server, /payload\.type === 'playback-mic-intent'/);
  assert.doesNotMatch(server, /payload\.type === 'playback-hello'/);
  assert.doesNotMatch(server, /payload\.type === 'youtube-telemetry'/);
  assert.doesNotMatch(server, /payload\.type === 'set-vocal-fine-tune'/);
  assert.doesNotMatch(server, /payload\.type === 'set-mix'/);
  assert.doesNotMatch(server, /payload\.type === 'start-timing-calibration'/);
  assert.doesNotMatch(server, /payload\.type === 'audio-uplink-health'/);
  assert.doesNotMatch(server, /payload\.type === 'mic-presence-telemetry'/);
});

test('the server composition boundary still owns the extracted message effects', () => {
  assert.match(server, /takeController\.start\(/);
  assert.match(server, /takeController\.stop\(/);
  assert.match(server, /takeFrameBoundary\(nowMs\)/);
  assert.match(server, /productStatusPayload\(nowMs\)/);
  assert.match(server, /participants\.releaseMic\(socket\.participantId\)/);
  const lifecycle = readFileSync(new URL('../src/relay-mic-lifecycle.ts', import.meta.url), 'utf8');
  assert.match(server, /relayMicLifecycle\.release\(/);
  assert.match(server, /applyOwnershipEffects: applyMicOwnerEffects/);
  assert.match(lifecycle, /commands\.applyOwnershipEffects\(current, performance\.now\(\), \{/);
  assert.match(lifecycle, /revokePublisherTransport: \(message\) => revokePublisherTransport\(message\)/);
  assert.match(server, /clearMicMediaAuthority\(\)/);
  assert.match(server, /micTransportGrace\.cancel\(\)/);
  assert.match(server, /parseRoomSongCommand\(payload\)/);
  assert.match(server, /roomSongCommands\.begin\(/);
  assert.match(server, /playbackTransport\.identity\(socket\)/);
  assert.match(server, /relaySongCommands\.accept\(\{/);
  const songBinding = variableInitializerCode(serverSource, 'relaySongCommands');
  assert.match(songBinding, /commands: roomSongCommands/);
  assert.match(songBinding, /song: youtubeTimeline/);
  assert.match(songBinding, /playback: playbackTransport/);
  assert.match(songBinding, /commandStatusPayload: roomSongCommandStatusPayload/);
  assert.match(songBinding, /send: sendJson, broadcast: broadcastJson/);
  assert.match(
    songOrchestration,
    /pendingForTarget: \(target, nowMs\) => commands\.pendingForTarget\(target, nowMs\)/,
  );
  assert.match(
    songOrchestration,
    /sendApply: \(target, command\) => playback\.send\(target, applyPayload\(command\)\)/,
  );
  assert.match(server, /rejectRoomSongCommand\(/);
  assert.match(functionCode(songSource, 'failPending'), /effects\.broadcast\(queries\.commandStatusPayload\(nowMs\)\)/);
  assert.match(server, /relaySongCommands\.failPending\(playbackIdentity, payload\.commandId, nowMs\)/);
  const failure = functionCode(songSource, 'failPending');
  assert.match(failure, /commands\.pendingForTarget\(identity, nowMs\)/);
  assert.match(failure, /commands\.fail\(identity, pending\.commandId\)/);
  assert.match(failure, /reportFailure\(pending\.commandId, 'playback-failed', nowMs\)/);
  assert.match(failure, /effects\.broadcast\(queries\.commandStatusPayload\(nowMs\)\)/);
  assert.match(server, /relaySongLifecycle\.ready\(\{/);
  assert.match(server, /relaySongLifecycle\.failed\(\{/);
  const lifecycleBinding = variableInitializerCode(serverSource, 'relaySongLifecycle');
  assert.match(lifecycleBinding, /song: youtubeTimeline/);
  assert.match(lifecycleBinding, /playback: playbackTransport/);
  assert.match(lifecycleBinding, /commands: roomSongCommands/);
  assert.match(lifecycleBinding, /commandOrchestration: relaySongCommands/);
  assert.match(lifecycleBinding, /commandStatusPayload: roomSongCommandStatusPayload/);
  assert.match(lifecycleBinding, /send: sendJson/);
  assert.match(lifecycleBinding, /broadcast: broadcastJson/);
  assert.match(lifecycleBinding, /crossCommands: \{ cancelActiveContentValidation, revokeContentMappingOnRateChange \}/);
  const handoff = variableInitializerCode(songSource, 'handoffResult');
  const registration = variableInitializerCode(songSource, 'registration');
  const telemetry = variableInitializerCode(songSource, 'telemetry');
  assert.match(handoff, /markReady: \(identity, handoffId, micOwnerId\) => song\.markHandoffReady\(identity, handoffId, micOwnerId\)/);
  assert.match(handoff, /defer: \(identity, handoffId\) => song\.deferHandoff\(identity, handoffId\)/);
  assert.match(handoff, /sendCommit: \(plan\) => \{ sendHandoffPlan\('song-handoff-commit', plan\); \}/);
  assert.match(handoff, /reportTimelineStatus: \(\) => effects\.broadcast\(song\.statusPayload\(\)\)/);
  assert.match(handoff, /reportRoomStatus: \(\) => effects\.broadcast\(song\.roomStatusPayload\(\)\)/);
  assert.match(server, /participants\.rename\(socket\.participantId, payload\.nickname, Date\.now\(\)\)/);
  assert.match(server, /Microphone ownership is committed by publisher registration/);
  assert.match(server, /playbackTransport\.noteMicIntent\(socket, performance\.now\(\)\)/);
  assert.match(server, /normalizePlaybackTransportId\(payload\.playbackTransportId\)/);
  assert.match(server, /normalizePlaybackGeneration\(payload\.playbackGeneration\)/);
  assert.match(server, /playbackTransport\.register\(socket,/);
  assert.match(server, /relaySongLifecycle\.continueRegistration\(\{/);
  assert.match(registration, /handoffPlanForTarget: \(identity\) => song\.handoffPlanForTarget\(identity\)/);
  assert.match(
    registration,
    /pendingCommandForTarget: \(identity, nowMs\) => commands\.pendingForTarget\(identity, nowMs\)/,
  );
  assert.match(
    registration,
    /sendCommandApply: \(identity, command\) => playback\.send\(identity, commandOrchestration\.applyPayload\(command\)\)/,
  );

  assert.match(server, /roomSongCommands\.gateTelemetry\(/);
  assert.match(server, /youtubeTimeline\.update\(/);
  assert.match(
    telemetry,
    /registerPlayback: \(socket, identity\) => \{ playback\.register\(socket, identity\); \}/,
  );
  assert.match(
    telemetry,
    /cancelActiveContentValidation: \(nowMs\) => crossCommands\.cancelActiveContentValidation\(nowMs\)/,
  );
  assert.match(
    telemetry,
    /completeRoomSongCommand: \(commandId\) => commands\.complete\(commandId\)/,
  );
  assert.match(telemetry, /releasePreviousLeader: \(previousLeader, handoffId, videoId\) => \{/);
  assert.match(telemetry, /playback\.send\(previousLeader,/);
  assert.match(telemetry, /type: 'song-handoff-complete'/);
  assert.match(server, /relaySongLifecycle\.acceptTelemetry\(\{/);
  assert.match(server, /reportRoomSongTelemetryRejected\(socket, commandGate\.reason\)/);
  assert.match(server, /reportTelemetryRejected\(socket, result\.reason \?\? 'invalid-telemetry'\)/);

  assert.match(server, /requireMicOwnerCommand\(socket, 'set-vocal-fine-tune'\)/);
  assert.match(server, /session\.setAlignment\(\{/);
  assert.match(server, /fineTuneMs: Math\.max\(-MAX_VOCAL_FINE_TUNE_MS, Math\.min\(MAX_VOCAL_FINE_TUNE_MS, nextFineTune\)\)/);
  assert.match(server, /requireMicOwnerCommand\(socket, 'set-mix'\)/);
  assert.match(server, /session\.setMicGainDb\(Math\.max\(0, Math\.min\(MAX_MIC_GAIN_DB, nextGain\)\)\)/);
  assert.match(server, /Song is now a server-owned 100% reference/);
  assert.match(server, /broadcastJson\(mixSettingsPayload\(\)\)/);
  assert.match(server, /requireMicOwnerCommand\(socket, 'start-timing-calibration'\)/);
  assert.match(server, /productStatusPayload\(nowMs\)\.actions/);
  assert.match(server, /restartManualBootCalibration\(nowMs\)/);
  assert.match(server, /timingRuntime\.beginContentCalibration\(nowMs, false\)/);
  assert.match(server, /calibration\.start\(nowMs\)/);
  assert.match(server, /parseAudioUplinkHealth\(payload\)/);
  assert.match(server, /const nowMs = performance\.now\(\)/);
  assert.match(server, /const accepted = micRuntime\.noteUplinkHealth\(socket, health, nowMs\)/);
  assert.match(server, /if \(accepted\) noteRecordingMicGapHealth\(health\)/);
  assert.match(
    server,
    /function noteRecordingMicGapHealth\(health: AudioUplinkHealth\)[\s\S]*takeController\.recordingTakeId[\s\S]*health\.inputGapActiveObserved !== true[\s\S]*previous\.takeId !== takeId[\s\S]*previous\.captureGeneration !== health\.captureGeneration[\s\S]*health\.inputGapSamples > previous\.inputGapSamples[\s\S]*takeController\.noteQualityEvent\('mic-input-gap'\)/,
    'accepted explicit source health must establish one per-Take baseline before gap deltas can become recording evidence',
  );

  assert.match(server, /parseMicPresenceTelemetry\(payload\)/);
  assert.match(server, /socket\.participantId !== participants\.micOwnerId/);
  assert.match(server, /socket\.participantId !== micRuntime\.mediaOwnerId/);
  assert.match(server, /presence\.captureGeneration !== micRuntime\.mediaGeneration/);
  assert.match(server, /socket\.micPresenceTelemetryAt = nowMs/);
  assert.match(server, /type: 'room-mic-presence'/);

  assert.doesNotMatch(
    protocol,
    /AudioSession|ParticipantSession|PlaybackTransportRuntime|SongSession|RoomSongCommandRuntime|sendJson|performance\.now/,
  );
});

test('registration and Robot lifecycle are not command authority', () => {
  assert.doesNotMatch(protocol, /case 'register'|robot-source-hello/);
  assert.match(server, /registrationProtocol\.dispatch\(socket, payload\)/);
  assert.match(server, /robotLifecycleProtocol\.dispatch\(socket, payload\)/);
});
