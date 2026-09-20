#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

test -f "$repo_dir/Service.qml"
rg -q '"service": "Service.qml"' "$repo_dir/manifest.json"
rg -q 'gjs' "$repo_dir/Service.qml"
rg -q '"-m"' "$repo_dir/Service.qml"
rg -q 'backend/relaxy.js' "$repo_dir/Service.qml"
rg -q 'assets/sounds' "$repo_dir/Service.qml"
rg -q 'XDG_RUNTIME_DIR' "$repo_dir/Service.qml"
rg -q 'TMPDIR' "$repo_dir/Service.qml"

echo "Service contract is complete."
