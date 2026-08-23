#!/usr/bin/env bash

set -o pipefail

if (( $# < 5 )); then
  echo "usage: $0 <job> <slug> <step> -- <command> [args...]" >&2
  exit 64
fi

job="$1"
slug="$2"
step="$3"
shift 3

if [[ "$1" != "--" ]]; then
  echo "ci-run: expected -- before command" >&2
  exit 64
fi
shift

if (( $# == 0 )); then
  echo "ci-run: missing command" >&2
  exit 64
fi

if [[ ! "$slug" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "ci-run: invalid slug: $slug" >&2
  exit 64
fi

log_dir="${RUNNER_TEMP:-/tmp}"
log_file="${log_dir}/relay-ci-${slug}.log"
summary_dir="ci-summary"
excerpt_file="${summary_dir}/${slug}-excerpt.txt"
failure_file="${summary_dir}/${slug}-failure.txt"
artifact_name="ci-failure-${slug}"

printf -v command_text '%q ' "$@"
command_text="${command_text% }"

set +e
"$@" 2>&1 | tee "$log_file"
status=${PIPESTATUS[0]}

if (( status == 0 )); then
  exit 0
fi

mkdir -p "$summary_dir"

tail -n 120 "$log_file" \
  | sed -E $'s/\x1B\\[[0-9;?]*[ -\\/]*[@-~]//g' \
  > "${summary_dir}/${slug}-tail.txt"
tail -c 12288 "${summary_dir}/${slug}-tail.txt" > "$excerpt_file"
rm -f "${summary_dir}/${slug}-tail.txt"

{
  echo 'Relay CI Failure Summary'
  echo '========================'
  echo
  echo "workflow=${GITHUB_WORKFLOW:-CI}"
  echo "job=${job}"
  echo "step=${step}"
  echo "sha=${GITHUB_SHA:-unknown}"
  echo "exit_code=${status}"
  echo "command=${command_text}"
  echo
  echo 'FAILURE EXCERPT (last 120 lines, final 12 KiB)'
  echo '------------------------------------------------'
  cat "$excerpt_file"
} > "$failure_file"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "## ❌ ${step} failed"
    echo
    echo "- **Job:** \`${job}\`"
    echo "- **Step:** \`${step}\`"
    echo "- **Exit code:** \`${status}\`"
    echo "- **Commit:** \`${GITHUB_SHA:-unknown}\`"
    echo
    echo '### Failure excerpt'
    echo
    echo '```text'
    cat "$excerpt_file"
    echo
    echo '```'
    echo
    echo '_Excerpt is limited to the final 120 lines and final 12 KiB; the full output remains in the Actions log._'
  } >> "$GITHUB_STEP_SUMMARY"
fi

echo "::error title=${step} failed::See the job summary and ${artifact_name} artifact for bounded failure evidence."
exit "$status"
