import GLib from "gi://GLib";
import Gst from "gi://Gst";

const AUDIO_CAPS_TEXT = "audio/x-raw,format=S16LE,rate=44100,channels=2,layout=interleaved";
const NOISE_WAVE_ENUM = { "white-noise": 5, "pink-noise": 6 };

function make(factory, name = null) {
  const element = Gst.ElementFactory.make(factory, name);
  if (!element) throw new Error(`Could not create GStreamer element: ${factory}`);
  return element;
}

function makeAudioSink() {
  const requested = GLib.getenv("RELAXY_AUDIO_SINK");
  const candidates = requested ? [requested] : ["pipewiresink", "autoaudiosink", "pulsesink", "alsasink"];
  for (const candidate of candidates) {
    if (Gst.ElementFactory.find(candidate)) return make(candidate, "output");
  }
  throw new Error(`Could not find a GStreamer audio sink (tried: ${candidates.join(", ")})`);
}

function uriForPath(path) {
  return GLib.filename_to_uri(path, null);
}

export class AmbientMixer {
  constructor(onEvent = () => {}) {
    Gst.init(null);
    this.audioCaps = Gst.Caps.from_string(AUDIO_CAPS_TEXT);
    this.onEvent = onEvent;
    this.pipeline = Gst.Pipeline.new("relaxy");
    this.mixer = make("audiomixer", "mixer");
    this.convert = make("audioconvert");
    this.resample = make("audioresample");
    this.master = make("volume", "master-volume");
    this.sink = makeAudioSink();
    this.pipeline.add(this.mixer);
    this.pipeline.add(this.convert);
    this.pipeline.add(this.resample);
    this.pipeline.add(this.master);
    this.pipeline.add(this.sink);
    if (!this.mixer.link(this.convert) || !this.convert.link(this.resample) || !this.resample.link(this.master) || !this.master.link(this.sink)) {
      throw new Error("Could not link the main audio pipeline");
    }
    this.branches = new Map();
    this.masterVolume = 1;
    this.playing = false;
    this.bus = this.pipeline.get_bus();
    this.bus.add_signal_watch();
    this.bus.connect("message", (_bus, message) => this.handleMessage(message));
  }

  handleMessage(message) {
    if (message.type === Gst.MessageType.ERROR) {
      const [, error, debug] = message.parse_error();
      const branch = [...this.branches.values()].find((item) => this.isOwnedBy(message.src, item.bin));
      this.onEvent({ type: "error", soundId: branch?.id || null, message: error.message, debug: debug || "" });
      if (branch) this.removeSound(branch.id);
    }
  }

  isOwnedBy(element, owner) {
    let current = element;
    while (current) {
      if (current === owner) return true;
      current = current.get_parent();
    }
    return false;
  }

