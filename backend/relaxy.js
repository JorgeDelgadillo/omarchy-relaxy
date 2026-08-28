#!/usr/bin/env gjs

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GLibUnix from "gi://GLibUnix";
import Gst from "gi://Gst";
import { allSoundSpecs } from "./catalog.js";
import {
  activePreset,
  addCustomSound,
  addPreset,
  loadState,
  removeCustomSound,
  removePreset,
  renameCustomSound,
  renamePreset,
  resetVolumes,
  saveState,
  setActivePreset,
  setSoundPlaying,
  setSoundVolume,
  statePath,
  stepPreset,
} from "./model.js";
import { AmbientMixer } from "./mixer.js";

const BUS_NAME = "org.mpris.MediaPlayer2.Relaxy";
const OBJECT_PATH = "/org/mpris/MediaPlayer2";
const MPRIS_ROOT_XML = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/><method name="Quit"/>
    <property name="CanQuit" type="b" access="read"/><property name="CanRaise" type="b" access="read"/>
    <property name="HasTrackList" type="b" access="read"/><property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/><property name="SupportedUriSchemes" type="as" access="read"/>
    <property name="SupportedMimeTypes" type="as" access="read"/>
  </interface>
</node>`;
const MPRIS_PLAYER_XML = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="Next"/><method name="Previous"/><method name="PlayPause"/><method name="Play"/><method name="Pause"/><method name="Stop"/>
    <property name="PlaybackStatus" type="s" access="read"/><property name="Metadata" type="a{sv}" access="read"/>
    <property name="Position" type="x" access="read"/><property name="Rate" type="d" access="readwrite"/>
    <property name="MinimumRate" type="d" access="read"/><property name="MaximumRate" type="d" access="read"/>
    <property name="Volume" type="d" access="readwrite"/><property name="CanSeek" type="b" access="read"/>
    <property name="CanGoNext" type="b" access="read"/><property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/><property name="CanPause" type="b" access="read"/><property name="CanControl" type="b" access="read"/>
  </interface>
</node>`;

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function bytes(text) {
  return new TextEncoder().encode(text);
}

function unpack(value) {
  return value instanceof GLib.Variant ? value.deep_unpack() : value;
}

class MprisAdapter {
  constructor(backend) {
    this.backend = backend;
    this.rootExported = null;
    this.playerExported = null;
    this.bus = null;
    this.ownerId = Gio.bus_own_name(
      Gio.BusType.SESSION,
      BUS_NAME,
      Gio.BusNameOwnerFlags.NONE,
      (connection) => this.exportOnBus(connection),
      null,
      null,
    );
  }

  exportOnBus(connection) {
    this.bus = connection;
    this.rootExported = Gio.DBusExportedObject.wrapJSObject(MPRIS_ROOT_XML, this);
    this.playerExported = Gio.DBusExportedObject.wrapJSObject(MPRIS_PLAYER_XML, this);
    this.rootExported.export(connection, OBJECT_PATH);
    this.playerExported.export(connection, OBJECT_PATH);
  }

  Raise() {
    try {
      Gio.Subprocess.new(["omarchy-shell", "shell", "summon", "jdelgadillo.relaxy"], Gio.SubprocessFlags.NONE);
    } catch (_error) {
      // The bar remains usable when the shell summon command is unavailable.
    }
  }

  Quit() {
    this.backend.setPlaying(false);
  }

  Next() {
    this.backend.mutate((state) => stepPreset(state, 1));
  }

  Previous() {
    this.backend.mutate((state) => stepPreset(state, -1));
  }

  PlayPause() {
    this.backend.setPlaying(!this.backend.state.playing);
  }

  Play() {
    this.backend.setPlaying(true);
  }

  Pause() {
    this.backend.setPlaying(false);
  }

  Stop() {
    this.backend.setPlaying(false);
  }

  get CanQuit() { return true; }
  get CanRaise() { return true; }
  get HasTrackList() { return false; }
  get Identity() { return "Relaxy"; }
  get DesktopEntry() { return "jdelgadillo.relaxy"; }
  get SupportedUriSchemes() { return []; }
  get SupportedMimeTypes() { return []; }
  get PlaybackStatus() { return this.backend.state.playing ? "Playing" : "Paused"; }
  get Metadata() { return unpack(this.propertyValue("org.mpris.MediaPlayer2.Player", "Metadata")); }
  get Position() { return 0; }
  get Rate() { return 1; }
  set Rate(_value) { /* Ambient sounds do not support variable playback rate. */ }
  get MinimumRate() { return 1; }
  get MaximumRate() { return 1; }
  get Volume() { return Number(this.backend.state.masterVolume); }
  set Volume(value) { this.backend.setMasterVolume(Number(value)); }
  get CanSeek() { return false; }
  get CanGoNext() { return this.backend.state.presets.findIndex((item) => item.id === this.backend.state.activePresetId) < this.backend.state.presets.length - 1; }
  get CanGoPrevious() { return this.backend.state.presets.findIndex((item) => item.id === this.backend.state.activePresetId) > 0; }
  get CanPlay() { return true; }
  get CanPause() { return true; }
  get CanControl() { return true; }

