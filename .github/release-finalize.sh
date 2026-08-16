#!/usr/bin/env bash
set -euo pipefail

test "$(git branch --show-current)" = 'integration'
git fetch origin main

echo '=== merge current main into verified integration tree ==='
if ! git merge --no-ff --no-commit origin/main; then
  echo 'FINAL_MAIN_CONFLICTS_BEGIN'
  git diff --name-only --diff-filter=U
  echo 'FINAL_MAIN_CONFLICTS_END'
  echo 'FINAL_MAIN_CONFLICT_DIFF_BEGIN'
  git diff --cc
  echo 'FINAL_MAIN_CONFLICT_DIFF_END'
  exit 1
fi

echo 'FINAL_MAIN_MERGE_CLEAN'
