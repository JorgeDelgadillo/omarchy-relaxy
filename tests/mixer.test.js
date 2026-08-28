import Gst from "gi://Gst";
import { AmbientMixer } from "../backend/mixer.js";

Gst.init(null);
const events = [];
const mixer = new AmbientMixer((event) => events.push(event));
const pipeline = mixer.pipeline;
if (!pipeline || !mixer.mixer || !mixer.master) throw new Error("Mixer pipeline was not created");
mixer.master.set_property("volume", 0.25);
mixer.addSound({ id: "pink-noise", type: "noise", wave: "pink-noise" }, 0.2);
if (!mixer.branches.has("pink-noise")) throw new Error("Noise branch was not attached");
mixer.removeSound("pink-noise");
mixer.stop();
print("Mixer tests passed.");
