import Gst from "gi://Gst";
import GLib from "gi://GLib";
import { AmbientMixer } from "../backend/mixer.js";

Gst.init(null);

function fail(message) {
  throw new Error(message);
}

function pumpLoop(seconds) {
  const loop = new GLib.MainLoop(null, false);
  const source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, Math.round(seconds * 1000)), () => {
    loop.quit();
    return GLib.SOURCE_CONTINUE;
  });
  loop.run();
  GLib.source_remove(source);
}

function waitUntil(predicate, timeoutSeconds) {
  const loop = new GLib.MainLoop(null, false);
  let intervalAlive = true;
  let timeoutAlive = true;
  let satisfied = false;
  const interval = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 25, () => {
    if (!predicate()) return GLib.SOURCE_CONTINUE;
    intervalAlive = false;
    satisfied = true;
    if (timeoutAlive) {
      GLib.source_remove(timeout);
      timeoutAlive = false;
    }
    loop.quit();
    return GLib.SOURCE_REMOVE;
  });
  const timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSeconds, () => {
    timeoutAlive = false;
    loop.quit();
    return GLib.SOURCE_REMOVE;
  });
  loop.run();
  if (intervalAlive) GLib.source_remove(interval);
  if (timeoutAlive) GLib.source_remove(timeout);
  return satisfied;
}

function createShortFile(path) {
  const writer = Gst.parse_launch(
    `audiotestsrc num-buffers=8 samplesperbuffer=11025 ! audioconvert ! audioresample ! vorbisenc ! oggmux ! filesink location=${path}`,
  );
  if (!writer) fail("Could not create the short test file pipeline");
  const bus = writer.get_bus();
  const loop = new GLib.MainLoop(null, false);
  bus.add_signal_watch();
  const watch = bus.connect("message", (_bus, message) => {
    if (message.type === Gst.MessageType.EOS || message.type === Gst.MessageType.ERROR) loop.quit();
  });
  writer.set_state(Gst.State.PLAYING);
  loop.run();
  bus.disconnect(watch);
  bus.remove_signal_watch();
  writer.set_state(Gst.State.NULL);
}

function stateWith(volumes) {
  const mutes = {};
  for (const id of Object.keys(volumes)) mutes[id] = false;
  return {
    playing: true,
    masterVolume: 1,
    activePresetId: "default",
    presets: [{ id: "default", volumes, mutes }],
  };
}

const events = [];
let mixer;
mixer = new AmbientMixer((event) => {
  events.push(event);
  if (event.type === "pipeline-ready" && mixer.sink) mixer.sink.set_property("sync", true);
});

function syncSink() {
  if (mixer.sink) mixer.sink.set_property("sync", true);
}

function assertRecovered(label, baseIndex, previousPipeline, soundId) {
  const newEvents = events.slice(baseIndex);
  const errors = newEvents.filter((event) => event.type === "error");
  if (errors.length > 0) {
    print(JSON.stringify(errors));
    fail(`${label}: recovery emitted an error`);
  }
  if (mixer.pipeline === previousPipeline) fail(`${label}: pipeline was not rebuilt`);
  const branch = mixer.branches.get(soundId);
  if (!branch || !branch.volume) fail(`${label}: ${soundId} branch is missing after recovery`);
  if (Math.abs(branch.volume.volume - 0.2) >= 0.001) fail(`${label}: ${soundId} level was not restored`);
  if (!waitUntil(() => mixer.pipeline.get_state(0)[1] === Gst.State.PLAYING, 5)) {
    fail(`${label}: pipeline did not resume PLAYING after recovery`);
  }
  const renderedBefore = mixer.sink.stats.get_value("rendered");
  pumpLoop(0.5);
  const renderedAfter = mixer.sink.stats.get_value("rendered");
  if (renderedAfter <= renderedBefore) fail(`${label}: pipeline did not render audio after recovery`);
}

const tempDirectory = GLib.dir_make_tmp("relaxy-mixer-test-XXXXXX");
const shortPath = GLib.build_filenamev([tempDirectory, "short.ogg"]);
const rainPath = GLib.build_filenamev([GLib.get_current_dir(), "assets", "sounds", "rain.ogg"]);

try {
  createShortFile(shortPath);

  mixer.sync([{ id: "pink-noise", type: "noise", wave: "pink-noise" }], stateWith({ "pink-noise": 0.2 }));
  if (!mixer.pipeline || !mixer.mixer || !mixer.master) fail("Mixer pipeline was not created");
  if (!mixer.branches.has("pink-noise")) fail("Noise branch was not attached");
  mixer.master.set_property("volume", 0.25);
  mixer.sync([], { ...stateWith({ "pink-noise": 0.2 }), playing: false });
  if (mixer.pipeline) fail("An empty mix should release the pipeline");

  mixer.sync([{ id: "rain", type: "file", path: rainPath }], stateWith({ rain: 0.2 }));
  syncSink();
  if (!mixer.branches.get("rain")?.source) fail("File branch was not attached");
  pumpLoop(1);
  if (events.some((event) => event.type === "error" && event.soundId === "rain")) {
    print(JSON.stringify(events));
    fail("File branch emitted an error");
  }

  let baseIndex = events.length;
  mixer.sync([{ id: "short", type: "file", path: shortPath }], stateWith({ short: 0.2 }));
  syncSink();
  let previousPipeline = mixer.pipeline;
  if (!waitUntil(() => events.slice(baseIndex).some((event) => event.type === "pipeline-ready"), 15)) {
    fail("Single file did not recover after end of stream");
  }
  assertRecovered("single file", baseIndex, previousPipeline, "short");

  // The audiomixer only posts EOS when every input has ended, so a finite file
  // inside a mixed topology must be recycled from its own branch.
  baseIndex = events.length;
  mixer.sync([
    { id: "rain", type: "file", path: rainPath },
    { id: "short", type: "file", path: shortPath },
  ], stateWith({ rain: 0.2, short: 0.2 }));
  syncSink();
  previousPipeline = mixer.pipeline;
  let busEos = 0;
  mixer.bus.connect("message", (_bus, message) => {
    if (message.type === Gst.MessageType.EOS) busEos += 1;
  });
  if (!waitUntil(() => events.slice(baseIndex).some((event) => event.type === "pipeline-ready"), 15)) {
    fail("Mixed files did not recycle the ended branch");
  }
  if (busEos !== 0) fail(`Mixed files reported pipeline EOS while rain was still playing: ${busEos}`);
  assertRecovered("mixed files", baseIndex, previousPipeline, "short");

  // The same applies when a live noise source never ends.
  baseIndex = events.length;
  mixer.sync([
    { id: "pink-noise", type: "noise", wave: "pink-noise" },
    { id: "short", type: "file", path: shortPath },
  ], stateWith({ "pink-noise": 0.2, short: 0.2 }));
  syncSink();
  previousPipeline = mixer.pipeline;
  if (!waitUntil(() => events.slice(baseIndex).some((event) => event.type === "pipeline-ready"), 15)) {
    fail("File plus live noise did not recycle the ended branch");
  }
  assertRecovered("file plus live noise", baseIndex, previousPipeline, "short");
} finally {
  mixer.stop();
  GLib.unlink(shortPath);
  GLib.rmdir(tempDirectory);
}

print("Mixer tests passed.");
