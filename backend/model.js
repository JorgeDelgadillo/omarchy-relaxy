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
  const state = defaultState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return state;

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

export function loadState(path = statePath()) {
  try {
    const [ok, contents] = GLib.file_get_contents(path);
    if (!ok) return defaultState();
    const text = contents instanceof Uint8Array ? new TextDecoder().decode(contents) : contents;
    return normalizeState(JSON.parse(text));
  } catch (_error) {
    return defaultState();
  }
}

// State and status files are written owner-only: the process umask is not
// trusted to keep another local account from reading them.
export function writePrivateFile(path, text) {
  const directory = GLib.path_get_dirname(path);
  GLib.mkdir_with_parents(directory, 0o700);
  const temporaryPath = `${path}.tmp-${GLib.get_real_time()}`;
  GLib.file_set_contents(temporaryPath, text);
  Gio.File.new_for_path(temporaryPath).set_attribute_uint32("unix::mode", 0o600, Gio.FileQueryInfoFlags.NONE, null);
  GLib.rename(temporaryPath, path);
  const mode = Gio.File.new_for_path(path).query_info("unix::mode", Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
    .get_attribute_uint32("unix::mode") & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`Could not secure file: ${path}`);
}

export function saveState(state, path = statePath()) {
  const normalized = normalizeState(state);
  writePrivateFile(path, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
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
