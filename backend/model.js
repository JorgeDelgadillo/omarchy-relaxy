import Gio from "gi://Gio";
import GLib from "gi://GLib";

export const STATE_VERSION = 1;
export const DEFAULT_PRESET_ID = "default";
export const DEFAULT_VOLUME = 0.5;

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function clampVolume(value, fallback = 0) {
  return Math.max(0, Math.min(1, finiteNumber(value, fallback)));
}

export function cleanName(value, fallback) {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  return name.length > 0 ? name.slice(0, 80) : fallback;
}

function normalizeMap(value, transform) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [key, item] of Object.entries(value)) result[String(key)] = transform(item);
  return result;
}

function normalizePreset(raw, index) {
  const id = cleanName(raw?.id, index === 0 ? DEFAULT_PRESET_ID : `preset-${index}`)
    .replace(/[^A-Za-z0-9._-]/g, "-");
  return {
    id,
    name: cleanName(raw?.name, index === 0 ? "Default" : `Preset ${index + 1}`),
    hideInactive: Boolean(raw?.hideInactive),
    volumes: normalizeMap(raw?.volumes, (item) => clampVolume(item)),
    mutes: normalizeMap(raw?.mutes, (item) => Boolean(item)),
  };
}

export function defaultState() {
  return {
    schemaVersion: STATE_VERSION,
    playing: false,
    masterVolume: 1,
    startPaused: false,
    inhibitSuspension: false,
    activePresetId: DEFAULT_PRESET_ID,
    presets: [normalizePreset({}, 0)],
    customSounds: [],
  };
}

export function normalizeState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Saved state must be a JSON object");
  if (raw.schemaVersion !== STATE_VERSION) {
    if (typeof raw.schemaVersion === "number" && raw.schemaVersion > STATE_VERSION) {
      throw new Error(`Saved state uses a newer state schema (${raw.schemaVersion}); this build supports ${STATE_VERSION}`);
    }
    throw new Error(`Saved state has an unsupported schema version; this build supports ${STATE_VERSION}`);
  }

  const state = defaultState();

  state.playing = Boolean(raw.playing);
  state.masterVolume = clampVolume(raw.masterVolume, 1);
  state.startPaused = Boolean(raw.startPaused);
  state.inhibitSuspension = Boolean(raw.inhibitSuspension);

  const sourcePresets = Array.isArray(raw.presets) ? raw.presets : [];
  const seenPresetIds = new Set();
  state.presets = sourcePresets
    .map((preset, index) => normalizePreset(preset, index))
    .filter((preset) => {
      if (seenPresetIds.has(preset.id)) return false;
      seenPresetIds.add(preset.id);
      return true;
    });
  if (state.presets.length === 0) state.presets = [normalizePreset({}, 0)];
  if (!state.presets.some((preset) => preset.id === DEFAULT_PRESET_ID)) {
    state.presets.unshift(normalizePreset({}, 0));
  }

  state.activePresetId = state.presets.some((preset) => preset.id === raw.activePresetId)
    ? raw.activePresetId
    : DEFAULT_PRESET_ID;

  const sourceCustomSounds = Array.isArray(raw.customSounds) ? raw.customSounds : [];
  const seenSoundIds = new Set();
  state.customSounds = sourceCustomSounds
    .map((sound, index) => ({
      id: cleanName(sound?.id, `custom-${index}`).replace(/[^A-Za-z0-9._-]/g, "-"),
      name: cleanName(sound?.name, `Custom Sound ${index + 1}`),
      path: String(sound?.path ?? "").trim(),
    }))
    .filter((sound) => {
      if (!sound.path || seenSoundIds.has(sound.id)) return false;
      seenSoundIds.add(sound.id);
      return true;
    });

  state.schemaVersion = STATE_VERSION;
  return state;
}

export function applyLaunchPlayback(state, powerSaverEnabled = false) {
  if ((state.startPaused || powerSaverEnabled) && state.playing) {
    state.playing = false;
    return true;
  }
  return false;
}

export function statePath() {
  const base = GLib.getenv("XDG_STATE_HOME") || GLib.build_filenamev([GLib.get_home_dir(), ".local", "state"]);
  return GLib.build_filenamev([base, "relaxy", "state.json"]);
}

function stateReadError(path, status, message, rawText = null, rawBytes = null) {
  return {
    state: defaultState(),
    status,
    message,
    path,
    rawText,
    rawBytes,
    canRecover: (status === "corrupt" || status === "future-version")
      && (rawText !== null || rawBytes !== null),
  };
}

