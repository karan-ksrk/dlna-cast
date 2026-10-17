import { EventEmitter } from "node:events";
import path from "node:path";
import { castFile, castScreen } from "./cast.mjs";
import { avTransport, parseTime, renderingControl } from "./soap.mjs";

const clampVolume = (level) => Math.round(Math.min(100, Math.max(0, level)));

/** Reads a renderer's state without a cast session: transport state, position and volume. */
export async function readDeviceStatus(device) {
  const transport = avTransport(device);
  const rendering = renderingControl(device);
  const [info, position, volume, muted] = await Promise.all([
    transport.transportInfo(),
    transport.positionInfo().catch(() => ({})),
    rendering.supported ? rendering.getVolume().catch(() => null) : null,
    rendering.supported ? rendering.getMute().catch(() => null) : null,
  ]);
  return {
    state: info.CurrentTransportState ?? "UNKNOWN",
    position: parseTime(position.RelTime),
    duration: parseTime(position.TrackDuration),
    uri: position.TrackURI || null,
    volume: Number.isFinite(volume) ? volume : null,
    muted,
  };
}

/** Pauses and confirms: some renderers answer 200 to Pause and keep playing. */
export async function pauseAndConfirm(device) {
  const transport = avTransport(device);
  // Renderers that are stopped either refuse Pause (UPnP 701, transition not available) or accept and ignore it.
  const refusal = await transport.pause().then(() => null, (error) => error);
  if (refusal && refusal.code !== 701) throw refusal;
  const { CurrentTransportState: state } = await transport.transportInfo().catch(() => ({}));
  if (refusal && state !== "STOPPED" && state !== "NO_MEDIA_PRESENT") throw refusal;
  if (state === "PLAYING") throw new IgnoredCommandError(`${device.friendlyName} accepted Pause but kept playing`);
  if (state === "STOPPED" || state === "NO_MEDIA_PRESENT") {
    throw new IgnoredCommandError(`Nothing is playing on ${device.friendlyName}, so there's nothing to pause`);
  }
  return state ?? "PAUSED_PLAYBACK";
}

export class IgnoredCommandError extends Error {}

/**
 * Sets the volume and reads it back. Some renderers (the Platinum-based goggles among them) answer SetVolume
 * with 200 and change nothing; that is reported instead of pretending it worked.
 */
export async function setVolumeAndConfirm(device, level) {
  const rendering = renderingControl(device);
  const requested = clampVolume(level);
  await rendering.setVolume(requested);
  const reported = await rendering.getVolume().catch(() => null);
  if (Number.isFinite(reported) && Math.abs(reported - requested) > 1) {
    throw new IgnoredCommandError(
      `${device.friendlyName} accepted the volume change but still reports ${reported}; it doesn't support remote volume. Use the device's own buttons.`,
    );
  }
  return Number.isFinite(reported) ? reported : requested;
}

export async function setMuteAndConfirm(device, muted) {
  const rendering = renderingControl(device);
  await rendering.setMute(muted);
  const reported = await rendering.getMute().catch(() => null);
  if (reported !== null && reported !== muted) {
    throw new IgnoredCommandError(
      `${device.friendlyName} accepted ${muted ? "mute" : "unmute"} but didn't change; it doesn't support remote mute. Use the device's own buttons.`,
    );
  }
  return muted;
}

/**
 * One cast in progress: polls the renderer, exposes pause/resume/seek/volume/mute/stop, and ends itself when
 * the renderer stops playback, stops answering, or the screen capture dies.
 * Events: "status" (snapshot), "ended" ({ reason, error, detail }).
 */
export class CastSession extends EventEmitter {
  #close;
  #timer = null;
  #busy = false;
  #failures = 0;
  #stoppedPolls = 0;
  #sawPlaying = false;
  #ended = false;

  constructor({ device, kind, title, media, transport, stream = null, close, details = {} }) {
    super();
    this.device = device;
    this.kind = kind;
    this.title = title;
    this.media = media;
    this.transport = transport;
    this.stream = stream;
    this.details = details;
    this.rendering = renderingControl(device);
    this.volumeIgnored = false;
    this.startedAt = Date.now();
    this.status = { state: "TRANSITIONING", position: null, duration: null, volume: null, muted: null };
    this.#close = close;
    stream?.events.once("exit", ({ code, tail }) => {
      this.transport.stop().catch(() => {});
      this.#end({ reason: "capture-stopped", error: `Screen capture stopped (ffmpeg exit ${code})`, detail: tail });
    });
  }

  static async startFile(device, filePath, options = {}) {
    const { media, transport } = await castFile(device, filePath, options);
    return new CastSession({
      device,
      kind: "file",
      title: options.title ?? path.parse(filePath).name,
      media,
      transport,
      close: media.close,
      details: { filePath, mimeType: media.mimeType, size: media.size },
    });
  }

  static async startScreen(device, options) {
    const session = await castScreen(device, options);
    return new CastSession({
      device,
      kind: "screen",
      title: options.title ?? (options.capture === "testsrc" ? "Test pattern" : "Desktop"),
      media: session.media,
      transport: session.transport,
      stream: session.stream,
      close: session.close,
      details: {
        capture: session.capture,
        encoder: session.encoder,
        systemAudio: session.systemAudio,
        fps: options.fps ?? 30,
        bitrateKbps: options.bitrateKbps ?? 6000,
      },
    });
  }