  Get(interfaceName, propertyName) {
    return new GLib.Variant("v", this.propertyValue(interfaceName, propertyName));
  }

  Set(_interfaceName, propertyName, value) {
    if (propertyName === "Volume") this.backend.setMasterVolume(Number(unpack(value)));
  }

  GetAll(interfaceName) {
    const properties = {};
    for (const property of this.propertyNames(interfaceName)) properties[property] = this.propertyValue(interfaceName, property);
    return properties;
  }

  propertyNames(interfaceName) {
    if (interfaceName === "org.mpris.MediaPlayer2") return ["CanQuit", "CanRaise", "HasTrackList", "Identity", "DesktopEntry", "SupportedUriSchemes", "SupportedMimeTypes"];
    if (interfaceName === "org.mpris.MediaPlayer2.Player") return ["PlaybackStatus", "Metadata", "Position", "Rate", "MinimumRate", "MaximumRate", "Volume", "CanSeek", "CanGoNext", "CanGoPrevious", "CanPlay", "CanPause", "CanControl"];
    return [];
  }

  propertyValue(interfaceName, propertyName) {
    const state = this.backend.state;
    const preset = activePreset(state);
    if (interfaceName === "org.mpris.MediaPlayer2") {
      const values = {
        CanQuit: new GLib.Variant("b", true),
        CanRaise: new GLib.Variant("b", true),
        HasTrackList: new GLib.Variant("b", false),
        Identity: new GLib.Variant("s", "Relaxy"),
        DesktopEntry: new GLib.Variant("s", "jdelgadillo.relaxy"),
        SupportedUriSchemes: new GLib.Variant("as", []),
        SupportedMimeTypes: new GLib.Variant("as", []),
      };
      if (values[propertyName]) return values[propertyName];
    }
    if (interfaceName === "org.mpris.MediaPlayer2.Player") {
      const values = {
        PlaybackStatus: new GLib.Variant("s", state.playing ? "Playing" : "Paused"),
        Metadata: new GLib.Variant("a{sv}", {
          "mpris:trackid": new GLib.Variant("o", "/org/mpris/MediaPlayer2/Track/1"),
          "xesam:title": new GLib.Variant("s", preset.name),
          "xesam:album": new GLib.Variant("s", "Ambient Sounds"),
          "xesam:artist": new GLib.Variant("as", ["Relaxy"]),
        }),
        Position: new GLib.Variant("x", 0),
        Rate: new GLib.Variant("d", 1),
        MinimumRate: new GLib.Variant("d", 1),
        MaximumRate: new GLib.Variant("d", 1),
        Volume: new GLib.Variant("d", Number(state.masterVolume)),
        CanSeek: new GLib.Variant("b", false),
        CanGoNext: new GLib.Variant("b", state.presets.findIndex((item) => item.id === state.activePresetId) < state.presets.length - 1),
        CanGoPrevious: new GLib.Variant("b", state.presets.findIndex((item) => item.id === state.activePresetId) > 0),
        CanPlay: new GLib.Variant("b", true),
        CanPause: new GLib.Variant("b", true),
        CanControl: new GLib.Variant("b", true),
      };
      if (values[propertyName]) return values[propertyName];
    }
    throw new Error(`Unknown MPRIS property: ${interfaceName}.${propertyName}`);
  }

  emitChanges() {
    if (!this.playerExported) return;
    const changed = {};
    for (const property of ["PlaybackStatus", "Metadata", "Volume", "CanGoNext", "CanGoPrevious"]) changed[property] = this.propertyValue("org.mpris.MediaPlayer2.Player", property);
    this.playerExported.emit_signal("PropertiesChanged", new GLib.Variant("(sa{sv}as)", ["org.mpris.MediaPlayer2.Player", changed, []]));
  }

  dispose() {
    if (this.rootExported) this.rootExported.unexport();
    if (this.playerExported) this.playerExported.unexport();
    if (this.ownerId) Gio.bus_unown_name(this.ownerId);
  }
}