export function inspectState(path = statePath()) {
  let contents;
  try {
    const [ok, loadedContents] = Gio.File.new_for_path(path).load_contents(null);
    if (!ok) return stateReadError(path, "unreadable", `Could not read saved state at ${path}.`);
    contents = loadedContents;
  } catch (error) {
    if (error.matches && error.matches(Gio.io_error_quark(), Gio.IOErrorEnum.NOT_FOUND)) {
      return { state: defaultState(), status: "missing", message: "", path, rawText: null, canRecover: false };
    }
    return stateReadError(path, "unreadable", `Could not read saved state at ${path}: ${error.message}`);
  }

  const rawBytes = contents instanceof Uint8Array ? new Uint8Array(contents) : new TextEncoder().encode(String(contents));
  let rawText;
  try {
    rawText = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
  } catch (error) {
    return stateReadError(path, "corrupt", `Saved state at ${path} is not valid UTF-8: ${error.message}`, null, rawBytes);
  }

  let raw;
  try {
    raw = JSON.parse(rawText);
  } catch (error) {
    return stateReadError(path, "corrupt", `Saved state at ${path} is not valid JSON: ${error.message}`, rawText, rawBytes);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return stateReadError(path, "corrupt", `Saved state at ${path} must be a JSON object.`, rawText, rawBytes);
  }
  if (typeof raw.schemaVersion === "number" && raw.schemaVersion > STATE_VERSION) {
    return stateReadError(
      path,
      "future-version",
      `Saved state at ${path} uses schema version ${raw.schemaVersion}; this build supports ${STATE_VERSION}. The file was left untouched.`,
      rawText,
      rawBytes,
    );
  }
  try {
    return { state: normalizeState(raw), status: "ok", message: "", path, rawText, rawBytes, canRecover: false };
  } catch (error) {
    return stateReadError(path, "corrupt", `Saved state at ${path} cannot be used: ${error.message}`, rawText, rawBytes);
  }
}

export function loadState(path = statePath()) {
  const result = inspectState(path);
  if (result.status === "missing" || result.status === "ok") return result.state;
  throw new Error(result.message);
}

function persistenceError(message, cause = null) {
  const error = new Error(cause ? `${message}: ${cause.message}` : message);
  error.name = "StatePersistenceError";
  return error;
}

