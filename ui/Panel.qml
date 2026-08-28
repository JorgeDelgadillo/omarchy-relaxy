import QtQuick
import QtQuick.Controls as QQC2
import QtQuick.Dialogs
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Catalog.js" as Catalog

Item {
  id: root

  property var bar: null
  property var anchorItem: null
  property var hostWidget: null
  property bool opened: false
  property var state: Catalog.defaultState()
  property string pendingCommand: ""
  property string pendingAction: ""
  property var pendingPayload: ({})

  readonly property string pluginDirectory: localPath(Qt.resolvedUrl(".."))
  readonly property string backendPath: pluginDirectory + "/backend/relaxy.js"
  readonly property string stateDirectory: Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state")
  readonly property string statePath: stateDirectory + "/relaxy/state.json"
  readonly property string runtimeDirectory: Quickshell.env("XDG_RUNTIME_DIR") || "/tmp"
  readonly property string socketPath: runtimeDirectory + "/relaxy-" + (Quickshell.env("USER") || "user") + ".sock"
  readonly property var preset: Catalog.activePreset(root.state)
  readonly property string barGlyph: root.state.playing ? "󰏤" : "󰐊"
  readonly property string tooltipText: "Relaxy · " + (root.state.playing ? "Playing" : "Paused")

  function localPath(url) {
    return decodeURIComponent(String(url).replace(/^file:\/\//, ""));
  }

  function open() {
    root.opened = true;
    stateFile.reload();
  }

  function close() {
    root.opened = false;
  }

  function toggle() {
    if (root.opened) root.close();
    else root.open();
  }

  function sendAction(action, payload) {
    var command = JSON.stringify({
      id: String(Date.now()) + "-" + action,
      action: action,
      payload: payload || {},
    });
    if (commandProcess.running) {
      root.pendingCommand = command;
      return;
    }
    commandProcess.command = ["gjs", root.backendPath, "--command", command, "--socket", root.socketPath];
    commandProcess.running = true;
  }

  function reloadState() {
    try {
      var parsed = JSON.parse(stateFile.text());
      if (parsed && parsed.schemaVersion === 1) root.state = parsed;
    } catch (error) {
      console.warn("relaxy state: " + error);
    }
  }

  function startPendingCommand() {
    if (root.pendingCommand === "") return;
    var command = root.pendingCommand;
    root.pendingCommand = "";
    commandProcess.command = ["gjs", root.backendPath, "--command", command, "--socket", root.socketPath];
    commandProcess.running = true;
  }

  FileView {
    id: stateFile
    path: root.statePath
    watchChanges: true
    printErrors: false
    onLoaded: root.reloadState()
    onFileChanged: reload()
  }

  Timer {
    interval: 1200
    running: true
    onTriggered: stateFile.reload()
  }

  Process {
    id: commandProcess
    onExited: {
      stateFile.reload();
      root.startPendingCommand();
    }
    stderr: SplitParser {
      onRead: function(line) { console.warn("relaxy command: " + line); }
    }
  }

  PopupCard {
    id: popup
    anchorItem: root.anchorItem
    bar: root.bar
    owner: root.hostWidget || root
    open: root.opened
    contentWidth: popup.fittedContentWidth(Style.space(380))
    contentHeight: popup.fittedContentHeight(contentColumn.implicitHeight + Style.space(16))

    Column {
      id: contentColumn
      anchors.fill: parent
      anchors.margins: Style.space(12)
      spacing: Style.space(10)

      Row {
        width: parent.width
        spacing: Style.space(8)

        Text {
          text: "Relaxy"
          color: root.bar ? root.bar.foreground : "white"
          font.family: root.bar ? root.bar.fontFamily : "sans-serif"
          font.pixelSize: Style.font.subtitle
          font.bold: true
          verticalAlignment: Text.AlignVCenter
        }

        Item { width: Math.max(0, parent.width - 220) }

        QQC2.ComboBox {
          id: presetBox
          width: Style.space(150)
          model: root.state.presets || []
          textRole: "name"
          currentIndex: Math.max(0, (root.state.presets || []).findIndex(function(item) { return item.id === root.state.activePresetId; }))
          onActivated: function(index) {
            if (root.state.presets[index]) root.sendAction("set-preset", { presetId: root.state.presets[index].id });
          }
        }

        Button {
          iconText: "󰐕"
          foreground: root.bar ? root.bar.foreground : "white"
          onClicked: root.sendAction("toggle-playing", {})
        }
      }

      Row {
        width: parent.width
        spacing: Style.space(8)

        Text {
          text: "Master volume"
          color: root.bar ? root.bar.foreground : "white"
          font.family: root.bar ? root.bar.fontFamily : "sans-serif"
          font.pixelSize: Style.font.body
          verticalAlignment: Text.AlignVCenter
        }

        QQC2.Slider {
          id: masterSlider
          width: parent.width - Style.space(105)
          from: 0
          to: 1
          value: Number(root.state.masterVolume || 0)
          onMoved: root.sendAction("set-master-volume", { volume: value })
        }
      }

      PanelSeparator { foreground: root.bar ? root.bar.foreground : "white" }

      Flickable {
        id: soundsScroll
        width: parent.width
        height: Math.min(Style.space(480), soundsColumn.implicitHeight)
        contentHeight: soundsColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds

        Column {
          id: soundsColumn
          width: soundsScroll.width
          spacing: Style.space(8)

          Repeater {
            model: Catalog.groups

            delegate: Column {
              width: soundsColumn.width
              spacing: Style.space(4)
              visible: !root.preset.hideInactive || modelData.sounds.some(function(sound) { return Catalog.isPlaying(root.state, sound.id); })

              Text {
                text: modelData.title
                color: root.bar ? root.bar.accent : "#9cc9ff"
                font.family: root.bar ? root.bar.fontFamily : "sans-serif"
                font.pixelSize: Style.font.caption
                font.bold: true
              }

              Repeater {
                model: modelData.sounds

                delegate: Item {
                  width: soundsColumn.width
                  height: Style.space(42)

                  Row {
                    anchors.fill: parent
                    spacing: Style.space(8)

                    Text {
                      width: Style.space(24)
                      text: "󰝚"
                      color: Catalog.isPlaying(root.state, modelData.id) ? (root.bar ? root.bar.accent : "#9cc9ff") : (root.bar ? root.bar.foreground : "white")
                      font.family: root.bar ? root.bar.fontFamily : "sans-serif"
                      font.pixelSize: Style.font.icon
                      verticalAlignment: Text.AlignVCenter
                    }

                    Text {
                      width: Style.space(104)
                      text: modelData.title
                      color: root.bar ? root.bar.foreground : "white"
                      font.family: root.bar ? root.bar.fontFamily : "sans-serif"
                      font.pixelSize: Style.font.body
                      elide: Text.ElideRight
                      verticalAlignment: Text.AlignVCenter
                    }

                    QQC2.Slider {
                      width: parent.width - Style.space(150)
                      anchors.verticalCenter: parent.verticalCenter
                      from: 0
                      to: 1
                      value: Catalog.volume(root.state, modelData.id)
                      onMoved: root.sendAction("set-sound-volume", { soundId: modelData.id, volume: value })
                    }
                  }

                  MouseArea {
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.top: parent.top
                    anchors.bottom: parent.bottom
                    anchors.rightMargin: Style.space(145)
                    onClicked: root.sendAction("toggle-sound", { soundId: modelData.id, playing: !Catalog.isPlaying(root.state, modelData.id) })
                  }
                }
              }
            }
          }
        }
      }

      Row {
        width: parent.width
        spacing: Style.space(6)

        Button {
          iconText: "󰐕"
          foreground: root.bar ? root.bar.foreground : "white"
          tooltipText: "Add preset"
          onClicked: root.sendAction("add-preset", { name: "New Preset" })
        }

        Button {
          iconText: "󰆴"
          foreground: root.bar ? root.bar.foreground : "white"
          tooltipText: "Reset sound volumes"
          onClicked: root.sendAction("reset-volumes", {})
        }

        Button {
          iconText: "󰑐"
          foreground: root.bar ? root.bar.foreground : "white"
          tooltipText: "Close"
          onClicked: root.close()
        }
      }
    }
  }
}
