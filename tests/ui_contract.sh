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
grep -q 'add-preset' "$repo_dir/ui/Panel.qml"
grep -q 'rename-preset' "$repo_dir/ui/Panel.qml"
grep -q 'remove-preset' "$repo_dir/ui/Panel.qml"
grep -q 'add-custom-sound' "$repo_dir/ui/Panel.qml"
grep -q 'rename-custom-sound' "$repo_dir/ui/Panel.qml"
grep -q 'remove-custom-sound' "$repo_dir/ui/Panel.qml"
grep -q 'set-start-paused' "$repo_dir/ui/Panel.qml"
grep -q 'set-inhibit-suspension' "$repo_dir/ui/Panel.qml"
grep -q 'set-hide-inactive' "$repo_dir/ui/Panel.qml"
grep -q 'FileDialog' "$repo_dir/ui/Panel.qml"
grep -q 'About Relaxy' "$repo_dir/ui/Panel.qml"

echo "Relaxy shell UI contract is present."
