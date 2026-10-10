import Gio from "gi://Gio";
import GLib from "gi://GLib";
import {
  defaultState,
  inspectState,
  loadState,
  mutateAndPersist,
  recoverStateFile,
  saveState,
} from "../backend/model.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertThrows(callback, pattern, message) {
  try {
    callback();
  } catch (error) {
    if (!pattern || pattern.test(error.message)) return;
    throw new Error(`${message}: unexpected error ${error.message}`);
  }
  throw new Error(message);
}

function readText(path) {
  const [ok, contents] = GLib.file_get_contents(path);
  if (!ok) throw new Error(`Could not read ${path}`);
  return contents instanceof Uint8Array ? new TextDecoder().decode(contents) : contents;
}

function readBytes(path) {
  const [ok, contents] = GLib.file_get_contents(path);
  if (!ok) throw new Error(`Could not read ${path}`);
  return new Uint8Array(contents);
}

function mode(path) {
  return Gio.File.new_for_path(path)
    .query_info("unix::mode", Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
    .get_attribute_uint32("unix::mode") & 0o777;
}

const testDirectory = GLib.dir_make_tmp("relaxy-state-recovery-test-XXXXXX");
const statePath = GLib.build_filenamev([testDirectory, "state.json"]);

const missing = inspectState(statePath);
assert(missing.status === "missing", "an absent state file should be distinguished from a broken file");
assert(missing.state.schemaVersion === 1, "missing state should use defaults in memory");

const corruptRaw = "{ this is not valid json\n";
GLib.file_set_contents(statePath, corruptRaw);
const corrupt = inspectState(statePath);
assert(corrupt.status === "corrupt" && corrupt.canRecover, "malformed JSON should be recoverable but flagged");
assert(readText(statePath) === corruptRaw, "loading malformed data must leave the original file untouched");
let rejectedCorruptSave = false;
try { saveState(defaultState(), statePath); } catch (_error) { rejectedCorruptSave = true; }
assert(rejectedCorruptSave && readText(statePath) === corruptRaw, "ordinary saves must not overwrite malformed data");

const futurePath = GLib.build_filenamev([testDirectory, "future.json"]);
const futureRaw = JSON.stringify({ schemaVersion: 99, futureData: { keep: true } }, null, 2) + "\n";
GLib.file_set_contents(futurePath, futureRaw);
const future = inspectState(futurePath);
assert(future.status === "future-version" && future.canRecover, "future schemas should be identified separately");
assert(readText(futurePath) === futureRaw, "future schema input must not be rewritten during load");
assertThrows(() => loadState(futurePath), /schema version 99/i, "loadState must not silently return defaults for a future schema");
assertThrows(() => saveState(defaultState(), futurePath), /preserved/i, "normal save must reject a future schema file");
assert(readText(futurePath) === futureRaw, "failed save must keep future-version input intact");

const directoryAsFile = GLib.build_filenamev([testDirectory, "not-a-file"]);
GLib.mkdir_with_parents(directoryAsFile, 0o700);
const unreadable = inspectState(directoryAsFile);
assert(unreadable.status === "unreadable" && !unreadable.canRecover, "read errors must not be confused with a missing file");

const validPath = GLib.build_filenamev([testDirectory, "valid.json"]);
const original = defaultState();
saveState(original, validPath);
const originalText = readText(validPath);
const updated = { ...original, masterVolume: 0.25 };
saveState(updated, validPath);
const backupPath = `${validPath}.bak`;
assert(readText(backupPath) === originalText, "the previous valid state must be retained as last-known-good");
assert(mode(backupPath) === 0o600 && mode(validPath) === 0o600, "state and recovery files must remain private");

const committedText = readText(validPath);
const committedState = loadState(validPath);
const renameFailure = {
  rename: function(source, destination) {
    if (destination === validPath) return false;
    return GLib.rename(source, destination);
  },
};
let rejectedMutation = false;
try {
  mutateAndPersist(committedState, (draft) => { draft.masterVolume = 0.9; return draft; }, validPath, renameFailure);
} catch (_error) {
  rejectedMutation = true;
}
assert(rejectedMutation, "a deterministic atomic-rename failure must reject the mutation");
assert(committedState.masterVolume === 0.25, "failed persistence must not publish the candidate in-memory state");
assert(readText(validPath) === committedText, "failed atomic replacement must preserve the current state file");
assert(readText(backupPath) === committedText, "failed replacement must retain the last-known-good copy");

const recoveryPath = GLib.build_filenamev([testDirectory, "recover-me.json"]);
GLib.file_set_contents(recoveryPath, corruptRaw);
const recoveryInput = inspectState(recoveryPath);
const recovered = recoverStateFile(defaultState(), recoveryPath, recoveryInput);
assert(readText(recovered.backupPath) === corruptRaw, "explicit recovery must archive the exact invalid input");
assert(mode(recovered.backupPath) === 0o600, "the archived invalid input must be owner-only");
assert(inspectState(recoveryPath).status === "ok", "explicit recovery should write a fresh supported state");

const invalidEncodingPath = GLib.build_filenamev([testDirectory, "invalid-encoding.json"]);
const invalidEncoding = new Uint8Array([0x7b, 0xff, 0x00, 0x7d]);
GLib.file_set_contents(invalidEncodingPath, invalidEncoding);
const invalidEncodingInspection = inspectState(invalidEncodingPath);
assert(invalidEncodingInspection.status === "corrupt" && invalidEncodingInspection.canRecover, "invalid UTF-8 is corrupt input, not a missing/unreadable file");
const invalidEncodingRecovery = recoverStateFile(defaultState(), invalidEncodingPath, invalidEncodingInspection);
assert(readBytes(invalidEncodingRecovery.backupPath).join(",") === invalidEncoding.join(","), "invalid UTF-8 bytes must be preserved exactly during explicit recovery");

const changedPath = GLib.build_filenamev([testDirectory, "changed.json"]);
GLib.file_set_contents(changedPath, corruptRaw);
const staleRecoveryInput = inspectState(changedPath);
GLib.file_set_contents(changedPath, "new invalid data\n");
assertThrows(
  () => recoverStateFile(defaultState(), changedPath, staleRecoveryInput),
  /changed since it was loaded/i,
  "recovery must not overwrite input that changed after inspection",
);
assert(readText(changedPath) === "new invalid data\n", "changed state data must remain untouched");

print("State recovery and persistence tests passed.");
