import QtQuick
import Quickshell
import Quickshell.Io
import "ui/RecoveryPolicy.js" as RecoveryPolicy

Item {
  id: root

  property var shell: null
  property bool stopping: false
  property var recoveryPolicy: RecoveryPolicy.create()
  property string recoveryState: "connecting"
  property int retryAttempt: 0
  property int retryDelayMs: 0
  property string lastExitReason: ""
  readonly property int retryLimit: recoveryPolicy.retryLimit

  function localPath(url) {
    return decodeURIComponent(String(url).replace(/^file:\/\//, ""));
  }

  readonly property string pluginDirectory: localPath(Qt.resolvedUrl("."));
  readonly property string stateDirectory: Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state");
  // Mirrors the backend socket fallback: $XDG_RUNTIME_DIR when set, otherwise
  // a per-user directory under $TMPDIR that the backend creates and verifies
  // as 0700 before binding the 0600 socket inside it.
  readonly property string runtimeDirectory: Quickshell.env("XDG_RUNTIME_DIR") || ((Quickshell.env("TMPDIR") || "/tmp") + "/relaxy-" + (Quickshell.env("USER") || "user"));
  readonly property string socketPath: runtimeDirectory + "/relaxy-" + (Quickshell.env("USER") || "user") + ".sock";
  readonly property string statePath: stateDirectory + "/relaxy/state.json";
  readonly property string backendStatusPath: runtimeDirectory + "/relaxy-" + (Quickshell.env("USER") || "user") + ".status.json";

  function markBackendReady(contents) {
    if (root.stopping || !backend.running) return;
    try {
      var parsed = JSON.parse(contents);
      if (!parsed || typeof parsed.pid !== "number" || parsed.pid <= 0) return;
    } catch (error) {
      return;
    }
    if (root.recoveryState !== "running") {
      root.recoveryState = "running";
      root.retryDelayMs = 0;
      root.lastExitReason = "";
      stableTimer.restart();
    }
  }

  function handleBackendExit(exitCode, exitStatus) {
    if (root.stopping) return;
    stableTimer.stop();
    root.lastExitReason = "Backend exited with code " + exitCode + " (" + exitStatus + ").";
    var decision = root.recoveryPolicy.failure();
    root.retryAttempt = decision.attempt;
    root.retryDelayMs = decision.delayMs;
    root.recoveryState = decision.state;
    console.warn("relaxy backend exited: " + root.lastExitReason);
    if (decision.shouldRetry) {
      restartTimer.interval = decision.delayMs;
      restartTimer.start();
    }
  }

  function retryBackend() {
    if (root.stopping || backend.running || root.recoveryState !== "unavailable") return false;
    var decision = root.recoveryPolicy.manualRetry();
    root.retryAttempt = decision.attempt;
    root.retryDelayMs = decision.delayMs;
    root.lastExitReason = "";
    root.recoveryState = decision.state;
    restartTimer.interval = decision.delayMs;
    restartTimer.start();
    return true;
  }

  Process {
    id: backend
    command: [
      "gjs",
      "-m",
      root.pluginDirectory + "/backend/relaxy.js",
      "--socket", root.socketPath,
      "--state", root.statePath,
      "--assets", root.pluginDirectory + "/assets/sounds",
    ]
    running: true

    onRunningChanged: {
      if (running && !root.stopping) {
        root.recoveryState = "connecting";
        backendStatusFile.reload();
      }
    }

    stderr: SplitParser {
      onRead: function(line) {
        console.warn("relaxy backend: " + line);
      }
    }

    onExited: function(exitCode, exitStatus) {
      root.handleBackendExit(exitCode, exitStatus);
    }
  }

  FileView {
    id: backendStatusFile
    path: root.backendStatusPath
    watchChanges: true
    printErrors: false
    onLoaded: root.markBackendReady(text())
    onFileChanged: reload()
  }

  Timer {
    id: restartTimer
    interval: 1000
    repeat: false
    onTriggered: {
      if (!root.stopping && !backend.running) {
        root.recoveryState = "connecting";
        backend.running = true;
      }
    }
  }

  Timer {
    id: stableTimer
    interval: RecoveryPolicy.STABLE_UPTIME_MS
    repeat: false
    onTriggered: {
      if (!root.stopping && backend.running && root.recoveryState === "running") {
        root.recoveryPolicy.markStable();
        root.retryAttempt = 0;
      }
    }
  }

  Component.onDestruction: {
    root.stopping = true;
    root.recoveryPolicy.cancel();
    restartTimer.stop();
    stableTimer.stop();
    backend.running = false;
  }
}
