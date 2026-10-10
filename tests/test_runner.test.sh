#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_dir/scripts/test_helpers.sh"

success_output="$(run_required "sample check" true)"
grep -q '\[RUN\] sample check' <<<"$success_output"
grep -q '\[PASS\] sample check' <<<"$success_output"

if failure_output="$(run_required "failing sample" bash -c 'exit 23' 2>&1)"; then
  echo "run_required must preserve a failing command's nonzero result" >&2
  exit 1
else
  failure_status=$?
fi
[[ "$failure_status" == 23 ]]
grep -q '\[FAIL\] failing sample (exit 23)' <<<"$failure_output"

skip_output="$(report_skip "optional sample" "dependency is unavailable")"
grep -q '\[SKIP\] optional sample: dependency is unavailable' <<<"$skip_output"

grep -q 'MPRIS integration failed: a session bus was available' "$repo_dir/tests/integration.sh"
grep -q '\[SKIP\] MPRIS controls:' "$repo_dir/tests/integration.sh"

echo "Test runner reporting tests passed."
