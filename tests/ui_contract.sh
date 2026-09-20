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
grep -q 'commandProcess.command = \["gjs", "-m"' "$repo_dir/ui/Panel.qml"
grep -q 'PanelSlider' "$repo_dir/ui/Panel.qml"
if grep -q 'QQC2.Slider' "$repo_dir/ui/Panel.qml"; then
  echo "Relaxy panel should use the Omarchy PanelSlider control." >&2
  exit 1
fi
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
grep -q 'Catalog.version' "$repo_dir/ui/Panel.qml"
grep -q 'Catalog.license' "$repo_dir/ui/Panel.qml"
grep -q 'SOUNDS_LICENSES.md' "$repo_dir/ui/Panel.qml"
grep -q 'statusPath' "$repo_dir/ui/Panel.qml"
grep -q 'XDG_RUNTIME_DIR' "$repo_dir/ui/Panel.qml"
grep -q 'TMPDIR' "$repo_dir/ui/Panel.qml"
grep -q 'lastError' "$repo_dir/ui/Panel.qml"
grep -q 'dismiss-error' "$repo_dir/ui/Panel.qml"

echo "Relaxy shell UI contract is present."
