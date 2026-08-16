# Robot deployment contract

Relay's product topology is **phone + robot**. The desktop used during development is only a stand-in for the robot-side browser host.

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
   └─ Monitor / Record / later Discord
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

This hostname requirement belongs only to the browser page. Machine-local readiness polling has no YouTube-origin constraint, so the semantic supervisor deliberately uses `http://127.0.0.1:$PORT/readyz` to avoid an IPv6 `localhost` resolution against Relay's IPv4 listener.

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
- launches an isolated Chromium profile under Xvfb, routed with `PULSE_SINK=relay_browser`;
- always opens `http://localhost:$PORT/source.html?robot=1`; and
- stops its child processes and unloads only a sink module it created itself.

`PORT` defaults to `3000`. `CHROMIUM_BIN` can select a nonstandard Chromium executable, and `RELAY_BROWSER_SINK` can select an existing sink with another name. The backing bridge continues to accept `RELAY_URL`, `RELAY_KEY`, `RELAY_BACKING_SAMPLE_RATE`, and `RELAY_BACKING_FRAME_MS`; see `npm run backing:stdin -- --help`. The launcher applies `RELAY_BACKING_SAMPLE_RATE` to both `parec` and the bridge so the declared rate always matches the PCM; the validated default remains 48 kHz. `RELAY_BACKING_CAPTURE_LATENCY_MS` controls `parec --latency-msec` and defaults to 40 ms; setting it explicitly avoids the roughly two-second default capture buffer observed on the robot. When `RELAY_KEY` is set, the launcher also adds it to the local source page URL so both browser and backing bridge can authenticate, without writing the key into its log line.

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

## Watching the route from another machine

The robot is unattended, so the interesting question from a second host is not
"is Relay running" but "is the route still carrying audio". `/healthz` cannot
answer that — it stays `{"ok": true}` while Chromium is dead.

```bash
curl -s http://<robot>:3100/statusz | jq '{ok, state, faults}'
```

`ok` is false only for a fault: a client that is connected but has stopped
sending audio, or a robot route missing its backing source or its source page.
Warnings such as a stale calibration are reported separately and leave `ok`
true, because audio still flows. With nothing connected the state is `idle`,
not a failure.

Relay binds `0.0.0.0`, and the endpoint is unauthenticated like `/healthz`
even when `RELAY_KEY` is set, so a poller needs no credentials — and the
payload therefore contains no nicknames and no key.

`/statusz` remains observation for people and external monitors; automatic
recovery does not parse its prose. The optional semantic supervisor instead
combines systemd `ActiveState` (whether the Robot route is intended to exist)
with `/readyz` component facts (whether it is actually present and streaming).
Its authority is deliberately limited to restarting
`relay-robot-source.service` for a small allowlist of persistent Robot-route
faults. See `ROBOT_RECOVERY.md` for the exact policy and rehearsal procedure.

## Ownership boundaries

- `source.html` mirrors the phone's YouTube media timeline.
- `scripts/robot-source.sh` owns robot-local browser audio capture and process cleanup.
- `src/backing-stdin.ts` owns PCM framing, its capture clock, and backing transport reconnection.
- `src/server.ts` owns WebSocket routing and source lifecycle orchestration.
- `AudioSession` owns the shared PCM timelines, alignment, mixer, and signal processing.
- `CalibrationSession` observes those timelines and owns measurement validity.
- `robot-supervisor` owns only the bounded semantic decision to restart the Robot route; it does not own media, calibration, the Relay server, or host reboot.

The launcher does not create a second mixer clock or alignment model. Observed follower deltas are diagnostics, not configuration: final audio alignment remains the calibration system's job.

## Boot services: written, deliberately not enabled

`deploy/` holds three systemd **user** units:

- `relay-server.service`
- `relay-robot-source.service`
- `relay-robot-supervisor.service`

They are committed so the boot design can be reviewed and rehearsed by hand;
nothing here enables them. The server and Robot route should be validated
first, and the supervisor must be rehearsed in dry-run mode before it is given
restart authority or enabled at boot.

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

Start the two workload units first:

```bash
systemctl --user start relay-server.service
systemctl --user start relay-robot-source.service
curl -s http://localhost:3100/statusz | jq '{ok, state, faults}'
```

Then rehearse semantic recovery separately and in dry-run mode as documented
in `ROBOT_RECOVERY.md`. In particular, stopping `relay-robot-source.service`
must withdraw Supervisor authority rather than cause an implicit start.

A normal maintenance stop remains:

```bash
systemctl --user stop relay-robot-source.service    # sink and Chromium go too
```

Only after the integrated phone-microphone + robot-backing + calibration test
passes on real devices, the workload units have been exercised by hand, and
the Supervisor fault-injection rehearsal passes:

```bash
systemctl --user enable relay-server.service relay-robot-source.service
systemctl --user enable relay-robot-supervisor.service
```

### What the units add over running the scripts

- **A readiness gate, not just ordering.** `After=` sequences starts but does
  not wait for the port to listen, and Chromium does not retry a refused load.
  `ExecStartPre` polls `/healthz` the way `robot:doctor` does, so a boot race
  cannot leave the source page on an error screen while every process in the
  unit looks healthy.
- **Process failure that stays bounded.** `Restart=on-failure` uses the exit
  status the launcher already reports, and `StartLimitBurst` stops the retrying
  after repeated process failures rather than respawning Chromium indefinitely.
- **Cleanup that survives SIGKILL.** The launcher's own trap handles signals,
  and systemd's cgroup sweep handles the case where the trap never runs.
- **Semantic recovery above process liveness.** When the Robot route unit is
  still active but its backing/source function remains broken, the Supervisor
  waits for a persistent allowlisted `/readyz` fault and may restart that route
  within its cooldown and retry budget.

The server and Robot route remain separate because the phone talks to the
server: a Chromium/capture problem must not end the singer's Relay session.
The Supervisor is a third, narrower unit so its policy can fail or be stopped
without changing either workload's lifecycle.

### What remains manual

The Supervisor is intentionally not a general fixer. Mic and phone-side
failures, playback/timeline problems, calibration faults, non-Robot backing,
unknown readiness reasons, Relay server restart, and host reboot all remain
manual diagnosis/recovery boundaries. An inactive Robot route also remains
inactive; the Supervisor has restart authority only while that unit is already
active.

## Current checkpoint and next stage

The Robot backing route and the bounded semantic-recovery policy are covered by
the automated regression suite, including the real HTTP/3/WebTransport loopback.
The remaining deployment gate is real Pi rehearsal: first dry-run fault
injection, then one controlled semantic hang with restart authority enabled.
Only after that evidence should the Supervisor be enabled for unattended boot.
