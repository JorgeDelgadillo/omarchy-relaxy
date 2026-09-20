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
  property var pendingVolumes: ({})
  property real pendingMasterVolume: -1
  property string editorMode: ""
  property string editorId: ""
  property string confirmAction: ""
  property var confirmPayload: ({})
  property var lastError: null

  readonly property string pluginDirectory: localPath(Qt.resolvedUrl(".."))
  readonly property string backendPath: pluginDirectory + "/backend/relaxy.js"
  readonly property string stateDirectory: Quickshell.env("XDG_STATE_HOME") || (Quickshell.env("HOME") + "/.local/state")
  readonly property string statePath: stateDirectory + "/relaxy/state.json"
  // Mirrors the backend socket fallback: $XDG_RUNTIME_DIR when set, otherwise
  // a per-user directory under $TMPDIR that the backend creates and verifies
  // as 0700 before binding the 0600 socket inside it.
  readonly property string runtimeDirectory: Quickshell.env("XDG_RUNTIME_DIR") || ((Quickshell.env("TMPDIR") || "/tmp") + "/relaxy-" + (Quickshell.env("USER") || "user"))
  readonly property string socketPath: runtimeDirectory + "/relaxy-" + (Quickshell.env("USER") || "user") + ".sock"
  readonly property string statusPath: runtimeDirectory + "/relaxy-" + (Quickshell.env("USER") || "user") + ".status.json"
  readonly property var preset: Catalog.activePreset(root.mixerState)
  readonly property string barGlyph: root.mixerState.playing ? "󰏤" : "󰐊"
  readonly property string tooltipText: "Relaxy · " + (root.mixerState.playing ? "Playing" : "Paused")
  readonly property string errorText: {
    if (!root.lastError) return "";
    var prefix = root.lastError.soundId ? root.soundTitle(root.lastError.soundId) + ": " : "";
    return "⚠ " + prefix + root.lastError.message;
  }

  function soundTitle(soundId) {
    for (var groupIndex = 0; groupIndex < Catalog.groups.length; groupIndex += 1) {
      var sounds = Catalog.groups[groupIndex].sounds;
      for (var soundIndex = 0; soundIndex < sounds.length; soundIndex += 1) {
        if (sounds[soundIndex].id === soundId) return sounds[soundIndex].title;
      }
    }
    var customSounds = root.mixerState.customSounds || [];
    for (var customIndex = 0; customIndex < customSounds.length; customIndex += 1) {
      if (customSounds[customIndex].id === soundId) return customSounds[customIndex].name;
    }
    return soundId;
  }

  function localPath(url) {
    return decodeURIComponent(String(url).replace(/^file:\/\//, ""));
  }

  function open() {
    root.opened = true;
    stateFile.reload();
    statusFile.reload();
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
    commandProcess.command = ["gjs", "-m", root.backendPath, "--command", command, "--socket", root.socketPath];
    commandProcess.running = true;
  }

  function volumeFor(soundId) {
    return root.pendingVolumes[soundId] !== undefined
      ? Number(root.pendingVolumes[soundId])
      : Catalog.volume(root.mixerState, soundId);
  }

  function setMasterVolumeFromSlider(next) {
    root.pendingMasterVolume = Number(next);
    root.sendAction("set-master-volume", { volume: next });
  }

  function setSoundVolumeFromSlider(soundId, next) {
    var nextPending = Object.assign({}, root.pendingVolumes);
    nextPending[soundId] = Number(next);
    root.pendingVolumes = nextPending;
    root.sendAction("set-sound-volume", { soundId: soundId, volume: next });
  }

  function clearPendingVolumes() {
    root.pendingMasterVolume = -1;
    root.pendingVolumes = ({});
  }

  function reconcilePendingVolumes() {
    if (root.pendingMasterVolume >= 0 && Math.abs(Number(root.mixerState.masterVolume) - root.pendingMasterVolume) < 0.001) {
      root.pendingMasterVolume = -1;
    }

    var remaining = {};
    for (var soundId in root.pendingVolumes) {
      if (Math.abs(Catalog.volume(root.mixerState, soundId) - Number(root.pendingVolumes[soundId])) >= 0.001) {
        remaining[soundId] = root.pendingVolumes[soundId];
      }
    }
    root.pendingVolumes = remaining;
  }

  function reloadState() {
    try {
      var parsed = JSON.parse(stateFile.text());
      if (parsed && parsed.schemaVersion === 1) {
        root.mixerState = parsed;
        root.reconcilePendingVolumes();
      }
    } catch (error) {
      console.warn("relaxy state: " + error);
    }
  }

  function reloadStatus() {
    try {
      var parsed = JSON.parse(statusFile.text());
      root.lastError = parsed && parsed.lastError ? parsed.lastError : null;
    } catch (error) {
      root.lastError = null;
    }
  }

  function startPendingCommand() {
    if (root.pendingCommand === "") return;
    var command = root.pendingCommand;
    root.pendingCommand = "";
    commandProcess.command = ["gjs", "-m", root.backendPath, "--command", command, "--socket", root.socketPath];
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

  FileView {
    id: statusFile
    path: root.statusPath
    watchChanges: true
    printErrors: false
    onLoaded: root.reloadStatus()
    onFileChanged: reload()
  }

  Timer {
    interval: 1200
    running: true
    onTriggered: {
      stateFile.reload();
      statusFile.reload();
    }
  }

  Process {
    id: commandProcess
    onExited: function(exitCode) {
      if (exitCode !== 0) root.clearPendingVolumes();
      stateFile.reload();
      root.startPendingCommand();
    }
    stdout: SplitParser {
      onRead: function(line) {
        try {
          var response = JSON.parse(line);
          if (!response.ok) {
            root.clearPendingVolumes();
          } else if (response.state) {
            root.mixerState = response.state;
            root.reconcilePendingVolumes();
          }
        } catch (error) {
          console.warn("relaxy response: " + error);
        }
      }
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
        accent: Color.accent
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
    width: Style.space(380)
    modal: true
    title: "About Relaxy"
    standardButtons: QQC2.Dialog.Close

    contentItem: Column {
      width: parent.width
      spacing: Style.space(8)

      Text {
        width: parent.width
        text: "Relaxy " + Catalog.version
        color: root.bar ? root.bar.foreground : "white"
        font.family: root.bar ? root.bar.fontFamily : "sans-serif"
        font.pixelSize: Style.font.subtitle
        font.bold: true
      }

      Text {
        width: parent.width
        text: "An unofficial Omarchy plugin for mixing ambient sounds. Inspired by Blanket."
        color: root.bar ? root.bar.foreground : "white"
        font.family: root.bar ? root.bar.fontFamily : "sans-serif"
        font.pixelSize: Style.font.body
        wrapMode: Text.WordWrap
      }

      Text {
        width: parent.width
        text: "License " + Catalog.license + " · Author " + Catalog.author
        color: root.bar ? root.bar.foreground : "white"
        font.family: root.bar ? root.bar.fontFamily : "sans-serif"
        font.pixelSize: Style.font.body
        wrapMode: Text.WordWrap
      }

      Text {
        width: parent.width
        text: "The bundled recordings keep their original authors, editors, and licenses. Attribution is in assets/SOUNDS_LICENSES.md."
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
        visible: root.lastError !== null

        Text {
          width: parent.width - Style.space(28)
          text: root.errorText
          color: Color.urgent
          font.family: root.bar ? root.bar.fontFamily : "sans-serif"
          font.pixelSize: Style.font.body
          elide: Text.ElideRight
          verticalAlignment: Text.AlignVCenter
        }

        Button {
          iconText: "󰅖"
          foreground: root.bar ? root.bar.foreground : "white"
          tooltipText: "Dismiss error"
          onClicked: root.sendAction("dismiss-error", {})
        }
      }

      Item {
        width: parent.width
        height: Style.space(42)

        Text {
          anchors.left: parent.left
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          width: Style.space(136)
          text: "Master volume"
          color: root.bar ? root.bar.foreground : "white"
          font.family: root.bar ? root.bar.fontFamily : "sans-serif"
          font.pixelSize: Style.font.body
          verticalAlignment: Text.AlignVCenter
        }

        PanelSlider {
          id: masterSlider
          bar: root.bar
          anchors.left: parent.left
          anchors.leftMargin: Style.space(144)
          anchors.right: parent.right
          anchors.top: parent.top
          anchors.bottom: parent.bottom
          minimum: 0
          maximum: 1
          value: root.pendingMasterVolume >= 0 ? root.pendingMasterVolume : Number(root.mixerState.masterVolume || 0)
          onMoved: function(next) { root.setMasterVolumeFromSlider(next) }
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
                color: Color.accent
                font.family: root.bar ? root.bar.fontFamily : "sans-serif"
                font.pixelSize: Style.font.caption
                font.bold: true
              }

              Repeater {
                model: modelData.sounds

                delegate: Item {
                  width: soundsColumn.width
                  height: Style.space(42)

                  Text {
                    id: soundIcon
                    anchors.left: parent.left
                    anchors.top: parent.top
                    anchors.bottom: parent.bottom
                    width: Style.space(24)
                    text: "󰝚"
                    color: Catalog.isPlaying(root.mixerState, modelData.id) ? Color.accent : (root.bar ? root.bar.foreground : "white")
                    font.family: root.bar ? root.bar.fontFamily : "sans-serif"
                    font.pixelSize: Style.font.icon
                    verticalAlignment: Text.AlignVCenter
                  }

                  Text {
                    id: soundName
                    anchors.left: soundIcon.right
                    anchors.leftMargin: Style.space(8)
                    anchors.top: parent.top
                    anchors.bottom: parent.bottom
                    width: Style.space(104)
                    text: modelData.title
                    color: root.bar ? root.bar.foreground : "white"
                    font.family: root.bar ? root.bar.fontFamily : "sans-serif"
                    font.pixelSize: Style.font.body
                    elide: Text.ElideRight
                    verticalAlignment: Text.AlignVCenter
                  }

                  PanelSlider {
                    id: soundSlider
                    bar: root.bar
                    anchors.left: soundName.right
                    anchors.leftMargin: Style.space(8)
                    anchors.right: parent.right
                    anchors.top: parent.top
                    anchors.bottom: parent.bottom
                    minimum: 0
                    maximum: 1
                    value: root.volumeFor(modelData.id)
                    onMoved: function(next) { root.setSoundVolumeFromSlider(modelData.id, next) }
                  }

                  MouseArea {
                    anchors.left: parent.left
                    anchors.top: parent.top
                    anchors.bottom: parent.bottom
                    width: Style.space(144)
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
              color: Color.accent
              font.family: root.bar ? root.bar.fontFamily : "sans-serif"
              font.pixelSize: Style.font.caption
              font.bold: true
            }

            Repeater {
            model: root.mixerState.customSounds || []

              delegate: Item {
                width: soundsColumn.width
                height: Style.space(42)

                Text {
                  id: customSoundIcon
                  anchors.left: parent.left
                  anchors.top: parent.top
                  anchors.bottom: parent.bottom
                  width: Style.space(24)
                  text: "󰝚"
                  color: Catalog.isPlaying(root.mixerState, modelData.id) ? Color.accent : (root.bar ? root.bar.foreground : "white")
                  font.family: root.bar ? root.bar.fontFamily : "sans-serif"
                  font.pixelSize: Style.font.icon
                  verticalAlignment: Text.AlignVCenter
                }

                Text {
                  id: customSoundName
                  anchors.left: customSoundIcon.right
                  anchors.leftMargin: Style.space(8)
                  anchors.top: parent.top
                  anchors.bottom: parent.bottom
                  width: Style.space(104)
                  text: modelData.name
                  color: root.bar ? root.bar.foreground : "white"
                  font.family: root.bar ? root.bar.fontFamily : "sans-serif"
                  font.pixelSize: Style.font.body
                  elide: Text.ElideRight
                  verticalAlignment: Text.AlignVCenter
                }

                Row {
                  id: customSoundActions
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  spacing: Style.space(8)

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

                PanelSlider {
                  id: customSoundSlider
                  bar: root.bar
                  anchors.left: customSoundName.right
                  anchors.leftMargin: Style.space(8)
                  anchors.right: customSoundActions.left
                  anchors.rightMargin: Style.space(8)
                  anchors.top: parent.top
                  anchors.bottom: parent.bottom
                  minimum: 0
                  maximum: 1
                  value: root.volumeFor(modelData.id)
                  onMoved: function(next) { root.setSoundVolumeFromSlider(modelData.id, next) }
                }

                MouseArea {
                  anchors.left: parent.left
                  anchors.top: parent.top
                  anchors.bottom: parent.bottom
                  width: Style.space(144)
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
          onClicked: {
            root.clearPendingVolumes();
            root.sendAction("reset-volumes", {});
          }
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
