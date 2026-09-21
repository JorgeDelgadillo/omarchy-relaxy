# Relaxy Architecture

Relaxy is an Omarchy schema-version-1 plugin composed of a long-lived service
entry point and a bar-widget entry point. The shell UI never owns the audio
pipeline; it sends small JSON commands to the backend over a per-user Unix
socket.

## Runtime flow

```text
Omarchy shell
    ├── Service.qml ── starts/restarts ──> backend/relaxy.js (GJS)
    │                                         ├── model.js (state)
    │                                         ├── catalog.js (audio specs)
    │                                         ├── mixer.js (GStreamer)
    │                                         └── MPRIS D-Bus service
    └── BarWidget.qml ──> ui/Panel.qml ── JSON commands/events ──> Unix socket
```

`Service.qml` derives all paths from the installed plugin URL and the user
runtime/state directories. It starts GJS with module mode, forwards backend
diagnostics to the shell log, and restarts the process after an unexpected
exit. It marks shutdown as intentional before stopping the process so shell
reloads do not create a restart loop.

`BarWidget.qml` owns the bar contract expected by Omarchy: `moduleName`,
`open()`, `close()`, `opened`, and `closeForPopoutSwitch()`. It loads the
panel lazily, injects the bar and anchor objects, and maps left/right click to
the panel and middle click to playback.

## Backend protocol

The backend accepts one newline-delimited JSON request per line, read with a
64 KiB byte ceiling: oversized or undecodable input closes the connection
without changing state. Every request is validated against a per-action
schema (known actions, exact fields, value types, and string length caps)
before it can change state; anything else receives an error response. The
response includes `ok`, the request id, the resulting state, and an error
message when the action fails. The UI uses one short-lived command client per
command and reloads the state file after every response. Backend broadcasts
notify other connected clients about state changes and sound errors.

Supported action families include playback (`play`, `pause`, `stop`, and
`toggle-playing`), volume changes, sound toggling, preset selection and
management, custom sound management, playback preferences, and `dismiss-error`
for the last reported sound error.

The socket directory is the trust boundary for local IPC. The backend uses
`$XDG_RUNTIME_DIR` when it is a user-owned directory and otherwise derives a
per-user fallback under `$TMPDIR` (`relaxy-$USER`); the shell UI mirrors both
formulas, since `$TMPDIR` and `$USER` are visible to QML. The directory is
created and verified as 0700 and owned by the current user, a stale file at
the socket path is replaced only when it is a user-owned socket, and the
bound socket is enforced and re-verified as 0600. State and status files are
written owner-only (0600) through a temporary file followed by an atomic
rename.

The backend writes `$XDG_RUNTIME_DIR/relaxy-$USER.status.json`, derived from
the socket path, with the backend pid and the last mixer error (`soundId`,
`message`, `debug`, and `at`) or `null`. On startup it replaces any leftover
Relaxy process still bound to that socket. The panel watches that file and
shows a dismissible warning, which keeps error reporting out of the persistent
state document. Errors are also printed to standard error, where `Service.qml`
forwards them to the shell log.

State mutations persist and respond immediately. Mixer topology changes are
scheduled on the GLib main loop so a blocking `pipewiresink` state change
cannot stall the Unix socket or freeze the one-shot command client.

## Audio mixer

`AmbientMixer` creates a single GStreamer pipeline with an `audiomixer`, a
master `volume`, and an automatic sink. File sounds use finite
`uridecodebin` branches. Pink and white noise use live `audiotestsrc` branches
with the corresponding GStreamer wave enum. Branches are created only for
unmuted tracks with a positive volume, which keeps idle playback inexpensive.

The master volume is applied after the mixer. Playback starts paused until the
user enables a sound or raises its volume. Playback state then maps to pipeline
`PLAYING` or `PAUSED`, while an empty mixer returns the pipeline to `NULL`.
GStreamer errors are associated with their sound id and remove only the bad
branch so another track can continue playing. The error rebuild is scheduled on
the GLib main loop for the same reason as EOS recovery: tearing down the
pipeline can wait for streaming work inside a PipeWire sink. A failed sound is
remembered so automatic recovery does not retry it forever; an explicit user
action on that sound clears the failure and retries it. The power-profile
monitor pauses active playback when the system enters power-saver mode and
leaves it paused until the user starts playback again. The same pause is
applied during backend startup when power-saver is already enabled or when
`startPaused` is set; the resulting playback flag is written back to the
state file so the panel and mixer agree before the first sync.

When a mixed pipeline posts `EOS`, the mixer schedules recovery on the GLib
main loop and rebuilds the current active topology from the beginning. The
recovery is intentionally not performed inside the GStreamer bus callback:
state transitions and teardown can wait for streaming work, especially with
`pipewiresink`, which would otherwise block the backend socket and freeze the
UI. `activeSpecs` contains the currently audible branches; `lastSpecs` contains
all available catalog and custom sounds and must not be used for playback
recovery. Dynamic decoder preroll also triggers a second volume application so
stored levels are not lost when a file branch links.

The audiomixer only forwards `EOS` when every input has ended, so a finite file
that ends while other sounds are still active would otherwise stop silently.
The mixer therefore also watches each file branch's position and duration from
a GLib timeout (`checkBranchEnds()`) and schedules the same recovery when a
branch reaches its end. Pad probes are not used because GJS callbacks are not
safe to run from streaming threads. Both the recovery idle source and the
branch watcher are cancelled when the pipeline is disposed.

## State model

`model.js` normalizes every loaded document to schema version 1. It clamps
volumes, removes duplicate ids, guarantees a default preset, cleans names, and
filters invalid custom sound entries. Saves use a mode-700 state directory, an
owner-only (0600) file mode, and an atomic temporary-file rename.

The default preset is protected from deletion. New presets copy the active
preset, and removing a custom sound also removes its volume and mute entries
from every preset.

## MPRIS

The backend owns `org.mpris.MediaPlayer2.Relaxy` and exports both the root and
player interfaces on the standard MPRIS object path. Playback status and
master volume are mapped to Relaxy state. Next and previous select adjacent
presets, which gives desktop media controls a useful meaning for an ambient
sound mixer. `Raise` asks Omarchy to summon the widget when available.

## Verification boundaries

- Shell-facing QML is checked with the Omarchy plugin validator, a QML parser,
  and focused UI/service contract checks.
- State transformations are covered by `tests/model.test.js`.
- GStreamer branch creation, end-of-stream recovery, and error handling are
  covered by `tests/mixer.test.js` with a clock-synced fake sink. The test
  generates a short OGG file, so it covers single-file mixes, a file mixed with
  a bundled recording, a file mixed with live noise, and retries after a branch
  failure without waiting for the bundled track durations.
- The Unix socket protocol, persistence, custom sounds, status reporting, and
  MPRIS controls are exercised by `tests/integration.sh`.
- Audio binaries are verified against `assets/SHA256SUMS`, and the JSON,
  backend, and UI catalog definitions are checked for parity by
  `tests/catalog_parity.test.js`.
