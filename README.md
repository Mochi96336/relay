# Relay

Relay is an experimental shared karaoke audio room. A singer uses the phone as the primary control surface and microphone, while an unattended Relay host renders the song, captures its backing audio, aligns both sources, serves the live room sound, and records server-owned Takes.

The current production target is **phone + unattended robot/host**. The desktop Chrome extension is a development adapter for exercising the same backing-audio path without the robot runtime.

Discord output is not connected yet.

## What Relay does

The phone is the human-facing surface: it presents normal song control, Mic actions, room listening, Take control, recording review, and product-facing recovery state.

The Relay host owns the room's authoritative runtime state: Mic and Song authority, timing/alignment, the 48 kHz mix, ProductStatus, Take lifecycle, Take quality evidence, and durable recording history.

The robot-side source mirrors the room song in Chromium and publishes the audio that was actually rendered by that browser. Relay does not download a YouTube media file or use a YouTube audio-download endpoint.

Relay supports voice-only rooms, song-only playback, and the normal combined voice + song path. A Song is not required just to use the Mic or record a voice-only Take.

## Architecture

```text
Singer phone
├─ Live UI / room controls
├─ visible YouTube player + media timeline
└─ microphone audio
        │
        ▼
Relay server
├─ participant / Mic / Song authority
├─ sample-addressed 48 kHz audio mixer
├─ timing and calibration authority
├─ ProductStatus + diagnostics
├─ room Listen output
└─ server-owned Takes + recording history
        ▲
        │
Robot source
├─ mirrored YouTube player in Chromium
└─ rendered backing audio
```

Production uses the phone plus an unattended robot/host. During desktop development, `chrome-tab-audio-probe/` can capture the rendered audio of `source.html` instead of using the robot's PipeWire route.

## Core contracts

- **The server owns room authority.** Browser UI renders domain decisions; it does not reconstruct Mic, Song, Take, calibration, or recovery authority from lower-level telemetry when a domain contract already owns that decision.
- **Audio is sample-addressed.** Capture/sample position is separate from packet arrival order, so a transport reconnect does not by itself mean a new capture timeline and delayed packets are not silently appended at the wrong audio position.
- **Mic identity, Mic ownership, and transports are separate lifecycles.** A participant may have multiple browser transports; a socket closing is not automatically equivalent to a person leaving or the Mic lease ending.
- **Takes are server-owned.** The browser sends Take commands and reviews artifacts; the authoritative mixed PCM, recording lifecycle, quality evidence, storage, and durable history are server responsibilities.
- **Product state and diagnostics are separate surfaces.** Normal Live UI consumes product-semantic state. Transport identities, sample/timing evidence, raw calibration observations, and operational health belong to diagnostics.
- **WebTransport is optional.** When direct microphone WebTransport is unavailable or not configured, microphone media continues over the WebSocket compatibility path.

Normative ownership details live in [ARCHITECTURE_BOUNDARIES.md](ARCHITECTURE_BOUNDARIES.md) and [SESSION_MODEL.md](SESSION_MODEL.md).

## Quick start

Relay requires Node.js **20.19 or newer**.

```bash
npm install
npm run check
npm test
npm run dev
```

Open:

```text
http://localhost:3000
```

Microphone capture on a phone requires a secure browser context. For remote handset development, expose Relay through HTTPS and open that HTTPS URL on the phone.

If the Relay URL is publicly reachable, configure the shared outer key:

```bash
RELAY_KEY=some-random-string npm run dev
```

Use the same `?key=some-random-string` query when opening Relay surfaces that require it. The same deployment key also protects finalized Take artifacts.

## Desktop development backing source

The Chrome extension under `chrome-tab-audio-probe/` is the simplest way to exercise the integrated backing path on a development computer.

1. Load `chrome-tab-audio-probe/` as an unpacked Chrome extension.
2. Start Relay and open the normal Live surface on the phone/browser.
3. Open `http://localhost:3000/source.html` on the desktop, using the same `?key=` when configured.
4. Enable source audio, then capture that tab with **Relay Tab Audio Source**.

The source page follows the authoritative room song/video timeline. The extension publishes the audio rendered by that tab as Relay's backing source.

This is a **development path**. The deployed robot does not require the extension.

## Robot deployment

The validated robot route is:

```text
Chromium
  ↓
PipeWire / PulseAudio null sink
  ↓
parec
  ↓
backing:stdin
  ↓
Relay
```

Useful entry points are:

```bash
PORT=3100 npm run robot:doctor
PORT=3100 npm run robot:source
```

