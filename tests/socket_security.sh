#!/usr/bin/env bash
set -euo pipefail

if [[ "${RELAXY_SOCKET_DBUS:-0}" != "1" ]] && command -v dbus-run-session >/dev/null 2>&1; then
  RELAXY_SOCKET_DBUS=1 exec dbus-run-session -- "$0" "$@"
fi

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
base_dir="$(mktemp -d "${TMPDIR:-/tmp}/relaxy-socket.XXXXXX")"
backend_pid=""

cleanup() {
  if [[ -n "$backend_pid" ]] && kill -0 "$backend_pid" 2>/dev/null; then
    kill -TERM "$backend_pid" 2>/dev/null || true
    wait "$backend_pid" 2>/dev/null || true
  fi
  rm -rf -- "$base_dir"
}
trap cleanup EXIT

user_name="$(id -un)"

# Without XDG_RUNTIME_DIR the backend must derive a per-user fallback
# directory, secure it, and bind the socket inside it.
fallback_tmp="$(mktemp -d "${TMPDIR:-/tmp}/relaxy-socket-tmp.XXXXXX")"
fallback_dir="$fallback_tmp/relaxy-$user_name"
fallback_socket="$fallback_dir/relaxy-$user_name.sock"
env -u XDG_RUNTIME_DIR TMPDIR="$fallback_tmp" RELAXY_AUDIO_SINK=fakesink \
  gjs -m "$repo_dir/backend/relaxy.js" \
  --state "$base_dir/fallback-state.json" \
  --assets "$repo_dir/assets/sounds" \
  >"$base_dir/fallback.log" 2>&1 &
backend_pid=$!

for _attempt in $(seq 1 50); do
  [[ -S "$fallback_socket" ]] && break
  sleep 0.1
done
[[ -S "$fallback_socket" ]] || { sed -n '1,120p' "$base_dir/fallback.log"; exit 1; }
[[ "$(stat -c %a "$fallback_dir")" == "700" ]] || { echo "fallback socket directory must be mode 0700" >&2; exit 1; }
[[ "$(stat -c %a "$fallback_socket")" == "600" ]] || { echo "fallback socket must be mode 0600" >&2; exit 1; }
response="$(gjs -m "$repo_dir/backend/relaxy.js" --command '{"id":"socket-fallback","action":"get-state","payload":{}}' --socket "$fallback_socket")"
jq -e '.ok == true and .state.schemaVersion == 1' <<<"$response" >/dev/null
kill -TERM "$backend_pid" 2>/dev/null || true
wait "$backend_pid" 2>/dev/null || true
backend_pid=""

# A stale regular file at the socket path must be refused, not replaced.
squat_dir="$(mktemp -d "${TMPDIR:-/tmp}/relaxy-socket-squat.XXXXXX")"
squat_socket="$squat_dir/backend.sock"
touch "$squat_socket"
RELAXY_AUDIO_SINK=fakesink gjs -m "$repo_dir/backend/relaxy.js" \
  --socket "$squat_socket" \
  --state "$base_dir/squat-state.json" \
  --assets "$repo_dir/assets/sounds" \
  >"$base_dir/squat.log" 2>&1 &
backend_pid=$!
sleep 3
if kill -0 "$backend_pid" 2>/dev/null; then
  kill -TERM "$backend_pid" 2>/dev/null || true
  wait "$backend_pid" 2>/dev/null || true
  echo "backend must refuse a non-socket file at the socket path" >&2
  exit 1
fi
wait "$backend_pid" 2>/dev/null || true
backend_pid=""
[[ -f "$squat_socket" ]] && ! [[ -S "$squat_socket" ]] || { echo "squat file must be left untouched" >&2; exit 1; }
rg -q 'Refusing to replace' "$base_dir/squat.log"

# An XDG_RUNTIME_DIR that is not a private directory must be refused.
not_a_dir="$base_dir/not-a-dir"
touch "$not_a_dir"
XDG_RUNTIME_DIR="$not_a_dir" RELAXY_AUDIO_SINK=fakesink gjs -m "$repo_dir/backend/relaxy.js" \
  --state "$base_dir/xdg-state.json" \
  --assets "$repo_dir/assets/sounds" \
  >"$base_dir/xdg.log" 2>&1 &
backend_pid=$!
sleep 3
if kill -0 "$backend_pid" 2>/dev/null; then
  kill -TERM "$backend_pid" 2>/dev/null || true
  wait "$backend_pid" 2>/dev/null || true
  echo "backend must refuse an invalid runtime directory" >&2
  exit 1
fi
wait "$backend_pid" 2>/dev/null || true
backend_pid=""
rg -q 'Not a private directory' "$base_dir/xdg.log"

echo "Relaxy socket security test passed."
