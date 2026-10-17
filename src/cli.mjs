#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { lookup } from "node:dns/promises";
import { discoverRenderers, probeDevice } from "./ssdp.mjs";
import { fetchDescription } from "./description.mjs";
import { avTransport, formatTime, parseSeekInput, parseTime, renderingControl } from "./soap.mjs";
import {
  CastSession,
  IgnoredCommandError,
  pauseAndConfirm,
  readDeviceStatus,
  setMuteAndConfirm,
  setVolumeAndConfirm,
} from "./session.mjs";
import { ENCODERS, findFfmpeg, listAudioDevices } from "./ffmpeg.mjs";
import { addRecentFile, loadLastDevice, saveLastDevice } from "./device-store.mjs";

const HELP = `dlna-cast — cast a file or your screen to a DLNA renderer

Casting:
  dlna-cast play <file> [device options] [--port n] [--title text]
  dlna-cast screen [device options] [screen options]
  dlna-cast gui [--port n] [--no-open] [--log file]   Open the desktop app

  While casting: Space pause/resume, Left/Right seek 10 s, Up/Down volume, M mute, Q stop

Controlling a renderer (works from another terminal too):
  dlna-cast pause | resume | stop | status
  dlna-cast seek <time>          90, 1:30, 0:01:30, or relative +30 / -10
  dlna-cast volume [level]       0-100, or +5 / -5; no level prints the volume
  dlna-cast mute | unmute

Finding renderers:
  dlna-cast discover [--timeout ms] [--json]
  dlna-cast audio-devices

Device options:
  --device, -d <n|name|ip|udn>  Pick a renderer (otherwise: last used, else the only one found, else ask)
  --rescan                      Ignore the remembered renderer and search again
  --ip <host[:httpPort]>        Talk to one device directly
  --location <url>              Use a known device description URL
  --timeout <ms>                How long to search (default 15000; 10000 for discover)

Screen options:
  --monitor <n>          Monitor index, 0 = primary (default 0)
  --fps <n>              Frames per second (default 30)
  --bitrate <kbps>       Video bitrate (default 6000)
  --max-height <px>      Downscale above this height (default 1080)
  --encoder <name>       auto | nvenc | qsv | amf | x264 | openh264 (default auto: GPU first)
  --capture <method>     auto | ddagrab | gdigrab | testsrc (testsrc sends a test pattern)
  --audio <source>       system (what the PC is playing, default) | none | <DirectShow device name>
  --no-mouse             Hide the mouse pointer
  --ffmpeg <path>        ffmpeg executable (default: PATH, or a portable build in .tools)`;

class CliError extends Error {}

const OPTIONS = {
  device: { type: "string", short: "d" },
  rescan: { type: "boolean" },
  ip: { type: "string" },
  location: { type: "string" },
  port: { type: "string", short: "p" },
  timeout: { type: "string", short: "t" },
  title: { type: "string" },
  json: { type: "boolean" },
  monitor: { type: "string" },
  fps: { type: "string" },
  bitrate: { type: "string" },
  "max-height": { type: "string" },
  encoder: { type: "string" },
  capture: { type: "string" },
  audio: { type: "string" },
  "no-mouse": { type: "boolean" },
  "no-open": { type: "boolean" },
  log: { type: "string" },
  ffmpeg: { type: "string" },
};

function numberOption(values, name, fallback, { min = 0 } = {}) {
  if (values[name] === undefined) return fallback;
  const value = Number(values[name]);
  if (!Number.isFinite(value) || value < min) throw new CliError(`--${name} must be a number ≥ ${min}`);
  return value;
}

function describe(device) {
  const model = [device.manufacturer, device.modelName].filter(Boolean).join(" ");
  return `${device.friendlyName}${model ? ` — ${model}` : ""} (${device.host})`;
}

const formatDevices = (devices) => devices.map((d, i) => `  ${i + 1}. ${describe(d)}`).join("\n");

function matchDevice(devices, selector) {
  const index = Number(selector);
  return (
    (Number.isInteger(index) && index >= 1 && index <= devices.length ? devices[index - 1] : null) ??
    devices.find((d) => d.udn === selector || d.host === selector) ??
    devices.find((d) => d.friendlyName.toLowerCase().includes(selector.toLowerCase()))
  );
}

async function askForDevice(devices) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await prompt.question(`Choose a renderer [1-${devices.length}]: `)).trim();
      const device = answer && matchDevice(devices, answer);
      if (device) return device;
    }
  } finally {
    prompt.close();
  }
}