export class Backend {
  constructor({ assetDirectory, socketPath, settingsPath }) {
    this.assetDirectory = assetDirectory;
    this.socketPath = socketPath;
    this.settingsPath = settingsPath;
    this.state = loadState(settingsPath);
    if (this.state.startPaused) this.state.playing = false;
    this.clients = new Set();
    this.loop = new GLib.MainLoop(null, false);
    this.inhibitor = null;
    this.responseClient = null;
    this.mixer = new AmbientMixer((event) => this.broadcast({ type: "event", event }));
    this.mpris = new MprisAdapter(this);
    this.server = new Gio.SocketService();
    this.powerMonitor = Gio.PowerProfileMonitor.dup_default();
    this.powerMonitor.connect("notify::power-saver-enabled", () => {
      const enabled = typeof this.powerMonitor.get_power_saver_enabled === "function"
        ? this.powerMonitor.get_power_saver_enabled()
        : Boolean(this.powerMonitor.power_saver_enabled);
      if (enabled && this.state.playing) {
        this.setPlaying(false);
        this.broadcast({ type: "power-saver-paused" });
      }
    });
  }

  start() {
    GLib.mkdir_with_parents(GLib.path_get_dirname(this.socketPath), 0o700);
    try { GLib.unlink(this.socketPath); } catch (_error) { /* The socket may not exist. */ }
    const address = Gio.UnixSocketAddress.new(this.socketPath);
    this.server.add_address(address, Gio.SocketType.STREAM, Gio.SocketProtocol.DEFAULT, null);
    this.server.connect("incoming", (_service, connection) => {
      this.accept(connection);
      return true;
    });
    this.server.start();
    this.sync();
    this.broadcast({ type: "ready", state: this.state });
    GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 15, () => { this.stop(); return GLib.SOURCE_REMOVE; });
    GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 2, () => { this.stop(); return GLib.SOURCE_REMOVE; });
    this.loop.run();
  }

  accept(connection) {
    const client = { connection, input: Gio.DataInputStream.new(connection.get_input_stream()), output: connection.get_output_stream() };
    this.clients.add(client);
    const readNext = () => {
      client.input.read_line_async(GLib.PRIORITY_DEFAULT, null, (_stream, result) => {
        try {
          const [line] = client.input.read_line_finish_utf8(result);
          if (line === null) return this.closeClient(client);
          this.handleRequest(client, JSON.parse(line));
          readNext();
        } catch (error) {
          this.respond(client, { type: "error", ok: false, error: error.message });
          this.closeClient(client);
        }
      });
    };
    readNext();
  }

  closeClient(client) {
    this.clients.delete(client);
    try { client.connection.close(null); } catch (_error) { /* Already closed. */ }
  }

  respond(client, response) {
    try { client.output.write_all(bytes(jsonLine(response)), null); client.output.flush(null); } catch (_error) { this.closeClient(client); }
  }

  broadcast(message) {
    for (const client of this.clients) {
      if (client === this.responseClient) continue;
      this.respond(client, { ...message, state: message.state || this.state });
    }
  }

  handleRequest(client, request) {
    this.responseClient = client;
    try {
      const result = this.handleAction(request.action, request.payload || {});
      this.respond(client, { id: request.id || null, type: "response", ok: true, result, state: this.state });
    } catch (error) {
      this.respond(client, { id: request.id || null, type: "response", ok: false, error: error.message, state: this.state });
    }
    this.responseClient = null;
  }

  handleAction(action, payload) {
    switch (action) {
      case "get-state": return this.state;
      case "play": this.setPlaying(true); break;
      case "pause": this.setPlaying(false); break;
      case "toggle-playing": this.setPlaying(!this.state.playing); break;
      case "stop": this.setPlaying(false); break;
      case "set-master-volume": this.setMasterVolume(payload.volume); break;
      case "set-sound-volume": this.mutate((state) => setSoundVolume(state, payload.soundId, payload.volume)); break;
      case "toggle-sound": this.mutate((state) => setSoundPlaying(state, payload.soundId, payload.playing)); break;
      case "set-preset": this.mutate((state) => setActivePreset(state, payload.presetId)); break;
      case "next-preset": this.mutate((state) => stepPreset(state, 1)); break;
      case "previous-preset": this.mutate((state) => stepPreset(state, -1)); break;
      case "reset-volumes": this.mutate(resetVolumes); break;
      case "add-preset": this.mutate((state) => addPreset(state, payload.name)); break;
      case "rename-preset": this.mutate((state) => renamePreset(state, payload.presetId, payload.name)); break;
      case "remove-preset": this.mutate((state) => removePreset(state, payload.presetId)); break;
      case "add-custom-sound": this.mutate((state) => addCustomSound(state, payload.path, payload.name)); break;
      case "rename-custom-sound": this.mutate((state) => renameCustomSound(state, payload.soundId, payload.name)); break;
      case "remove-custom-sound": this.mutate((state) => removeCustomSound(state, payload.soundId)); break;
      case "set-start-paused": this.mutate((state) => { state.startPaused = Boolean(payload.value); return state; }); break;
      case "set-inhibit-suspension": this.mutate((state) => { state.inhibitSuspension = Boolean(payload.value); return state; }); break;
      case "set-hide-inactive": this.mutate((state) => { activePreset(state).hideInactive = Boolean(payload.value); return state; }); break;
      default: throw new Error(`Unknown action: ${action}`);
    }
    return this.state;
  }

  mutate(mutator) {
    this.state = mutator(this.state) || this.state;
    this.persistAndSync();
  }

  setPlaying(value) {
    this.state.playing = Boolean(value);
    this.persistAndSync();
  }

  setMasterVolume(value) {
    this.state.masterVolume = Math.max(0, Math.min(1, Number(value) || 0));
    this.persistAndSync();
  }

  persistAndSync() {
    saveState(this.state, this.settingsPath);
    this.sync();
    this.mpris.emitChanges();
    this.broadcast({ type: "state-changed" });
  }

  sync() {
    const specs = allSoundSpecs(this.assetDirectory, this.state.customSounds);
    this.mixer.sync(specs, this.state);
    if (this.state.playing && this.state.inhibitSuspension) this.startInhibitor();
    else this.stopInhibitor();
  }

  startInhibitor() {
    if (this.inhibitor) return;
    try {
      this.inhibitor = Gio.Subprocess.new(["systemd-inhibit", "--what=sleep", "--who=Relaxy", "--why=Ambient playback in progress", "--mode=block", "sleep", "infinity"], Gio.SubprocessFlags.NONE);
    } catch (error) {
      this.broadcast({ type: "event", event: { type: "error", soundId: null, message: `Could not inhibit suspension: ${error.message}` } });
    }
  }

  stopInhibitor() {
    if (!this.inhibitor) return;
    this.inhibitor.force_exit();
    this.inhibitor = null;
  }

  stop() {
    this.stopInhibitor();
    this.mixer.stop();
    this.mpris.dispose();
    for (const client of [...this.clients]) this.closeClient(client);
    this.server.stop();
    try { GLib.unlink(this.socketPath); } catch (_error) { /* The socket may already be gone. */ }
    if (this.loop.is_running()) this.loop.quit();
  }
}

