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
command -v node >/dev/null 2>&1 || die "required command not found: node"

# systemd starts this without npm, so resolve the entry from the checkout itself.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# systemd serializes its own oneshot invocations, but an operator can invoke the
# same command while the timer-owned run is still sampling, restarting, or
# proving PCM recovery. Hold one host-local lock across that entire authority
# window so two processes cannot read the same pre-restart budget and both act.
lock_file="$runtime_dir/relay-robot-semantic-recovery-live.lock"
exec {lock_fd}>"$lock_file"
if ! flock -n "$lock_fd"; then
  printf '%s\n' '{"mode":"live","skipped":"already-running","restartAttempted":false}'
  exit 0
fi

# The entry runs as one prebuilt bundle. Loading it through tsx cost about
# 0.45 s of CPU, and the timer starts a run every ~12 s. The bundle is keyed by
# a hash of everything that shapes it: src/, the lockfile, tsconfig.json (which
# esbuild reads) and this script (which holds esbuild's flags). Any change to
# those, however it got there, builds a new one. It lives in the runtime
# directory, never in the checkout, and is built under the lock. If hashing or
# esbuild fails, this run uses tsx instead: recovery never waits on its own build.
entry=src/robot-semantic-recovery-live-entry.ts
bundle=""
if source_hash="$(find src package-lock.json tsconfig.json scripts/robot-semantic-recovery-live.sh \
    -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum)"; then
  bundle="$runtime_dir/relay-robot-semantic-recovery-live.${source_hash:0:16}.mjs"
fi
if [[ -z "$bundle" ]]; then
  log "could not hash the sources of $entry; running it through tsx"
elif [[ ! -f "$bundle" ]]; then
  rm -f "$runtime_dir"/relay-robot-semantic-recovery-live.*.mjs
  if ! node_modules/.bin/esbuild "$entry" --bundle --platform=node --format=esm \
      --log-level=warning --outfile="$bundle.tmp" \
    || ! mv -f "$bundle.tmp" "$bundle"; then
    rm -f "$bundle" "$bundle.tmp"
    bundle=""
    log "could not bundle $entry; running it through tsx"
  fi
fi

# Keep this shell alive while the live entry runs so it remains the unambiguous
# owner of lock_fd for the complete evaluation/effect/verification lifetime.
if [[ -n "$bundle" ]]; then
  node "$bundle"
else
  node --import tsx "$entry"
fi