/** --location, --ip, the remembered device, or a live search; then --device, the only result, or a prompt. */
async function resolveDevice(values, { quiet = false } = {}) {
  const say = (message) => !quiet && console.log(message);
  if (values.location) {
    try {
      return await fetchDescription(values.location);
    } catch (error) {
      throw new CliError(`Couldn't read the device description at ${values.location}: ${error.message}`);
    }
  }

  const timeoutMs = numberOption(values, "timeout", 15000, { min: 500 });
  if (values.ip) {
    const [host, httpPort] = values.ip.split(":");
    let address;
    try {
      ({ address } = await lookup(host, { family: 4 }));
    } catch {
      throw new CliError(`Couldn't resolve "${host}".`);
    }
    say(`Looking for a renderer at ${address}…`);
    const [device] = await probeDevice(address, { httpPort: httpPort ? Number(httpPort) : null, timeoutMs });
    if (!device) {
      throw new CliError(
        `No DLNA renderer answered at ${address} within ${timeoutMs / 1000}s. Check the IP in the device's network ` +
          "settings, or run without --ip to search automatically.",
      );
    }
    return device;
  }

  if (!values.device && !values.rescan) {
    const last = loadLastDevice();
    if (last) {
      try {
        const device = await fetchDescription(last.location, { timeoutMs: 2000 });
        if (device.avTransport && (!last.udn || device.udn === last.udn)) {
          say(`Using ${describe(device)} from last time (--rescan to search again).`);
          return device;
        }
      } catch {
        // Gone or moved: fall through to a search.
      }
    }
  }

  say("Searching for renderers…");
  const devices = await discoverRenderers({
    timeoutMs,
    settleMs: 2500,
    onDevice: (device) => say(`  found ${describe(device)}`),
  });
  if (!devices.length) {
    throw new CliError(
      `No DLNA renderers found in ${timeoutMs / 1000}s. Make sure the device is on and on the same network as ` +
        "this PC, then try again (or --timeout 30000).",
    );
  }
  if (values.device) {
    const device = matchDevice(devices, values.device);
    if (!device) throw new CliError(`No renderer matches "${values.device}":\n${formatDevices(devices)}`);
    return device;
  }
  if (devices.length === 1) return devices[0];
  if (!process.stdin.isTTY) {
    throw new CliError(`Found ${devices.length} renderers; pick one with --device:\n${formatDevices(devices)}`);
  }
  console.log(formatDevices(devices));
  return askForDevice(devices);
}

async function discover(values) {
  const timeoutMs = numberOption(values, "timeout", 10000, { min: 500 });
  if (!values.json) console.log(`Searching for ${timeoutMs / 1000}s…`);
  const devices = await discoverRenderers({
    timeoutMs,
    onDevice: (device) => !values.json && console.log(`  found ${describe(device)}`),
  });
  if (values.json) console.log(JSON.stringify(devices, null, 2));
  else console.log(devices.length ? `${devices.length} renderer(s) found.` : "No DLNA renderers found.");
  return 0;
}

const STATE_LABELS = {
  PLAYING: "Playing",
  PAUSED_PLAYBACK: "Paused",
  STOPPED: "Stopped",
  TRANSITIONING: "Starting",
  NO_MEDIA_PRESENT: "Idle",
};

function statusLine(snapshot) {
  const state = (STATE_LABELS[snapshot.state] ?? snapshot.state).padEnd(8);
  const time = snapshot.live
    ? `${formatTime(snapshot.elapsed)} live, ${(snapshot.bytesSent / 1e6).toFixed(1)} MB sent`
    : `${snapshot.position === null ? "-:--:--" : formatTime(snapshot.position)} / ${snapshot.duration === null ? "-:--:--" : formatTime(snapshot.duration)}`;
  const volume = snapshot.volume === null ? "" : `  vol ${snapshot.volume}${snapshot.muted ? " (muted)" : ""}`;
  return `${state} ${time}${volume}`;
}

/** Runs a session in the terminal: a live status line, keyboard controls on a TTY, Ctrl+C to stop. */
function runInTerminal(session) {
  return new Promise((resolve) => {
    const interactive = process.stdin.isTTY;
    let line = "";
    const draw = (text = line) => {
      line = text;
      process.stdout.write(`\r${text.padEnd(70)}`);
    };
    const note = (message) => {
      process.stdout.write(`\r${" ".repeat(70)}\r${message}\n`);
      draw();
    };
    const act = (promise, done) =>
      promise.then((result) => done && note(done(result))).catch((error) => note(`  ${error.message}`));

    const onKey = (_text, key = {}) => {
      if ((key.ctrl && key.name === "c") || key.name === "q") return void session.stop();
      if (key.name === "space") return act(session.togglePause());
      if (key.name === "left" || key.name === "right") {
        return act(session.seek(key.name === "left" ? -10 : 10, { relative: true }), (to) => `  Seeked to ${formatTime(to)}`);
      }
      if (key.name === "up" || key.name === "down") return act(session.changeVolume(key.name === "up" ? 5 : -5));
      if (key.name === "m") return act(session.toggleMute(), (muted) => `  ${muted ? "Muted" : "Unmuted"}`);
    };
    const onSigint = () => session.stop();

    if (interactive) {
      readline.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.on("keypress", onKey);
      console.log("Space pause/resume, Left/Right seek 10 s, Up/Down volume, M mute, Q stop");
    } else {
      process.once("SIGINT", onSigint);
    }

    session.on("status", (snapshot) => draw(statusLine(snapshot)));
    session.once("ended", ({ reason, error, detail }) => {
      if (interactive) {
        process.stdin.off("keypress", onKey);
        process.stdin.setRawMode(false);
        process.stdin.pause();
      } else {
        process.off("SIGINT", onSigint);
      }
      process.stdout.write("\n");
      if (error) console.error(`${error}${detail ? `\n${detail}` : ""}`);
      else console.log(reason === "renderer-stopped" ? "The renderer stopped playback." : "Stopped.");
      resolve(error ? 1 : 0);
    });
    session.start(1000);
  });
}

