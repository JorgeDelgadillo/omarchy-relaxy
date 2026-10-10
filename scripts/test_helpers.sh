#!/usr/bin/env bash

run_required() {
  if (( $# < 2 )); then
    echo "run_required needs a label and a command" >&2
    return 2
  fi
  local label="$1"
  shift
  printf '[RUN] %s\n' "$label"
  if "$@"; then
    printf '[PASS] %s\n' "$label"
  else
    local status=$?
    printf '[FAIL] %s (exit %s)\n' "$label" "$status" >&2
    return "$status"
  fi
}

report_skip() {
  if (( $# != 2 )); then
    echo "report_skip needs a label and a reason" >&2
    return 2
  fi
  printf '[SKIP] %s: %s\n' "$1" "$2"
}
