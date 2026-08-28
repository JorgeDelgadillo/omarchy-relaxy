import QtQuick
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "jdelgadillo.relaxy"

  function injectPanel() {
    const panel = panelLoader.item;
    if (!panel) return;
    if ("bar" in panel) panel.bar = root.bar;
    if ("anchorItem" in panel) panel.anchorItem = button;
    if ("hostWidget" in panel) panel.hostWidget = root;
  }

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() {
    if (panelLoader.item) panelLoader.item.open();
  }

  function close() {
    if (panelLoader.item) panelLoader.item.close();
  }

  function toggle() {
    if (root.opened) root.close();
    else root.open();
  }

  function closeForPopoutSwitch() {
    root.close();
  }

  readonly property bool popoutSwitchClosing: false

  visible: true
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("ui/Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel();
      Qt.callLater(root.injectPanel);
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: panelLoader.item ? panelLoader.item.barGlyph : "󰝚"
    slotSize: Style.bar.statusSlot
    tooltipText: panelLoader.item ? panelLoader.item.tooltipText : "Relaxy"

    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton) root.toggle();
      else if (buttonCode === Qt.MiddleButton) {
        if (panelLoader.item) panelLoader.item.sendAction("toggle-playing", {});
      } else root.toggle();
    }
  }

  onBarChanged: injectPanel()
}