const logRequest = (r) => process.stdout.write(`\r  ${r.remote} ${r.method} ${r.range ?? "full"} -> ${r.status}\n`);

async function play(file, values) {
  if (!file) throw new CliError("Usage: dlna-cast play <file> [--device <n|name|ip|udn>]");
  const filePath = path.resolve(file);
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch {
    throw new CliError(`Cannot read ${filePath}`);
  }
  const device = await resolveDevice(values);
  console.log(`Casting ${path.basename(filePath)} to ${device.friendlyName}…`);
  const session = await CastSession.startFile(device, filePath, {
    port: numberOption(values, "port", 0),
    title: values.title,
    onRequest: logRequest,
    onWarning: (message) => console.warn(`Warning: ${message}`),
  });
  saveLastDevice(device);
  addRecentFile(filePath);
  console.log(`Serving ${session.media.url}`);
  return runInTerminal(session);
}

function requireFfmpeg(values) {
  let ffmpegPath;
  try {
    ffmpegPath = findFfmpeg(values.ffmpeg);
  } catch (error) {
    throw new CliError(error.message);
  }
  if (!ffmpegPath) {
    throw new CliError(
      "Screen streaming needs ffmpeg. Install it (winget install Gyan.FFmpeg) or pass --ffmpeg <path to ffmpeg.exe>.",
    );
  }
  return ffmpegPath;
}

async function screen(values) {
  const ffmpegPath = requireFfmpeg(values);
  const encoder = values.encoder ?? "auto";
  if (encoder !== "auto" && !ENCODERS[encoder]) {
    throw new CliError(`--encoder must be auto or one of: ${Object.keys(ENCODERS).join(", ")}`);
  }
  const capture = values.capture ?? "auto";
  if (!["auto", "ddagrab", "gdigrab", "testsrc"].includes(capture)) {
    throw new CliError("--capture must be auto, ddagrab, gdigrab or testsrc");
  }
  const fps = numberOption(values, "fps", 30, { min: 1 });
  const bitrateKbps = numberOption(values, "bitrate", 6000, { min: 100 });

  const device = await resolveDevice(values);
  console.log(`Starting screen capture for ${device.friendlyName}…`);
  const session = await CastSession.startScreen(device, {
    ffmpegPath,
    capture,
    encoder,
    monitor: numberOption(values, "monitor", 0),
    fps,
    bitrateKbps,
    maxHeight: numberOption(values, "max-height", 1080, { min: 144 }),
    drawMouse: !values["no-mouse"],
    audio: values.audio ?? "system",
    port: numberOption(values, "port", 0),
    title: values.title,
    onRequest: logRequest,
    onStatus: (message) => console.log(message),
  });
  saveLastDevice(device);
  const { details } = session;
  const audioLabel = details.systemAudio ? "system audio" : values.audio && !["system", "none"].includes(values.audio) ? values.audio : "no audio";
  console.log(`Streaming via ${details.capture} + ${ENCODERS[details.encoder].name}, ${fps} fps, ${bitrateKbps} kbps, ${audioLabel}.`);
  return runInTerminal(session);
}

