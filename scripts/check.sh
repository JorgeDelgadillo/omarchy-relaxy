#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v jq >/dev/null
command -v omarchy-plugin-validate >/dev/null
omarchy-plugin-validate "$repo_dir"
jq -e '.id == "jdelgadillo.relaxy" and .schemaVersion == 1' "$repo_dir/manifest.json" >/dev/null

if [[ -e "$repo_dir/AGENTS.md" ]]; then
  echo "AGENTS.md must not ship inside the plugin tree; see docs/DEVELOPMENT.md." >&2
  exit 1
fi

echo "Relaxy plugin manifest is valid."