function argumentsObject() {
  const result = { mode: "serve", socketPath: "", settingsPath: statePath(), assetDirectory: "" };
  for (let index = 0; index < ARGV.length; index += 1) {
    const argument = ARGV[index];
    if (argument === "--command") result.mode = "command", result.command = JSON.parse(ARGV[++index]);
    else if (argument === "--socket") result.socketPath = ARGV[++index];
    else if (argument === "--state") result.settingsPath = ARGV[++index];
    else if (argument === "--assets") result.assetDirectory = ARGV[++index];
  }
  if (!result.socketPath) {
    const runtime = GLib.getenv("XDG_RUNTIME_DIR") || "/tmp";
    result.socketPath = GLib.build_filenamev([runtime, `relaxy-${GLib.get_user_name()}.sock`]);
  }
  if (!result.assetDirectory) result.assetDirectory = GLib.build_filenamev([GLib.path_get_dirname(import.meta.url.replace("file://", "")), "..", "assets", "sounds"]);
  return result;
}

const options = argumentsObject();
if (options.mode === "command") {
  try {
    const client = new Gio.SocketClient();
    const connection = client.connect(Gio.UnixSocketAddress.new(options.socketPath), null);
    const output = connection.get_output_stream();
    output.write_all(bytes(jsonLine(options.command)), null);
    output.flush(null);
    const input = Gio.DataInputStream.new(connection.get_input_stream());
    const [line] = input.read_line_utf8(null);
    print(line || jsonLine({ ok: false, error: "No response from Relaxy backend" }));
  } catch (error) {
    print(jsonLine({ ok: false, error: error.message }));
    imports.system.exit(1);
  }
} else {
  new Backend(options).start();
}