`PORT` defaults to `3000`.

The robot source page must use `localhost`, not `127.0.0.1`; that hostname difference is part of the validated deployment contract.

Robot infrastructure authentication, PipeWire setup, Chromium/Xvfb behavior, systemd user units, startup checks, backing capture latency, and direct WebTransport deployment are documented in [ROBOT_DEPLOYMENT.md](ROBOT_DEPLOYMENT.md).

## Audio transport

Relay keeps control-plane state on WebSocket connections. Microphone media uses AudioPacket framing with transport order kept separate from the capture sample timeline.

When a direct HTTP/3 endpoint is configured and the browser can establish it, microphone media can use WebTransport. Otherwise Relay continues over WebSocket binary media; WebTransport is an optional direct-media path, not a startup requirement.

Robot backing audio currently enters through `backing:stdin` and the normal backing publisher path.

For deployment details, certificate requirements, UDP reachability, and media-ticket behavior, see [ROBOT_DEPLOYMENT.md](ROBOT_DEPLOYMENT.md).

## Recording model

A Take records the exact authoritative mixed PCM produced by Relay. It is room-owned rather than Mic-owner-owned: Mic handoff or controller-page disconnect does not by itself split the recording.

Finalized recordings are persisted through the recording library and remain distinct from the single current Take lifecycle. The Live UI can review recording history without scanning raw WAV files or rebuilding artifact state in the browser.

Take quality is also attached to the recording boundary. Relay records concrete evidence from the samples accepted into that Take and derives a versioned verdict from that evidence; completed recording quality does not become the health of the current room.

By default Take artifacts live under `./takes`; deployment/storage policy is implemented server-side.

## Product state and diagnostics

Normal Live surfaces use server-derived product state for user-facing availability, recovery, and action decisions. Technical diagnostics remain a separate engineering surface.

For machine-readable monitoring, `GET /api/status/v1` is the stable read-only observation contract. It reports anonymous workload and route health such as `idle`, `live`, `degraded`, or `fault` without exposing participant identity, credentials, Takes, or internal runtime generations.

See [OBSERVATION_CONTRACT.md](OBSERVATION_CONTRACT.md) for the versioned observation schema and consumer boundary.

## Verification

The repository's local baseline is:

```bash
npm run check
npm test
```

Pull-request CI adds several higher-level proof layers instead of relying only on unit tests:

- browser JavaScript and launcher shell syntax checks;
- real-server domain and transport regressions;
- production-shaped Live DOM interaction tests;
- phone/desktop geometry checks and screenshot artifacts;
- a real HTTP/3 WebTransport loopback;
- a real Chromium microphone → AudioWorklet → Relay → authoritative mix → Take path;
- a real Chromium listener path through Relay's monitor framing and playback worklet; and
- a real Chromium native-WebTransport microphone mode proving the direct path without using WebSocket media fallback.

These proofs protect software contracts and browser integration. They are not a substitute for physical-device rehearsal.

## What CI does not prove

A green CI run does **not** prove every physical mobile-audio behavior. Important real-device boundaries still include:

- iPhone/iOS browser audio-session and physical output-route behavior;
- real speaker-to-microphone acoustic interaction on the singer's device;
- end-to-end audible vocal alignment on the deployed phone + robot route;
- browser/OS behavior around backgrounding, lock/unlock, permission UI, and route changes; and
- site/device-specific playback behavior that Chromium CI cannot reproduce.

Claims about those boundaries should come from explicit handset/robot rehearsal, not from Chromium CI alone.

## Documentation

- [ARCHITECTURE_BOUNDARIES.md](ARCHITECTURE_BOUNDARIES.md) — normative ownership and authority boundaries between product, diagnostics, recording, and UI.
- [SESSION_MODEL.md](SESSION_MODEL.md) — participant identity, presence, Mic lease, takeover, reconnect, and publisher transport lifecycle.
- [ROBOT_DEPLOYMENT.md](ROBOT_DEPLOYMENT.md) — robot Chromium/PipeWire route, launcher, systemd deployment, infrastructure auth, and optional WebTransport setup.
- [OBSERVATION_CONTRACT.md](OBSERVATION_CONTRACT.md) — stable machine-readable monitoring contract.
- [HANDOFF.md](HANDOFF.md) — engineering handoff notes and hardware-validation context; useful for ongoing development, not the canonical product overview.

The README intentionally stays at the repository-entry level. Detailed state machines, calibration internals, implementation history, temporary debugging paths, and PR-era milestones belong in their owning code, tests, or dedicated engineering documents rather than being duplicated here.
