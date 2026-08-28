#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
catalog="$repo_dir/assets/catalog.json"

test "$(jq '.sounds | length' "$catalog")" -eq 14
test "$(jq '[.groups[].sounds[]] | length' "$catalog")" -eq 14
test "$(jq '[.sounds[].id] | unique | length' "$catalog")" -eq 14
test "$(jq '[.sounds[] | select(.type == "file")] | length' "$catalog")" -eq 12
test "$(jq '[.sounds[] | select(.type == "noise")] | length' "$catalog")" -eq 2

while IFS= read -r file; do
  test -f "$repo_dir/assets/sounds/$file"
done < <(jq -r '.sounds[] | select(.type == "file") | .file' "$catalog")

echo "Sound catalog is complete."

