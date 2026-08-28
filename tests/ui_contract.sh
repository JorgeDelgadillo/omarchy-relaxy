#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

grep -q 'moduleName: "jdelgadillo.relaxy"' "$repo_dir/BarWidget.qml"
grep -q 'source: Qt.resolvedUrl("ui/Panel.qml")' "$repo_dir/BarWidget.qml"
grep -q 'PopupCard' "$repo_dir/ui/Panel.qml"
grep -q 'Repeater' "$repo_dir/ui/Panel.qml"
grep -q 'set-sound-volume' "$repo_dir/ui/Panel.qml"
grep -q 'toggle-sound' "$repo_dir/ui/Panel.qml"
grep -q 'set-master-volume' "$repo_dir/ui/Panel.qml"

echo "Relaxy shell UI contract is present."
