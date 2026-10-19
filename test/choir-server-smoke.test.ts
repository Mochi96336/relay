import assert from 'node:assert/strict';
import test from 'node:test';
import { startRelay, RelayClient, sleep, waitForNewMessage } from './helpers/harness.js';
import { encodePcmFrame } from '../src/pcm-frame.js';
import { encodeAudioPacket } from '../src/audio-packet.js';
import { participantIdForCapability } from '../src/participant-capability.js';
import { laggedMultibandMusicPair } from './helpers/music-calibration.js';

/**
 * With Choir off, Relay is the single-Mic Relay: no second Mic is advertised,
 * every second Mic message is refused, and nothing it sends seizes a media role.
 */
test('with Choir off, no second Mic is offered and its messages take no role', async () => {
  const relay = await startRelay();
  const clients: RelayClient[] = [];
  try {
    const page = await fetch(relay.httpUrl('/'));
    assert.equal(page.status, 200);
    const [client, publisher] = await Promise.all([RelayClient.connect(relay), RelayClient.connect(relay)]);
    clients.push(client, publisher);
    const capability = '9'.repeat(64);
    const participantId = participantIdForCapability(capability)!;
    client.send({ type: 'participant-authenticate', participantId, capability, nickname: 'A' });
    await client.waitForType('participant-authenticated');
    client.send({ type: 'choir-secondary-join' });
    assert.equal((await client.waitForType('choir-consent-rejected')).reason, 'unavailable');
    client.send({ type: 'choir-secondary-media-claim-request' });
    await client.waitFor((m) => m.type === 'choir-media-rejected' && m.reason === 'disabled-or-unverified');
    client.send({ type: 'choir-secondary-media-register',
      claimToken: 'a'.repeat(64), packetVersion: 2, sampleRate: 48_000 });
    await client.waitFor((m) => m.type === 'choir-media-rejected' && m.reason === 'disabled-or-unverified');
    client.sendBinary(encodePcmFrame(7, 0, Buffer.from(new Int16Array(960).fill(8_000).buffer)));
    assert.equal(client.messages.some((m) => m.type === 'choir-available'), false,
      'Choir off must not advertise the second Mic');
    // The same socket still takes an ordinary role: nothing above seized one.
    client.send({ type: 'register', role: 'monitor' });
    assert.equal((await client.waitForType('registered')).role, 'monitor');

    publisher.send({ type: 'register', role: 'publisher', sampleRate: 48_000 });
    assert.equal((await publisher.waitForType('registered')).role, 'publisher');
    publisher.sendPcm(Buffer.from(new Int16Array(960).fill(5_000).buffer));
    assert.equal(publisher.errors.length, 0);
  } finally {
    for (const c of clients) c.close();
    await relay.stop();
  }
});

