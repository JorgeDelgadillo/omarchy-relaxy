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
  property var mixerState: Catalog.defaultState()
  property string pendingCommand: ""
  property string pendingAction: ""
  property var pendingPayload: ({})
  property string editorMode: ""
  property string editorId: ""
  property string confirmAction: ""
  property var confirmPayload: ({})

  readonly property string pluginDirectory: localPath(Qt.resolvedUrl(".."))
  readonly property string backendPath: pluginDirectory + "/backend/relaxy.js"
  readonly property string stateDirectory: Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state")
  readonly property string statePath: stateDirectory + "/relaxy/state.json"
  readonly property string runtimeDirectory: Quickshell.env("XDG_RUNTIME_DIR") || "/tmp"
  readonly property string socketPath: runtimeDirectory + "/relaxy-" + (Quickshell.env("USER") || "user") + ".sock"
  readonly property var preset: Catalog.activePreset(root.mixerState)
  readonly property string barGlyph: root.mixerState.playing ? "󰏤" : "󰐊"
  readonly property string tooltipText: "Relaxy · " + (root.mixerState.playing ? "Playing" : "Paused")

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
      if (parsed && parsed.schemaVersion === 1) root.mixerState = parsed;
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

  function openPresetEditor(mode, presetId, currentName) {
    root.editorMode = mode;
    root.editorId = presetId || "";
    editorDialog.title = mode === "rename" ? "Rename preset" : "New preset";
    editorField.text = currentName || "";
    editorDialog.open();
    Qt.callLater(function() {
      editorField.selectAll();
      editorField.forceActiveFocus();
    });
  }

  function openCustomSoundEditor(soundId, currentName) {
    root.editorMode = "rename-custom";
    root.editorId = soundId;
    editorDialog.title = "Rename custom sound";
    editorField.text = currentName || "";
    editorDialog.open();
    Qt.callLater(function() {
      editorField.selectAll();
      editorField.forceActiveFocus();
    });
  }

  function submitEditor() {
    var name = editorField.text.trim();
    if (!name) return;
    if (root.editorMode === "rename") {
      root.sendAction("rename-preset", { presetId: root.editorId, name: name });
    } else if (root.editorMode === "rename-custom") {
      root.sendAction("rename-custom-sound", { soundId: root.editorId, name: name });
    } else {
      root.sendAction("add-preset", { name: name });
    }
    editorDialog.close();
  }

  function confirm(action, payload, title, message) {
    root.confirmAction = action;
    root.confirmPayload = payload;
    confirmDialog.title = title;
    confirmMessage.text = message;
    confirmDialog.open();
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

  QQC2.Dialog {
    id: editorDialog
    width: Style.space(300)
    modal: true
    standardButtons: QQC2.Dialog.Ok | QQC2.Dialog.Cancel

    onAccepted: root.submitEditor()

    contentItem: Column {
      spacing: Style.space(8)

      Text {
        text: "Name"
        color: root.bar ? root.bar.foreground : "white"
        font.family: root.bar ? root.bar.fontFamily : "sans-serif"
        font.pixelSize: Style.font.caption
      }

      TextField {
        id: editorField
        width: parent.width
        foreground: root.bar ? root.bar.foreground : "white"
        accent: root.bar ? root.bar.accent : "#9cc9ff"
        onAccepted: root.submitEditor()
      }
    }
  }

  QQC2.Dialog {
    id: confirmDialog
    width: Style.space(320)
    modal: true
    standardButtons: QQC2.Dialog.Yes | QQC2.Dialog.No

    onAccepted: {
      root.sendAction(root.confirmAction, root.confirmPayload);
      confirmDialog.close();
    }

    contentItem: Text {
      id: confirmMessage
      width: parent.width
      color: root.bar ? root.bar.foreground : "white"
      font.family: root.bar ? root.bar.fontFamily : "sans-serif"
      font.pixelSize: Style.font.body
      wrapMode: Text.WordWrap
    }
  }

  FileDialog {
    id: soundFileDialog
    title: "Add custom sound"
    fileMode: FileDialog.OpenFile
    nameFilters: ["Audio files (*.ogg *.oga *.wav *.mp3 *.flac *.m4a)", "All files (*)"]

    onAccepted: {
      var path = root.localPath(selectedFile);
      var parts = path.split("/");
      var name = parts.length > 0 ? parts[parts.length - 1] : "Custom Sound";
      root.sendAction("add-custom-sound", { path: path, name: name.replace(/\.[^.]+$/, "") });
    }
  }

  QQC2.Dialog {
    id: settingsDialog
    width: Style.space(340)
    modal: true
    title: "Settings"
    standardButtons: QQC2.Dialog.Close

    contentItem: Column {
      spacing: Style.space(6)

      QQC2.CheckBox {
        text: "Start paused"
        checked: root.mixerState.startPaused
        onToggled: root.sendAction("set-start-paused", { value: checked })
      }

      QQC2.CheckBox {
        text: "Prevent suspend while playing"
        checked: root.mixerState.inhibitSuspension
        onToggled: root.sendAction("set-inhibit-suspension", { value: checked })
      }

      QQC2.CheckBox {
        text: "Hide inactive sound groups"
        checked: root.preset.hideInactive
        onToggled: root.sendAction("set-hide-inactive", { value: checked })
      }
    }
  }

  QQC2.Dialog {
    id: aboutDialog
    width: Style.space(360)
    modal: true
    title: "About Relaxy"
    standardButtons: QQC2.Dialog.Close

    contentItem: Column {
      spacing: Style.space(8)

      Text {
        text: "Relaxy 0.1.0"
        color: root.bar ? root.bar.foreground : "white"
        font.family: root.bar ? root.bar.fontFamily : "sans-serif"
        font.pixelSize: Style.font.subtitle
        font.bold: true
      }

      Text {
        text: "An Omarchy ambient sound mixer inspired by Blanket. The bundled sounds retain their original attribution and license information in the plugin's assets directory."
        color: root.bar ? root.bar.foreground : "white"
        font.family: root.bar ? root.bar.fontFamily : "sans-serif"
        font.pixelSize: Style.font.body
        wrapMode: Text.WordWrap
      }
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
            model: root.mixerState.presets || []
          textRole: "name"
          currentIndex: Math.max(0, (root.mixerState.presets || []).findIndex(function(item) { return item.id === root.mixerState.activePresetId; }))
          onActivated: function(index) {
            if (root.mixerState.presets[index]) root.sendAction("set-preset", { presetId: root.mixerState.presets[index].id });
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
          value: Number(root.mixerState.masterVolume || 0)
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
              visible: !root.preset.hideInactive || modelData.sounds.some(function(sound) { return Catalog.isPlaying(root.mixerState, sound.id); })

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
                      color: Catalog.isPlaying(root.mixerState, modelData.id) ? (root.bar ? root.bar.accent : "#9cc9ff") : (root.bar ? root.bar.foreground : "white")
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
                      value: Catalog.volume(root.mixerState, modelData.id)
                      onMoved: root.sendAction("set-sound-volume", { soundId: modelData.id, volume: value })
                    }
                  }

                  MouseArea {
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.top: parent.top
                    anchors.bottom: parent.bottom
                    anchors.rightMargin: Style.space(145)
                    onClicked: root.sendAction("toggle-sound", { soundId: modelData.id, playing: !Catalog.isPlaying(root.mixerState, modelData.id) })
                  }
                }
              }
            }
          }

          Column {
            width: soundsColumn.width
            spacing: Style.space(4)
            visible: (root.mixerState.customSounds || []).length > 0

            Text {
              text: "Custom sounds"
              color: root.bar ? root.bar.accent : "#9cc9ff"
              font.family: root.bar ? root.bar.fontFamily : "sans-serif"
              font.pixelSize: Style.font.caption
              font.bold: true
            }

            Repeater {
            model: root.mixerState.customSounds || []

              delegate: Item {
                width: soundsColumn.width
                height: Style.space(42)

                Row {
                  anchors.fill: parent
                  spacing: Style.space(6)

                  Text {
                    width: Style.space(24)
                    text: "󰝚"
                    color: Catalog.isPlaying(root.mixerState, modelData.id) ? (root.bar ? root.bar.accent : "#9cc9ff") : (root.bar ? root.bar.foreground : "white")
                    font.family: root.bar ? root.bar.fontFamily : "sans-serif"
                    font.pixelSize: Style.font.icon
                    verticalAlignment: Text.AlignVCenter
                  }

                  Text {
                    width: Style.space(100)
                    text: modelData.name
                    color: root.bar ? root.bar.foreground : "white"
                    font.family: root.bar ? root.bar.fontFamily : "sans-serif"
                    font.pixelSize: Style.font.body
                    elide: Text.ElideRight
                    verticalAlignment: Text.AlignVCenter
                  }

                  QQC2.Slider {
                    width: parent.width - Style.space(232)
                    anchors.verticalCenter: parent.verticalCenter
                    from: 0
                    to: 1
                    value: Catalog.volume(root.mixerState, modelData.id)
                    onMoved: root.sendAction("set-sound-volume", { soundId: modelData.id, volume: value })
                  }

                  Button {
                    iconText: "󰏫"
                    foreground: root.bar ? root.bar.foreground : "white"
                    tooltipText: "Rename custom sound"
                    onClicked: root.openCustomSoundEditor(modelData.id, modelData.name)
                  }

                  Button {
                    iconText: "󰆴"
                    foreground: root.bar ? root.bar.foreground : "white"
                    tooltipText: "Remove custom sound"
                    onClicked: root.confirm("remove-custom-sound", { soundId: modelData.id }, "Remove custom sound", "Remove '" + modelData.name + "' from Relaxy?")
                  }
                }

                MouseArea {
                  anchors.left: parent.left
                  anchors.right: parent.right
                  anchors.top: parent.top
                  anchors.bottom: parent.bottom
                  anchors.rightMargin: Style.space(232)
                  onClicked: root.sendAction("toggle-sound", { soundId: modelData.id, playing: !Catalog.isPlaying(root.mixerState, modelData.id) })
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
          onClicked: root.openPresetEditor("add", "", "")
        }

        Button {
          iconText: "󰏫"
          foreground: root.bar ? root.bar.foreground : "white"
          tooltipText: "Rename preset"
          onClicked: root.openPresetEditor("rename", root.preset.id, root.preset.name)
        }

        Button {
          iconText: "󰆴"
          foreground: root.bar ? root.bar.foreground : "white"
          tooltipText: "Remove preset"
          onClicked: root.confirm("remove-preset", { presetId: root.preset.id }, "Remove preset", "Remove '" + root.preset.name + "' from Relaxy?")
        }

        Button {
          iconText: "󰐑"
          foreground: root.bar ? root.bar.foreground : "white"
          tooltipText: "Add custom sound"
          onClicked: soundFileDialog.open()
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

        Button {
          iconText: "󰒓"
          foreground: root.bar ? root.bar.foreground : "white"
          tooltipText: "Settings"
          onClicked: settingsDialog.open()
        }

        Button {
          iconText: "󰋼"
          foreground: root.bar ? root.bar.foreground : "white"
          tooltipText: "About Relaxy"
          onClicked: aboutDialog.open()
        }
      }
    }
  }
}
