#!/usr/bin/env bash
set -euo pipefail

# The previous integration step leaves us on the synthesized `integration` branch.
test "$(git branch --show-current)" = 'integration'

python3 - <<'PY'
from pathlib import Path

path = Path('src/server.ts')
text = path.read_text()

# Preserve route intent through backing reconnect grace. #20 already accepts the
# explicit RouteMode input; #14's runtime collector is the missing caller seam.
if 'function readinessRouteMode()' not in text:
    anchor = 'function readinessPayload(nowMs = performance.now()) {'
    helper = """function readinessRouteMode() {
  if (backingIsRobot || activeRobotSource?.readyState === WebSocket.OPEN) return 'robot' as const;
  if (backing?.readyState === WebSocket.OPEN || backingAbsenceTimer !== null) return 'legacy' as const;
  return 'idle' as const;
}

"""
    assert anchor in text
    text = text.replace(anchor, helper + anchor, 1)

needle = '  return buildReadiness({\n    backingConnected:'
if needle in text:
    text = text.replace(
        needle,
        "  return buildReadiness({\n    routeMode: readinessRouteMode(),\n    backingConnected:",
        1,
    )

# A Take snapshot is valid even without a Song. Keep a stable nullable-song
# object so voice-only Takes remain first-class artifacts.
old = """function takeSongSnapshot(nowMs = performance.now()): TakeSongSnapshot | null {
  const room = youtubeTimeline.roomStatusPayload(nowMs) as Record<string, unknown>;
  if (typeof room.videoId !== 'string' || !room.videoId) return null;

  const revision = Number(room.revision);
  const state = Number(room.state);
  const serverTime = Number(room.serverTime);
  const playbackRate = Number(room.playbackRate);
  return {
    videoId: room.videoId,
    revision: Number.isInteger(revision) ? revision : null,
    state: Number.isFinite(state) ? state : null,
    serverTime: Number.isFinite(serverTime) ? serverTime : null,
    playbackRate: Number.isFinite(playbackRate) ? playbackRate : null,
  };
}"""
new = """function takeSongSnapshot(nowMs = performance.now()): TakeSongSnapshot {
  const room = youtubeTimeline.roomStatusPayload(nowMs) as Record<string, unknown>;
  const videoId = typeof room.videoId === 'string' && room.videoId ? room.videoId : null;
  if (videoId === null) {
    return {
      videoId: null,
      revision: null,
      state: null,
      serverTime: null,
      playbackRate: null,
    };
  }

  const revision = Number(room.revision);
  const state = Number(room.state);
  const serverTime = Number(room.serverTime);
  const playbackRate = Number(room.playbackRate);
  return {
    videoId,
    revision: Number.isInteger(revision) ? revision : null,
    state: Number.isFinite(state) ? state : null,
    serverTime: Number.isFinite(serverTime) ? serverTime : null,
    playbackRate: Number.isFinite(playbackRate) ? playbackRate : null,
  };
}"""
assert old in text
text = text.replace(old, new, 1)

old = """      const song = takeSongSnapshot();
      if (!song) {
        rejectTakeCommand(socket, 'start', 'song-required');
        return;
      }

      const result = takeController.start(socket.participantId, song);"""
new = """      const nowMs = performance.now();
      const song = takeSongSnapshot(nowMs);
      const micStreaming = micMediaConnected() && nowMs - lastMicFrameAt < STREAM_LIVE_MS;
      if (song.videoId === null && !micStreaming) {
        rejectTakeCommand(socket, 'start', 'take-not-ready');
        return;
      }

      const result = takeController.start(socket.participantId, song);"""
assert old in text
text = text.replace(old, new, 1)

path.write_text(text)

# Voice-only rooms now have a continuously clocked authoritative mixer. That
# makes monitor frame count intentionally independent of packet count, so pin
# packet ordering through the transport telemetry that #19 added for exactly
# this boundary.
path = Path('test/audio-packet-server.test.ts')
text = path.read_text()

anchor = "function registerV2(client: RelayClient, generation: number) {"
helper = """async function receiverStats(server: Awaited<ReturnType<typeof startRelay>>) {
  const response = await fetch(server.httpUrl('/statusz'));
  const status = await response.json() as any;
  return status.audio?.receiverTransport as Record<string, number> | null;
}

async function waitForReceiverStats(
  server: Awaited<ReturnType<typeof startRelay>>,
  predicate: (stats: Record<string, number>) => boolean,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stats = await receiverStats(server);
    if (stats && predicate(stats)) return stats;
    await sleep(10);
  }
  throw new Error('Timed out waiting for receiver transport stats');
}

"""
if 'async function receiverStats(' not in text:
    assert anchor in text
    text = text.replace(anchor, helper + anchor, 1)

