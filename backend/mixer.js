import GLib from "gi://GLib";
import Gst from "gi://Gst";

const AUDIO_CAPS_TEXT = "audio/x-raw,format=S16LE,rate=44100,channels=2,layout=interleaved";
const NOISE_WAVE_ENUM = { "white-noise": 5, "pink-noise": 6 };
const END_WATCH_INTERVAL_MS = 250;
const END_WATCH_TOLERANCE = Gst.SECOND / 10;
const END_WATCH_STALL_TICKS = 3;

function selectAudioSink() {
  const requested = GLib.getenv("RELAXY_AUDIO_SINK");
  const candidates = requested ? [requested] : ["pipewiresink", "autoaudiosink", "pulsesink", "alsasink"];
  for (const candidate of candidates) {
    // The override flows into a Gst.parse_launch() description, so it must be
    // a bare element name and nothing that parses as pipeline syntax.
    if (!/^[A-Za-z0-9_-]+$/.test(candidate)) throw new Error(`Invalid GStreamer element name: ${candidate}`);
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
    this.activeSpecs = [];
    this.eosRecoverySource = 0;
    this.errorRecoverySource = 0;
    this.endWatchSource = 0;
    this.branchProgress = new Map();
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
        this.scheduleErrorRecovery();
      }
    } else if (message.type === Gst.MessageType.ASYNC_DONE) {
      // Dynamic file decoders can finish linking after the initial properties
      // are applied. Reapply levels once the pipeline has completed preroll.
      this.applyVolumes();
    } else if (message.type === Gst.MessageType.EOS) {
      // Defer recovery out of the bus callback. State changes and pipeline
      // teardown can wait for streaming work that is still handling EOS.
      this.scheduleEosRecovery();
    }
  }

  scheduleEosRecovery() {
    if (this.eosRecoverySource || !this.pipeline) return;
    const eosPipeline = this.pipeline;
    this.eosRecoverySource = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this.eosRecoverySource = 0;
      if (this.pipeline !== eosPipeline || this.activeSpecs.length === 0) return GLib.SOURCE_REMOVE;
      try {
        // Rebuilding the active topology is reliable for both file-only mixes
        // and mixes that also contain live noise sources. Sounds that already
        // failed are excluded so recovery does not retry them on its own.
        const specs = this.activeSpecs.filter((spec) => !this.failedSounds.has(spec.id));
        this.installPipeline(specs);
        this.onEvent({ type: "pipeline-ready" });
      } catch (error) {
        this.onEvent({ type: "error", soundId: null, message: this.errorMessage(error), debug: "" });
      }
      return GLib.SOURCE_REMOVE;
    });
  }

  scheduleErrorRecovery() {
    if (this.errorRecoverySource || !this.pipeline) return;
    const errorPipeline = this.pipeline;
    this.errorRecoverySource = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this.errorRecoverySource = 0;
      if (this.pipeline !== errorPipeline) return GLib.SOURCE_REMOVE;
      // Deferred out of the bus callback for the same reason as EOS recovery:
      // rebuilding waits for streaming work and can stall a PipeWire sink.
      this.rebuildPipeline();
      return GLib.SOURCE_REMOVE;
    });
  }

  clearFailure(soundId) {
    this.failedSounds.delete(soundId);
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
    if (this.eosRecoverySource) {
      GLib.source_remove(this.eosRecoverySource);
      this.eosRecoverySource = 0;
    }
    if (this.errorRecoverySource) {
      GLib.source_remove(this.errorRecoverySource);
      this.errorRecoverySource = 0;
    }
    this.stopEndWatch();
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
    this.startEndWatch();
    this.applyVolumes();
    this.syncPipeline();
  }

  startEndWatch() {
    if (this.endWatchSource) return;
    this.branchProgress = new Map();
    this.endWatchSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, END_WATCH_INTERVAL_MS, () => this.checkBranchEnds());
  }

  stopEndWatch() {
    if (this.endWatchSource) {
      GLib.source_remove(this.endWatchSource);
      this.endWatchSource = 0;
    }
    this.branchProgress = new Map();
  }

  // The audiomixer only forwards end of stream when every input has ended, so
  // finite files inside a mix are detected here instead of relying on a
  // pipeline-level EOS message. Probes cannot be used: GJS callbacks are not
  // safe to run from the streaming thread.
  checkBranchEnds() {
    if (!this.pipeline || !this.playing) {
      this.branchProgress.clear();
      return GLib.SOURCE_CONTINUE;
    }
    for (const branch of this.branches.values()) {
      if (!branch.source) continue;
      const positionQuery = Gst.Query.new_position(Gst.Format.TIME);
      if (!branch.source.query(positionQuery)) continue;
      const [, position] = positionQuery.parse_position();
      if (position <= 0) continue;
      const durationQuery = Gst.Query.new_duration(Gst.Format.TIME);
      const duration = branch.source.query(durationQuery) ? durationQuery.parse_duration()[1] : -1;
      const progress = this.branchProgress.get(branch.id) || { position: -1, stalled: 0 };
      progress.stalled = position === progress.position ? progress.stalled + 1 : 0;
      progress.position = position;
      this.branchProgress.set(branch.id, progress);
      const ended = duration > 0 && position >= duration - END_WATCH_TOLERANCE;
      if (ended || progress.stalled >= END_WATCH_STALL_TICKS) {
        this.scheduleEosRecovery();
        return GLib.SOURCE_CONTINUE;
      }
    }
    return GLib.SOURCE_CONTINUE;
  }

  levelFor(spec) {
    const preset = this.lastState.presets.find((item) => item.id === this.lastState.activePresetId) || this.lastState.presets[0];
    return Math.max(0, Math.min(1, Number(preset?.volumes?.[spec.id]) || 0));
  }

  rebuildPipeline() {
    const specs = this.activeSpecs.filter((spec) => !this.failedSounds.has(spec.id));
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
    this.activeSpecs = desired;

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
    this.activeSpecs = [];
    this.topologyKey = "";
  }
}
