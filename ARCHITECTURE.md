# Relaxy Architecture

Relaxy is an Omarchy schema-version-1 plugin with two entry points:

- `Service.qml` owns the long-lived backend process.
- `BarWidget.qml` provides the themed status-bar control and panel.

The backend will be an isolated GJS process using GStreamer. Quickshell will
communicate with it through a local Unix socket and will never own the audio
pipeline directly. Persistent user state will be written below
`$XDG_STATE_HOME/relaxy/`.

All user-facing text, source comments, tests, and documentation are written in
English.

