// The desktop app's back end: a CastController that owns devices and the current cast, and a loopback HTTP
// server exposing it to the page through a JSON API and Server-Sent Events.
import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { discoverRenderers, probeDevice } from "../ssdp.mjs";
import { fetchDescription } from "../description.mjs";
import { CastSession } from "../session.mjs";
import { ENCODERS, detectEncoders, listAudioDevices } from "../ffmpeg.mjs";
import { addRecentFile, loadLastDevice, loadRecentFiles, saveLastDevice } from "../device-store.mjs";
import { isLanAddress } from "../lan.mjs";
import { listMonitors, openAppWindow, pickMediaFile } from "../windows.mjs";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/icon.svg": ["icon.svg", "image/svg+xml"],
};
const MAX_BODY_BYTES = 64 * 1024;
const MAX_LOG_ENTRIES = 200;
const CAPTURES = ["auto", "ddagrab", "gdigrab", "testsrc"];

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const deviceKey = (device) => device.udn ?? device.location;

function publicDevice(device) {
  return {
    key: deviceKey(device),
    friendlyName: device.friendlyName,
    manufacturer: device.manufacturer,
    modelName: device.modelName,
    host: device.host,
    volumeSupported: Boolean(device.renderingControl),
  };
}

function boundedInteger(value, name, min, max, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}`);
  }
  return number;
}

/** Devices, the selected renderer, the current cast and an activity log, with change notifications. */
export class CastController {
  #listeners = new Set();

  constructor({ ffmpegPath = null, discover = discoverRenderers, discoveryOptions = {} } = {}) {
    this.ffmpegPath = ffmpegPath;
    this.discoverFn = discover;
    this.discoveryOptions = discoveryOptions;
    this.devices = new Map();
    this.selectedKey = null;
    this.discovering = false;
    this.starting = false;
    this.session = null;
    this.lastEnded = null;
    this.log = [];
    this.optionsPromise = null;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(event, data) {
    for (const listener of this.#listeners) listener(event, data);
  }

  addLog(level, message) {
    const entry = { time: Date.now(), level, message };
    this.log.push(entry);
    if (this.log.length > MAX_LOG_ENTRIES) this.log.shift();
    this.#notify("log", entry);
  }

  snapshot() {
    return {
      devices: [...this.devices.values()].map(publicDevice),
      selectedKey: this.selectedKey,
      discovering: this.discovering,
      starting: this.starting,
      session: this.session?.snapshot() ?? null,
      lastEnded: this.lastEnded,
      ffmpeg: Boolean(this.ffmpegPath),
      recentFiles: loadRecentFiles(),
      filePicker: process.platform === "win32",
    };
  }

  pushState() {
    this.#notify("state", this.snapshot());
  }

  addDevice(device) {
    const key = deviceKey(device);
    if (!this.devices.has(key)) this.addLog("info", `Found ${device.friendlyName} at ${device.host}`);
    this.devices.set(key, device);
    if (!this.selectedKey) this.selectedKey = key;
    this.pushState();
    return key;
  }

  async restoreLastDevice() {
    const last = loadLastDevice();
    if (!last) return;
    try {
      const device = await fetchDescription(last.location, { timeoutMs: 2500 });
      if (device.avTransport && (!last.udn || device.udn === last.udn)) this.selectedKey = this.addDevice(device);
    } catch {
      // Not reachable right now; discovery may still find it.
    }
  }

  async discover({ timeoutMs = 12000 } = {}) {
    if (this.discovering) return;
    this.discovering = true;
    this.addLog("info", "Searching the network for renderers");
    this.pushState();
    try {
      const found = await this.discoverFn({ timeoutMs, ...this.discoveryOptions, onDevice: (d) => this.addDevice(d) });
      for (const device of found) this.addDevice(device);
      this.addLog("info", found.length ? `Search finished: ${found.length} renderer(s) on the network` : "Search finished: no renderers answered");
    } finally {
      this.discovering = false;
      this.pushState();
    }
  }

  async probe(address) {
    if (!net.isIPv4(address ?? "") || !isLanAddress(address)) {
      throw new HttpError(400, "Enter the device's local IPv4 address, like 192.168.1.42");
    }
    this.addLog("info", `Looking for a renderer at ${address}`);
    const [device] = await probeDevice(address, { timeoutMs: 8000 });
    if (!device) {
      throw new HttpError(404, `No renderer answered at ${address}. Check the IP address in the device's network settings.`);
    }
    this.selectedKey = this.addDevice(device);
    this.pushState();
    return publicDevice(device);
  }

  select(key) {
    if (!this.devices.has(key)) throw new HttpError(404, "That renderer is no longer in the list; search again");
    this.selectedKey = key;
    this.pushState();
  }

  #selectedDevice() {
    const device = this.devices.get(this.selectedKey);
    if (!device) throw new HttpError(409, "Choose a renderer first");
    return device;
  }

  async #replaceSession(describeCast, start) {
    if (this.starting) throw new HttpError(409, "A cast is already starting");
    const device = this.#selectedDevice();
    this.starting = true;
    this.pushState();
    try {
      if (this.session) await this.session.stop();
      this.addLog("info", `Starting ${describeCast} on ${device.friendlyName}`);
      const session = await start(device);
      this.session = session;
      this.lastEnded = null;
      session.on("status", () => this.pushState());
      session.once("ended", ({ reason, error }) => {
        if (this.session === session) this.session = null;
        this.lastEnded = { reason, error, title: session.title };
        if (error) this.addLog("error", error);
        else this.addLog("info", reason === "renderer-stopped" ? `${device.friendlyName} finished playing ${session.title}` : `Stopped ${session.title}`);
        this.pushState();
      });
      session.start(1000);
      saveLastDevice(device);
      this.addLog("info", `Casting ${session.title} to ${device.friendlyName}`);
      return session;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      this.addLog("error", error.message);
      throw new HttpError(502, error.message);
    } finally {
      this.starting = false;
      this.pushState();
    }
  }

  async castFile(filePath) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath.trim())) {
      throw new HttpError(400, "Choose a file, or paste its full path");
    }
    const resolved = path.resolve(filePath.trim());
    try {
      if (!(await fs.promises.stat(resolved)).isFile()) throw new Error();
    } catch {
      throw new HttpError(400, `Can't open ${resolved}`);
    }
    await this.#replaceSession(path.basename(resolved), (device) =>
      CastSession.startFile(device, resolved, {
        onWarning: (message) => this.addLog("warning", message),
        onRequest: (r) => this.addLog("detail", `${r.remote} ${r.method} ${r.range ?? "whole file"}: ${r.status}`),
      }),
    );
    addRecentFile(resolved);
    this.pushState();
  }

  async castScreen(options = {}) {
    if (!this.ffmpegPath) throw new HttpError(409, "Screen casting needs ffmpeg; install it and restart the app");
    const encoder = options.encoder ?? "auto";
    if (encoder !== "auto" && !ENCODERS[encoder]) throw new HttpError(400, "Unknown encoder");
    const capture = options.capture ?? "auto";
    if (!CAPTURES.includes(capture)) throw new HttpError(400, "Unknown capture method");
    const audio = typeof options.audio === "string" && options.audio ? options.audio : "system";
    const settings = {
      ffmpegPath: this.ffmpegPath,
      monitor: boundedInteger(options.monitor, "Display", 0, 15, 0),
      fps: boundedInteger(options.fps, "Frame rate", 5, 60, 30),
      bitrateKbps: boundedInteger(options.bitrateKbps, "Bitrate", 500, 40000, 6000),
      maxHeight: boundedInteger(options.maxHeight, "Resolution", 360, 2160, 1080),
      encoder,
      capture,
      audio,
      drawMouse: options.drawMouse !== false,
      onStatus: (message) => this.addLog("info", message.trim()),
      onRequest: (r) => this.addLog("detail", `${r.remote} ${r.method}: ${r.status}`),
    };
    await this.#replaceSession(capture === "testsrc" ? "a test pattern" : "your screen", (device) =>
      CastSession.startScreen(device, settings),
    );
  }

  async control(action, value) {
    const session = this.session;
    if (!session) throw new HttpError(409, "Nothing is casting right now");
    try {
      switch (action) {
        case "toggle":
          return await session.togglePause();
        case "pause":
          return await session.pause();
        case "resume":
          return await session.resume();
        case "stop":
          return await session.stop();
        case "seek":
          return await session.seek(Number(value));
        case "skip":
          return await session.seek(Number(value), { relative: true });
        case "volume":
          return await session.setVolume(Number(value));
        case "mute":
          return await session.setMute(Boolean(value));
        default:
          throw new HttpError(400, `Unknown action "${action}"`);
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      this.addLog("error", error.message);
      throw new HttpError(502, error.message);
    }
  }

  /** Screen-casting choices for the page; detected once because probing encoders takes a few seconds. */
  options() {
    this.optionsPromise ??= (async () => {
      const [monitors, audioDevices, encoders] = await Promise.all([
        listMonitors(),
        this.ffmpegPath ? listAudioDevices(this.ffmpegPath).catch(() => []) : [],
        this.ffmpegPath ? detectEncoders(this.ffmpegPath).catch(() => []) : [],
      ]);
      return { monitors, audioDevices, encoders: encoders.map((key) => ({ key, name: ENCODERS[key].name })) };
    })();
    return this.optionsPromise;
  }

  async shutdown() {
    await this.session?.stop();
  }
}

