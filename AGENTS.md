# Agent Guide

This file records the working context for agents maintaining Relaxy.

## Project scope

Relaxy is an unofficial Omarchy schema-version-1 plugin. The repository root
contains the plugin manifest, QML entry points, GJS backend, bundled audio, and
tests. Runtime installation belongs in:

```text
$HOME/.config/omarchy/plugins/jdelgadillo.relaxy/
```

Never edit `/usr/share/omarchy/`; it is managed by the Omarchy package. The
user-owned plugin is installed and enabled with `omarchy plugin` commands,
removed with `omarchy plugin remove jdelgadillo.relaxy`, and the shell can be
reloaded with `omarchy restart shell`.

## Collaboration rules

- Keep source code, comments, tests, and documentation in English.
- Make one local Git commit for each implementation step.
- Never run `git push`. The repository may have a remote, but publication is a
  deliberate user action.
- Preserve unrelated user changes and preserve
  `$XDG_STATE_HOME/relaxy/state.json` unless a state reset is explicitly
  requested.
- Before handing off work, run the relevant checks and leave the worktree
  clean when possible.

## Runtime architecture

`Service.qml` owns the long-lived GJS backend process. `BarWidget.qml` loads
`ui/Panel.qml`, which sends newline-delimited JSON commands through the local
Unix socket. `backend/relaxy.js` owns persistent state, MPRIS, power-saver
handling, and `AmbientMixer` from `backend/mixer.js`.

The mixer builds one GStreamer pipeline. File branches use `uridecodebin`,
while pink and white noise use live `audiotestsrc`. Only unmuted sounds with a
positive level are included in the active topology. Volume properties are
applied after decoder preroll as well as during normal synchronization.

### Critical GStreamer invariant

Do not call `set_state()`, `seek_simple()`, pipeline teardown, or pipeline
rebuild directly from `AmbientMixer.handleMessage()` while handling a bus
`EOS` message. With `pipewiresink`, those operations can wait for streaming
work that is still processing the message and deadlock the backend socket.

The current implementation calls `scheduleEosRecovery()`, which defers the
operation to the GLib main loop and rebuilds `activeSpecs`. Keep the recovery
coalesced to one pending idle source, cancel it when disposing the pipeline,
and do not substitute `lastSpecs` for `activeSpecs`.

Because the audiomixer only forwards EOS when every input has ended, finite
files inside a mix are detected by `checkBranchEnds()`, a GLib timeout that
watches file branch positions and durations on the main loop. Do not replace it
with pad probes: GJS callbacks are not safe to run from GStreamer streaming
threads and crash the process. Cancel the watcher together with the recovery
source when disposing the pipeline.

Error recovery follows the same deferral rule: `handleMessage()` only marks the
branch as failed and schedules `scheduleErrorRecovery()`. A failed sound stays
out of automatic EOS recovery until an explicit user action clears it through
`clearFailure()`, which avoids retry loops for permanently broken files.

## Validation commands

Run these from the repository root:

```bash
./scripts/check.sh
./tests/check_catalog.sh
(cd assets && sha256sum -c SHA256SUMS)
gjs -m tests/model.test.js
RELAXY_AUDIO_SINK=fakesink gjs -m tests/mixer.test.js
./tests/ui_contract.sh
./tests/service_contract.sh
./tests/integration.sh
```

`tests/mixer.test.js` generates a short OGG file and drives recovery in a
single-file topology, a file mixed with a bundled recording, and a file mixed
with live noise. It sets `sync` on the fake sink so each phase runs in real
time and finishes in a few seconds. `tests/integration.sh` creates a temporary
D-Bus session and may require a normal user session rather than a restricted
sandbox.

## Recent audio recovery history

The current recovery behavior was introduced in these local commits:

- `c9e0a51` — recover mixed playback after end of stream.
- `5001abf` — cover mixed live-source looping with a regression test.
- `808074b` — keep the backend responsive during audio recovery.
- `21e209d` — recycle finite files mixed with other sounds.
- `8724a15` — defer mixer error recovery and allow sound retries.
- `d040983` — surface backend sound errors in the shell and panel.
- `c46fb8c` — check catalog parity across JSON, backend, and UI.

When debugging a future regression, first check whether a GStreamer bus
callback is performing synchronous state work and whether commands sent to the
Unix socket still receive responses.
