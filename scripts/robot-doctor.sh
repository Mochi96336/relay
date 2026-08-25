#!/usr/bin/env bash

set -uo pipefail

PORT="${PORT:-3000}"
SINK_NAME="${RELAY_BROWSER_SINK:-relay_browser}"
CHROMIUM_BIN="${CHROMIUM_BIN:-}"
failures=0

ok() {
  printf '[robot-doctor] OK   %s\n' "$*"
}

warn() {
  printf '[robot-doctor] WARN %s\n' "$*" >&2
}

fail() {
  printf '[robot-doctor] FAIL %s\n' "$*" >&2
  failures=$((failures + 1))
}

check_command() {
  if command -v "$1" >/dev/null 2>&1; then
    ok "command available: $1"
  else
    fail "required command not found: $1"
  fi
}

if [[ "$PORT" =~ ^[0-9]+$ ]] && ((10#$PORT >= 1 && 10#$PORT <= 65535)); then
  port_number=$((10#$PORT))
  ok "PORT=$port_number"
else
  fail "PORT must be an integer from 1 to 65535"
  port_number=3000
fi

if [[ "$SINK_NAME" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  ok "sink name: $SINK_NAME"
else
  fail "RELAY_BROWSER_SINK may contain only letters, numbers, dot, underscore, and hyphen"
fi

for command_name in pactl parec xvfb-run npm node curl flock; do
  check_command "$command_name"
done

if [[ -z "$CHROMIUM_BIN" ]]; then
  if command -v chromium >/dev/null 2>&1; then
    CHROMIUM_BIN="chromium"
    ok "Chromium executable: $CHROMIUM_BIN"
  elif command -v chromium-browser >/dev/null 2>&1; then
    CHROMIUM_BIN="chromium-browser"
    ok "Chromium executable: $CHROMIUM_BIN"
  else
    fail "Chromium not found (set CHROMIUM_BIN to override)"
  fi
elif command -v "$CHROMIUM_BIN" >/dev/null 2>&1; then
  ok "Chromium executable: $CHROMIUM_BIN"
else
  fail "CHROMIUM_BIN is not executable: $CHROMIUM_BIN"
fi

if command -v pactl >/dev/null 2>&1; then
  if pactl info >/dev/null 2>&1; then
    ok "PipeWire/PulseAudio server is reachable"

    if pactl list short sinks | awk -v sink="$SINK_NAME" '$2 == sink { found = 1 } END { exit !found }'; then
      ok "sink exists: $SINK_NAME"
      if pactl list short sources | awk -v monitor="${SINK_NAME}.monitor" '$2 == monitor { found = 1 } END { exit !found }'; then
        ok "monitor exists: ${SINK_NAME}.monitor"
      else
        fail "sink exists but monitor is missing: ${SINK_NAME}.monitor"
      fi
    else
      warn "sink does not exist yet; robot:source will create $SINK_NAME"
    fi
  else
    fail "could not connect to the PipeWire/PulseAudio server"
  fi
fi

relay_base="http://localhost:${port_number}"
if command -v curl >/dev/null 2>&1; then
  if curl --fail --silent --show-error --max-time 3 "$relay_base/healthz" >/dev/null; then
    ok "Relay health endpoint: $relay_base/healthz"
  else
    fail "Relay health endpoint is unavailable: $relay_base/healthz"
  fi

  if curl --fail --silent --show-error --max-time 3 "$relay_base/source.html?robot=1" >/dev/null; then
    ok "robot source page uses the required localhost origin"
  else
    fail "robot source page is unavailable: $relay_base/source.html?robot=1"
  fi
fi

if command -v pgrep >/dev/null 2>&1; then
  if pgrep -f '[s]rc/backing-stdin' >/dev/null 2>&1; then
    ok "backing bridge process is running"
  else
    warn "backing bridge is not running (expected before robot:source starts)"
  fi

  if pgrep -f '[s]ource\.html\?robot=1' >/dev/null 2>&1; then
    ok "robot source browser process is running"
  else
    warn "robot source browser is not running (expected before robot:source starts)"
  fi
fi

if ((failures > 0)); then
  printf '[robot-doctor] RESULT %d check(s) failed\n' "$failures" >&2
  exit 1
fi

printf '[robot-doctor] RESULT ready for robot:source\n'
