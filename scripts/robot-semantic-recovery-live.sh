#!/usr/bin/env bash

set -Eeuo pipefail

log() {
  printf '[robot-semantic-recovery-live] %s\n' "$*" >&2
}

die() {
  log "$*"
  exit 1
}

runtime_dir="${XDG_RUNTIME_DIR:-}"
[[ -n "$runtime_dir" && "$runtime_dir" == /* ]] \
  || die "XDG_RUNTIME_DIR must be an absolute path"
[[ -d "$runtime_dir" ]] \
  || die "XDG_RUNTIME_DIR does not exist: $runtime_dir"
command -v flock >/dev/null 2>&1 || die "required command not found: flock"
command -v tsx >/dev/null 2>&1 || die "required command not found: tsx"

# systemd serializes its own oneshot invocations, but an operator can invoke the
# same npm command while the timer-owned run is still sampling, restarting, or
# proving PCM recovery. Hold one host-local lock across that entire authority
# window so two processes cannot read the same pre-restart budget and both act.
lock_file="$runtime_dir/relay-robot-semantic-recovery-live.lock"
exec {lock_fd}>"$lock_file"
if ! flock -n "$lock_fd"; then
  printf '%s\n' '{"mode":"live","skipped":"already-running","restartAttempted":false}'
  exit 0
fi

# Keep this shell alive while the live entry runs so it remains the unambiguous
# owner of lock_fd for the complete evaluation/effect/verification lifetime.
tsx src/robot-semantic-recovery-live-entry.ts
