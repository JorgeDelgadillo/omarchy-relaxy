#!/usr/bin/env bash
set -euo pipefail

if [[ "${RELAXY_INTEGRATION_DBUS:-0}" != "1" ]] && command -v dbus-run-session >/dev/null 2>&1; then
  RELAXY_INTEGRATION_DBUS=1 exec dbus-run-session -- "$0" "$@"
fi

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_dir="$(mktemp -d "${TMPDIR:-/tmp}/relaxy-integration.XXXXXX")"
socket_path="$runtime_dir/backend.sock"
state_path="$runtime_dir/state.json"
backend_pid=""

cat >"$state_path" <<'EOF'
{
  "schemaVersion": 1,
  "playing": true,
  "masterVolume": 1,
  "startPaused": true,
  "inhibitSuspension": false,
  "activePresetId": "default",
  "presets": [
    {
      "id": "default",
      "name": "Default",
      "hideInactive": false,
      "volumes": {},
      "mutes": {}
    }
  ],
  "customSounds": []
}
EOF

cleanup() {
  if [[ -n "$backend_pid" ]] && kill -0 "$backend_pid" 2>/dev/null; then
    kill -TERM "$backend_pid" 2>/dev/null || true
    wait "$backend_pid" 2>/dev/null || true
  fi
  rm -rf -- "$runtime_dir"
}
trap cleanup EXIT

RELAXY_AUDIO_SINK=fakesink gjs -m "$repo_dir/backend/relaxy.js" \
  --socket "$socket_path" \
  --state "$state_path" \
  --assets "$repo_dir/assets/sounds" \
  >"$runtime_dir/backend.log" 2>&1 &
backend_pid=$!

for _attempt in $(seq 1 50); do
  [[ -S "$socket_path" ]] && break
  sleep 0.1
done
[[ -S "$socket_path" ]] || { sed -n '1,120p' "$runtime_dir/backend.log"; exit 1; }
[[ "$(stat -c %a "$socket_path")" == "600" ]] || { echo "backend socket must be mode 0600" >&2; exit 1; }
[[ "$(stat -c %a "$runtime_dir")" == "700" ]] || { echo "backend socket directory must be mode 0700" >&2; exit 1; }

command_response() {
  gjs -m "$repo_dir/backend/relaxy.js" --command "$1" --socket "$socket_path"
}

get_state() {
  command_response '{"id":"integration-get-state","action":"get-state","payload":{}}'
}

response="$(get_state)"
jq -e '.ok == true and .state.schemaVersion == 1 and .state.startPaused == true and .state.playing == false and ((.state.presets | length) == 1)' <<<"$response" >/dev/null
jq -e '.playing == false and .startPaused == true' "$state_path" >/dev/null

response="$(command_response '{"id":"integration-play","action":"play","payload":{}}')"
jq -e '.ok == true and .state.playing == true' <<<"$response" >/dev/null

response="$(command_response '{"id":"integration-volume","action":"set-master-volume","payload":{"volume":0.35}}')"
jq -e '.ok == true and .state.masterVolume == 0.35' <<<"$response" >/dev/null

response="$(command_response '{"id":"integration-preset","action":"add-preset","payload":{"name":"Integration Focus"}}')"
jq -e '.ok == true and ((.state.presets | length) == 2)' <<<"$response" >/dev/null

response="$(command_response '{"id":"integration-custom","action":"add-custom-sound","payload":{"path":"/tmp/integration.ogg","name":"Integration Sound"}}')"
jq -e '.ok == true and (.state.customSounds | length) == 1' <<<"$response" >/dev/null

custom_id="$(jq -r '.state.customSounds[0].id' <<<"$response")"
status_path="${socket_path%.sock}.status.json"

response="$(command_response "{\"id\":\"integration-custom-volume\",\"action\":\"set-sound-volume\",\"payload\":{\"soundId\":\"$custom_id\",\"volume\":0.2}}")"
jq -e '.ok == true' <<<"$response" >/dev/null

for _attempt in $(seq 1 50); do
  [[ -f "$status_path" ]] && jq -e --arg custom_id "$custom_id" '.lastError.soundId == $custom_id' "$status_path" >/dev/null 2>&1 && break
  sleep 0.1
