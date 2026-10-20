import assert from 'node:assert/strict';
import test from 'node:test';
import { startRelay, RelayClient, sleep, statusz, waitForNewMessage } from './helpers/harness.js';
import { encodePcmFrame } from '../src/pcm-frame.js';
import { encodeAudioPacket } from '../src/audio-packet.js';
import { participantIdForCapability } from '../src/participant-capability.js';
import { laggedMultibandMusicPair } from './helpers/music-calibration.js';
import { registerPlayback } from './support/client-commands.js';

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
    const [client, publisher] = await Promise.all([
      RelayClient.connect(relay),
      RelayClient.connectAs(relay, 'singer', 'Singer'),
    ]);
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

const VIDEO_ID = 'dQw4w9WgXcQ';
const PLAYBACK_TRANSPORT_ID = 'choir-playback-a';
const CAPABILITY_A = 'c'.repeat(64);
const CAPABILITY_B = 'd'.repeat(64);

/**
 * A Relay with Choir on, ready for a duet: A publishing (v2) and holding the
 * song player with a song loaded and paused, the Robot's backing and control,
 * and B authenticated on its page socket and on a separate media socket.
 */
async function startDuet() {
  const relay = await startRelay({
    RELAY_CHOIR: '1',
    RELAY_AUTO_CALIBRATE: '0',
  });
  const clients: RelayClient[] = [];
  const close = async () => {
    for (const client of clients) client.close();
    await relay.stop();
  };
  const connect = async () => {
    const client = await RelayClient.connect(relay);
    clients.push(client);
    return client;
  };
  const authenticate = async (client: RelayClient, capability: string, nickname: string) => {
    const participantId = participantIdForCapability(capability)!;
    client.send({ type: 'participant-authenticate', participantId, capability, nickname });
    await client.waitFor((m) => m.type === 'participant-authenticated' && m.participantId === participantId);
  };
  const authenticateInfrastructure = async (client: RelayClient) => {
    client.send({ type: 'infrastructure-authenticate', key: relay.infrastructureKey });
    await client.waitForType('infrastructure-authenticated');
  };
  try {
    const [a, b, publisher, robotBacking, robotControl, bMedia] = await Promise.all(
      Array.from({ length: 6 }, () => connect()),
    );
    await Promise.all([
      authenticate(a, CAPABILITY_A, 'A'), authenticate(b, CAPABILITY_B, 'B'),
      authenticate(publisher, CAPABILITY_A, 'A'), authenticate(bMedia, CAPABILITY_B, 'B'),
      authenticateInfrastructure(robotBacking), authenticateInfrastructure(robotControl),
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

    /** A's player telemetry; the anchor says where the song was at a capture sample. */
    const telemetry = (state: number, position: number, captureAnchor?: unknown) => ({
      type: 'youtube-telemetry', videoId: VIDEO_ID, state, currentTime: position, duration: 200,
      playbackRate: 1, bufferedFraction: .8, playbackTransportId: PLAYBACK_TRANSPORT_ID,
      playbackGeneration: 1, captureAnchor,
    });
    await registerPlayback(a, PLAYBACK_TRANSPORT_ID);
    a.send({ type: 'room-song-command', commandId: 'duet-load-1',
      expectedRevision: 0, action: 'load', videoId: VIDEO_ID, positionSeconds: 10 });
    await a.waitFor((m) => m.type === 'room-song-command-apply' && m.commandId === 'duet-load-1');
    a.send(telemetry(5, 10));
    await a.waitFor((m) => m.type === 'room-song-command-complete' && m.commandId === 'duet-load-1');

    /** Plays the song from 10 s; resolves with when the room began playing. */
    const play = async () => {
      a.send({ type: 'room-song-command', commandId: 'duet-play-1', expectedRevision: 1, action: 'play' });
      await a.waitFor((m) => m.type === 'room-song-command-apply' && m.commandId === 'duet-play-1');
      const beganAt = Date.now();
      a.send(telemetry(1, 10));
      await a.waitFor((m) => m.type === 'room-song-command-complete' && m.commandId === 'duet-play-1');
      return beganAt;
    };
    /** Joins `client` as the second Mic, by its own press. */
    const join = async (client = b) => {
      client.send({ type: 'choir-secondary-join' });
      const reply = await client.waitFor((m) => m.type === 'choir-secondary-consent-status'
        || m.type === 'choir-consent-rejected');
      assert.equal(reply.status, 'accepted', JSON.stringify(reply));
      return reply;
    };
    /**
     * Once the server asks, B's page socket claims media and B's media socket
     * redeems the claim; `register` adds fields to the registration.
     */
    const claimMedia = async (register: Record<string, unknown> = {}) => {
      await b.waitForType('choir-media-ready', 5_000);
      b.send({ type: 'choir-secondary-media-claim-request' });
      const claim = await b.waitForType('choir-secondary-media-claim');
      const from = bMedia.messages.length;
      bMedia.send({ type: 'choir-secondary-media-register',
        claimToken: claim.claimToken, sampleRate: 48_000, packetVersion: 2, ...register });
      const registration = await waitForNewMessage(bMedia, from, (m) =>
        m.type === 'choir-secondary-media-registered' || m.type === 'choir-media-rejected');
      assert.equal(registration.type, 'choir-secondary-media-registered', JSON.stringify(registration));
      return { claim, registration };
    };
    /** Sends one 20 ms frame of `pcm` from A, the Robot and B, every 20 ms. */
    const singAlong = (pcm: Buffer) => {
      let sequence = 0;
      const timer = setInterval(() => {
        publisher.sendAudioPacket(pcm);
        robotBacking.sendPcm(pcm);
        bMedia.sendBinary(encodeAudioPacket({
          source: 'mic', generation: 7, firstSampleIndex: 960 * sequence, sequence, pcm,
        }));
        sequence += 1;
      }, 20);
      return () => clearInterval(timer);
    };
    const statusAudio = async () => (await statusz(relay)).audio;
    /** Polls B's track in /statusz until `done` holds or `ms` pass; returns the last. */
    const waitForSecondary = async (done: (duet: any) => boolean, ms = 2_000) => {
      let duet: any = null;
      for (const until = Date.now() + ms; Date.now() < until; await sleep(30)) {
        duet = (await statusAudio())?.duetSecondary ?? null;
        if (done(duet)) break;
      }
      return duet;
    };
    const choirLog = (last = 10) => relay.stdout().split('\n')
      .filter((line) => line.startsWith('[choir]')).slice(-last).join('\n');
    return {
      relay, close, connect, authenticate, a, b, publisher, robotBacking, robotControl, bMedia,
      telemetry, play, join, claimMedia, singAlong, statusAudio, waitForSecondary, choirLog,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

test('a joined B claims media on its own socket, takes no main Mic role, and is placed by Content', async () => {
  const duet = await startDuet();
  const { a, b, publisher, robotBacking, bMedia, statusAudio } = duet;
  try {
    const playbackBeganAt = await duet.play();
    await sleep(350);

    // An authenticated B that has not joined can never claim media.
    b.send({ type: 'choir-secondary-media-claim-request' });
    assert.equal((await b.waitFor((m) =>
      m.type === 'choir-media-rejected' && m.reason === 'claim-not-authorized')).reason,
    'claim-not-authorized');

    await duet.join();
    await b.waitForType('choir-media-ready');
    // Another tab of B is not the socket B joined from.
    bMedia.send({ type: 'choir-secondary-media-claim-request' });
    await bMedia.waitFor((m) => m.type === 'choir-media-rejected' && m.reason === 'claim-not-authorized');

    // Whatever else the page names, the server alone decides what this is.
    const { claim, registration } = await duet.claimMedia({ seat: 'primary', transportId: 'forged' });
    assert.match(claim.claimToken, /^[0-9a-f]{64}$/);
    assert.ok(claim.expiresInMs <= 15_000);
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
    // one-use v2 transport. Paced on the real network clock: sending 7 s at
    // once would fabricate an unrepresentative future capture timeline.
    const { mic, backing } = laggedMultibandMusicPair(
      12, 48_000, 120, { singerGain: .18 },
    );
    const frameSamples = 960;
    const frameBytes = frameSamples * 2;
    // Keep real PCM and playback-owner telemetry alive until BOTH sequential
    // Worker jobs complete, twice through the clip: a window rejected on a
    // slow host gets a retry before the song would run out.
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
      // Playback owner authority must remain fresh for both singer jobs.
      if (i % 25 === 0) a.send(duet.telemetry(1, 10 + (Date.now() - playbackBeganAt) / 1_000));
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
    let secondary = await duet.waitForSecondary((d) => d?.audible);
    assert.equal(secondary?.audible, true, `B is in the room mix once measured: ${JSON.stringify(secondary)}`);
    assert.ok(Number.isFinite(secondary.lagMs), 'B has a lag in room-output coordinates');
    assert.ok(secondary.bufferedSamples > 0, "B's PCM reached the room output");
    // B leaving takes B out of the mix at once.
    b.send({ type: 'choir-secondary-withdraw' });
    await b.waitFor((m) => m.type === 'choir-secondary-consent-status'
      && m.status === 'withdrawn');
    secondary = await duet.waitForSecondary((d) => !d?.audible);
    assert.ok(!secondary?.audible, `a withdrawn B leaves the room mix: ${JSON.stringify(secondary)}`);
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
    await duet.close();
  }
});

test('B joins by its own press, sets its own gain, and can be taken over like the Mic', async () => {
  const duet = await startDuet();
  const { a, b } = duet;
  try {
    // B joins A by its own press while nothing plays. A sends nothing.
    const joined = await duet.join();
    assert.equal(joined.joined, true);
    await duet.claimMedia();
    const stopSinging = duet.singAlong(Buffer.from(new Int16Array(960).fill(3_000).buffer));
    try {
      let secondary = await duet.waitForSecondary((d) => d?.audible, 4_000);
      assert.equal(secondary?.audible, true, `the joined B sings in the room mix: ${JSON.stringify(secondary)}`);

      // B sets its own Mic gain from its page.
      b.send({ type: 'choir-secondary-gain', micGainDb: 12 });
      secondary = await duet.waitForSecondary((d) => d?.gainDb === 12);
      assert.equal(secondary?.gainDb, 12, JSON.stringify(secondary));
      // Only the joined B: someone else's gain is ignored.
      a.send({ type: 'choir-secondary-gain', micGainDb: 30 });
      await sleep(300);
      assert.equal((await duet.statusAudio())?.duetSecondary?.gainDb, 12);

      // C takes over the second Mic, as the Mic itself can be taken over:
      // B is told it was replaced and leaves the room mix, and C is asked
      // for its media.
      const c = await duet.connect();
      await duet.authenticate(c, 'e'.repeat(64), 'C');
      await duet.join(c);
      const replaced = await b.waitFor((m) => m.type === 'choir-secondary-consent-status' && m.status === 'revoked');
      assert.equal(replaced.reason, 'replaced');
      secondary = await duet.waitForSecondary((d) => !d?.audible);
      assert.ok(!secondary?.audible, `the replaced B leaves the room mix: ${JSON.stringify(secondary)}`);
      await c.waitForType('choir-media-ready', 5_000);
      const beforeReplacedClaim = b.messages.length;
      b.send({ type: 'choir-secondary-media-claim-request' });
      assert.equal((await waitForNewMessage(b, beforeReplacedClaim, (m) => m.type === 'choir-media-rejected'
        || m.type === 'choir-secondary-media-claim')).reason, 'claim-not-authorized');
    } finally {
      stopSinging();
    }
  } finally {
    await duet.close();
  }
});

test('a joined B is heard with no song, and a song starting keeps B on the same connection', async () => {
  const duet = await startDuet();
  const { a, b, relay } = duet;
  try {
    await duet.join();
    // No song: the server asks B for media all the same.
    await duet.claimMedia();
    const stopSinging = duet.singAlong(Buffer.from(new Int16Array(960).fill(3_000).buffer));
    try {
      let audio: any = null;
      for (const until = Date.now() + 4_000; Date.now() < until; await sleep(50)) {
        audio = await duet.statusAudio();
        if (audio?.duetSecondary?.audible && audio.duetSecondary.recentlyHeard) break;
      }
      assert.equal(audio?.duetSecondary?.audible, true, `B is heard with no song: ${JSON.stringify(audio?.duetSecondary)}`);
      assert.equal(audio.duetSecondary.recentlyHeard, true);
      assert.equal(audio.duetYoutube.lagSource, 'no-song');
      const asked = b.messages.filter((m) => m.type === 'choir-media-ready').length;

      // A song starts: B carries on, on the connection it already has.
      const playbackBeganAt = await duet.play();
      const keepPlaying = setInterval(() => a.send(duet.telemetry(1, 10 + (Date.now() - playbackBeganAt) / 1_000)), 500);
      try {
        await sleep(3_500);
        assert.equal(b.messages.filter((m) => m.type === 'choir-media-ready').length, asked,
          'B is never asked to reconnect');
        assert.equal(relay.stdout().includes('"event":"b-media-disconnected"'), false);
        audio = await duet.statusAudio();
        assert.equal(audio.duetSecondary.audible, true, 'B stays in the mix as the song starts');
      } finally {
        clearInterval(keepPlaying);
      }
    } finally {
      stopSinging();
    }
  } finally {
    await duet.close();
  }
});

test('without Content, B is placed by its YouTube time against the Robot', async () => {
  const duet = await startDuet();
  const { a, b, publisher, robotBacking, robotControl, bMedia, relay } = duet;
  try {
    await duet.join();
    const playBeganAt = await duet.play();
    const songAt = (unixMs: number) => 10 + (unixMs - playBeganAt) / 1_000;
    await duet.claimMedia();

    // Both singers silent: Content can never place B. The YouTube time can:
    // B's player is 150 ms behind the Robot's at the same moment of capture.
    const frame = 960;
    const silence = Buffer.alloc(frame * 2);
    const backingPcm = Buffer.from(new Int16Array(frame).fill(900).buffer);
    const startedAt = Date.now();
    const loopSong = songAt(startedAt);
    let secondary: any = null;
    let audio: any = null;
    let i = 0;
    let bAnchors = true;
    // One 20 ms frame of every source, paced on the wall clock so the frames
    // keep up with real time; every 240 ms, A's and the Robot's song
    // positions, and B's while bAnchors is on.
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
      a.send(duet.telemetry(1, songAt(at), { ...anchor(1), mediaDeltaSeconds: robotSeconds - songAt(at) }));
      robotControl.send({ type: 'robot-player-offset', offsetMs: 0, songObservation: {
        videoId: VIDEO_ID, state: 1, mediaSeconds: robotSeconds, playbackRate: 1, observedAtUnixMs: at } });
      robotBacking.send({ type: 'backing-song-clock', generation: 9, sampleRate: 48_000,
        sampleIndex: cursor, observedAtUnixMs: at });
      if (bAnchors) b.send({ type: 'choir-secondary-song-anchor', videoId: VIDEO_ID, state: 1, playbackRate: 1,
        currentTime: robotSeconds - .15, captureAnchor: anchor(7) });
    };
    for (; Date.now() - startedAt < 8_000; i++) {
      await step();
      if (i % 48 !== 47) continue;
      audio = await duet.statusAudio();
      secondary = audio?.duetSecondary ?? null;
      if (secondary?.audible && relay.stdout().includes('"source":"youtube-time"')) break;
    }
    assert.match(relay.stdout(), /"event":"b-lag-source","source":"youtube-time"/,
      `${duet.choirLog(Infinity)}\n${JSON.stringify({ secondary, youtube: audio?.duetYoutube })}`);
    assert.equal(secondary?.audible, true, JSON.stringify(secondary));
    // In the main Mic's coordinates: A's own YouTube-time lag, plus the 150 ms
    // B's player runs behind A's for the same captured moment.
    const from = a.messages.length;
    a.send({ type: 'timing-calibration-status-request' });
    const timing = await waitForNewMessage(a, from, (m) => m.type === 'timing-calibration-status');
    const aLagMs = timing.sampleSongFallback.candidateMs;
    assert.equal(typeof aLagMs, 'number', JSON.stringify(timing.sampleSongFallback));
    assert.ok(Math.abs(secondary.targetLagMs - (aLagMs + 150)) < 40,
      `B ${secondary.targetLagMs} ms against A ${aLagMs} ms: ${JSON.stringify(secondary)}`);
    // The anchors stop (they come over the slower control path and lapse now
    // and then): B keeps its place in the mix instead of going silent.
    bAnchors = false;
    for (const until = Date.now() + 1_500; Date.now() < until; i++) await step();
    const after = await duet.statusAudio();
    const held = after?.duetSecondary;
    assert.equal(held?.audible, true, `B stays in the mix through a lapse: ${JSON.stringify({
      held, ingress: after?.duetIngress })}\n${duet.choirLog(8)}`);
    // The last B anchor remains usable for its first second without new
    // reports; A/Robot clock trim may still refine the estimate during that
    // interval. Once it has expired, the target must stay exactly fixed.
    const heldLag = held.targetLagMs;
    for (const until = Date.now() + 500; Date.now() < until; i++) await step();
    const settled = (await duet.statusAudio())?.duetSecondary;
    assert.equal(settled?.audible, true);
    assert.equal(settled.targetLagMs, heldLag);
  } finally {
    await duet.close();
  }
});
