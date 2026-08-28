import GLib from "gi://GLib";
import Gst from "gi://Gst";

const AUDIO_CAPS_TEXT = "audio/x-raw,format=S16LE,rate=44100,channels=2,layout=interleaved";
const NOISE_WAVE_ENUM = { "white-noise": 5, "pink-noise": 6 };

function selectAudioSink() {
  const requested = GLib.getenv("RELAXY_AUDIO_SINK");
  const candidates = requested ? [requested] : ["pipewiresink", "autoaudiosink", "pulsesink", "alsasink"];
  for (const candidate of candidates) {
    if (Gst.ElementFactory.find(candidate)) return candidate;
  }
  throw new Error(`Could not find a GStreamer audio sink (tried: ${candidates.join(", ")})`);
}

function launchString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function branchElementName(prefix, soundId) {
  return `${prefix}-${String(soundId).replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

export class AmbientMixer {
  constructor(onEvent = () => {}) {
    Gst.init(null);
    this.onEvent = onEvent;
    this.audioSinkFactory = selectAudioSink();
    this.pipeline = null;
    this.mixer = null;
    this.master = null;
    this.sink = null;
    this.bus = null;
    this.branches = new Map();
    this.failedSounds = new Set();
    this.topologyKey = "";
    this.lastSpecs = [];
    this.lastState = { playing: false, masterVolume: 1, presets: [{ volumes: {}, mutes: {} }] };
    this.masterVolume = 1;
    this.playing = false;
  }

  errorMessage(error) {
    return error?.message || String(error);
  }

  isOwnedBy(element, owner) {
    let current = element;
    while (current) {
      if (current === owner) return true;
      current = current.get_parent();
    }
    return false;
  }

  handleMessage(message) {
    if (message.type === Gst.MessageType.ERROR) {
      const [, error, debug] = message.parse_error();
      const branch = [...this.branches.values()].find((item) => this.isOwnedBy(message.src, item.source || item.volume));
      const event = {
        type: "error",
        soundId: branch?.id || null,
        message: this.errorMessage(error),
        debug: debug || "",
      };
      this.onEvent(event);
      if (branch) {
        this.failedSounds.add(branch.id);
        this.rebuildPipeline();
      }
    } else if (message.type === Gst.MessageType.ASYNC_DONE) {
      // Dynamic file decoders can finish linking after the initial properties
      // are applied. Reapply levels once the pipeline has completed preroll.
      this.applyVolumes();
    } else if (message.type === Gst.MessageType.EOS) {
      let replayed = false;
      for (const branch of this.branches.values()) {
        if (!branch.source) continue;
        try {
          replayed = branch.source.seek_simple(
            Gst.Format.TIME,
            Gst.SeekFlags.FLUSH | Gst.SeekFlags.KEY_UNIT,
            0,
          ) || replayed;
        } catch (error) {
          this.onEvent({ type: "error", soundId: branch.id, message: this.errorMessage(error), debug: "" });
        }
      }
      if (replayed) this.syncPipeline();
    }
  }

  applyVolumes() {
    if (!this.pipeline) return;
    this.master.set_property("volume", this.masterVolume);
    for (const branch of this.branches.values()) {
      branch.volume.set_property("volume", this.levelFor(branch.spec));
    }
  }

  branchDescription(spec) {
    const volumeName = branchElementName("volume", spec.id);
    if (spec.type === "noise") {
      const wave = NOISE_WAVE_ENUM[spec.wave] ?? NOISE_WAVE_ENUM["white-noise"];
      return `audiotestsrc is-live=true wave=${wave} ! audioconvert ! audioresample ! capsfilter caps=${AUDIO_CAPS_TEXT} ! volume name=${volumeName} ! mixer.`;
    }
    const sourceName = branchElementName("source", spec.id);
    const uri = launchString(GLib.filename_to_uri(spec.path, null));
    return `uridecodebin name=${sourceName} uri="${uri}" ! audioconvert ! audioresample ! capsfilter caps=${AUDIO_CAPS_TEXT} ! volume name=${volumeName} ! mixer.`;
  }

  pipelineDescription(specs) {
    const output = [
      "audiomixer name=mixer",
      "! audioconvert",
      "! audioresample",
      "! volume name=master-volume",
      `! ${this.audioSinkFactory} name=output`,
    ].join(" ");
    return [output, ...specs.map((spec) => this.branchDescription(spec))].join(" ");
  }

  topologyFor(specs) {
    return JSON.stringify(specs.map((spec) => ({
      id: spec.id,
      type: spec.type,
      path: spec.path || "",
      wave: spec.wave || "",
    })));
  }

  disposePipeline() {
    if (!this.pipeline) return;
    if (this.bus) this.bus.remove_signal_watch();
    this.pipeline.set_state(Gst.State.NULL);
    this.pipeline = null;
    this.mixer = null;
    this.master = null;
    this.sink = null;
    this.bus = null;
    this.branches = new Map();
  }

  installPipeline(specs) {
    this.disposePipeline();
    if (specs.length === 0) {
      this.topologyKey = this.topologyFor(specs);
      return;
    }

    const pipeline = Gst.parse_launch(this.pipelineDescription(specs));
    if (!pipeline) throw new Error("Could not create the Relaxy audio pipeline");
    const mixer = pipeline.get_by_name("mixer");
    const master = pipeline.get_by_name("master-volume");
    const sink = pipeline.get_by_name("output");
    if (!mixer || !master || !sink) throw new Error("Could not inspect the Relaxy audio pipeline");

    this.pipeline = pipeline;
    this.mixer = mixer;
    this.master = master;
    this.sink = sink;
    this.bus = pipeline.get_bus();
    this.bus.add_signal_watch();
    this.bus.connect("message", (_bus, message) => this.handleMessage(message));
    this.topologyKey = this.topologyFor(specs);

    for (const spec of specs) {
      const volume = pipeline.get_by_name(branchElementName("volume", spec.id));
      if (!volume) throw new Error(`Could not inspect the ${spec.id} volume control`);
      const source = spec.type === "noise" ? null : pipeline.get_by_name(branchElementName("source", spec.id));
      this.branches.set(spec.id, { id: spec.id, spec, volume, source });
    }
    this.applyVolumes();
    this.syncPipeline();
  }

  levelFor(spec) {
    const preset = this.lastState.presets.find((item) => item.id === this.lastState.activePresetId) || this.lastState.presets[0];
    return Math.max(0, Math.min(1, Number(preset?.volumes?.[spec.id]) || 0));
  }

  rebuildPipeline() {
    const specs = this.lastSpecs.filter((spec) => !this.failedSounds.has(spec.id));
    try {
      this.installPipeline(specs);
      this.onEvent({ type: "pipeline-ready" });
    } catch (error) {
      this.onEvent({ type: "error", soundId: null, message: this.errorMessage(error), debug: "" });
    }
  }

  sync(specs, state) {
    this.lastSpecs = specs;
    this.lastState = state;
    this.masterVolume = Math.max(0, Math.min(1, Number(state.masterVolume) || 0));
    this.playing = Boolean(state.playing);

    const availableIds = new Set(specs.map((spec) => spec.id));
    for (const id of this.failedSounds) if (!availableIds.has(id)) this.failedSounds.delete(id);

    const preset = state.presets.find((item) => item.id === state.activePresetId) || state.presets[0];
    const desired = [];
    for (const spec of specs) {
      const level = Math.max(0, Math.min(1, Number(preset.volumes[spec.id]) || 0));
      const muted = preset.mutes[spec.id] !== false;
      if (!muted && level > 0 && !this.failedSounds.has(spec.id)) desired.push(spec);
    }

    const nextTopologyKey = this.topologyFor(desired);
    if (nextTopologyKey !== this.topologyKey) {
      try {
        this.installPipeline(desired);
      } catch (error) {
        this.onEvent({ type: "error", soundId: null, message: this.errorMessage(error), debug: "" });
      }
    } else if (this.pipeline) {
      this.applyVolumes();
    }
    this.syncPipeline();
  }

  syncPipeline() {
    if (!this.pipeline) return;
    const target = this.branches.size === 0 ? Gst.State.NULL : (this.playing ? Gst.State.PLAYING : Gst.State.PAUSED);
    this.pipeline.set_state(target);
  }

  stop() {
    this.disposePipeline();
    this.topologyKey = "";
  }
}
