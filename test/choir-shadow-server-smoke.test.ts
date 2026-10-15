import assert from 'node:assert/strict';
import test from 'node:test';
import { startRelay, RelayClient, sleep } from './helpers/harness.js';
import { encodePcmFrame } from '../src/pcm-frame.js';
import { encodeAudioPacket } from '../src/audio-packet.js';
import { participantIdForCapability } from '../src/participant-capability.js';
import { laggedMultibandMusicPair } from './helpers/music-calibration.js';

/**
 * Real production entrypoint smoke: opt-in Choir observes only.
 * No Mic admission, new client message, PCM routing or monitoring output
 * is enabled by this flag.
 */
test('flagged Choir control-plane shadow starts and shuts down ordinary Relay cleanly', async () => {
  const relay = await startRelay({ RELAY_CHOIR_SHADOW: '1' });
  try {
    const response = await fetch(relay.httpUrl('/'));
    assert.equal(response.status, 200);
    const page = await response.text();
    assert.ok(page.length > 0);
  } finally {
    await relay.stop();
  }
});

test('shadow server rejects unapproved Choir registration while ordinary sockets still work', async () => {
  const relay = await startRelay({ RELAY_CHOIR_SHADOW: '1' });
  let unknown: RelayClient | null = null;
  let publisher: RelayClient | null = null;
  try {
    unknown = await RelayClient.connect(relay);
    // No public Choir registration protocol exists, even with the shadow
    // flag ON. Client-asserted seat and room epochs are not capabilities.
    unknown.send({
      type: 'choir-secondary-register', role: 'secondary',
      participantId: 'B', roomEpoch: 1, songEpoch: 1,
      transportId: 'forged-B', mediaEpoch: 2, sampleRate: 48_000,
    });
    unknown.sendBinary(encodePcmFrame(7, 0,
      Buffer.from(new Int16Array(960).fill(8_000).buffer)));
    // Same physical socket can still use an ordinary, pre-existing role:
    // the unapproved Choir JSON/PCM did not seize media authority.
    unknown.send({ type: 'register', role: 'monitor' });
    assert.equal((await unknown.waitForType('registered')).role, 'monitor');
    assert.equal(unknown.messages.some(message =>
      message.type === 'choir-secondary-registered'), false);

    publisher = await RelayClient.connect(relay);
    publisher.send({ type: 'register', role: 'publisher', sampleRate: 48_000 });
    assert.equal((await publisher.waitForType('registered')).role, 'publisher');
    publisher.sendPcm(Buffer.from(new Int16Array(960).fill(5_000).buffer));
    assert.equal(publisher.errors.length, 0,
      'production N=1 publisher remains available with Choir shadow enabled');
  } finally {
    unknown?.close();
    publisher?.close();
    await relay.stop();
  }
});

test('Choir invite commands require browser capability and never grant audio without Robot authority', async () => {
  const relay = await startRelay({ RELAY_CHOIR_SHADOW: '1',
    RELAY_TEST_LEGACY_PARTICIPANTS: '0' });
  let anonymous: RelayClient | null = null;
  let a: RelayClient | null = null;
  let b: RelayClient | null = null;
  try {
    anonymous = await RelayClient.connect(relay);
    anonymous.send({ type: 'choir-secondary-invite', secondaryId: 'participant-pretend' });
    assert.equal((await anonymous.waitForType('choir-consent-rejected')).reason,
      'unavailable', 'an unidentified WebSocket cannot invite B');

    const capA = 'a'.repeat(64);
    const capB = 'b'.repeat(64);
    const idA = participantIdForCapability(capA)!;
    const idB = participantIdForCapability(capB)!;
    a = await RelayClient.connect(relay);
    b = await RelayClient.connect(relay);
    a.send({ type: 'participant-authenticate', participantId: idA,
      capability: capA, nickname: 'A' });
    b.send({ type: 'participant-authenticate', participantId: idB,
      capability: capB, nickname: 'B' });
    assert.equal((await a.waitForType('participant-authenticated')).participantId, idA);
    assert.equal((await b.waitForType('participant-authenticated')).participantId, idB);
    a.send({ type: 'choir-secondary-invite', secondaryId: idB });
    assert.equal((await a.waitForType('choir-consent-rejected')).reason,
      'invalid-or-stale',
      'even an authenticated browser is not granted a Choir room without the live primary Mic and Robot');
    b.send({ type: 'choir-secondary-accept',
      inviteId: '00000000-0000-0000-0000-000000000000' });
    assert.equal((await b.waitForType('choir-consent-rejected')).reason,
      'invalid-or-stale');
    assert.equal(a.messages.some(m => m.type === 'choir-secondary-invite-acknowledged'), false);
    assert.equal(b.messages.some(m => m.type === 'choir-secondary-invitation'), false);
    assert.equal(a.messages.some(m => m.type === 'choir-secondary-registered'), false);
    assert.equal(b.messages.some(m => m.type === 'choir-secondary-registered'), false);
  } finally {
    anonymous?.close();
    a?.close();
    b?.close();
    await relay.stop();
  }
});