// One-shot controls: they act on the renderer directly, so they also work while another terminal is casting.
async function control(command, argument, values) {
  const device = await resolveDevice(values, { quiet: true });
  const transport = avTransport(device);
  const rendering = renderingControl(device);
  const requireVolume = () => {
    if (!rendering.supported) throw new CliError(`${device.friendlyName} doesn't offer volume control.`);
  };
  const confirmed = async (command) => {
    try {
      return await command();
    } catch (error) {
      throw error instanceof IgnoredCommandError ? new CliError(error.message) : error;
    }
  };

  switch (command) {
    case "pause":
      await confirmed(() => pauseAndConfirm(device));
      console.log(`Paused ${device.friendlyName}`);
      return 0;
    case "resume":
      await transport.play();
      console.log(`Resumed ${device.friendlyName}`);
      return 0;
    case "stop":
      await transport.stop();
      console.log(`Stopped ${device.friendlyName}`);
      return 0;
    case "seek": {
      const target = parseSeekInput(argument);
      if (!target) throw new CliError("Usage: dlna-cast seek <time>   e.g. 90, 1:30, 0:01:30, +30, -10");
      let seconds = target.seconds;
      if (target.relative) {
        const current = parseTime((await transport.positionInfo()).RelTime);
        if (current === null) throw new CliError(`${device.friendlyName} didn't report a position to seek from.`);
        seconds = Math.max(0, current + target.seconds);
      }
      await transport.seek(seconds);
      console.log(`Seeked ${device.friendlyName} to ${formatTime(seconds)}`);
      return 0;
    }
    case "volume": {
      requireVolume();
      if (argument === undefined) {
        console.log(`Volume ${await rendering.getVolume()}${(await rendering.getMute().catch(() => false)) ? " (muted)" : ""}`);
        return 0;
      }
      const match = /^([+-])?(\d+)$/.exec(argument.trim());
      if (!match) throw new CliError("Usage: dlna-cast volume [0-100 | +n | -n]");
      const amount = Number(match[2]);
      const level = match[1] ? (await rendering.getVolume()) + (match[1] === "-" ? -amount : amount) : amount;
      console.log(`Volume ${await confirmed(() => setVolumeAndConfirm(device, level))}`);
      return 0;
    }
    case "mute":
    case "unmute":
      requireVolume();
      await confirmed(() => setMuteAndConfirm(device, command === "mute"));
      console.log(`${command === "mute" ? "Muted" : "Unmuted"} ${device.friendlyName}`);
      return 0;
    case "status": {
      const status = await readDeviceStatus(device);
      const time = status.position === null ? "" : `  ${formatTime(status.position)}${status.duration ? ` / ${formatTime(status.duration)}` : ""}`;
      const volume = status.volume === null ? "" : `  vol ${status.volume}${status.muted ? " (muted)" : ""}`;
      console.log(`${device.friendlyName}: ${STATE_LABELS[status.state] ?? status.state}${time}${volume}`);
      return 0;
    }
  }
}

// Without a console (the desktop shortcut), send output to a file instead. Append mode lets a second launch
// write to the same log while the first instance still has it open.
function logToFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stream = fs.createWriteStream(file, { flags: "a" });
  const writer = (level) => (...parts) => stream.write(`${new Date().toISOString()} ${level} ${parts.join(" ")}\n`);
  console.log = writer("info");
  console.warn = writer("warn");
  console.error = writer("error");
  process.on("uncaughtException", (error) => {
    stream.write(`${new Date().toISOString()} fatal ${error.stack ?? error}\n`, () => process.exit(1));
  });
}

async function gui(values) {
  if (values.log) logToFile(path.resolve(values.log));
  const { runGui } = await import("./gui/server.mjs");
  return runGui({ port: numberOption(values, "port", 0), open: !values["no-open"], ffmpegPath: findFfmpeg(values.ffmpeg) });
}

async function audioDevices(values) {
  const ffmpegPath = requireFfmpeg(values);
  const names = await listAudioDevices(ffmpegPath);
  console.log("System audio (what the PC is playing) is the default: --audio system");
  console.log(names.length ? `DirectShow inputs for --audio:\n${names.map((n) => `  "${n}"`).join("\n")}` : "No DirectShow audio inputs.");
  return 0;
}

const CONTROL_COMMANDS = new Set(["pause", "resume", "stop", "seek", "volume", "mute", "unmute", "status"]);

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return 0;
  }
  let parsed;
  try {
    // Negative numbers like "-10" are seek or volume arguments, not options.
    parsed = parseArgs({ args: rest.map((a) => (/^-\d/.test(a) ? ` ${a}` : a)), options: OPTIONS, allowPositionals: true });
  } catch (error) {
    throw new CliError(`${error.message}\n\n${HELP}`);
  }
  const { values } = parsed;
  const positionals = parsed.positionals.map((p) => p.trim());
  if (CONTROL_COMMANDS.has(command)) return control(command, positionals[0], values);
  switch (command) {
    case "discover":
      return discover(values);
    case "play":
      return play(positionals[0], values);
    case "screen":
      return screen(values);
    case "gui":
      return gui(values);
    case "audio-devices":
      return audioDevices(values);
    default:
      throw new CliError(`Unknown command "${command}"\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof CliError ? error.message : `Error: ${error.message}`);
    process.exitCode = error instanceof CliError ? 2 : 1;
  },
);
