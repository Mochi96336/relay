#!/usr/bin/env bash

# This helper stores child-process output in a failure artifact.
# Only use it for CI checks/tests that cannot emit credentials or other secrets.
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
normalized_file="${summary_dir}/${slug}-normalized.txt"
markers_file="${summary_dir}/${slug}-markers.txt"
marker_excerpt_file="${summary_dir}/${slug}-marker-excerpt.txt"
final_tail_file="${summary_dir}/${slug}-final-tail.txt"
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

# Normalize progress-style carriage returns and ANSI decoration before looking
# for causal failure markers. Keep the raw Actions log untouched.
tr '\r' '\n' < "$log_file" \
  | sed -E $'s/\x1B\\[[0-9;?]*[ -\\/]*[@-~]//g' \
  > "$normalized_file"

# A final tail alone can lose an early test failure when a large suite keeps
# running. Preserve bounded windows around the first few likely failure markers,
# then append the final output so aggregate test counts remain visible.
failure_pattern='(^|[[:space:]])(not ok|FAIL|FAILED|AssertionError|SyntaxError:|Error:|ERR_[[:alnum:]_]+|error TS[0-9]+|syntax error)|^✖[[:space:]]'
grep -nE "$failure_pattern" "$normalized_file" | sed -n '1,8p' > "$markers_file" || true
: > "$marker_excerpt_file"
last_window_end=0
marker_windows=0
while IFS=: read -r marker_line _; do
  [[ "$marker_line" =~ ^[0-9]+$ ]] || continue
  (( marker_line <= last_window_end )) && continue
  start=$(( marker_line > 8 ? marker_line - 8 : 1 ))
  end=$(( marker_line + 24 ))
  printf '\n--- lines %d-%d around failure marker at line %d ---\n' \
    "$start" "$end" "$marker_line" >> "$marker_excerpt_file"
  sed -n "${start},${end}p" "$normalized_file" >> "$marker_excerpt_file"
  last_window_end="$end"
  marker_windows=$(( marker_windows + 1 ))
  (( marker_windows >= 4 )) && break
done < "$markers_file"

: > "$excerpt_file"
if [[ -s "$marker_excerpt_file" ]]; then
  {
    echo 'DETECTED FAILURE CONTEXT (first markers, bounded to 7 KiB)'
    echo '----------------------------------------------------------'
  } >> "$excerpt_file"
  head -c 7168 "$marker_excerpt_file" >> "$excerpt_file"
  printf '\n\n' >> "$excerpt_file"
fi

tail -n 40 "$normalized_file" > "$final_tail_file"
{
  echo 'FINAL OUTPUT (last 40 normalized lines, final 4 KiB)'
  echo '---------------------------------------------------'
} >> "$excerpt_file"
tail -c 4096 "$final_tail_file" >> "$excerpt_file"

rm -f \
  "$normalized_file" \
  "$markers_file" \
  "$marker_excerpt_file" \
  "$final_tail_file"

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
    echo '### Failure evidence'
    echo
    echo '```text'
    cat "$excerpt_file"
    echo
    echo '```'
    echo
    echo '_Failure evidence is bounded to marker context plus the final output; the full output remains in the Actions log._'
  } >> "$GITHUB_STEP_SUMMARY"
fi

echo "::error title=${step} failed::See the job summary and ${artifact_name} artifact for bounded failure evidence."
exit "$status"
