import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MicCaptureRecoveryWatchdog } from '../public/mic-capture-recovery.js';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function snap(
  nowMs: number,
  contextTime: number,
  sampleCursor: number,
  contextState = 'running',
  visible = true,
) {
  return { nowMs, contextTime, sampleCursor, contextState, visible };
}

test('normal capture becomes healthy only after context clock and fresh PCM advance', () => {
  const watchdog = new MicCaptureRecoveryWatchdog({ stallAfterMs: 1000 });
  watchdog.start(snap(0, 1, 0));

  assert.equal(watchdog.status().recovering, true);
  assert.equal(watchdog.observe(snap(10, 1.01, 0)).recovered, false);
  assert.equal(watchdog.observe(snap(20, 1.02, 128), { freshPcm: true }).recovered, true);
  assert.equal(watchdog.status().recovering, false);
});

test('background foreground without sample progress becomes a capture discontinuity', () => {
  const watchdog = new MicCaptureRecoveryWatchdog({ hiddenDiscontinuityMs: 250 });
  watchdog.start(snap(0, 1, 128));
  watchdog.observe(snap(20, 1.02, 256), { freshPcm: true });
  watchdog.noteHidden(snap(100, 1.1, 256, 'suspended', false));

  const foreground = watchdog.noteForeground(snap(500, 1.1, 256, 'running', true));
  assert.equal(foreground.discontinuity, true);
  assert.equal(watchdog.observe(snap(510, 1.11, 256)).recovered, false);
  assert.equal(watchdog.observe(snap(520, 1.12, 384), { freshPcm: true }).recovered, true);
});

test('background partial progress followed by a long stall becomes a capture discontinuity', () => {
  const watchdog = new MicCaptureRecoveryWatchdog({ hiddenDiscontinuityMs: 250 });
  watchdog.start(snap(0, 1, 128));
  watchdog.noteHidden(snap(100, 1.1, 128, 'running', false));

  // WebKit may deliver a little more PCM after the page hides and only then
  // suspend the graph. That brief progress must not bless the whole hidden
  // interval as one continuous sample clock.
  watchdog.observe(snap(200, 1.2, 256, 'running', false), { freshPcm: true });
  const foreground = watchdog.noteForeground(snap(1_000, 1.2, 256, 'running', true));
  assert.equal(foreground.discontinuity, true);
});

test('background capture that keeps producing fresh PCM stays on the same generation', () => {
  const watchdog = new MicCaptureRecoveryWatchdog({ hiddenDiscontinuityMs: 250 });
  watchdog.start(snap(0, 1, 128));
  watchdog.noteHidden(snap(100, 1.1, 128, 'running', false));
  watchdog.observe(snap(700, 1.7, 256, 'running', false), { freshPcm: true });
  watchdog.observe(snap(900, 1.9, 384, 'running', false), { freshPcm: true });

  const foreground = watchdog.noteForeground(snap(1_000, 2.0, 384, 'running', true));
  assert.equal(foreground.discontinuity, false);
});

test('running AudioContext without PCM requests one graph rebuild', () => {
  const watchdog = new MicCaptureRecoveryWatchdog({ stallAfterMs: 100 });
  watchdog.start(snap(0, 1, 0));

  assert.equal(watchdog.observe(snap(50, 1.05, 0)).rebuild, false);
  const stalled = watchdog.observe(snap(120, 1.12, 0));
  assert.equal(stalled.contextAdvanced, true);
  assert.equal(stalled.rebuild, true);
  assert.equal(watchdog.observe(snap(140, 1.14, 0)).rebuild, false);
});

test('suspended or interrupted context requests resume without generation-storm rebuilds', () => {
  const watchdog = new MicCaptureRecoveryWatchdog({ stallAfterMs: 100 });
  watchdog.start(snap(0, 1, 0));

  const suspended = watchdog.observe(snap(150, 1, 0, 'suspended'));
  assert.equal(suspended.resume, true);
  assert.equal(suspended.rebuild, false);

  const interrupted = watchdog.observe(snap(300, 1, 0, 'interrupted'));
  assert.equal(interrupted.resume, true);
  assert.equal(interrupted.rebuild, false);
});

test('graph rebuild requires fresh PCM before recovery is accepted', () => {
  const watchdog = new MicCaptureRecoveryWatchdog({ stallAfterMs: 100 });
  watchdog.start(snap(0, 1, 0));
  assert.equal(watchdog.observe(snap(120, 1.12, 0)).rebuild, true);

  watchdog.noteGraphRebuilt(snap(130, 1.13, 0));
  assert.equal(watchdog.status().rebuildRequested, false);
  assert.equal(watchdog.observe(snap(140, 1.14, 0)).recovered, false);
  assert.equal(watchdog.observe(snap(150, 1.15, 128), { freshPcm: true }).recovered, true);
});

