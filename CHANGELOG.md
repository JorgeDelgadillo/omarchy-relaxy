# Changelog

## 0.1.0 - Unreleased

- Added an Omarchy schema-version-1 bar widget and persistent service.
- Added the fourteen attributed ambient recordings from Blanket's catalog.
- Added GStreamer mixing for file sounds, pink noise, and white noise.
- Added presets, custom sounds, master/per-track volume, and playback controls.
- Added MPRIS support, power-saver pause, and optional suspend inhibition.
- Added state normalization, checksums, shell contracts, and integration tests.
- Fixed initial volume application after dynamic file decoder preroll.
- Fixed mixed-track end-of-stream recovery, including the non-blocking backend
  recovery path required by PipeWire playback.
- Fixed finite sounds stopping silently when mixed with other active sounds;
  branch end detection now avoids streaming-thread callbacks.
- Fixed error-driven pipeline rebuilds to run outside the GStreamer bus
  callback; failed sounds are retried after an explicit user action.
- Added panel error reporting backed by a runtime status file and shell-log
  diagnostics.
- Added a catalog parity check across the JSON, backend, and UI definitions.
- Added regression coverage for file-only and file-plus-live-noise mixes.