  get live() {
    return this.kind === "screen";
  }

  get ended() {
    return this.#ended;
  }

  get bytesSent() {
    return this.live ? this.stream.broadcast.bytesSent : this.media.stats.bytesServed;
  }

  snapshot() {
    return {
      kind: this.kind,
      title: this.title,
      live: this.live,
      device: { udn: this.device.udn, friendlyName: this.device.friendlyName, host: this.device.host },
      ...this.status,
      volumeSupported: this.rendering.supported && !this.volumeIgnored,
      volumeIgnored: Boolean(this.volumeIgnored),
      seekable: !this.live,
      startedAt: this.startedAt,
      elapsed: (Date.now() - this.startedAt) / 1000,
      bytesSent: this.bytesSent,
      ended: this.#ended,
      details: this.details,
    };
  }

  start(intervalMs = 1000) {
    this.#refreshVolume();
    this.#timer = setInterval(() => this.refresh(), intervalMs);
    this.refresh();
    return this;
  }

  async refresh() {
    if (this.#busy || this.#ended) return;
    this.#busy = true;
    try {
      const [info, position] = await Promise.all([
        this.transport.transportInfo(),
        this.transport.positionInfo().catch(() => ({})),
      ]);
      this.#failures = 0;
      const state = info.CurrentTransportState ?? "UNKNOWN";
      if (state === "PLAYING") this.#sawPlaying = true;
      this.#stoppedPolls = state === "STOPPED" || state === "NO_MEDIA_PRESENT" ? this.#stoppedPolls + 1 : 0;
      Object.assign(this.status, {
        state,
        // Renderers report 0 for live streams; elapsed time stands in for position there.
        position: this.live ? null : parseTime(position.RelTime),
        duration: this.live ? null : parseTime(position.TrackDuration),
      });
      this.#emitStatus();
      // Two polls in a row, so a renderer that blips through STOPPED during a seek isn't taken as finished.
      if (this.#sawPlaying && this.#stoppedPolls >= 2) await this.#end({ reason: "renderer-stopped" });
    } catch (error) {
      if (++this.#failures >= 5) {
        await this.#end({ reason: "renderer-lost", error: `Lost contact with ${this.device.friendlyName}: ${error.message}` });
      }
    } finally {
      this.#busy = false;
    }
  }

  async pause() {
    this.status.state = await pauseAndConfirm(this.device);
    this.#emitStatus();
  }

  async resume() {
    await this.transport.play();
    this.status.state = "PLAYING";
    this.#emitStatus();
  }

  togglePause() {
    return this.status.state === "PLAYING" ? this.pause() : this.resume();
  }

  async seek(seconds, { relative = false } = {}) {
    if (this.live) throw new Error("A live screen stream can't be seeked");
    let target = seconds;
    if (relative) {
      const reported = parseTime((await this.transport.positionInfo()).RelTime);
      target = (reported ?? this.status.position ?? 0) + seconds;
    }
    const { duration } = this.status;
    target = Math.max(0, duration ? Math.min(target, duration - 1) : target);
    await this.transport.seek(target);
    this.status.position = target;
    this.#emitStatus();
    return target;
  }

  #requireVolume() {
    if (!this.rendering.supported) throw new Error(`${this.device.friendlyName} doesn't offer volume control`);
    if (this.volumeIgnored) throw new Error(`${this.device.friendlyName} ignores remote volume and mute; use the device's own buttons`);
  }

  // A renderer that ignored one volume or mute command ignores the rest; stop offering them for this cast.
  async #confirmed(command) {
    try {
      return await command();
    } catch (error) {
      if (error instanceof IgnoredCommandError) {
        this.volumeIgnored = true;
        await this.#refreshVolume();
      }
      throw error;
    }
  }

  async setVolume(level) {
    this.#requireVolume();
    const volume = await this.#confirmed(() => setVolumeAndConfirm(this.device, level));
    this.status.volume = volume;
    this.#emitStatus();
    return volume;
  }

  async changeVolume(delta) {
    this.#requireVolume();
    const current = this.status.volume ?? (await this.rendering.getVolume());
    return this.setVolume(current + delta);
  }

  async setMute(muted) {
    this.#requireVolume();
    await this.#confirmed(() => setMuteAndConfirm(this.device, muted));
    this.status.muted = muted;
    this.#emitStatus();
    return muted;
  }

  toggleMute() {
    return this.setMute(!this.status.muted);
  }

  async stop() {
    if (this.#ended) return;
    await this.transport.stop().catch(() => {});
    await this.#end({ reason: "stopped" });
  }

  async #refreshVolume() {
    if (!this.rendering.supported) return;
    const [volume, muted] = await Promise.all([
      this.rendering.getVolume().catch(() => null),
      this.rendering.getMute().catch(() => null),
    ]);
    if (Number.isFinite(volume)) this.status.volume = volume;
    if (muted !== null) this.status.muted = muted;
    this.#emitStatus();
  }

  #emitStatus() {
    if (!this.#ended) this.emit("status", this.snapshot());
  }

  async #end({ reason, error = null, detail = null }) {
    if (this.#ended) return;
    this.#ended = true;
    clearInterval(this.#timer);
    this.status.state = "STOPPED";
    await this.#close().catch(() => {});
    this.emit("ended", { reason, error, detail });
  }
}