test('a joined B claims media on its own socket, takes no main Mic role, and is placed by Content', async () => {
  const relay = await startRelay({
    RELAY_CHOIR: '1',
    RELAY_TEST_LEGACY_PARTICIPANTS: '0',
    RELAY_AUTO_CALIBRATE: '0', RELAY_HEARTBEAT_MS: '60000',
  });
  const clients: RelayClient[] = [];
  const connect = async () => {
    const c = await RelayClient.connect(relay);
    clients.push(c);
    return c;
  };
  try {
    const [a, b, publisher, robotBacking, robotControl, bMedia] = await Promise.all(
      Array.from({ length: 6 }, () => connect()),
    );
    const capA = 'e'.repeat(64);
    const capB = 'f'.repeat(64);
    const idA = participantIdForCapability(capA)!;
    const idB = participantIdForCapability(capB)!;
    const authenticate = async (client: RelayClient, id: string, cap: string) => {
      client.send({ type: 'participant-authenticate', participantId: id,
        capability: cap, nickname: id === idA ? 'A' : 'B' });
      await client.waitFor((m) =>
        m.type === 'participant-authenticated' && m.participantId === id);
    };
    await Promise.all([
      authenticate(a, idA, capA),
      authenticate(b, idB, capB),
      authenticate(publisher, idA, capA),
      authenticate(bMedia, idB, capB),
    ]);
    await a.waitForType('choir-available');
    publisher.send({ type: 'register', role: 'publisher', sampleRate: 48_000,
      captureGeneration: 1, initialSequence: 0, audioPacketVersion: 2 });
    await publisher.waitFor((m) => m.type === 'registered' && m.role === 'publisher');
    robotBacking.send({ type: 'register', role: 'backing', robot: true,
      sampleRate: 48_000, captureGeneration: 9, captureSampleCursor: 0 });
    await robotBacking.waitFor((m) => m.type === 'registered' && m.role === 'backing');
    robotBacking.resumeCaptureSession(9, 0);
    robotBacking.sendPcm(Buffer.from(new Int16Array(960).fill(900).buffer));
    robotControl.send({ type: 'robot-source-hello' });
    a.send({ type: 'playback-hello', playbackTransportId: 'choir-media-playback-a',
      playbackGeneration: 1 });
    await a.waitForType('playback-registered');
    a.send({ type: 'room-song-command', commandId: 'media-load-1',
      expectedRevision: 0, action: 'load', videoId: 'dQw4w9WgXcQ',
      positionSeconds: 10 });
    await a.waitFor((m) => m.type === 'room-song-command-apply'
      && m.commandId === 'media-load-1');
    const telemetry = (state: number, position: number) => ({
      type: 'youtube-telemetry', videoId: 'dQw4w9WgXcQ', state,
      currentTime: position, duration: 200, playbackRate: 1,
      bufferedFraction: .8, playbackTransportId: 'choir-media-playback-a',
      playbackGeneration: 1,
    });
    a.send(telemetry(5, 10));
    await a.waitFor((m) => m.type === 'room-song-command-complete'
      && m.commandId === 'media-load-1');
    a.send({ type: 'room-song-command', commandId: 'media-play-1',
      expectedRevision: 1, action: 'play' });
    await a.waitFor((m) => m.type === 'room-song-command-apply'
      && m.commandId === 'media-play-1');
    const playbackBeganAt = Date.now();
    a.send(telemetry(1, 10.1));
    await a.waitFor((m) => m.type === 'room-song-command-complete'
      && m.commandId === 'media-play-1');
    await sleep(350);

    // An authenticated B that has not joined can never claim media.
    b.send({ type: 'choir-secondary-media-claim-request' });
    assert.equal((await b.waitFor((m) =>
      m.type === 'choir-media-rejected' && m.reason === 'claim-not-authorized')).reason,
    'claim-not-authorized');

    b.send({ type: 'choir-secondary-join' });
    await b.waitFor((m) => m.type === 'choir-secondary-consent-status'
      && m.status === 'accepted');
    await b.waitForType('choir-media-ready');
    // Another tab of B is not the socket B joined from.
    bMedia.send({ type: 'choir-secondary-media-claim-request' });
    await bMedia.waitFor((m) => m.type === 'choir-media-rejected' && m.reason === 'claim-not-authorized');

    b.send({ type: 'choir-secondary-media-claim-request' });
    const claim = await b.waitForType('choir-secondary-media-claim');
    assert.match(claim.claimToken, /^[0-9a-f]{64}$/);
    assert.ok(claim.expiresInMs <= 15_000);

    // Whatever else the page names, the server alone decides what this is.
    const beforeRegister = bMedia.messages.length;
    bMedia.send({ type: 'choir-secondary-media-register',
      claimToken: claim.claimToken, sampleRate: 48_000,
      packetVersion: 2, seat: 'primary', transportId: 'forged' });
    const registration = await waitForNewMessage(bMedia, beforeRegister, (m) =>
      m.type === 'choir-secondary-media-registered'
      || m.type === 'choir-media-rejected');
    assert.equal(registration.type, 'choir-secondary-media-registered',
      `B's real authenticated media Socket could not redeem: ${JSON.stringify(registration)}`);
    assert.equal(registration.sampleRate, 48_000);
    assert.equal(bMedia.messages.some(m => m.type === 'registered' && m.role === 'publisher'),
      false, 'B never claims the production N=1 Mic');

    bMedia.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 7, firstSampleIndex: 0, sequence: 0,
      pcm: Buffer.from(new Int16Array(960).fill(4_000).buffer),
    }));
    bMedia.send({ type: 'register', role: 'publisher', sampleRate: 48_000 });
    await sleep(75);
    assert.equal(bMedia.messages.some(m => m.type === 'registered'),
      false, 'an admitted B PCM socket cannot take another production role');

    // Real WebSocket end-to-end six-second Content measurement. A uses the
    // main v2 Mic receiver, the Robot the backing receiver, and B its own
    // one-use v2 transport.
    // Pace the real network clock; sending 7s at once would fabricate an
    // unrepresentative future capture timeline.
    const { mic, backing } = laggedMultibandMusicPair(
      12, 48_000, 120, { singerGain: .18 },
    );
    const frameSamples = 960;
    const frameBytes = frameSamples * 2;
    // Keep real PCM and playback-owner telemetry alive until BOTH sequential
    // Worker jobs complete. Stopping at 7.5s made B depend on CPU speed: A's
    // job could finish just as the remaining source window/authority expired.
    // The finite fixture still bounds the test if either job never completes.
    const statusAudio = async () => (await (await fetch(relay.httpUrl('/statusz'))).json()).audio;
    // Twice through the clip: a window rejected on a slow host gets a retry
    // before the song would run out.
    const clipFrames = mic.byteLength / frameBytes;
    for (let i = 0; i < 2 * clipFrames; i++) {
      if (i % 50 === 0 && (await statusAudio())?.duetYoutube?.lagSource === 'content') break;
      const start = (i % clipFrames) * frameBytes;
      const end = start + frameBytes;
      publisher.sendAudioPacket(mic.subarray(start, end));
      robotBacking.sendPcm(backing.subarray(start, end));
      bMedia.sendBinary(encodeAudioPacket({
        source: 'mic', generation: 7,
        firstSampleIndex: frameSamples * (i + 1), sequence: i + 1,
        pcm: mic.subarray(start, end),
      }));
      if (i % 25 === 0) {
        // Playback owner authority must remain fresh for both singer jobs.
        a.send(telemetry(1, 10.1 + (Date.now() - playbackBeganAt) / 1_000));
      }
      await sleep(20);
    }
    const proofDeadline = Date.now() + 8_000;
    while ((await statusAudio())?.duetYoutube?.lagSource !== 'content'
      && Date.now() < proofDeadline) await sleep(100);
    const audio = await statusAudio();
    assert.equal(audio?.duetYoutube?.lagSource, 'content',
      'both singers must independently complete the server-owned Content '
      + 'Worker measurement from WebSocket PCM; ' + JSON.stringify(audio?.duetContent));
    assert.equal(bMedia.messages.some(m => m.type === 'registered'),
      false, 'B must remain outside the N=1 publisher path after calibration');
    // B now sings in the room output, the mix Listen and Take carry, at A's
    // advance plus B's measured lag difference.
    const duetSecondary = async () =>
      (await (await fetch(relay.httpUrl('/statusz'))).json()).audio?.duetSecondary ?? null;
    let duet: any = null;
    for (const until = Date.now() + 2_000; Date.now() < until; await sleep(30)) {
      duet = await duetSecondary();
      if (duet?.audible) break;
    }
    assert.equal(duet?.audible, true, `B is in the room mix once measured: ${JSON.stringify(duet)}`);
    assert.ok(Number.isFinite(duet.lagMs), 'B has a lag in room-output coordinates');
    assert.ok(duet.bufferedSamples > 0, "B's PCM reached the room output");
    // B leaving takes B out of the mix at once.
    b.send({ type: 'choir-secondary-withdraw' });
    await b.waitFor((m) => m.type === 'choir-secondary-consent-status'
      && m.status === 'withdrawn');
    for (const until = Date.now() + 2_000; Date.now() < until; await sleep(30)) {
      duet = await duetSecondary();
      if (!duet?.audible) break;
    }
    assert.ok(!duet?.audible, `a withdrawn B leaves the room mix: ${JSON.stringify(duet)}`);
    bMedia.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 7, firstSampleIndex: 960, sequence: 1,
      pcm: Buffer.from(new Int16Array(960).fill(4_000).buffer),
    }));
    await sleep(50);
    const beforeLeftClaim = b.messages.length;
    b.send({ type: 'choir-secondary-media-claim-request' });
    assert.equal((await waitForNewMessage(b, beforeLeftClaim, (m) => m.type === 'choir-media-rejected'
      || m.type === 'choir-secondary-media-claim')).reason, 'claim-not-authorized');
    assert.equal(publisher.errors.length, 0,
      'the production N=1 publisher remains unaffected by B experimental PCM');
  } finally {
    for (const client of clients) client.close();
    await relay.stop();
  }
});

