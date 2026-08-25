# Robot deployment contract

Relay's target product topology is **phone + robot**. The desktop used during development is only a stand-in for the robot-side browser host.

```text
Singer phone
├─ visible YouTube
├─ YouTube media timeline ───────────────┐
└─ microphone PCM ───────────────────────┤
                                         │
Robot                                    │
├─ Relay server <────────────────────────┘
├─ Xvfb + Chromium
│  └─ http://localhost:$PORT/source.html?robot=1
│     └─ mirrored YouTube
└─ PipeWire backing route
   └─ rendered song PCM ────────────────> Relay server

Relay server
└─ aligned song + microphone
   └─ Listen / Take / later Discord
```

## Validated browser audio route

The robot route has been validated on Debian 13 arm64:

```text
Chromium
  PULSE_SINK=relay_browser
        ↓
PipeWire/PulseAudio null sink
        ↓
relay_browser.monitor
        ↓
parec --raw --format=s16le --rate=48000 --channels=1 --latency-msec=40
        ↓
npm run backing:stdin
        ↓
Relay
```

This proves both halves of the deployment seam: Chromium's rendered audio reaches raw PCM through PipeWire, and `backing:stdin` frames that PCM and publishes it as Relay's normal `backing` role. The Chrome extension remains useful for desktop development, but it is not part of the robot runtime.

## Localhost is a deployment requirement

The robot source URL **must use `localhost`**:

```text
✓ http://localhost:$PORT/source.html?robot=1
✗ http://127.0.0.1:$PORT/source.html?robot=1
```

On the validated installation, the same YouTube video played through the `localhost` origin and created the expected PipeWire sink input, while the `127.0.0.1` origin showed `Video unavailable`. Treat the hostname as part of the deployment contract, not as an interchangeable loopback spelling.

The port is not part of that contract. Relay defaults to `3000`; use another port when the host already reserves it.

Robot/backing authority is protected by a separate `RELAY_INFRA_KEY`, not by the human participant capability and not by the shared outer `RELAY_KEY`. Generate one 256-bit value once (for example `openssl rand -hex 32`) and put it in `~/.config/relay/robot.env` so both checked-in user units inherit the same secret:

```bash
RELAY_INFRA_KEY=<64 lowercase hex characters>
```

The launcher passes this key to `source.html` in the URL **fragment** (`#infra=...`), which browsers do not send in HTTP requests or access logs. The backing bridge sends the same capability only after the WebSocket upgrade.

## Launcher

Before launching, the read-only doctor checks dependencies, the PipeWire
server and sink monitor, and the required `localhost` Relay endpoints:

```bash
PORT=3100 npm run robot:doctor
```

It reports a missing sink as a warning because the launcher can create it;
missing commands, an unreachable Relay server, or a sink without its monitor
source are failures.

The checked-in launcher owns the complete browser backing route:

```bash
PORT=3100 npm run robot:source
```

It:

- verifies `pactl`, `parec`, `xvfb-run`, `npm`, Node.js, and Chromium are available;
- creates the `relay_browser` null sink only when it does not already exist;
- captures `relay_browser.monitor` as mono 16-bit little-endian PCM at 48 kHz by default;
- pipes the capture into `backing:stdin`;
- launches an isolated Chromium profile under Xvfb on a small screen, routed with `PULSE_SINK=relay_browser`;
- always opens `http://localhost:$PORT/source.html?robot=1`; and
- stops its child processes and unloads only a sink module it created itself.

`PORT` defaults to `3000`. `CHROMIUM_BIN` can select a nonstandard Chromium executable, and `RELAY_BROWSER_SINK` can select an existing sink with another name. The backing bridge requires `RELAY_INFRA_KEY` and continues to accept `RELAY_URL`, `RELAY_KEY`, `RELAY_BACKING_SAMPLE_RATE`, and `RELAY_BACKING_FRAME_MS`; see `npm run backing:stdin -- --help`. The launcher applies `RELAY_BACKING_SAMPLE_RATE` to both `parec` and the bridge so the declared rate always matches the PCM; the validated default remains 48 kHz. `RELAY_BACKING_CAPTURE_LATENCY_MS` controls `parec --latency-msec` and defaults to 40 ms; setting it explicitly avoids the roughly two-second default capture buffer observed on the robot. When `RELAY_KEY` is set, the launcher also adds it to the local source page URL so both browser and backing bridge can authenticate, without writing the key into its log line.

