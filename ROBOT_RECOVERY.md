# Robot semantic recovery

Relay already has three lower recovery layers on the robot: application reconnects, the in-page YouTube watchdog, and systemd process restart. This supervisor adds one narrow layer above them for cases where every process is still alive but the Robot route is no longer healthy.

## Evidence boundary

The supervisor deliberately does **not** parse `/statusz` fault prose. `/statusz` remains an operator-facing summary. Automatic recovery uses two independent machine-readable facts:

- `systemd` decides whether `relay-robot-source.service` is currently **active**, which is the operator's intent that the Robot route should exist;
- `/readyz` describes whether the route is actually present and carrying audio.

This separation matters when Relay has forgotten the whole route. An idle `/readyz` snapshot is correctly healthy from the application's point of view, but an **active** Robot service whose backing bridge and source page are both absent is still a semantic service failure and may be repaired. Conversely, a deliberately stopped or failed Robot service never gains implicit start authority from this supervisor.

The automatic allowlist is intentionally small:

- `backing-not-connected`
- `backing-not-streaming`
- `robot-source-not-connected`

Everything else fails closed. In particular, Mic, phone timeline, calibration, `backing-not-robot`, and any future readiness reason do not gain restart authority automatically.

## Recovery policy

Defaults:

- poll systemd and `/readyz` every 5 seconds;
- require the same allowlisted fault continuously for 30 seconds;
- after an attempted repair, wait 60 seconds before a new fault can start another grace window;
- allow at most 3 restart attempts in 10 minutes;
- repair only `relay-robot-source.service`;
- never start an inactive Robot route, restart `relay-server.service`, or reboot the host.

The restart budget and cooldown live in `${XDG_RUNTIME_DIR}/relay-robot-supervisor.json`, so restarting the supervisor process does not erase its recent recovery attempts. The runtime directory is recreated at boot, which intentionally starts a fresh boot-level budget. A malformed or unreadable existing state file is treated as a safety failure rather than as an empty budget.

If Relay itself is unreachable, `/readyz` cannot be parsed, or systemd state cannot be read, the supervisor takes no action and breaks continuous-fault evidence. Server/process recovery remains systemd's responsibility.

The supervisor uses `127.0.0.1` for `/readyz`. This is intentionally different from `source.html`, whose validated YouTube origin must remain `localhost`; the readiness probe has no origin requirement and should not depend on IPv6 localhost resolution while Relay listens on `0.0.0.0`.

## Rehearse in dry-run mode

Install the unit beside the other user units, but do not enable it yet:

```bash
cp deploy/relay-robot-supervisor.service ~/.config/systemd/user/
systemctl --user daemon-reload
```

Start the normal Robot route through systemd first, because the active unit is the supervisor's authority boundary:

```bash
systemctl --user start relay-server.service relay-robot-source.service
```

Then run the policy without allowing `systemctl restart`:

```bash
RELAY_SUPERVISOR_DRY_RUN=1 PORT=3100 npm run robot:supervisor
```

Dry-run uses a separate runtime state file and logs `would restart ...` when the real supervisor would act.

Useful policy overrides for rehearsal live in `~/.config/relay/robot.env`:

```bash
RELAY_SUPERVISOR_POLL_MS=5000
RELAY_SUPERVISOR_FAULT_GRACE_MS=30000
RELAY_SUPERVISOR_COOLDOWN_MS=60000
RELAY_SUPERVISOR_BUDGET_WINDOW_MS=600000
RELAY_SUPERVISOR_MAX_RESTARTS=3
```

After observing the intended behavior on the Pi, remove `RELAY_SUPERVISOR_DRY_RUN=1`, then start the service manually:

```bash
systemctl --user start relay-robot-supervisor.service
journalctl --user -u relay-robot-supervisor.service -f
```

Only after a real fault-injection rehearsal should it be enabled at boot:

```bash
systemctl --user enable relay-robot-supervisor.service
```

Stopping `relay-robot-source.service` is itself sufficient to withdraw automatic restart authority. For maintenance performed while the route unit intentionally remains active but its internals are being disrupted, stop the supervisor too.
