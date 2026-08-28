import GLib from "gi://GLib";
import {
  DEFAULT_PRESET_ID,
  addCustomSound,
  addPreset,
  defaultState,
  loadState,
  normalizeState,
  removeCustomSound,
  removePreset,
  renameCustomSound,
  renamePreset,
  saveState,
  setSoundPlaying,
  setSoundVolume,
  statePath,
} from "../backend/model.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const state = defaultState();
setSoundPlaying(state, "rain", true);
setSoundVolume(state, "rain", 0.75);
assert(state.presets[0].volumes.rain === 0.75, "volume should be stored");
assert(state.presets[0].mutes.rain === false, "playing sound should be unmuted");

addPreset(state, "Focus");
assert(state.presets.length === 2 && state.activePresetId !== DEFAULT_PRESET_ID, "preset should be created and selected");
renamePreset(state, state.activePresetId, "Deep Focus");
removePreset(state, state.activePresetId);
assert(state.presets.length === 1 && state.activePresetId === DEFAULT_PRESET_ID, "preset should be removed safely");

addCustomSound(state, "/tmp/example.ogg", "Example");
const customId = state.customSounds[0].id;
renameCustomSound(state, customId, "Renamed Example");
removeCustomSound(state, customId);
assert(state.customSounds.length === 0, "custom sound should be removed");

const normalized = normalizeState({
  schemaVersion: 99,
  masterVolume: 9,
  presets: [{ id: "default", name: "", volumes: { rain: 2 } }, { id: "default", name: "Duplicate" }],
});
assert(normalized.schemaVersion === 1, "state schema should be normalized");
assert(normalized.masterVolume === 1, "master volume should be clamped");
assert(normalized.presets.length === 1, "duplicate preset ids should be discarded");

const testDirectory = GLib.dir_make_tmp("relaxy-model-test-XXXXXX");
const testPath = GLib.build_filenamev([testDirectory, "state.json"]);
saveState(state, testPath);
const loaded = loadState(testPath);
assert(loaded.schemaVersion === 1, "saved state should load");
assert(statePath().endsWith("relaxy/state.json"), "default state path should use the Relaxy directory");

print("Model tests passed.");

