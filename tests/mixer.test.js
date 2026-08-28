import Gst from "gi://Gst";
import GLib from "gi://GLib";
import { AmbientMixer } from "../backend/mixer.js";

Gst.init(null);
const events = [];

function stateFor(soundId, level = 0.2) {
  return {
    playing: true,
    masterVolume: 1,
    activePresetId: "default",
    presets: [{ id: "default", volumes: { [soundId]: level }, mutes: { [soundId]: false } }],
  };
}

const mixer = new AmbientMixer((event) => events.push(event));
mixer.sync([{ id: "pink-noise", type: "noise", wave: "pink-noise" }], stateFor("pink-noise"));
if (!mixer.pipeline || !mixer.mixer || !mixer.master) throw new Error("Mixer pipeline was not created");
if (!mixer.branches.has("pink-noise")) throw new Error("Noise branch was not attached");
mixer.master.set_property("volume", 0.25);
mixer.sync([], { ...stateFor("pink-noise"), playing: false });

const rainPath = GLib.build_filenamev([GLib.get_current_dir(), "assets", "sounds", "rain.ogg"]);
mixer.sync([{ id: "rain", type: "file", path: rainPath }], stateFor("rain"));
const rainBranch = mixer.branches.get("rain");
if (!rainBranch || !rainBranch.source) throw new Error("File branch was not attached");
const loop = new GLib.MainLoop(null, false);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
loop.run();
if (events.some((event) => event.type === "error" && event.soundId === "rain")) {
  print(JSON.stringify(events));
  throw new Error("File branch emitted an error");
}
mixer.stop();
print("Mixer tests passed.");