test('B joins by its own press, sets its own gain, and can be taken over like the Mic', async () => {
  const relay = await startRelay({
    RELAY_CHOIR: '1',
    RELAY_TEST_LEGACY_PARTICIPANTS: '0',
    RELAY_AUTO_CALIBRATE: '0', RELAY_HEARTBEAT_MS: '60000',
  });
  const clients: RelayClient[] = [];
  const connect = async () => {
    const c = await RelayClient.connect(relay);
    clients.push(c);
    return c;
  };
  try {
    const [a, b, publisher, robotBacking, robotControl, bMedia] = await Promise.all(
      Array.from({ length: 6 }, () => connect()),
    );
    const capA = 'c'.repeat(64);
    const capB = 'd'.repeat(64);
    const idA = participantIdForCapability(capA)!;
    const idB = participantIdForCapability(capB)!;
    const authenticate = async (client: RelayClient, id: string, cap: string) => {
      client.send({ type: 'participant-authenticate', participantId: id,
        capability: cap, nickname: id === idA ? 'A' : 'B' });
      await client.waitFor((m) =>
        m.type === 'participant-authenticated' && m.participantId === id);
    };
    await Promise.all([
      authenticate(a, idA, capA), authenticate(b, idB, capB),
      authenticate(publisher, idA, capA), authenticate(bMedia, idB, capB),
    ]);
    publisher.send({ type: 'register', role: 'publisher', sampleRate: 48_000,
      captureGeneration: 1, initialSequence: 0, audioPacketVersion: 2 });
    await publisher.waitFor((m) => m.type === 'registered' && m.role === 'publisher');
    robotBacking.send({ type: 'register', role: 'backing', robot: true,
      sampleRate: 48_000, captureGeneration: 9, captureSampleCursor: 0 });
    await robotBacking.waitFor((m) => m.type === 'registered' && m.role === 'backing');
    robotBacking.resumeCaptureSession(9, 0);
    robotBacking.sendPcm(Buffer.from(new Int16Array(960).fill(900).buffer));
    robotControl.send({ type: 'robot-source-hello' });
    a.send({ type: 'playback-hello', playbackTransportId: 'choir-join-playback-a',
      playbackGeneration: 1 });
    await a.waitForType('playback-registered');
    a.send({ type: 'room-song-command', commandId: 'join-load-1',
      expectedRevision: 0, action: 'load', videoId: 'dQw4w9WgXcQ', positionSeconds: 10 });
    await a.waitFor((m) => m.type === 'room-song-command-apply' && m.commandId === 'join-load-1');
    const telemetry = (state: number, position: number) => ({
      type: 'youtube-telemetry', videoId: 'dQw4w9WgXcQ', state,
      currentTime: position, duration: 200, playbackRate: 1,
      bufferedFraction: .8, playbackTransportId: 'choir-join-playback-a',
      playbackGeneration: 1,
    });
    a.send(telemetry(5, 10));
    await a.waitFor((m) => m.type === 'room-song-command-complete' && m.commandId === 'join-load-1');

    // B joins A by its own press while nothing plays. A sends nothing.
    b.send({ type: 'choir-secondary-join' });
    const joined = await b.waitFor((m) => m.type === 'choir-secondary-consent-status'
      || m.type === 'choir-consent-rejected');
    assert.equal(joined.status, 'accepted', JSON.stringify(joined));
    assert.equal(joined.joined, true);
    await b.waitForType('choir-media-ready', 5_000);
    b.send({ type: 'choir-secondary-media-claim-request' });
    const claim = await b.waitForType('choir-secondary-media-claim');
    bMedia.send({ type: 'choir-secondary-media-register',
      claimToken: claim.claimToken, sampleRate: 48_000, packetVersion: 2 });
    const registration = await bMedia.waitFor((m) => m.type === 'choir-secondary-media-registered'
      || m.type === 'choir-media-rejected');
    assert.equal(registration.type, 'choir-secondary-media-registered', JSON.stringify(registration));

    const pcm = Buffer.from(new Int16Array(960).fill(3_000).buffer);
    let sequence = 0;
    const singing = setInterval(() => {
      publisher.sendAudioPacket(pcm);
      robotBacking.sendPcm(pcm);
      bMedia.sendBinary(encodeAudioPacket({
        source: 'mic', generation: 7, firstSampleIndex: 960 * sequence, sequence, pcm,
      }));
      sequence += 1;
    }, 20);
    try {
      const duetSecondary = async () =>
        (await (await fetch(relay.httpUrl('/statusz'))).json()).audio?.duetSecondary ?? null;
      let duet: any = null;
      for (const until = Date.now() + 4_000; Date.now() < until; await sleep(50)) {
        duet = await duetSecondary();
        if (duet?.audible) break;
      }
      assert.equal(duet?.audible, true, `the joined B sings in the room mix: ${JSON.stringify(duet)}`);

      // B sets its own Mic gain from its page.
      b.send({ type: 'choir-secondary-gain', micGainDb: 12 });
      for (const until = Date.now() + 2_000; Date.now() < until; await sleep(30)) {
        duet = await duetSecondary();
        if (duet?.gainDb === 12) break;
      }
      assert.equal(duet?.gainDb, 12, JSON.stringify(duet));
      // Only the joined B: someone else's gain is ignored.
      a.send({ type: 'choir-secondary-gain', micGainDb: 30 });
      await sleep(300);
      assert.equal((await duetSecondary())?.gainDb, 12);

      // C takes over the second Mic, as the Mic itself can be taken over:
      // B is told it was replaced and leaves the room mix, and C is asked
      // for its media.
      const c = await connect();
      const capC = 'e'.repeat(64);
      const idC = participantIdForCapability(capC)!;
      c.send({ type: 'participant-authenticate', participantId: idC, capability: capC, nickname: 'C' });
      await c.waitFor((m) => m.type === 'participant-authenticated' && m.participantId === idC);
      c.send({ type: 'choir-secondary-join' });
      const cIn = await c.waitFor((m) => m.type === 'choir-secondary-consent-status' || m.type === 'choir-consent-rejected');
      assert.equal(cIn.status, 'accepted', JSON.stringify(cIn));
      const replaced = await b.waitFor((m) => m.type === 'choir-secondary-consent-status' && m.status === 'revoked');
      assert.equal(replaced.reason, 'replaced');
      for (const until = Date.now() + 2_000; Date.now() < until; await sleep(30)) {
        duet = await duetSecondary();
        if (!duet?.audible) break;
      }
      assert.ok(!duet?.audible, `the replaced B leaves the room mix: ${JSON.stringify(duet)}`);
      await c.waitForType('choir-media-ready', 5_000);
      const beforeReplacedClaim = b.messages.length;
      b.send({ type: 'choir-secondary-media-claim-request' });
      assert.equal((await waitForNewMessage(b, beforeReplacedClaim, (m) => m.type === 'choir-media-rejected'
        || m.type === 'choir-secondary-media-claim')).reason, 'claim-not-authorized');
    } finally {
      clearInterval(singing);
    }
  } finally {
    for (const client of clients) client.close();
    await relay.stop();
  }
});