test('real authenticated A and B complete opt-in and withdrawal without obtaining Choir PCM permission', async () => {
  const relay = await startRelay({
    RELAY_CHOIR_SHADOW: '1', RELAY_TEST_LEGACY_PARTICIPANTS: '0',
    RELAY_AUTO_CALIBRATE: '0', RELAY_HEARTBEAT_MS: '60000',
  });
  const clients: RelayClient[] = [];
  const connect = async () => {
    const c = await RelayClient.connect(relay);
    clients.push(c);
    return c;
  };
  try {
    const [a, b, publisher, robotBacking, robotControl] = await Promise.all(
      Array.from({ length: 5 }, () => connect()),
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
      authenticate(a, idA, capA),
      authenticate(b, idB, capB),
      authenticate(publisher, idA, capA),
    ]);
    assert.equal((await a.waitForType('choir-consent-available')).mode,
      'invitation-only');

    publisher.send({ type: 'register', role: 'publisher',
      sampleRate: 48_000, captureGeneration: 1 });
    await publisher.waitFor((m) =>
      m.type === 'registered' && m.role === 'publisher');
    robotBacking.send({ type: 'register', role: 'backing', robot: true,
      sampleRate: 48_000, captureGeneration: 9, captureSampleCursor: 0 });
    await robotBacking.waitFor((m) =>
      m.type === 'registered' && m.role === 'backing');
    // Registered backing alone is NOT an acoustic clock. The first
    // positioned native PCM must establish actual backingGeneration=9.
    robotBacking.resumeCaptureSession(9, 0);
    robotBacking.sendPcm(Buffer.from(new Int16Array(960).fill(900).buffer));
    robotControl.send({ type: 'robot-source-hello' });

    a.send({ type: 'playback-hello',
      playbackTransportId: 'choir-invite-playback-a',
      playbackGeneration: 1 });
    await a.waitForType('playback-registered');
    a.send({ type: 'room-song-command', commandId: 'invite-load-1',
      expectedRevision: 0, action: 'load',
      videoId: 'dQw4w9WgXcQ', positionSeconds: 10 });
    await a.waitFor((m) =>
      m.type === 'room-song-command-apply' && m.commandId === 'invite-load-1');
    const telemetry = (state: number, position: number) => ({
      type: 'youtube-telemetry', videoId: 'dQw4w9WgXcQ',
      state, currentTime: position, duration: 200,
      playbackRate: 1, bufferedFraction: .8,
      playbackTransportId: 'choir-invite-playback-a',
      playbackGeneration: 1,
    });
    a.send(telemetry(5, 10));
    await a.waitFor((m) =>
      m.type === 'room-song-command-complete' && m.commandId === 'invite-load-1');
    a.send({ type: 'room-song-command', commandId: 'invite-play-1',
      expectedRevision: 1, action: 'play' });
    await a.waitFor((m) =>
      m.type === 'room-song-command-apply' && m.commandId === 'invite-play-1');
    a.send(telemetry(1, 10.1));
    await a.waitFor((m) =>
      m.type === 'room-song-command-complete' && m.commandId === 'invite-play-1');
    await sleep(350); // One regular server-owned shadow clock observation.
    a.send({ type: 'youtube-timeline-request' });
    a.send({ type: 'source-status-request' });
    a.send({ type: 'session-status-request' });
    const timeline = await a.waitFor((m) => m.type === 'youtube-timeline-status'
      && m.playbackLeaderParticipantId === idA && m.state === 1);
    const source = await a.waitFor((m) => m.type === 'source-status'
      && m.robotSourceConnected === true);
    const presence = await a.waitFor((m) => m.type === 'session-status'
      && m.micOwnerId === idA && m.micConnected === true);
    assert.ok(timeline && source && presence);

    a.send({ type: 'choir-secondary-invite', secondaryId: idB });
    const decision = await a.waitFor((m) =>
      m.type === 'choir-secondary-invite-acknowledged'
      || m.type === 'choir-consent-rejected');
    assert.equal(decision.type, 'choir-secondary-invite-acknowledged',
      `server refused a fully authenticated invite: ${JSON.stringify({
        decision, timeline: { state: timeline.state, leaderFresh: timeline.leaderFresh,
          playbackLeaderParticipantId: timeline.playbackLeaderParticipantId },
        source: { robotSourceConnected: source.robotSourceConnected,
          robotBackingConnected: source.robotBackingConnected },
        presence: { micOwnerId: presence.micOwnerId, micConnected: presence.micConnected },
        stderr: relay.stderr().slice(-1500),
      })}`);
    const invitation = await b.waitForType('choir-secondary-invitation');
    assert.equal(invitation.primaryId, idA);
    assert.ok(Number.isSafeInteger(invitation.roomEpoch));
    assert.equal(invitation.videoId, 'dQw4w9WgXcQ');
    b.send({ type: 'choir-secondary-accept', inviteId: invitation.inviteId });
    assert.equal((await a.waitFor((m) => m.type === 'choir-secondary-consent-status'
      && m.status === 'accepted')).secondaryId, idB);
    assert.equal((await b.waitFor((m) => m.type === 'choir-secondary-consent-status'
      && m.status === 'accepted')).secondaryId, idB);
    assert.equal(b.messages.some(m => m.type === 'choir-secondary-registered'), false,
      'B consent must not mint a microphone publisher or Media Epoch');

    b.send({ type: 'choir-secondary-withdraw' });
    assert.equal((await b.waitFor((m) =>
      m.type === 'choir-secondary-consent-status'
      && m.status === 'withdrawn')).secondaryId, idB);
    assert.equal((await a.waitFor((m) =>
      m.type === 'choir-secondary-consent-status'
      && m.status === 'withdrawn')).secondaryId, idB);
  } finally {
    for (const c of clients) c.close();
    await relay.stop();
  }
});

