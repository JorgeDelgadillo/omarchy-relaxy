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
  applyLaunchPlayback,
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
  writePrivateFile,
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

function powerSaverEnabled(monitor) {
  if (!monitor) return false;
  return typeof monitor.get_power_saver_enabled === "function"
    ? monitor.get_power_saver_enabled()
    : Boolean(monitor.power_saver_enabled);
}

const MAX_REQUEST_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 8192;
const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 512;
const MAX_PATH_LENGTH = 4096;
const MAX_SOCKET_PATH_BYTES = 107;
const S_IFMT = 0o170000;
const S_IFSOCK = 0o140000;

function queryAttributes(path, attributes) {
  return Gio.File.new_for_path(path).query_info(attributes, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
}

function setUnixMode(path, mode) {
  Gio.File.new_for_path(path).set_attribute_uint32("unix::mode", mode, Gio.FileQueryInfoFlags.NONE, null);
}

// The socket directory is the trust boundary for local IPC: only the owning
// user may traverse it, so another local account can neither connect to the
// backend nor squat the socket path.
function ensurePrivateDirectory(path) {
  GLib.mkdir_with_parents(path, 0o700);
  const info = queryAttributes(path, "standard::type,owner::user");
  if (info.get_file_type() !== Gio.FileType.DIRECTORY) throw new Error(`Not a private directory: ${path}`);
  if (info.get_attribute_string("owner::user") !== GLib.get_user_name()) throw new Error(`Not owned by the current user: ${path}`);
  setUnixMode(path, 0o700);
  const mode = queryAttributes(path, "unix::mode").get_attribute_uint32("unix::mode") & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`Could not secure directory: ${path}`);
}

function defaultSocketDirectory() {
  const runtime = GLib.getenv("XDG_RUNTIME_DIR");
  if (runtime) return runtime;
  // The shell UI mirrors this fallback with $TMPDIR (or /tmp) and $USER, so
  // both sides derive the same path when the session has no runtime dir.
  return GLib.build_filenamev([GLib.get_tmp_dir(), `relaxy-${GLib.get_user_name()}`]);
}

function defaultSocketPath() {
  return GLib.build_filenamev([defaultSocketDirectory(), `relaxy-${GLib.get_user_name()}.sock`]);
}

const ACTION_SCHEMAS = {
  "get-state": {},
  "play": {},
  "pause": {},
  "toggle-playing": {},
  "stop": {},
  "set-master-volume": { volume: "number" },
  "set-sound-volume": { soundId: "id", volume: "number" },
  "toggle-sound": { soundId: "id", playing: "boolean" },
  "set-preset": { presetId: "id" },
  "next-preset": {},
  "previous-preset": {},
  "reset-volumes": {},
  "add-preset": { name: "name" },
  "rename-preset": { presetId: "id", name: "name" },
  "remove-preset": { presetId: "id" },
  "add-custom-sound": { path: "path", name: "name" },
  "rename-custom-sound": { soundId: "id", name: "name" },
  "remove-custom-sound": { soundId: "id" },
  "set-start-paused": { value: "boolean" },
  "set-inhibit-suspension": { value: "boolean" },
  "set-hide-inactive": { value: "boolean" },
  "dismiss-error": {},
};

function checkFieldString(name, value, max) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error(`Invalid ${name}`);
}