`RELAY_ROBOT_SCREEN` sizes the Xvfb screen and the Chromium window, and defaults to `480x360x24`. Nobody ever looks at this screen — only its audio leaves the machine — and a desktop-sized YouTube player rendered in software costs decode headroom on a Raspberry Pi that hosts neither WebGL nor Vulkan. That cost is not only power: it shows up as jitter in the player position the mixer aligns the microphone against. Raise it only if a site refuses to serve a real player at this size.

Run the Relay server separately before starting the launcher. Robot mode automatically arms source audio, and Chromium is launched with the autoplay policy needed for that unattended local page; no source-page gesture or extension invocation is required.

## Optional direct WebTransport microphone path

Relay keeps the phone page and control WebSocket on the existing HTTPS origin, but microphone media can use a separate **direct HTTP/3/UDP endpoint**. This is optional: if it is not configured, or if the browser cannot establish it, AudioPacket v2 continues over the existing WebSocket binary path.

A Cloudflare Tunnel URL is **not** the WebTransport media endpoint. Cloudflare can accept HTTP/3 from the browser at its edge, but Tunnel published applications currently connect from `cloudflared` to the origin with HTTP/1.1 or HTTP/2 rather than forwarding an end-to-end HTTP/3 WebTransport session. The media hostname therefore has to reach the robot's UDP port directly (or through infrastructure that explicitly supports WebTransport end to end).

Configure the direct path in `~/.config/relay/robot.env` only after DNS, UDP forwarding/firewall, and a certificate are ready:

```bash
RELAY_WEBTRANSPORT_PUBLIC_URL=https://media.example.com:4433/media
RELAY_WEBTRANSPORT_CERT=/home/mochi/.config/relay/media-cert.pem
RELAY_WEBTRANSPORT_KEY=/home/mochi/.config/relay/media-key.pem
# Optional when the public UDP port differs from the local bind port:
# RELAY_WEBTRANSPORT_PORT=4433
# RELAY_WEBTRANSPORT_HOST=0.0.0.0
```

With a normal publicly trusted certificate, leave `RELAY_WEBTRANSPORT_PIN_CERT` unset. For a short-lived local/test certificate, `RELAY_WEBTRANSPORT_PIN_CERT=1` makes Relay advertise the SHA-256 certificate hash to the browser; pinned WebTransport certificates are deliberately restricted to a validity period shorter than 14 days and an EC/P-256-compatible key.

The WebTransport URL carries a random, capture-scoped media ticket issued only after publisher registration. A fresh capture or ownership change rotates it. A same-capture control reconnect preserves it until the existing microphone reconnect grace expires. This ticket is a narrow media capability, not a replacement for `RELAY_KEY` or participant ownership.

## Watching the route

The robot is unattended, so the interesting question is not only "is Relay running" but "is the route still carrying audio". `/healthz` cannot answer that — it stays `{"ok": true}` while Chromium is dead.

For an operator spot-check, `/statusz` is the richer route diagnostic:

```bash
curl -s http://<robot>:3100/statusz | jq '{ok, state, faults}'
```

`ok` is false only for a fault: a client that is connected but has stopped
sending audio, or a robot route missing its backing source or its source page.
Warnings such as a stale calibration are reported separately and leave `ok`
true, because audio still flows. With nothing connected the state is `idle`,
not a failure.

For a long-lived machine consumer, use `GET /api/status/v1` instead of scraping `/statusz`. It is Relay's stable, versioned, read-only observation contract; consumers should key on its `schema` and own their own fetch freshness. See [OBSERVATION_CONTRACT.md](OBSERVATION_CONTRACT.md).

Both `/statusz` and `/api/status/v1` are currently unauthenticated even when `RELAY_KEY` is set. `/statusz` therefore contains no nicknames or keys, while the v1 observation contract is explicitly identity-free and credential-free.