done
jq -e --arg custom_id "$custom_id" '.lastError.soundId == $custom_id and (.lastError.message | length > 0)' "$status_path" >/dev/null
rg -q 'relaxy: sound .* error:' "$runtime_dir/backend.log"

response="$(command_response '{"id":"integration-dismiss","action":"dismiss-error","payload":{}}')"
jq -e '.ok == true' <<<"$response" >/dev/null
jq -e '.lastError == null and (.pid | type == "number" and . > 1)' "$status_path" >/dev/null
[[ "$(stat -c %a "$status_path")" == "600" ]] || { echo "backend status file must be mode 0600" >&2; exit 1; }

response="$(command_response "{\"id\":\"integration-hide\",\"action\":\"set-hide-inactive\",\"payload\":{\"value\":true}}")"
jq -e '.ok == true and .state.presets[1].hideInactive == true' <<<"$response" >/dev/null

response="$(command_response '{"id":"integration-sound","action":"set-sound-volume","payload":{"soundId":"rain","volume":0.2}}')"
jq -e '.ok == true and .state.presets[1].volumes.rain == 0.2 and .state.presets[1].mutes.rain == false' <<<"$response" >/dev/null
sleep 0.5
if rg -q 'Attempting to call back into JSAPI|reason not-linked|Could not create the Relaxy audio pipeline' "$runtime_dir/backend.log"; then
  sed -n '1,160p' "$runtime_dir/backend.log"
  exit 1
fi

response="$(command_response '{"id":"integration-reset","action":"reset-volumes","payload":{}}')"
jq -e '.ok == true and (.state.presets[1].volumes | length) == 0 and (.state.presets[1].mutes | length) == 0' <<<"$response" >/dev/null
[[ "$(stat -c %a "$state_path")" == "600" ]] || { echo "backend state file must be mode 0600" >&2; exit 1; }

response="$(command_response '{"id":"integration-bad-type","action":"set-master-volume","payload":{"volume":"loud"}}')"
jq -e '.ok == false' <<<"$response" >/dev/null

response="$(command_response '{"id":"integration-extra-field","action":"set-master-volume","payload":{"volume":0.5,"extra":true}}')"
jq -e '.ok == false' <<<"$response" >/dev/null

response="$(command_response '{"id":"integration-unknown","action":"delete-everything","payload":{}}')"
jq -e '.ok == false' <<<"$response" >/dev/null

response="$(command_response '{"id":"integration-bad-shape","action":"get-state","payload":[]}')"
jq -e '.ok == false' <<<"$response" >/dev/null

if ! python3 - "$socket_path" <<'EOF'
import socket
import sys
path = sys.argv[1]
peer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
peer.connect(path)
peer.sendall(b"A" * 200000 + b"\n")
peer.settimeout(5)
try:
    data = peer.recv(4096)
except (ConnectionResetError, BrokenPipeError, OSError) as error:
    print(f"oversized request rejected ({type(error).__name__})")
    sys.exit(0)
if data:
    print(f"unexpected response to oversized request: {data[:64]!r}")
    sys.exit(1)
print("oversized request rejected (connection closed)")
EOF
then
  echo "backend must reject oversized requests" >&2
  exit 1
fi

response="$(get_state)"
jq -e '.ok == true and .state.masterVolume == 0.35' <<<"$response" >/dev/null

response="$(get_state)"
jq -e --arg custom_id "$custom_id" '.state.masterVolume == 0.35 and .state.customSounds[0].id == $custom_id and .state.presets[1].hideInactive == true' <<<"$response" >/dev/null

