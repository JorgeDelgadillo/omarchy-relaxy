import GLib from "gi://GLib";
import { builtInSounds, groupsWithSounds } from "../backend/catalog.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function compareGroups(label, actual, expected) {
  assert(actual.length === expected.length, `${label}: expected ${expected.length} groups, found ${actual.length}`);
  for (let groupIndex = 0; groupIndex < expected.length; groupIndex += 1) {
    const expectedGroup = expected[groupIndex];
    const actualGroup = actual[groupIndex];
    assert(actualGroup.id === expectedGroup.id, `${label}: group ${groupIndex} id mismatch`);
    assert(actualGroup.title === expectedGroup.title, `${label}: group ${expectedGroup.id} title mismatch`);
    const actualIds = actualGroup.sounds.map((sound) => sound.id).join(",");
    const expectedIds = expectedGroup.sounds.join(",");
    assert(actualIds === expectedIds, `${label}: group ${expectedGroup.id} sounds mismatch (${actualIds} != ${expectedIds})`);
  }
}

const repositoryDirectory = GLib.path_get_dirname(GLib.path_get_dirname(decodeURIComponent(import.meta.url.replace("file://", ""))));
const soundDirectory = GLib.build_filenamev([repositoryDirectory, "assets", "sounds"]);
const catalogPath = GLib.build_filenamev([repositoryDirectory, "assets", "catalog.json"]);
const manifestPath = GLib.build_filenamev([repositoryDirectory, "manifest.json"]);
const uiCatalogPath = GLib.build_filenamev([repositoryDirectory, "ui", "Catalog.js"]);

const [catalogOk, catalogContents] = GLib.file_get_contents(catalogPath);
assert(catalogOk, "Could not read assets/catalog.json");
const catalog = JSON.parse(new TextDecoder().decode(catalogContents));

const builtIns = builtInSounds(soundDirectory);
assert(builtIns.length === catalog.sounds.length, `backend catalog has ${builtIns.length} sounds, expected ${catalog.sounds.length}`);
for (let index = 0; index < catalog.sounds.length; index += 1) {
  const expected = catalog.sounds[index];
  const actual = builtIns[index];
  assert(actual.id === expected.id, `backend sound ${index} id mismatch (${actual.id} != ${expected.id})`);
  assert(actual.title === expected.title, `backend sound ${expected.id} title mismatch`);
  assert(actual.type === expected.type, `backend sound ${expected.id} type mismatch`);
  if (expected.type === "file") {
    assert(GLib.path_get_basename(actual.path) === expected.file, `backend sound ${expected.id} file mismatch`);
  } else {
    assert(actual.wave === expected.wave, `backend sound ${expected.id} wave mismatch`);
  }
}
compareGroups("backend groups", groupsWithSounds(soundDirectory), catalog.groups);

const [uiOk, uiContents] = GLib.file_get_contents(uiCatalogPath);
assert(uiOk, "Could not read ui/Catalog.js");
const uiSource = new TextDecoder().decode(uiContents).replace(/^\s*\.pragma library\s*$/m, "");
const [manifestOk, manifestContents] = GLib.file_get_contents(manifestPath);
assert(manifestOk, "Could not read manifest.json");
const manifest = JSON.parse(new TextDecoder().decode(manifestContents));
const identity = new Function(`${uiSource}\nreturn { version, license, author };`)();
assert(identity.version === manifest.version, `ui version ${identity.version} != manifest ${manifest.version}`);
assert(identity.license === manifest.license, `ui license ${identity.license} != manifest ${manifest.license}`);
assert(identity.author === manifest.author, `ui author ${identity.author} != manifest ${manifest.author}`);
const uiGroups = new Function(`${uiSource}\nreturn groups;`)();
compareGroups("ui groups", uiGroups, catalog.groups);
const titlesById = new Map(catalog.sounds.map((sound) => [sound.id, sound.title]));
for (const group of uiGroups) {
  for (const sound of group.sounds) {
    assert(titlesById.has(sound.id), `ui group ${group.id} has unknown sound ${sound.id}`);
    assert(sound.title === titlesById.get(sound.id), `ui sound ${sound.id} title mismatch (${sound.title} != ${titlesById.get(sound.id)})`);
  }
}

print("Catalog parity test passed.");