This is observation only. Nothing acts on a route fault yet; restarting the route is still manual, and remains so until a deliberately narrower recovery policy exists.

## Ownership boundaries

- `source.html` mirrors the phone's YouTube media timeline.
- `scripts/robot-source.sh` owns robot-local browser audio capture and process cleanup.
- `src/backing-stdin.ts` owns PCM framing, its capture clock, and backing transport reconnection.
- `src/server.ts` owns WebSocket routing and source lifecycle orchestration.
- `AudioSession` owns the shared PCM timelines, alignment, mixer, and signal processing.
- `CalibrationSession` observes those timelines and owns measurement validity.

The launcher does not create a second mixer clock or alignment model. Observed follower deltas are diagnostics, not configuration: final audio alignment remains the calibration system's job.

## Boot services: written, deliberately not enabled

`deploy/` holds two systemd **user** units, `relay-server.service` and
`relay-robot-source.service`. They are committed so the boot design can be
reviewed and rehearsed by hand; nothing here enables them, and the first
unattended boot should not also be the first time the whole route runs
unattended.

### Why user units

The route reaches PipeWire through the per-user socket under
`/run/user/$UID`, and on this installation `pipewire`, `pipewire-pulse` and
`wireplumber` all run as user services. A system unit cannot reach that socket
without recreating the session around it.

The consequence is the step that is easy to miss: **without lingering the user
manager does not exist at boot**, so no user unit starts and `/run/user/$UID`
is never created. Check before anything else:

```bash
loginctl show-user "$USER" -p Linger      # Linger=no means nothing will start
sudo loginctl enable-linger "$USER"
```

### Install

```bash
mkdir -p ~/.config/systemd/user ~/.config/relay
cp deploy/*.service ~/.config/systemd/user/
printf 'PORT=3100\n' > ~/.config/relay/robot.env   # add RELAY_KEY= here if used
chmod 600 ~/.config/relay/robot.env
systemctl --user daemon-reload
```

The units read `~/.config/relay/robot.env`, which is optional and overrides
their built-in `PORT` default. The key belongs in that file rather than in a
unit: `~/.config/systemd/user` is readable, and the units are in the
repository.

### Rehearse before enabling

```bash
systemctl --user start relay-server.service
systemctl --user start relay-robot-source.service
curl -s http://localhost:3100/statusz | jq '{ok, state, faults}'
systemctl --user stop relay-robot-source.service    # sink and Chromium go too
```

Only after the integrated phone-microphone + robot-backing + calibration test
passes on real devices, and the units have been exercised by hand:

```bash
systemctl --user enable relay-server.service relay-robot-source.service
```

### What the units add over running the scripts

- **A readiness gate, not just ordering.** `After=` sequences starts but does
  not wait for the port to listen, and Chromium does not retry a refused load.
  `ExecStartPre` polls `/healthz` the way `robot:doctor` does, so a boot race
  cannot leave the source page on an error screen while every process in the
  unit looks healthy.
- **Failure that stays still.** `Restart=on-failure` uses the exit status the
  launcher already reports, and `StartLimitBurst` stops the retrying after five
  attempts in two minutes rather than respawning Chromium indefinitely. A
  stopped unit reads the same on every `/statusz` poll; a thrashing one does
  not.
- **Cleanup that survives SIGKILL.** The launcher's own trap handles signals,
  and systemd's cgroup sweep handles the case where the trap never runs.

Two units rather than one because the phone talks to the server: collapsing
them would make a Chromium crash end the singer's session along with the
backing route.

### Still manual after this

Nothing acts on a `/statusz` fault. Recovery is restarting a unit by hand, and
a watchdog would need a narrower signal than `ok: false` — several faults it
reports are phone-side, and restarting the robot route would not touch them.

## Current deployment checkpoint

The manually launched robot backing route is reproducible and validated. Full phone microphone + robot backing + automatic calibration still needs an integrated real-device sung Take rehearsal. That rehearsal remains the gate on enabling the units above.