function validateField(name, kind, value) {
  if (kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid ${name}`);
  } else if (kind === "boolean") {
    if (typeof value !== "boolean") throw new Error(`Invalid ${name}`);
  } else if (kind === "id") {
    checkFieldString(name, value, MAX_ID_LENGTH);
  } else if (kind === "name") {
    checkFieldString(name, value, MAX_NAME_LENGTH);
  } else if (kind === "path") {
    checkFieldString(name, value, MAX_PATH_LENGTH);
  }
}

// Every request is validated before it can change state: unknown actions,
// unexpected fields, wrong types, and oversized strings are rejected here so
// a peer that reaches the socket cannot smuggle anything past the schema.
function validateRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
  let id = value.id;
  if (id === undefined || id === null || id === "") id = null;
  else if (typeof id !== "string" || id.length > MAX_ID_LENGTH) throw new Error("Invalid request id");
  const action = value.action;
  if (typeof action !== "string" || !Object.hasOwn(ACTION_SCHEMAS, action)) throw new Error(`Unknown action: ${action}`);
  const payload = value.payload === undefined || value.payload === null ? {} : value.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid payload");
  const schema = ACTION_SCHEMAS[action];
  const schemaKeys = Object.keys(schema);
  const payloadKeys = Object.keys(payload);
  if (payloadKeys.length !== schemaKeys.length || !payloadKeys.every((key) => Object.hasOwn(schema, key))) {
    throw new Error("Invalid payload fields");
  }
  for (const [key, kind] of Object.entries(schema)) validateField(key, kind, payload[key]);
  return { id, action, payload };
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
  constructor({ assetDirectory, socketPath, settingsPath, statusPath }) {
    this.assetDirectory = assetDirectory;
    this.socketPath = socketPath;
    this.settingsPath = settingsPath;
    this.statusPath = statusPath;
    ensurePrivateDirectory(GLib.path_get_dirname(this.settingsPath));
    this.state = loadState(settingsPath);
    this.clients = new Set();
    this.loop = new GLib.MainLoop(null, false);
    this.inhibitor = null;
    this.responseClient = null;
    this.lastError = null;
    this.powerMonitor = Gio.PowerProfileMonitor.dup_default();
    if (applyLaunchPlayback(this.state, powerSaverEnabled(this.powerMonitor))) {
      saveState(this.state, this.settingsPath);
    }
    this.mixer = new AmbientMixer((event) => this.handleMixerEvent(event));
    this.mpris = new MprisAdapter(this);
    this.server = new Gio.SocketService();
    this.powerMonitor.connect("notify::power-saver-enabled", () => {
      if (powerSaverEnabled(this.powerMonitor) && this.state.playing) {
        this.setPlaying(false);
        this.broadcast({ type: "power-saver-paused" });
      }
    });
  }

  start() {
    ensurePrivateDirectory(GLib.path_get_dirname(this.socketPath));
    this.bindSocket();
    this.server.connect("incoming", (_service, connection) => {
      this.accept(connection);
      return true;
    });
    this.server.start();
    this.sync();
    this.writeStatus();
    this.broadcast({ type: "ready", state: this.state });
    GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 15, () => { this.stop(); return GLib.SOURCE_REMOVE; });
    GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 2, () => { this.stop(); return GLib.SOURCE_REMOVE; });
    this.loop.run();
  }

  // GIO reports sockets as SPECIAL, so socket identity is read from the unix
  // mode bits instead of the generic file type.
  socketIdentity() {
    const info = queryAttributes(this.socketPath, "owner::user,unix::mode");
    return {
      owner: info.get_attribute_string("owner::user"),
      mode: info.get_attribute_uint32("unix::mode"),
    };
  }

  bindSocket() {
    if (bytes(this.socketPath).length > MAX_SOCKET_PATH_BYTES) throw new Error(`Socket path is too long: ${this.socketPath}`);
    const socketFile = Gio.File.new_for_path(this.socketPath);
    let existing = null;
    try {
      existing = this.socketIdentity();
    } catch (error) {
      if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) throw error;
    }
    if (existing) {
      // Never unlink a foreign file: in a shared directory that would be a
      // squatting vector, and in a private directory it signals corruption.
      if ((existing.mode & S_IFMT) !== S_IFSOCK || existing.owner !== GLib.get_user_name()) {
        throw new Error(`Refusing to replace unexpected file: ${this.socketPath}`);
      }
      socketFile.delete(null);
    }
    const address = Gio.UnixSocketAddress.new(this.socketPath);
    this.server.add_address(address, Gio.SocketType.STREAM, Gio.SocketProtocol.DEFAULT, null);
    setUnixMode(this.socketPath, 0o600);
    const created = this.socketIdentity();
    if ((created.mode & S_IFMT) !== S_IFSOCK) throw new Error(`Socket was not created: ${this.socketPath}`);
    if (created.owner !== GLib.get_user_name()) throw new Error(`Socket is not owned by the current user: ${this.socketPath}`);
    if ((created.mode & 0o777) !== 0o600) throw new Error(`Could not secure socket: ${this.socketPath}`);
  }

  accept(connection) {
    const client = { connection, input: connection.get_input_stream(), output: connection.get_output_stream(), pending: new Uint8Array(0) };
    this.clients.add(client);
    this.readMore(client);
  }

  // Requests are read with an explicit byte ceiling so a peer cannot exhaust
  // backend memory with an unbounded line. Oversized or undecodable input
  // closes the connection without a state-changing response.
  readMore(client) {
    client.input.read_bytes_async(READ_CHUNK_BYTES, GLib.PRIORITY_DEFAULT, null, (stream, result) => {
      if (!this.clients.has(client)) return;
      let chunk;
      try {
        chunk = stream.read_bytes_finish(result).get_data();
      } catch (_error) {
        this.closeClient(client);
        return;
      }
      if (chunk.length === 0) {
        this.closeClient(client);
        return;
      }
      const pending = new Uint8Array(client.pending.length + chunk.length);
      pending.set(client.pending, 0);
      pending.set(chunk, client.pending.length);
      client.pending = pending;
      if (client.pending.length > MAX_REQUEST_BYTES + READ_CHUNK_BYTES) {
        printerr("relaxy: closing oversized request");
        this.closeClient(client);
        return;
      }
      let newline = client.pending.indexOf(10);
      while (newline >= 0) {
        const lineBytes = client.pending.subarray(0, newline);
        client.pending = client.pending.subarray(newline + 1);
        if (lineBytes.length > MAX_REQUEST_BYTES) {
          printerr("relaxy: closing oversized request");
          this.closeClient(client);
          return;
        }
        this.handleLine(client, lineBytes);
        if (!this.clients.has(client)) return;
        newline = client.pending.indexOf(10);
      }
      this.readMore(client);
    });
  }

  handleLine(client, lineBytes) {
    let text = "";
    try {
      let end = lineBytes.length;
      if (end > 0 && lineBytes[end - 1] === 13) end -= 1;
      text = new TextDecoder("utf-8", { fatal: true }).decode(lineBytes.subarray(0, end));
    } catch (_error) {
      this.respond(client, { type: "error", ok: false, error: "Invalid request encoding" });
      this.closeClient(client);
      return;
    }
    let request;
    try {
      request = validateRequest(JSON.parse(text));
    } catch (error) {
      this.respond(client, { type: "error", ok: false, error: error.message });
      this.closeClient(client);
      return;
    }
    this.handleRequest(client, request);
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

  handleMixerEvent(event) {
    if (event.type === "error") {
      this.lastError = {
        soundId: event.soundId || null,
        message: event.message,
        debug: event.debug || "",
        at: Date.now(),
      };
      this.writeStatus();
      printerr(`relaxy: ${event.soundId ? `sound ${event.soundId}` : "pipeline"} error: ${event.message}${event.debug ? ` (${event.debug})` : ""}`);
    }
    this.broadcast({ type: "event", event });
  }

  writeStatus() {
    const document = { schemaVersion: 1, lastError: this.lastError };
    try {
      writePrivateFile(this.statusPath, `${JSON.stringify(document, null, 2)}\n`);
    } catch (error) {
      printerr(`relaxy: could not write the status file: ${error.message}`);
    }
  }

  clearSoundError(soundId) {
    if (!this.lastError || this.lastError.soundId !== soundId) return;
    this.dismissError();
  }

  dismissError() {
    if (!this.lastError) return;
    this.lastError = null;
    this.writeStatus();
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
      case "set-sound-volume": this.clearSoundError(payload.soundId); this.mixer.clearFailure(payload.soundId); this.mutate((state) => setSoundVolume(state, payload.soundId, payload.volume)); break;
      case "toggle-sound": this.clearSoundError(payload.soundId); this.mixer.clearFailure(payload.soundId); this.mutate((state) => setSoundPlaying(state, payload.soundId, payload.playing)); break;
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
      case "dismiss-error": this.dismissError(); break;
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
    if (this.lastError?.soundId && !specs.some((spec) => spec.id === this.lastError.soundId)) this.dismissError();
    this.mixer.sync(specs, this.state);
    if (this.state.playing && this.state.inhibitSuspension) this.startInhibitor();
    else this.stopInhibitor();
  }

  startInhibitor() {
    if (this.inhibitor) return;
    try {
      this.inhibitor = Gio.Subprocess.new(["systemd-inhibit", "--what=sleep", "--who=Relaxy", "--why=Ambient playback in progress", "--mode=block", "sleep", "infinity"], Gio.SubprocessFlags.NONE);
    } catch (error) {
      this.handleMixerEvent({ type: "error", soundId: null, message: `Could not inhibit suspension: ${error.message}`, debug: "" });
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
    try { GLib.unlink(this.statusPath); } catch (_error) { /* The status file may already be gone. */ }
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
    result.socketPath = defaultSocketPath();
  }
  if (!result.assetDirectory) result.assetDirectory = GLib.build_filenamev([GLib.path_get_dirname(import.meta.url.replace("file://", "")), "..", "assets", "sounds"]);
  result.statusPath = `${result.socketPath.replace(/\.sock$/, "")}.status.json`;
  return result;
}

// The one-shot client bounds the response the same way the server bounds
// requests, so a rogue peer on an explicitly chosen socket cannot exhaust it.
function readResponseLine(input) {
  let pending = new Uint8Array(0);
  for (;;) {
    const newline = pending.indexOf(10);
    if (newline >= 0) {
      if (newline > MAX_REQUEST_BYTES) throw new Error("Response is too large");
      return new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, newline));
    }
    if (pending.length > MAX_REQUEST_BYTES + READ_CHUNK_BYTES) throw new Error("Response is too large");
    const chunk = input.read_bytes(READ_CHUNK_BYTES, null).get_data();
    if (chunk.length === 0) {
      if (pending.length === 0) return null;
      throw new Error("Incomplete response");
    }
    const next = new Uint8Array(pending.length + chunk.length);
    next.set(pending, 0);
    next.set(chunk, pending.length);
    pending = next;
  }
}

const options = argumentsObject();
if (options.mode === "command") {
  try {
    const client = new Gio.SocketClient();
    const connection = client.connect(Gio.UnixSocketAddress.new(options.socketPath), null);
    const output = connection.get_output_stream();
    output.write_all(bytes(jsonLine(options.command)), null);
    output.flush(null);
    const line = readResponseLine(connection.get_input_stream());
    print(line || jsonLine({ ok: false, error: "No response from Relaxy backend" }));
  } catch (error) {
    print(jsonLine({ ok: false, error: error.message }));
    imports.system.exit(1);
  }
} else {
  new Backend(options).start();
}
