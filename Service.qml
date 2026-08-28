import QtQuick
import Quickshell
import Quickshell.Io

Item {
  id: root

  property var shell: null
  property bool stopping: false

  function localPath(url) {
    return decodeURIComponent(String(url).replace(/^file:\/\//, ""));
  }

  readonly property string pluginDirectory: localPath(Qt.resolvedUrl("."));
  readonly property string stateDirectory: Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state");
  readonly property string runtimeDirectory: Quickshell.env("XDG_RUNTIME_DIR") || "/tmp";
  readonly property string socketPath: runtimeDirectory + "/relaxy-" + (Quickshell.env("USER") || "user") + ".sock";
  readonly property string statePath: stateDirectory + "/relaxy/state.json";

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

    stderr: SplitParser {
      onRead: function(line) {
        console.warn("relaxy backend: " + line);
      }
    }

    onExited: function(exitCode, exitStatus) {
      if (!root.stopping) {
        console.warn("relaxy backend exited (code " + exitCode + ", status " + exitStatus + ")");
        restartTimer.start();
      }
    }
  }

  Timer {
    id: restartTimer
    interval: 1000
    repeat: false
    onTriggered: if (!root.stopping) backend.running = true
  }

  Component.onDestruction: {
    root.stopping = true;
    restartTimer.stop();
    backend.running = false;
  }
}