function sameToken(supplied, expected) {
  const a = Buffer.from(String(supplied ?? ""));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return {};
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, "Request too large");
    chunks.push(chunk);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  } catch {
    throw new HttpError(400, "Malformed JSON");
  }
}

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function sendJson(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body ?? {}));
}

/**
 * Serves the app on loopback. Every API call needs the per-launch token (sent by the page in a header, or as a
 * query parameter for the event stream) and a Host header naming this listener, which blocks other sites and
 * DNS-rebinding pages from driving it.
 */
export async function startGuiServer({ controller, host = "127.0.0.1", port = 0 }) {
  const token = randomBytes(24).toString("base64url");
  const streams = new Set();
  let boundPort = port;

  const unsubscribe = controller.subscribe((event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of streams) res.write(payload);
  });

  const api = {
    "GET /api/state": () => controller.snapshot(),
    "GET /api/log": () => controller.log,
    "GET /api/options": () => controller.options(),
    "POST /api/discover": () => {
      controller.discover().catch((error) => controller.addLog("error", error.message));
      return { started: true };
    },
    "POST /api/devices/probe": (body) => controller.probe(body.address?.trim()),
    "POST /api/devices/select": (body) => controller.select(body.key),
    "POST /api/pick-file": async (body) => ({ path: await pickMediaFile(body.initialDirectory ?? null) }),
    "POST /api/cast/file": (body) => controller.castFile(body.path),
    "POST /api/cast/screen": (body) => controller.castScreen(body),
    "POST /api/control": (body) => controller.control(body.action, body.value),
  };

  const handle = async (req, res) => {
    const url = new URL(req.url, "http://loopback.invalid");
    if (![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`].includes(req.headers.host)) {
      throw new HttpError(421, "This app only answers on its own loopback address");
    }

    const file = req.method === "GET" && STATIC_FILES[url.pathname];
    if (file) {
      const [name, type] = file;
      let body = await fs.promises.readFile(path.join(PUBLIC_DIR, name));
      if (name === "index.html") body = Buffer.from(body.toString("utf8").replace("__API_TOKEN__", token));
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": type });
      return res.end(body);
    }
    if (!url.pathname.startsWith("/api/")) throw new HttpError(404, "Not found");
    if (!sameToken(req.headers["x-dlna-cast-token"] ?? url.searchParams.get("token"), token)) {
      throw new HttpError(403, "Missing or wrong app token");
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream", Connection: "keep-alive" });
      res.write(`event: state\ndata: ${JSON.stringify(controller.snapshot())}\n\n`);
      streams.add(res);
      const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15000);
      req.once("close", () => {
        clearInterval(heartbeat);
        streams.delete(res);
      });
      return;
    }

    const route = api[`${req.method} ${url.pathname}`];
    if (!route) throw new HttpError(404, "Unknown API endpoint");
    const result = await route(req.method === "POST" ? await readJson(req) : {});
    sendJson(res, 200, result ?? { ok: true });
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (res.headersSent) return res.end();
      sendJson(res, error.status ?? 500, { error: error.message });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  boundPort = server.address().port;

  return {
    url: `http://127.0.0.1:${boundPort}/`,
    port: boundPort,
    token,
    /** Pages currently connected to the event stream. */
    get openPages() {
      return streams.size;
    },
    close: () =>
      new Promise((resolve) => {
        unsubscribe();
        for (const res of streams) res.end();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const LOCK_PATH = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "dlna-cast", "gui.json");
// After the last app page closes, wait this long (a reload reconnects well within it) before quitting.
const CLOSED_GRACE_MS = 6000;
// If no page ever connects (the window failed to open), give up after this long.
const FIRST_PAGE_TIMEOUT_MS = 60000;

/** The URL of a dlna-cast app that is already running and answering, or null. */
async function runningInstance() {
  let lock;
  try {
    lock = JSON.parse(await fs.promises.readFile(LOCK_PATH, "utf8"));
    process.kill(lock.pid, 0);
  } catch {
    return null;
  }
  try {
    const response = await fetch(lock.url, { signal: AbortSignal.timeout(1500) });
    return response.ok ? lock.url : null;
  } catch {
    return null;
  }
}

/**
 * `dlna-cast gui`: start the app (or reuse the one already running), open its window, and quit a few seconds
 * after the last app page closes. Watching the page connections rather than the browser process works however
 * Edge hands the launch between its processes, so a launch without a console never leaves a hidden process
 * behind. `--no-open` keeps serving until Ctrl+C.
 */
export async function runGui({ port = 0, open = true, ffmpegPath = null } = {}) {
  const existing = await runningInstance();
  if (existing) {
    console.log(`dlna-cast is already running at ${existing}; opening its window.`);
    if (open) openAppWindow(existing);
    return 0;
  }

  const controller = new CastController({ ffmpegPath });
  const gui = await startGuiServer({ controller, port });
  await fs.promises.mkdir(path.dirname(LOCK_PATH), { recursive: true });
  await fs.promises.writeFile(LOCK_PATH, JSON.stringify({ pid: process.pid, url: gui.url }));
  console.log(`dlna-cast is running at ${gui.url}`);
  controller.restoreLastDevice().finally(() => controller.discover().catch(() => {}));

  return new Promise((resolve) => {
    let closing = false;
    let idleTimer = null;
    const shutdown = async (message) => {
      if (closing) return;
      closing = true;
      clearInterval(idleTimer);
      if (message) console.log(message);
      await controller.shutdown();
      await gui.close();
      try {
        if (JSON.parse(await fs.promises.readFile(LOCK_PATH, "utf8")).pid === process.pid) await fs.promises.rm(LOCK_PATH);
      } catch {
        // Already gone.
      }
      resolve(0);
    };
    process.once("SIGINT", () => shutdown("Stopping…"));

    if (!open) {
      console.log("Press Ctrl+C to quit.");
      return;
    }
    openAppWindow(gui.url);
    const startedAt = Date.now();
    let everOpen = false;
    let lastSeenOpen = startedAt;
    idleTimer = setInterval(() => {
      const now = Date.now();
      if (gui.openPages > 0) {
        everOpen = true;
        lastSeenOpen = now;
      } else if (everOpen && now - lastSeenOpen > CLOSED_GRACE_MS) {
        shutdown("App window closed; stopping.");
      } else if (!everOpen && now - startedAt > FIRST_PAGE_TIMEOUT_MS) {
        shutdown("The app window never connected; stopping. Open the URL above in a browser to use the app.");
      }
    }, 1000);
  });
}