test('a joined B is heard with no song, and a song starting keeps B on the same connection', async () => {
  const relay = await startRelay({
    RELAY_CHOIR: '1',
    RELAY_TEST_LEGACY_PARTICIPANTS: '0',
    RELAY_AUTO_CALIBRATE: '0', RELAY_HEARTBEAT_MS: '60000',
  });
  const clients: RelayClient[] = [];
  const connect = async () => {
    const c = await RelayClient.connect(relay);
    clients.push(c);
    return c;
  };
  try {
    const [a, b, publisher, robotBacking, robotControl, bMedia] = await Promise.all(
      Array.from({ length: 6 }, () => connect()),
    );
    const capA = 'c'.repeat(64);
    const capB = 'd'.repeat(64);
    const idA = participantIdForCapability(capA)!;
    const idB = participantIdForCapability(capB)!;
    const authenticate = async (client: RelayClient, id: string, cap: string) => {
      client.send({ type: 'participant-authenticate', participantId: id,
        capability: cap, nickname: id === idA ? 'A' : 'B' });
      await client.waitFor((m) =>
        m.type === 'participant-authenticated' && m.participantId === id);
    };
    await Promise.all([
      authenticate(a, idA, capA), authenticate(b, idB, capB),
      authenticate(publisher, idA, capA), authenticate(bMedia, idB, capB),
    ]);
    publisher.send({ type: 'register', role: 'publisher', sampleRate: 48_000,
      captureGeneration: 1, initialSequence: 0, audioPacketVersion: 2 });
    await publisher.waitFor((m) => m.type === 'registered' && m.role === 'publisher');
    robotBacking.send({ type: 'register', role: 'backing', robot: true,
      sampleRate: 48_000, captureGeneration: 9, captureSampleCursor: 0 });
    await robotBacking.waitFor((m) => m.type === 'registered' && m.role === 'backing');
    robotBacking.resumeCaptureSession(9, 0);
    robotBacking.sendPcm(Buffer.from(new Int16Array(960).fill(900).buffer));
    robotControl.send({ type: 'robot-source-hello' });
    a.send({ type: 'playback-hello', playbackTransportId: 'choir-join-playback-a',
      playbackGeneration: 1 });
    await a.waitForType('playback-registered');
    a.send({ type: 'room-song-command', commandId: 'join-load-1',
      expectedRevision: 0, action: 'load', videoId: 'dQw4w9WgXcQ', positionSeconds: 10 });
    await a.waitFor((m) => m.type === 'room-song-command-apply' && m.commandId === 'join-load-1');
    const telemetry = (state: number, position: number) => ({
      type: 'youtube-telemetry', videoId: 'dQw4w9WgXcQ', state,
      currentTime: position, duration: 200, playbackRate: 1,
      bufferedFraction: .8, playbackTransportId: 'choir-join-playback-a',
      playbackGeneration: 1,
    });
    a.send(telemetry(5, 10));
    await a.waitFor((m) => m.type === 'room-song-command-complete' && m.commandId === 'join-load-1');

    b.send({ type: 'choir-secondary-join' });
    const joined = await b.waitFor((m) => m.type === 'choir-secondary-consent-status'
      || m.type === 'choir-consent-rejected');
    assert.equal(joined.status, 'accepted', JSON.stringify(joined));

    // No song: the server asks B for media all the same.
    await b.waitForType('choir-media-ready', 5_000);
    b.send({ type: 'choir-secondary-media-claim-request' });
    const claim = await b.waitForType('choir-secondary-media-claim');
    bMedia.send({ type: 'choir-secondary-media-register',
      claimToken: claim.claimToken, sampleRate: 48_000, packetVersion: 2 });
    const registration = await bMedia.waitFor((m) => m.type === 'choir-secondary-media-registered'
      || m.type === 'choir-media-rejected');
    assert.equal(registration.type, 'choir-secondary-media-registered', JSON.stringify(registration));

    const pcm = Buffer.from(new Int16Array(960).fill(3_000).buffer);
    let sequence = 0;
    const singing = setInterval(() => {
      publisher.sendAudioPacket(pcm);
      robotBacking.sendPcm(pcm);
      bMedia.sendBinary(encodeAudioPacket({
        source: 'mic', generation: 7, firstSampleIndex: 960 * sequence, sequence, pcm,
      }));
      sequence += 1;
    }, 20);
    try {
      const status = async () => (await (await fetch(relay.httpUrl('/statusz'))).json()).audio;
      let audio: any = null;
      for (const until = Date.now() + 4_000; Date.now() < until; await sleep(50)) {
        audio = await status();
        if (audio?.duetSecondary?.audible && audio.duetSecondary.recentlyHeard) break;
      }
      assert.equal(audio?.duetSecondary?.audible, true, `B is heard with no song: ${JSON.stringify(audio?.duetSecondary)}`);
      assert.equal(audio.duetSecondary.recentlyHeard, true);
      assert.equal(audio.duetYoutube.lagSource, 'no-song');
      const asked = b.messages.filter((m) => m.type === 'choir-media-ready').length;

      // A song starts: B carries on, on the connection it already has.
      a.send({ type: 'room-song-command', commandId: 'join-play-1',
        expectedRevision: 1, action: 'play' });
      await a.waitFor((m) => m.type === 'room-song-command-apply' && m.commandId === 'join-play-1');
      const playbackBeganAt = Date.now();
      a.send(telemetry(1, 10.1));
      await a.waitFor((m) => m.type === 'room-song-command-complete' && m.commandId === 'join-play-1');
      const keepPlaying = setInterval(() => a.send(telemetry(1, 10.1 + (Date.now() - playbackBeganAt) / 1_000)), 500);
      try {
        await sleep(3_500);
        assert.equal(b.messages.filter((m) => m.type === 'choir-media-ready').length, asked,
          'B is never asked to reconnect');
        assert.equal(relay.stdout().includes('"event":"b-media-disconnected"'), false);
        audio = await status();
        assert.equal(audio.duetSecondary.audible, true, 'B stays in the mix as the song starts');
      } finally {
        clearInterval(keepPlaying);
      }
    } finally {
      clearInterval(singing);
    }
  } finally {
    for (const client of clients) client.close();
    await relay.stop();
  }
});

