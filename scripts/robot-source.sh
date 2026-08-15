#!/usr/bin/env bash

set -Eeuo pipefail
# Give each background component its own process group so cleanup also reaches
# npm/tsx, xvfb-run/Chromium, and any other descendants they start.
set -m

PORT="${PORT:-3000}"
SINK_NAME="${RELAY_BROWSER_SINK:-relay_browser}"
CHROMIUM_BIN="${CHROMIUM_BIN:-}"
CAPTURE_RATE="${RELAY_BACKING_SAMPLE_RATE:-48000}"
# Asked for explicitly because the default is enormous. Left alone, PipeWire
# gave this capture a 96000-sample buffer at 48 kHz - a full two seconds - which
# boot calibration measured as 2110 ms of backing latency and the mixer then
# had to correct for. It is buffering, not load: the Pi sat at 0.9 with four cores.
CAPTURE_LATENCY_MS="${RELAY_BACKING_CAPTURE_LATENCY_MS:-40}"
created_module=""
parec_pid=""
backing_pid=""
browser_pid=""
runtime_dir=""
lock_fd=""

log() {
  printf '[robot-source] %s\n' "$*" >&2
}

die() {
  log "$*"
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM

  for pid in "$browser_pid" "$backing_pid" "$parec_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    fi
  done
  for pid in "$browser_pid" "$backing_pid" "$parec_pid"; do
    if [[ -n "$pid" ]]; then
      wait "$pid" 2>/dev/null || true
    fi
  done

  if [[ -n "$created_module" ]]; then
    pactl unload-module "$created_module" 2>/dev/null || true
  fi
  if [[ -n "$runtime_dir" && -d "$runtime_dir" ]]; then
    rm -r -- "$runtime_dir"
  fi

  exit "$status"
}

trap cleanup EXIT INT TERM

require_command pactl
require_command parec
require_command xvfb-run
require_command npm
require_command node
require_command flock

pactl info >/dev/null 2>&1 || die "could not connect to the PipeWire/PulseAudio server"

if [[ -z "$CHROMIUM_BIN" ]]; then
  if command -v chromium >/dev/null 2>&1; then
    CHROMIUM_BIN="chromium"
  elif command -v chromium-browser >/dev/null 2>&1; then
    CHROMIUM_BIN="chromium-browser"
  else
    die "required command not found: chromium (set CHROMIUM_BIN to override)"
  fi
elif ! command -v "$CHROMIUM_BIN" >/dev/null 2>&1; then
  die "CHROMIUM_BIN is not executable: $CHROMIUM_BIN"
fi

[[ "$PORT" =~ ^[0-9]+$ ]] && ((10#$PORT >= 1 && 10#$PORT <= 65535)) \
  || die "PORT must be an integer from 1 to 65535"
[[ "$SINK_NAME" =~ ^[A-Za-z0-9_.-]+$ ]] \
  || die "RELAY_BROWSER_SINK may contain only letters, numbers, dot, underscore, and hyphen"
[[ "$CAPTURE_RATE" =~ ^[0-9]+$ ]] && ((10#$CAPTURE_RATE >= 8000 && 10#$CAPTURE_RATE <= 192000)) \
  || die "RELAY_BACKING_SAMPLE_RATE must be an integer from 8000 to 192000"
[[ "$CAPTURE_LATENCY_MS" =~ ^[0-9]+$ ]] && ((10#$CAPTURE_LATENCY_MS >= 5 && 10#$CAPTURE_LATENCY_MS <= 2000)) \
  || die "RELAY_BACKING_CAPTURE_LATENCY_MS must be an integer from 5 to 2000"

# Two launchers mean two Chromium players and two probes feeding the same sink.
# Protocol-level source ownership can ignore duplicate telemetry, but it cannot
# un-play audio that a second local browser has already written to PipeWire.
# Keep the whole browser/capture/bridge route single-instance per sink.
lock_file="${XDG_RUNTIME_DIR:-/tmp}/relay-robot-source-${SINK_NAME}.lock"
exec {lock_fd}>"$lock_file"
flock -n "$lock_fd" || die "another robot-source launcher already owns sink $SINK_NAME"

if ! pactl list short sinks | awk -v sink="$SINK_NAME" '$2 == sink { found = 1 } END { exit !found }'; then
  created_module="$(pactl load-module module-null-sink \
    "sink_name=$SINK_NAME" \
    "sink_properties=device.description=Relay_Browser")"
  [[ "$created_module" =~ ^[0-9]+$ ]] || die "could not create PipeWire/PulseAudio sink $SINK_NAME"
  log "created sink $SINK_NAME (module $created_module)"
else
  log "using existing sink $SINK_NAME"
fi

runtime_dir="$(mktemp -d "${TMPDIR:-/tmp}/relay-robot-source.XXXXXX")"
pcm_fifo="$runtime_dir/backing.pcm"
profile_dir="$runtime_dir/chromium-profile"
mkfifo "$pcm_fifo"
mkdir "$profile_dir"

parec --device="${SINK_NAME}.monitor" \
  --raw --format=s16le --rate="$CAPTURE_RATE" --channels=1 \
  --latency-msec="$CAPTURE_LATENCY_MS" >"$pcm_fifo" &
parec_pid=$!

# Declare robot ownership before Chromium has even loaded. The server uses this
# registration bit to suppress the legacy song-content calibrator during the
# launch gap between backing capture coming online and source.html announcing
# the active robot player.
RELAY_BACKING_ROBOT=1 RELAY_BACKING_SAMPLE_RATE="$CAPTURE_RATE" npm run backing:stdin <"$pcm_fifo" &
backing_pid=$!

source_url="http://localhost:${PORT}/source.html?robot=1"
if [[ -n "${RELAY_KEY:-}" ]]; then
  encoded_key="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$RELAY_KEY")"
  source_url+="&key=$encoded_key"
fi
log "opening http://localhost:${PORT}/source.html?robot=1 with audio routed to $SINK_NAME at $CAPTURE_RATE Hz / ${CAPTURE_LATENCY_MS} ms${RELAY_KEY:+ (authenticated)}"
PULSE_SINK="$SINK_NAME" xvfb-run -a "$CHROMIUM_BIN" \
  --user-data-dir="$profile_dir" \
  --autoplay-policy=no-user-gesture-required \
  "$source_url" &
browser_pid=$!

# Any component exiting breaks the route, so stop the other two and return its
# status. This also makes the script suitable for a future service supervisor.
set +e
wait -n "$parec_pid" "$backing_pid" "$browser_pid"
route_status=$?
set -e
# This route is expected to run until the launcher receives a signal. A child
# exiting cleanly is still a broken route and must look like a failure to a
# service supervisor using Restart=on-failure.
if ((route_status == 0)); then
  log "a route component exited unexpectedly"
  route_status=1
fi
exit "$route_status"
