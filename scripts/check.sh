#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v jq >/dev/null
command -v omarchy-plugin-validate >/dev/null
omarchy-plugin-validate "$repo_dir"
jq -e '.id == "jdelgadillo.relaxy" and .schemaVersion == 1' "$repo_dir/manifest.json" >/dev/null

echo "Relaxy plugin manifest is valid."

