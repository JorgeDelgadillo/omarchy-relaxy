.pragma library

var groups = [
  {
    id: "nature",
    title: "Nature",
    sounds: [
      { id: "rain", title: "Rain" },
      { id: "storm", title: "Storm" },
      { id: "wind", title: "Wind" },
      { id: "waves", title: "Waves" },
      { id: "stream", title: "Stream" },
      { id: "birds", title: "Birds" },
      { id: "summer-night", title: "Summer Night" },
    ],
  },
  {
    id: "travel",
    title: "Travel",
    sounds: [
      { id: "train", title: "Train" },
      { id: "boat", title: "Boat" },
      { id: "city", title: "City" },
    ],
  },
  {
    id: "interiors",
    title: "Interiors",
    sounds: [
      { id: "coffee-shop", title: "Coffee Shop" },
      { id: "fireplace", title: "Fireplace" },
    ],
  },
  {
    id: "noise",
    title: "Noise",
    sounds: [
      { id: "pink-noise", title: "Pink Noise" },
      { id: "white-noise", title: "White Noise" },
    ],
  },
];

function defaultState() {
  return {
    schemaVersion: 1,
    playing: true,
    masterVolume: 1,
    startPaused: false,
    inhibitSuspension: false,
    activePresetId: "default",
    presets: [{ id: "default", name: "Default", hideInactive: false, volumes: {}, mutes: {} }],
    customSounds: [],
  };
}

function activePreset(state) {
  var presets = state && Array.isArray(state.presets) ? state.presets : [];
  for (var index = 0; index < presets.length; index++) {
    if (presets[index].id === state.activePresetId) return presets[index];
  }
  return presets.length > 0 ? presets[0] : defaultState().presets[0];
}

function isPlaying(state, soundId) {
  return activePreset(state).mutes[soundId] === false && Number(activePreset(state).volumes[soundId] || 0) > 0;
}

function volume(state, soundId) {
  return Number(activePreset(state).volumes[soundId] || 0);
}

