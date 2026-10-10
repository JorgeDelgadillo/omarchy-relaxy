#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_dir/scripts/test_helpers.sh"

run_required "test-runner reporting" "$repo_dir/tests/test_runner.test.sh"
run_required "shell syntax" bash -n \
  "$repo_dir/scripts/test.sh" \
  "$repo_dir/scripts/test_helpers.sh" \
  "$repo_dir/tests/integration.sh" \
  "$repo_dir/tests/socket_security.sh" \
  "$repo_dir/tests/test_runner.test.sh" \
  "$repo_dir/tests/ui_contract.sh" \
  "$repo_dir/tests/service_contract.sh"
run_required "plugin manifest and packaging" "$repo_dir/scripts/check.sh"
run_required "catalog parity" "$repo_dir/tests/check_catalog.sh"
run_required "asset checksums" bash -c 'cd "$1/assets" && sha256sum -c SHA256SUMS' _ "$repo_dir"
run_required "state model" gjs -m "$repo_dir/tests/model.test.js"
run_required "state recovery" gjs -m "$repo_dir/tests/state_recovery.test.js"
run_required "mixer recovery" env RELAXY_AUDIO_SINK=fakesink gjs -m "$repo_dir/tests/mixer.test.js"
run_required "command queue behavior" node "$repo_dir/tests/command_queue.test.js"
run_required "backend recovery policy" node "$repo_dir/tests/recovery_policy.test.js"
run_required "service contract" "$repo_dir/tests/service_contract.sh"
run_required "UI contract" "$repo_dir/tests/ui_contract.sh"
run_required "backend and MPRIS integration" "$repo_dir/tests/integration.sh"
run_required "socket security" "$repo_dir/tests/socket_security.sh"

printf '[PASS] All required Relaxy checks passed.\n'