test('socket reconnect cannot count as capture recovery evidence', () => {
  const watchdog = new MicCaptureRecoveryWatchdog({ stallAfterMs: 100 });
  watchdog.start(snap(0, 1, 0));

  assert.equal(watchdog.observe(snap(50, 1.05, 0)).recovered, false);
  assert.equal(watchdog.status().recovering, true);
  assert.doesNotMatch(
    MicCaptureRecoveryWatchdog.toString(),
    /WebSocket|publisherActive|socket/,
    'the liveness state machine must remain sample/clock driven',
  );
});

test('app rebuild path advances generation and replaces the graph instead of splicing sample clocks', () => {
  assert.match(app, /function advanceCaptureGeneration\(reason\)[\s\S]*captureGeneration = \(\(captureGeneration >>> 0\) \+ 1\) >>> 0[\s\S]*captureSampleCursor = 0[\s\S]*capturePacketSequence = 0/);
  assert.match(app, /function rebuildPublisherCaptureGraph\(reason\)[\s\S]*advanceCaptureGeneration\(reason\)[\s\S]*installCaptureGraph/);
  assert.match(app, /micCaptureRecovery\.noteGraphRebuilt\(captureSnapshot\(\)\)/);
});

test('reconnect preserves a healthy generation while graph recovery re-registers the new one', () => {
  assert.match(app, /function schedulePublisherReconnect\(\s*sessionEpoch = publisherSessionEpoch,\s*expectedGeneration = captureGeneration >>> 0,\s*\)/);
  assert.match(app, /async function connectPublisherSocket\(\s*sessionEpoch = publisherSessionEpoch,\s*expectedGeneration = captureGeneration >>> 0,\s*\)/);
  assert.match(app, /captureGeneration: expectedGeneration/);
  assert.match(app, /restartPublisherConnectionForGeneration\(sessionEpoch, generation\)/);
});

test('stale async socket continuation and stale worklet messages cannot mutate replacement capture', () => {
  assert.match(app, /const ws = await connectSocket\(\);[\s\S]*!isCurrentPublisherCapture\(sessionEpoch, expectedGeneration\)[\s\S]*ws\.close\(\)/);
  assert.match(app, /function captureGraphIsCurrent\(graph\)[\s\S]*activeCaptureGraph === graph[\s\S]*graph\.epoch === captureGraphEpoch/);
  assert.match(app, /if \(!captureGraphIsCurrent\(graph\)\) return;/);
});

test('capture graph rebuild is single-flight and stop tears down the installed graph', () => {
  assert.match(app, /let captureGraphRebuildPromise = null/);
  assert.match(app, /if \(captureGraphRebuildPromise\) return captureGraphRebuildPromise/);
  assert.match(app, /const closingGraph = activeCaptureGraph/);
  assert.match(app, /disposeCaptureGraph\(closingGraph\)/);
});

test('track callbacks survive graph-generation changes but stay fenced to the Mic session', () => {
  assert.match(app, /const captureIsCurrent = \(\) => isCurrentPublisherSession\(sessionEpoch\)[\s\S]*mediaStream === captureStream[\s\S]*audioContext === captureContext/);
  assert.doesNotMatch(app, /const captureIsCurrent = \(\) => isCurrentPublisherCapture\(sessionEpoch, generation\)/);
});

test('foreground and unmute do not claim recovery before fresh PCM', () => {
  const unmuteAt = app.indexOf("track?.addEventListener('unmute'");
  const endedAt = app.indexOf("track?.addEventListener('ended'", unmuteAt);
  assert.ok(unmuteAt >= 0 && endedAt > unmuteAt);
  const unmute = app.slice(unmuteAt, endedAt);
  assert.doesNotMatch(unmute, /setStatus\('Microphone is live'/);
  assert.match(unmute, /beginCaptureRecovery\('input-unmuted'/);

  const foregroundAt = app.indexOf('function recoverPublisherAudio');
  const reconnectAt = app.indexOf('function schedulePublisherReconnect', foregroundAt);
  assert.ok(foregroundAt >= 0 && reconnectAt > foregroundAt);
  const foreground = app.slice(foregroundAt, reconnectAt);
  assert.doesNotMatch(foreground, /setStatus\('Microphone is live'/);
  assert.match(foreground, /micCaptureRecovery\.noteForeground/);
});