if command -v gdbus >/dev/null 2>&1 && [[ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
  if ! mpris_status="$(gdbus call --session \
    --dest org.mpris.MediaPlayer2.Relaxy \
    --object-path /org/mpris/MediaPlayer2 \
    --method org.freedesktop.DBus.Properties.Get \
    org.mpris.MediaPlayer2.Player PlaybackStatus 2>&1)"; then
    echo "MPRIS integration failed: a session bus was available but Relaxy did not expose PlaybackStatus: $mpris_status" >&2
    sed -n '1,160p' "$runtime_dir/backend.log" >&2
    exit 1
  fi
  if [[ "$mpris_status" != *"Playing"* ]]; then
    echo "MPRIS integration failed: expected PlaybackStatus=Playing, received: $mpris_status" >&2
    exit 1
  fi
  if ! gdbus call --session \
    --dest org.mpris.MediaPlayer2.Relaxy \
    --object-path /org/mpris/MediaPlayer2 \
    --method org.mpris.MediaPlayer2.Player.PlayPause >/dev/null; then
    echo "MPRIS integration failed: PlayPause could not be called." >&2
    exit 1
  fi
  response="$(get_state)"
  jq -e '.state.playing == false' <<<"$response" >/dev/null
  echo "[PASS] MPRIS controls"
elif ! command -v gdbus >/dev/null 2>&1; then
  echo "[SKIP] MPRIS controls: gdbus is not installed."
else
  echo "[SKIP] MPRIS controls: no session D-Bus is available."
fi

[[ -f "$state_path" ]]
jq -e '.schemaVersion == 1 and .masterVolume == 0.35' "$state_path" >/dev/null

kill -TERM "$backend_pid"
wait "$backend_pid" 2>/dev/null || true
backend_pid=""

recovery_socket="$runtime_dir/recovery.sock"
recovery_state_path="$runtime_dir/future-state.json"
future_original_path="$runtime_dir/future-original.json"
future_original='{"schemaVersion":99,"futureData":{"keep":"untouched"}}'
printf '%s\n' "$future_original" >"$recovery_state_path"
cp "$recovery_state_path" "$future_original_path"

RELAXY_AUDIO_SINK=fakesink gjs -m "$repo_dir/backend/relaxy.js" \
  --socket "$recovery_socket" \
  --state "$recovery_state_path" \
  --assets "$repo_dir/assets/sounds" \
  >"$runtime_dir/recovery-backend.log" 2>&1 &
backend_pid=$!

for _attempt in $(seq 1 50); do
  [[ -S "$recovery_socket" ]] && break
  sleep 0.1
done
[[ -S "$recovery_socket" ]] || { sed -n '1,120p' "$runtime_dir/recovery-backend.log"; exit 1; }
recovery_status_path="${recovery_socket%.sock}.status.json"

recovery_command() {
  gjs -m "$repo_dir/backend/relaxy.js" --command "$1" --socket "$recovery_socket"
}

for _attempt in $(seq 1 50); do
  [[ -f "$recovery_status_path" ]] && jq -e '.stateRecovery.status == "future-version" and .stateRecovery.canRecover == true' "$recovery_status_path" >/dev/null 2>&1 && break
  sleep 0.1
done
jq -e '.stateRecovery.status == "future-version" and .stateRecovery.canRecover == true' "$recovery_status_path" >/dev/null
cmp -s "$recovery_state_path" "$future_original_path"

response="$(recovery_command '{"id":"recovery-read","action":"get-state","payload":{}}')"
jq -e '.ok == true and .state.schemaVersion == 1 and .state.masterVolume == 1' <<<"$response" >/dev/null
response="$(recovery_command '{"id":"recovery-blocked-write","action":"set-master-volume","payload":{"volume":0.2}}')"
jq -e '.ok == false and .state.masterVolume == 1' <<<"$response" >/dev/null
cmp -s "$recovery_state_path" "$future_original_path"

response="$(recovery_command '{"id":"recovery-confirm","action":"recover-state","payload":{}}')"
jq -e '.ok == true and .state.schemaVersion == 1 and .state.masterVolume == 1' <<<"$response" >/dev/null
for _attempt in $(seq 1 50); do
  jq -e '.stateRecovery.status == "recovered" and (.stateRecovery.backupPath | length > 0)' "$recovery_status_path" >/dev/null 2>&1 && break
  sleep 0.1
done
recovery_backup_path="$(jq -r '.stateRecovery.backupPath' "$recovery_status_path")"
cmp -s "$recovery_backup_path" "$future_original_path"
jq -e '.schemaVersion == 1 and .masterVolume == 1' "$recovery_state_path" >/dev/null
[[ "$(stat -c %a "$recovery_backup_path")" == "600" ]]

echo "Relaxy backend integration test passed."