old = """    publisher.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 7, sequence: 2, firstSampleIndex: 4, pcm: pcm(30),
    }));
    await sleep(30);
    assert.equal(monitor.binaryFrames, 1, 'packet 2 waits for packet 1 inside the reorder window');

    publisher.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 7, sequence: 1, firstSampleIndex: 2, pcm: pcm(20),
    }));
    await waitForBinaryFrames(monitor, 3);

    publisher.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 7, sequence: 2, firstSampleIndex: 4, pcm: pcm(30),
    }));
    publisher.sendUnheaderedPcm(pcm(99));
    publisher.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 6, sequence: 3, firstSampleIndex: 6, pcm: pcm(40),
    }));
    await sleep(30);
    assert.equal(monitor.binaryFrames, 3, 'duplicates, malformed v2 and wrong generations are rejected');"""
new = """    publisher.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 7, sequence: 2, firstSampleIndex: 4, pcm: pcm(30),
    }));
    let stats = await waitForReceiverStats(server, (value) => value.receivedPackets >= 2);
    assert.equal(stats.emittedPackets, 1, 'packet 2 waits for packet 1 inside the reorder window');
    assert.equal(stats.bufferedPackets, 1);
    assert.equal(stats.reorderedPackets, 1);

    publisher.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 7, sequence: 1, firstSampleIndex: 2, pcm: pcm(20),
    }));
    stats = await waitForReceiverStats(server, (value) => value.emittedPackets >= 3);
    assert.equal(stats.emittedPackets, 3);
    assert.equal(stats.bufferedPackets, 0);

    publisher.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 7, sequence: 2, firstSampleIndex: 4, pcm: pcm(30),
    }));
    publisher.sendUnheaderedPcm(pcm(99));
    publisher.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 6, sequence: 3, firstSampleIndex: 6, pcm: pcm(40),
    }));
    stats = await waitForReceiverStats(
      server,
      (value) => value.duplicatePackets >= 1
        && value.malformedPackets >= 1
        && value.wrongGenerationPackets >= 1,
    );
    assert.equal(stats.emittedPackets, 3, 'duplicates, malformed v2 and wrong generations are rejected');"""
assert old in text
text = text.replace(old, new, 1)

old = """    reconnected.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 7, sequence: 3, firstSampleIndex: 6, pcm: pcm(40),
    }));
    await waitForBinaryFrames(monitor, 4);"""
new = """    reconnected.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 7, sequence: 3, firstSampleIndex: 6, pcm: pcm(40),
    }));
    stats = await waitForReceiverStats(server, (value) => value.emittedPackets >= 4);
    assert.equal(stats.emittedPackets, 4, 'same-capture reconnect keeps receiver continuity');"""
assert old in text
text = text.replace(old, new, 1)

old = """    freshCapture.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 7, sequence: 4, firstSampleIndex: 8, pcm: pcm(50),
    }));
    await sleep(20);
    assert.equal(monitor.binaryFrames, 4, 'media cannot switch generation without control registration');

    freshCapture.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 8, sequence: 0, firstSampleIndex: 0, pcm: pcm(60),
    }));
    await waitForBinaryFrames(monitor, 5);"""
new = """    freshCapture.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 7, sequence: 4, firstSampleIndex: 8, pcm: pcm(50),
    }));
    stats = await waitForReceiverStats(server, (value) => value.wrongGenerationPackets >= 1);
    assert.equal(stats.emittedPackets, 0, 'media cannot switch generation without control registration');

    freshCapture.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 8, sequence: 0, firstSampleIndex: 0, pcm: pcm(60),
    }));
    stats = await waitForReceiverStats(server, (value) => value.emittedPackets >= 1);
    assert.equal(stats.emittedPackets, 1, 'fresh capture resets the receiver sequence origin');"""
assert old in text
text = text.replace(old, new, 1)

path.write_text(text)
PY

git add src/server.ts test/audio-packet-server.test.ts
git diff --check
git commit -m 'fix release integration runtime seams'

npm run check
find public -maxdepth 1 -name '*.js' -print0 | xargs -0 -n1 node --check
npm test

echo 'POSTFIX_TREE_GREEN'
