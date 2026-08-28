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
try {
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

const stormPath = GLib.build_filenamev([GLib.get_current_dir(), "assets", "sounds", "storm.ogg"]);
const multiState = {
  playing: true,
  masterVolume: 1,
  activePresetId: "default",
  presets: [{ id: "default", volumes: { rain: 0.2, storm: 0.2 }, mutes: { rain: false, storm: false } }],
};
mixer.sync([
  { id: "rain", type: "file", path: rainPath },
  { id: "storm", type: "file", path: stormPath },
], multiState);
const stormBranch = mixer.branches.get("storm");
if (!stormBranch || !stormBranch.source) throw new Error("Storm branch was not attached");
let eosCount = 0;
mixer.bus.connect("message", (_bus, message) => {
  if (message.type === Gst.MessageType.EOS) eosCount += 1;
});
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 27, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
loop.run();
const stormStatsBeforeLoop = mixer.sink.stats;
const renderedBeforeLoop = stormStatsBeforeLoop.get_value("rendered");
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
loop.run();
const stormStatsAfterLoop = mixer.sink.stats;
const renderedAfterLoop = stormStatsAfterLoop.get_value("rendered");
const [, stormState] = mixer.pipeline.get_state(0);
if (eosCount === 0) throw new Error("Storm test did not reach EOS");
if (renderedAfterLoop <= renderedBeforeLoop) throw new Error("Storm pipeline did not render audio after EOS");
if (stormState !== Gst.State.PLAYING) throw new Error(`Storm pipeline did not resume PLAYING: ${stormState}`);

const liveMixState = {
  playing: true,
  masterVolume: 1,
  activePresetId: "default",
  presets: [{ id: "default", volumes: { "pink-noise": 0.2, storm: 0.2 }, mutes: { "pink-noise": false, storm: false } }],
};
mixer.sync([
  { id: "pink-noise", type: "noise", wave: "pink-noise" },
  { id: "storm", type: "file", path: stormPath },
], liveMixState);
const liveStormBranch = mixer.branches.get("storm");
if (!liveStormBranch || !liveStormBranch.source) throw new Error("Live storm branch was not attached");
mixer.pipeline.seek_simple(Gst.Format.TIME, Gst.SeekFlags.FLUSH | Gst.SeekFlags.KEY_UNIT, 23 * Gst.SECOND);
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
loop.run();
const positionQuery = Gst.Query.new_position(Gst.Format.TIME);
if (!liveStormBranch.source.query(positionQuery)) throw new Error("Could not query live storm position");
const [, liveStormPosition] = positionQuery.parse_position();
if (liveStormPosition >= 8 * Gst.SECOND) throw new Error(`Live storm branch did not loop: ${liveStormPosition}`);
} finally {
  mixer.stop();
}
print("Mixer tests passed.");
