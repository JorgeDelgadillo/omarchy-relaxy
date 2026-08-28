import GLib from "gi://GLib";

export const GROUPS = [
  { id: "nature", title: "Nature", sounds: ["rain", "storm", "wind", "waves", "stream", "birds", "summer-night"] },
  { id: "travel", title: "Travel", sounds: ["train", "boat", "city"] },
  { id: "interiors", title: "Interiors", sounds: ["coffee-shop", "fireplace"] },
  { id: "noise", title: "Noise", sounds: ["pink-noise", "white-noise"] },
];

const FILE_SOUNDS = [
  ["rain", "Rain", "rain.ogg"],
  ["storm", "Storm", "storm.ogg"],
  ["wind", "Wind", "wind.ogg"],
  ["waves", "Waves", "waves.ogg"],
  ["stream", "Stream", "stream.ogg"],
  ["birds", "Birds", "birds.ogg"],
  ["summer-night", "Summer Night", "summer-night.ogg"],
  ["train", "Train", "train.ogg"],
  ["boat", "Boat", "boat.ogg"],
  ["city", "City", "city.ogg"],
  ["coffee-shop", "Coffee Shop", "coffee-shop.ogg"],
  ["fireplace", "Fireplace", "fireplace.ogg"],
];

export function builtInSounds(assetDirectory) {
  const sounds = FILE_SOUNDS.map(([id, title, file]) => ({
    id,
    title,
    type: "file",
    path: GLib.build_filenamev([assetDirectory, file]),
  }));
  sounds.push({ id: "pink-noise", title: "Pink Noise", type: "noise", wave: "pink-noise" });
  sounds.push({ id: "white-noise", title: "White Noise", type: "noise", wave: "white-noise" });
  return sounds;
}

export function groupsWithSounds(assetDirectory, customSounds = []) {
  const builtIns = builtInSounds(assetDirectory);
  const byId = Object.fromEntries(builtIns.map((sound) => [sound.id, sound]));
  return [
    ...GROUPS.map((group) => ({
      ...group,
      sounds: group.sounds.map((id) => byId[id]).filter(Boolean),
    })),
    ...(customSounds.length > 0 ? [{
      id: "custom",
      title: "Custom",
      sounds: customSounds.map((sound) => ({ id: sound.id, title: sound.name, type: "file", path: sound.path, custom: true })),
    }] : []),
  ];
}

export function allSoundSpecs(assetDirectory, customSounds = []) {
  return groupsWithSounds(assetDirectory, customSounds).flatMap((group) => group.sounds);
}