  createBranch(spec) {
    const bin = Gst.Bin.new(`sound-${spec.id}`);
    const convert = make("audioconvert");
    const resample = make("audioresample");
    const caps = make("capsfilter");
    const volume = make("volume");
    caps.set_property("caps", this.audioCaps);
    for (const element of [convert, resample, caps, volume]) bin.add(element);
    if (!convert.link(resample) || !resample.link(caps) || !caps.link(volume)) throw new Error(`Could not link sound ${spec.id}`);

    if (spec.type === "noise") {
      const source = make("audiotestsrc");
      source.set_property("is-live", true);
      source.set_property("wave", NOISE_WAVE_ENUM[spec.wave] ?? NOISE_WAVE_ENUM["white-noise"]);
      bin.add(source);
      if (!source.link(convert)) throw new Error(`Could not link noise ${spec.id}`);
    } else {
      const decoder = make("uridecodebin");
      decoder.set_property("uri", uriForPath(spec.path));
      decoder.connect("pad-added", (_decoder, pad) => {
        const capsOnPad = pad.get_current_caps() || pad.query_caps(null);
        const structure = capsOnPad?.get_structure(0);
        const name = structure?.get_name() || "";
        if (name.startsWith("audio/")) pad.link(convert.get_static_pad("sink"));
      });
      bin.add(decoder);
      decoder.connect("pad-added", (_decoder, pad) => {
        pad.add_probe(Gst.PadProbeType.EVENT_DOWNSTREAM, (_pad, info) => {
          const event = info.get_event();
          if (event.type === Gst.EventType.EOS || event.type === Gst.EventType.SEGMENT_DONE) {
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
              if (this.branches.has(spec.id)) decoder.seek_simple(Gst.Format.TIME, Gst.SeekFlags.FLUSH | Gst.SeekFlags.KEY_UNIT, 0);
              return GLib.SOURCE_REMOVE;
            });
            return Gst.PadProbeReturn.DROP;
          }
          return Gst.PadProbeReturn.OK;
        });
      });
    }

    const sourcePad = volume.get_static_pad("src");
    bin.add_pad(Gst.GhostPad.new("src", sourcePad));
    return { bin, volume };
  }

  addSound(spec, level) {
    if (this.branches.has(spec.id)) {
      this.branches.get(spec.id).volume.set_property("volume", level);
      return;
    }
    try {
      const branch = this.createBranch(spec);
      this.pipeline.add(branch.bin);
      const mixerPad = this.mixer.get_request_pad("sink_%u");
      const sourcePad = branch.bin.get_static_pad("src");
      if (!mixerPad || !sourcePad || sourcePad.link(mixerPad) !== Gst.PadLinkReturn.OK) throw new Error(`Could not attach sound ${spec.id}`);
      branch.bin.set_state(this.playing ? Gst.State.PLAYING : Gst.State.PAUSED);
      branch.volume.set_property("volume", level);
      this.branches.set(spec.id, { id: spec.id, bin: branch.bin, volume: branch.volume, mixerPad });
      this.syncPipeline();
      this.onEvent({ type: "sound-ready", soundId: spec.id });
    } catch (error) {
      this.onEvent({ type: "error", soundId: spec.id, message: error.message, debug: "" });
    }
  }

  removeSound(soundId) {
    const branch = this.branches.get(soundId);
    if (!branch) return;
    branch.bin.set_state(Gst.State.NULL);
    const sourcePad = branch.bin.get_static_pad("src");
    if (sourcePad && branch.mixerPad) sourcePad.unlink(branch.mixerPad);
    if (branch.mixerPad) this.mixer.release_request_pad(branch.mixerPad);
    this.pipeline.remove(branch.bin);
    this.branches.delete(soundId);
    this.syncPipeline();
  }

  sync(specs, state) {
    this.masterVolume = Math.max(0, Math.min(1, Number(state.masterVolume) || 0));
    this.master.set_property("volume", this.masterVolume);
    const preset = state.presets.find((item) => item.id === state.activePresetId) || state.presets[0];
    const desired = new Map();
    for (const spec of specs) {
      const level = Math.max(0, Math.min(1, Number(preset.volumes[spec.id]) || 0));
      const muted = preset.mutes[spec.id] !== false;
      if (!muted && level > 0) desired.set(spec.id, { spec, level });
    }
    for (const id of this.branches.keys()) if (!desired.has(id)) this.removeSound(id);
    for (const { spec, level } of desired.values()) this.addSound(spec, level);
    this.playing = Boolean(state.playing);
    this.syncPipeline();
  }

  syncPipeline() {
    const target = this.branches.size === 0 ? Gst.State.NULL : (this.playing ? Gst.State.PLAYING : Gst.State.PAUSED);
    this.pipeline.set_state(target);
  }

  setPlaying(playing) {
    this.playing = Boolean(playing);
    this.syncPipeline();
  }

  stop() {
    for (const id of [...this.branches.keys()]) this.removeSound(id);
    this.pipeline.set_state(Gst.State.NULL);
    this.bus.remove_signal_watch();
  }
}