test('without Content, B is placed by its YouTube time against the Robot', async () => {
  const relay = await startRelay({
    RELAY_CHOIR: '1',
    RELAY_TEST_LEGACY_PARTICIPANTS: '0',
    RELAY_AUTO_CALIBRATE: '0', RELAY_HEARTBEAT_MS: '60000',
  });
  const clients: RelayClient[] = [];
  try {
    const [a, b, publisher, robotBacking, robotControl, bMedia] = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const c = await RelayClient.connect(relay);
        clients.push(c);
        return c;
      }),
    );
    const capA = 'f'.repeat(64);
    const capB = '9'.repeat(64);
    const idA = participantIdForCapability(capA)!;
    const idB = participantIdForCapability(capB)!;
    const authenticate = async (client: RelayClient, id: string, cap: string) => {
      client.send({ type: 'participant-authenticate', participantId: id, capability: cap, nickname: id === idA ? 'A' : 'B' });
      await client.waitFor((m) => m.type === 'participant-authenticated' && m.participantId === id);
    };
    await Promise.all([
      authenticate(a, idA, capA), authenticate(b, idB, capB),
      authenticate(publisher, idA, capA), authenticate(bMedia, idB, capB),
    ]);
    publisher.send({ type: 'register', role: 'publisher', sampleRate: 48_000,
      captureGeneration: 1, initialSequence: 0, audioPacketVersion: 2 });
    await publisher.waitFor((m) => m.type === 'registered' && m.role === 'publisher');
    robotBacking.send({ type: 'register', role: 'backing', robot: true,
      sampleRate: 48_000, captureGeneration: 9, captureSampleCursor: 0 });
    await robotBacking.waitFor((m) => m.type === 'registered' && m.role === 'backing');
    robotBacking.resumeCaptureSession(9, 0);
    robotBacking.sendPcm(Buffer.from(new Int16Array(960).fill(900).buffer));
    robotControl.send({ type: 'robot-source-hello' });
    const videoId = 'dQw4w9WgXcQ';
    a.send({ type: 'playback-hello', playbackTransportId: 'choir-yt-playback-a', playbackGeneration: 1 });
    await a.waitForType('playback-registered');
    const telemetry = (state: number, position: number, captureAnchor?: unknown) => ({
      type: 'youtube-telemetry', videoId, state, currentTime: position, duration: 200,
      playbackRate: 1, bufferedFraction: .8, playbackTransportId: 'choir-yt-playback-a', playbackGeneration: 1,
      captureAnchor,
    });
    a.send({ type: 'room-song-command', commandId: 'yt-load-1', expectedRevision: 0, action: 'load', videoId, positionSeconds: 10 });
    const loaded = await a.waitFor((m) => (m.type === 'room-song-command-apply' || m.type === 'room-song-command-rejected') && m.commandId === 'yt-load-1');
    assert.equal(loaded.type, 'room-song-command-apply', JSON.stringify(loaded));
    a.send(telemetry(5, 10));
    await a.waitFor((m) => m.type === 'room-song-command-complete' && m.commandId === 'yt-load-1');
    b.send({ type: 'choir-secondary-join' });
    const joined = await b.waitFor((m) => m.type === 'choir-secondary-consent-status' || m.type === 'choir-consent-rejected');
    assert.equal(joined.status, 'accepted', JSON.stringify(joined));
    a.send({ type: 'room-song-command', commandId: 'yt-play-1', expectedRevision: 1, action: 'play' });
    await a.waitFor((m) => m.type === 'room-song-command-apply' && m.commandId === 'yt-play-1');
    const playBeganAt = Date.now();
    const songAt = (unixMs: number) => 10 + (unixMs - playBeganAt) / 1_000;
    a.send(telemetry(1, 10));
    await a.waitFor((m) => m.type === 'room-song-command-complete' && m.commandId === 'yt-play-1');
    await b.waitForType('choir-media-ready', 5_000);
    b.send({ type: 'choir-secondary-media-claim-request' });
    const claim = await b.waitForType('choir-secondary-media-claim');
    bMedia.send({ type: 'choir-secondary-media-register', claimToken: claim.claimToken, sampleRate: 48_000, packetVersion: 2 });
    const registration = await bMedia.waitFor((m) => m.type === 'choir-secondary-media-registered' || m.type === 'choir-media-rejected');
    assert.equal(registration.type, 'choir-secondary-media-registered', JSON.stringify(registration));

    // Both singers silent: Content can never place B. The YouTube time can:
    // B's player is 150 ms behind the Robot's at the same moment of capture.
    const frame = 960;
    const silence = Buffer.alloc(frame * 2);
    const backingPcm = Buffer.from(new Int16Array(frame).fill(900).buffer);
    const startedAt = Date.now();
    const loopSong = songAt(startedAt);
    let duet: any = null;
    let audio: any = null;
    let i = 0;
    // Wall-clock pacing, so the 20 ms frames keep up with real time.
    let bAnchors = true;
    // One 20 ms frame of every source; every 240 ms, A's and the Robot's
    // song positions, and B's while bAnchors is on.
    const step = async () => {
      while (Date.now() - startedAt < i * 20) await sleep(2);
      publisher.sendAudioPacket(silence);
      robotBacking.sendPcm(backingPcm);
      bMedia.sendBinary(encodeAudioPacket({ source: 'mic', generation: 7,
        firstSampleIndex: frame * i, sequence: i, pcm: silence }));
      if (i % 12 !== 11) return;
      const cursor = frame * (i + 1);
      const at = Date.now();
      // Where the song was when this sample was captured.
      const robotSeconds = loopSong + cursor / 48_000;
      const anchor = (generation: number) => ({ generation, sampleRate: 48_000,
        sampleIndex: cursor, mediaDeltaSeconds: 0, uncertaintyMs: 40 });
      // A's player reports real time, as the server projects it (a lagging
      // test loop must not look like a Seek); its anchor says where the song
      // was at the sample.
      a.send(telemetry(1, songAt(at), { ...anchor(1), mediaDeltaSeconds: robotSeconds - songAt(at) }));
      robotControl.send({ type: 'robot-player-offset', offsetMs: 0, songObservation: {
        videoId, state: 1, mediaSeconds: robotSeconds, playbackRate: 1, observedAtUnixMs: at } });
      robotBacking.send({ type: 'backing-song-clock', generation: 9, sampleRate: 48_000,
        sampleIndex: cursor, observedAtUnixMs: at });
      if (bAnchors) b.send({ type: 'choir-secondary-song-anchor', videoId, state: 1, playbackRate: 1,
        currentTime: robotSeconds - .15, captureAnchor: anchor(7) });
    };
    for (; Date.now() - startedAt < 8_000; i++) {
      await step();
      if (i % 48 !== 47) continue;
      audio = (await (await fetch(relay.httpUrl('/statusz'))).json()).audio;
      duet = audio?.duetSecondary ?? null;
      if (duet?.audible && relay.stdout().includes('"source":"youtube-time"')) break;
    }
    assert.match(relay.stdout(), /"event":"b-lag-source","source":"youtube-time"/,
      `${relay.stdout().split('\n').filter((l) => l.startsWith('[choir]')).join('\n')}\n${JSON.stringify({ duet, youtube: audio?.duetYoutube })}`);
    assert.equal(duet?.audible, true, JSON.stringify(duet));
    // In the main Mic's coordinates: A's own YouTube-time lag, plus the 150 ms
    // B's player runs behind A's for the same captured moment.
    const from = a.messages.length;
    a.send({ type: 'timing-calibration-status-request' });
    const timing = await waitForNewMessage(a, from, (m) => m.type === 'timing-calibration-status');
    const aLagMs = timing.sampleSongFallback.candidateMs;
    assert.equal(typeof aLagMs, 'number', JSON.stringify(timing.sampleSongFallback));
    assert.ok(Math.abs(duet.targetLagMs - (aLagMs + 150)) < 40,
      `B ${duet.targetLagMs} ms against A ${aLagMs} ms: ${JSON.stringify(duet)}`);
    // The anchors stop (they come over the slower control path and lapse now
    // and then): B keeps its place in the mix instead of going silent.
    bAnchors = false;
    for (const until = Date.now() + 1_500; Date.now() < until; i++) await step();
    const after = (await (await fetch(relay.httpUrl('/statusz'))).json()).audio;
    const held = after?.duetSecondary;
    assert.equal(held?.audible, true, `B stays in the mix through a lapse: ${JSON.stringify({
      held, ingress: after?.duetIngress })}\n${relay.stdout().split('\n').filter((l) => l.startsWith('[choir]')).slice(-8).join('\n')}`);
    // The last B anchor remains usable for its first second without new
    // reports; A/Robot clock trim may still refine the estimate during that
    // interval. Once it has expired, the target must stay exactly fixed.
    const heldLag = held.targetLagMs;
    for (const until = Date.now() + 500; Date.now() < until; i++) await step();
    const settled = (await (await fetch(relay.httpUrl('/statusz'))).json()).audio?.duetSecondary;
    assert.equal(settled?.audible, true);
    assert.equal(settled.targetLagMs, heldLag);
  } finally {
    for (const client of clients) client.close();
    await relay.stop();
  }
});
