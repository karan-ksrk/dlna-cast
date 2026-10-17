import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { LiveBroadcast } from "./live-broadcast.mjs";
import { buildScreenArgs } from "./ffmpeg.mjs";

const LOOPBACK_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "wasapi-loopback.ps1");

function waitForExit(child) {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("close", resolve));
}

/** Starts the WASAPI loopback helper and waits for it to announce its PCM format. */
export function startSystemAudio({ timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (process.platform !== "win32") return reject(new Error("System audio capture is only implemented on Windows"));
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", LOOPBACK_SCRIPT],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const errors = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("System audio capture did not start in time"));
    }, timeoutMs);
    readline.createInterface({ input: child.stderr }).on("line", (line) => {
      const match = /^FORMAT (\S+) (\d+) (\d+)$/.exec(line.trim());
      if (!match) return void errors.push(line);
      clearTimeout(timer);
      resolve({
        child,
        stdout: child.stdout,
        format: { format: match[1], rate: Number(match[2]), channels: Number(match[3]) },
        stop: async () => {
          child.kill();
          await waitForExit(child);
        },
      });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`System audio capture exited (${code}): ${errors.join(" ").trim() || "no output"}`));
    });
  });
}

/**
 * Runs ffmpeg for a live screen stream and fans its MPEG-TS output out through a LiveBroadcast.
 * `audioSource` (from startSystemAudio) feeds ffmpeg's stdin. Emits "exit" once with { code, tail }.
 */
export function startScreenStream(ffmpegPath, options, { audioSource = null } = {}) {
  const args = buildScreenArgs({ ...options, audio: audioSource ? { pipe: audioSource.format } : options.audio });
  const child = spawn(ffmpegPath, args, {
    stdio: [audioSource ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const broadcast = new LiveBroadcast();
  const events = new EventEmitter();
  const stderrTail = [];
  let bytesProduced = 0;
  let exited = null;

  if (audioSource) {
    audioSource.stdout.pipe(child.stdin);
    // ffmpeg closing its stdin on exit is expected; the exit itself is reported below.
    child.stdin.on("error", () => {});
  }
  child.stdout.on("data", (chunk) => {
    bytesProduced += chunk.length;
    broadcast.push(chunk);
  });
  readline.createInterface({ input: child.stderr }).on("line", (line) => {
    stderrTail.push(line);
    if (stderrTail.length > 30) stderrTail.shift();
  });
  const onExit = (code, error) => {
    if (exited) return;
    exited = { code, tail: (error ? [error.message, ...stderrTail] : stderrTail).join("\n") };
    broadcast.end();
    events.emit("exit", exited);
  };
  child.once("error", (error) => onExit(null, error));
  child.once("close", (code) => onExit(code));

  return {
    args,
    broadcast,
    events,
    get bytesProduced() {
      return bytesProduced;
    },
    /** Resolves once ffmpeg is producing output, so capture and encoder are known to work. */
    ready(timeoutMs = 12000) {
      return new Promise((resolve, reject) => {
        if (exited) return reject(new Error(exited.tail || `ffmpeg exited (${exited.code})`));
        const started = Date.now();
        const poll = setInterval(() => {
          if (bytesProduced >= 188 * 64) {
            clearInterval(poll);
            events.off("exit", onEarlyExit);
            resolve();
          } else if (Date.now() - started > timeoutMs) {
            clearInterval(poll);
            events.off("exit", onEarlyExit);
            reject(new Error("ffmpeg produced no output in time"));
          }
        }, 50);
        const onEarlyExit = ({ code, tail }) => {
          clearInterval(poll);
          reject(new Error(tail.trim() || `ffmpeg exited (${code})`));
        };
        events.once("exit", onEarlyExit);
      });
    },
    async stop() {
      if (!exited) child.kill();
      await waitForExit(child);
    },
  };
}