test('double opt-in A/B room issues real one-use v2 B Media Epoch but no N=1 audio takeover', async () => {
  const relay = await startRelay({
    RELAY_CHOIR_SHADOW: '1', RELAY_CHOIR_MEDIA_EXPERIMENT: '1',
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
    assert.equal((await a.waitForType('choir-consent-available')).mode,
      'media-experiment');
    // Choir A mirroring requires an authenticated v2 native generation,
    // not a legacy publisher that has no stable capture clock identity.
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

    // An authenticated B without a room can never claim a Media Epoch.
    b.send({ type: 'choir-secondary-media-claim-request' });
    assert.equal((await b.waitFor((m) =>
      m.type === 'choir-media-rejected' && m.reason === 'claim-not-authorized')).reason,
    'claim-not-authorized');

    a.send({ type: 'choir-secondary-invite', secondaryId: idB });
    await a.waitForType('choir-secondary-invite-acknowledged');
    const invitation = await b.waitForType('choir-secondary-invitation');
    b.send({ type: 'choir-secondary-accept', inviteId: invitation.inviteId });
    await b.waitFor((m) => m.type === 'choir-secondary-consent-status'
      && m.status === 'accepted');

    a.send({ type: 'choir-room-begin', secondaryId: idB });
    const started = await a.waitFor((m) =>
      m.type === 'choir-room-ready' || m.type === 'choir-media-rejected');
    assert.equal(started.type, 'choir-room-ready',
      `room did not accept explicit dual-opt-in: ${JSON.stringify(started)}`);
    assert.equal(started.secondary, 'join-required');

    b.send({ type: 'choir-secondary-media-claim-request' });
    const claim = await b.waitForType('choir-secondary-media-claim');
    assert.match(claim.claimToken, /^[0-9a-f]{64}$/);
    assert.ok(claim.expiresInMs <= 15_000);

    bMedia.send({ type: 'choir-secondary-media-register',
      claimToken: claim.claimToken, sampleRate: 48_000,
      packetVersion: 2, roomEpoch: 9_999, seat: 'primary',
      mediaEpoch: 9_999 });
    const registration = await bMedia.waitFor((m) =>
      m.type === 'choir-secondary-media-registered'
      || m.type === 'choir-media-rejected');
    assert.equal(registration.type, 'choir-secondary-media-registered',
      `B's real authenticated media Socket could not redeem: ${JSON.stringify(registration)}`);
    assert.ok(registration.mediaEpoch > 0);
    assert.equal(registration.roomEpoch, started.roomEpoch);
    assert.equal(registration.awaitingContent, true);
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

    // Real WebSocket end-to-end six-second Content proof, NOT a direct
    // coordinator call. A uses the production v2 Mic receiver, Robot the
    // actual backing receiver, and B its isolated one-use v2 transport.
    // Pace the real network clock; sending 7s at once would fabricate an
    // unrepresentative future capture timeline.
    const { mic, backing } = laggedMultibandMusicPair(
      7.5, 48_000, 120, { singerGain: .18 },
    );
    const frameSamples = 960;
    const frameBytes = frameSamples * 2;
    for (let i = 0; i < mic.byteLength / frameBytes; i++) {
      const start = i * frameBytes;
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
    const proofDeadline = Date.now() + 4_500;
    while (!relay.stderr().includes('"state":"duet-ready"')
      && Date.now() < proofDeadline) await sleep(30);
    assert.match(relay.stderr(), /\[choir-proof-ci\].*"state":"duet-ready"/,
      'both singers must independently complete the real server-owned '
      + 'A/B/Robot Content Worker pipeline from WebSocket PCM; '
      + relay.stderr().slice(-2_500));
    assert.equal(bMedia.messages.some(m => m.type === 'registered'),
      false, 'B must remain outside the N=1 publisher path after calibration');
    // B's original consent can still revoke audio admission immediately.
    b.send({ type: 'choir-secondary-withdraw' });
    await b.waitFor((m) => m.type === 'choir-secondary-consent-status'
      && m.status === 'withdrawn');
    bMedia.sendBinary(encodeAudioPacket({
      source: 'mic', generation: 7, firstSampleIndex: 960, sequence: 1,
      pcm: Buffer.from(new Int16Array(960).fill(4_000).buffer),
    }));
    await sleep(50);
    b.send({ type: 'choir-secondary-media-claim-request' });
    assert.equal((await b.waitFor((m) => m.type === 'choir-media-rejected'
      && m.reason === 'claim-not-authorized')).reason, 'claim-not-authorized');
    assert.equal(publisher.errors.length, 0,
      'the production N=1 publisher remains unaffected by B experimental PCM');
  } finally {
    for (const client of clients) client.close();
    await relay.stop();
  }
});

test('media flag alone never enables Choir without explicit Shadow consent control plane', async () => {
  const relay = await startRelay({
    RELAY_CHOIR_MEDIA_EXPERIMENT: '1', RELAY_CHOIR_SHADOW: '0',
    RELAY_TEST_LEGACY_PARTICIPANTS: '0',
  });
  const client = await RelayClient.connect(relay);
  try {
    const capability = '9'.repeat(64);
    const participantId = participantIdForCapability(capability)!;
    client.send({ type: 'participant-authenticate',
      participantId, capability, nickname: 'Unapproved A' });
    await client.waitForType('participant-authenticated');
    client.send({ type: 'choir-room-begin', secondaryId: participantId });
    assert.equal((await client.waitFor((m) => m.type === 'choir-media-rejected'
      && m.reason === 'disabled-or-unverified')).reason, 'disabled-or-unverified');
    client.send({ type: 'choir-secondary-media-claim-request' });
    await client.waitFor((m) => m.type === 'choir-media-rejected'
      && m.reason === 'disabled-or-unverified');
    client.send({ type: 'choir-secondary-media-register',
      claimToken: 'a'.repeat(64), packetVersion: 2, sampleRate: 48_000 });
    await client.waitFor((m) => m.type === 'choir-media-rejected'
      && m.reason === 'disabled-or-unverified');
    assert.equal(client.messages.some(m => m.type === 'choir-consent-available'),
      false, 'shadow disabled must not advertise consent or media features');
  } finally {
    client.close();
    await relay.stop();
  }
});