// State, backups, and status files are written owner-only: the process umask
// is not trusted to keep another local account from reading them.
export function writePrivateFile(path, text, io = {}) {
  const directory = GLib.path_get_dirname(path);
  const temporaryPath = `${path}.tmp-${GLib.uuid_string_random()}`;
  try {
    GLib.mkdir_with_parents(directory, 0o700);
    const wrote = io.writeContents
      ? io.writeContents(temporaryPath, text)
      : GLib.file_set_contents(temporaryPath, text);
    if (wrote === false) throw new Error("temporary write returned false");
    const modeSet = io.setPrivateMode
      ? io.setPrivateMode(temporaryPath)
      : Gio.File.new_for_path(temporaryPath).set_attribute_uint32("unix::mode", 0o600, Gio.FileQueryInfoFlags.NONE, null);
    if (modeSet === false) throw new Error("could not set owner-only permissions");
    const mode = io.queryMode
      ? io.queryMode(temporaryPath)
      : Gio.File.new_for_path(temporaryPath).query_info("unix::mode", Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
        .get_attribute_uint32("unix::mode");
    if ((mode & 0o077) !== 0) throw new Error(`could not secure temporary file: ${temporaryPath}`);
    const moved = io.rename
      ? io.rename(temporaryPath, path)
      : GLib.rename(temporaryPath, path);
    if (moved === false) throw new Error(`atomic rename failed for ${path}`);
  } catch (error) {
    try {
      if (io.remove) io.remove(temporaryPath);
      else GLib.unlink(temporaryPath);
    } catch (_cleanupError) {
      // Keep the original failure; a leftover private temporary file is safer than masking it.
    }
    throw persistenceError(`Could not safely write ${path}`, error);
  }
}

export function saveState(state, path = statePath(), io = {}) {
  const normalized = normalizeState(state);
  const existing = inspectState(path);
  if (existing.status === "unreadable") throw persistenceError(`${existing.message} The existing file was not replaced.`);
  if (existing.status === "corrupt" || existing.status === "future-version") {
    throw persistenceError(`${existing.message} The file is preserved; use the explicit recover-state action to replace it.`);
  }
  if (existing.status === "ok") writePrivateFile(`${path}.bak`, existing.rawText, io);
  writePrivateFile(path, `${JSON.stringify(normalized, null, 2)}\n`, io);
  return normalized;
}

export function mutateAndPersist(currentState, mutator, path = statePath(), io = {}) {
  const candidate = JSON.parse(JSON.stringify(currentState));
  const result = mutator(candidate) || candidate;
  return saveState(result, path, io);
}

function byteArraysEqual(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

export function recoverStateFile(state, path, expectedInspection, io = {}) {
  const current = inspectState(path);
  if (!current.canRecover || !expectedInspection || !byteArraysEqual(current.rawBytes, expectedInspection.rawBytes)) {
    throw persistenceError(`Saved state at ${path} changed since it was loaded or cannot be recovered; it was left untouched.`);
  }
  const normalized = normalizeState(state);
  const backupPath = `${path}.recovery-${GLib.uuid_string_random()}.json`;
  writePrivateFile(backupPath, current.rawBytes, io);
  writePrivateFile(path, `${JSON.stringify(normalized, null, 2)}\n`, io);
  return { state: normalized, backupPath };
}

export function activePreset(state) {
  return state.presets.find((preset) => preset.id === state.activePresetId) || state.presets[0];
}

export function setActivePreset(state, presetId) {
  if (state.presets.some((preset) => preset.id === presetId)) state.activePresetId = presetId;
  return state;
}

export function setSoundVolume(state, soundId, volume) {
  const preset = activePreset(state);
  preset.volumes[soundId] = clampVolume(volume);
  preset.mutes[soundId] = preset.volumes[soundId] <= 0;
  if (!preset.mutes[soundId]) state.playing = true;
  return state;
}

export function setSoundPlaying(state, soundId, playing) {
  const preset = activePreset(state);
  preset.mutes[soundId] = !Boolean(playing);
  if (playing && clampVolume(preset.volumes[soundId]) <= 0) preset.volumes[soundId] = DEFAULT_VOLUME;
  if (playing) state.playing = true;
  return state;
}

export function resetVolumes(state) {
  const preset = activePreset(state);
  preset.volumes = {};
  preset.mutes = {};
  return state;
}

export function addPreset(state, name) {
  const normalizedName = cleanName(name, "");
  if (!normalizedName) throw new Error("Preset name cannot be empty");
  const id = `preset-${GLib.uuid_string_random()}`;
  const current = activePreset(state);
  state.presets.push({
    id,
    name: normalizedName,
    hideInactive: current.hideInactive,
    volumes: { ...current.volumes },
    mutes: { ...current.mutes },
  });
  state.activePresetId = id;
  return state;
}

export function renamePreset(state, presetId, name) {
  const normalizedName = cleanName(name, "");
  if (!normalizedName) throw new Error("Preset name cannot be empty");
  const preset = state.presets.find((item) => item.id === presetId);
  if (!preset) throw new Error("Preset not found");
  preset.name = normalizedName;
  return state;
}

export function removePreset(state, presetId) {
  if (presetId === DEFAULT_PRESET_ID) throw new Error("The default preset cannot be removed");
  if (state.presets.length <= 1) throw new Error("At least one preset is required");
  const index = state.presets.findIndex((preset) => preset.id === presetId);
  if (index < 0) throw new Error("Preset not found");
  state.presets.splice(index, 1);
  if (state.activePresetId === presetId) state.activePresetId = state.presets[Math.max(0, index - 1)].id;
  return state;
}

export function stepPreset(state, direction) {
  const index = state.presets.findIndex((preset) => preset.id === state.activePresetId);
  const nextIndex = Math.max(0, Math.min(state.presets.length - 1, index + (direction < 0 ? -1 : 1)));
  state.activePresetId = state.presets[nextIndex].id;
  return state;
}

export function addCustomSound(state, path, name) {
  const sourcePath = String(path ?? "").trim();
  if (!sourcePath) throw new Error("Sound path cannot be empty");
  if (state.customSounds.some((sound) => sound.path === sourcePath)) throw new Error("Sound already added");
  const id = `custom-${GLib.uuid_string_random()}`;
  state.customSounds.push({ id, path: sourcePath, name: cleanName(name, GLib.path_get_basename(sourcePath)) });
  return state;
}

export function renameCustomSound(state, soundId, name) {
  const normalizedName = cleanName(name, "");
  if (!normalizedName) throw new Error("Sound name cannot be empty");
  const sound = state.customSounds.find((item) => item.id === soundId);
  if (!sound) throw new Error("Custom sound not found");
  sound.name = normalizedName;
  return state;
}

export function removeCustomSound(state, soundId) {
  const index = state.customSounds.findIndex((sound) => sound.id === soundId);
  if (index < 0) throw new Error("Custom sound not found");
  state.customSounds.splice(index, 1);
  for (const preset of state.presets) {
    delete preset.volumes[soundId];
    delete preset.mutes[soundId];
  }
  return state;
}
