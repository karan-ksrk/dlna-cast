import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXE = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

// In preference order: hardware first, then software.
export const ENCODERS = {
  nvenc: { name: "h264_nvenc", pixFmt: "nv12" },
  qsv: { name: "h264_qsv", pixFmt: "nv12" },
  amf: { name: "h264_amf", pixFmt: "nv12" },
  x264: { name: "libx264", pixFmt: "yuv420p" },
  openh264: { name: "libopenh264", pixFmt: "yuv420p" },
};

/** Explicit path, then DLNA_CAST_FFMPEG, then PATH, then a portable build in a `.tools` folder beside this package. */
export function findFfmpeg(explicit = process.env.DLNA_CAST_FFMPEG) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`ffmpeg not found at ${explicit}`);
    return explicit;
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = dir && path.join(dir, EXE);
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const toolsDir of [path.join(packageDir, ".tools"), path.join(packageDir, "..", ".tools")]) {
    let entries;
    try {
      entries = fs.readdirSync(toolsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(toolsDir, entry.name, "bin", EXE);
      if (entry.isDirectory() && /ffmpeg/i.test(entry.name) && fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function runFfmpeg(ffmpegPath, args, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const keepTail = (text, chunk) => (text + chunk).slice(-65536);
    child.stdout.on("data", (chunk) => (stdout = keepTail(stdout, chunk)));
    child.stderr.on("data", (chunk) => (stderr = keepTail(stderr, chunk)));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Encoders that are compiled in and actually work here: a GPU encoder can be compiled in with no driver behind it. */
export async function detectEncoders(ffmpegPath) {
  const { stdout } = await runFfmpeg(ffmpegPath, ["-hide_banner", "-encoders"]);
  const compiled = Object.keys(ENCODERS).filter((key) => new RegExp(`\\s${ENCODERS[key].name}\\s`).test(stdout));
  const working = await Promise.all(
    compiled.map(async (key) => {
      const { name, pixFmt } = ENCODERS[key];
      const { code } = await runFfmpeg(
        ffmpegPath,
        ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=black:s=320x240:r=30:d=1", "-c:v", name, "-pix_fmt", pixFmt, "-f", "null", "-"],
        { timeoutMs: 15000 },
      );
      return code === 0 ? key : null;
    }),
  );
  return working.filter(Boolean);
}

/** Desktop Duplication (GPU) capture; unavailable over some remote sessions and on older ffmpeg builds. */
export async function ddagrabAvailable(ffmpegPath, monitor = 0) {
  if (process.platform !== "win32") return false;
  const { code } = await runFfmpeg(
    ffmpegPath,
    ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `ddagrab=output_idx=${monitor}:framerate=10`, "-frames:v", "2", "-f", "null", "-"],
    { timeoutMs: 8000 },
  );
  return code === 0;
}

export async function listAudioDevices(ffmpegPath) {
  const { stderr } = await runFfmpeg(ffmpegPath, ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]);
  return [...stderr.matchAll(/"([^"]+)"\s*\(audio\)/g)].map((m) => m[1]);
}

function encoderArgs(encoder, { fps, bitrateKbps }) {
  const rate = ["-b:v", `${bitrateKbps}k`, "-maxrate", `${bitrateKbps}k`, "-bufsize", `${bitrateKbps}k`];
  // A keyframe every second, so a renderer that joins mid-stream starts decoding within a second.
  const gop = ["-g", String(fps), "-bf", "0"];
  switch (encoder) {
    case "nvenc":
      return ["-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ull", "-rc", "cbr", ...rate, ...gop, "-zerolatency", "1", "-profile:v", "main"];
    case "qsv":
      return ["-c:v", "h264_qsv", "-preset", "veryfast", "-async_depth", "1", "-look_ahead", "0", ...rate, ...gop, "-profile:v", "main"];
    case "amf":
      return ["-c:v", "h264_amf", "-usage", "ultralowlatency", "-rc", "cbr", "-quality", "speed", ...rate, ...gop, "-profile:v", "main"];
    case "x264":
      return ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", ...rate, ...gop, "-profile:v", "main"];
    case "openh264":
      return ["-c:v", "libopenh264", "-b:v", `${bitrateKbps}k`, ...gop];
    default:
      throw new Error(`Unknown encoder "${encoder}"`);
  }
}

/**
 * ffmpeg arguments for a live screen stream as MPEG-TS on stdout.
 * `audio`: null for a silent track, { pipe: { format, rate, channels } } for PCM on stdin, or { dshow: name }.
 */
export function buildScreenArgs({
  capture = "ddagrab",
  monitor = 0,
  fps = 30,
  bitrateKbps = 6000,
  maxHeight = 1080,
  encoder = "x264",
  drawMouse = true,
  audio = null,
}) {
  const { pixFmt } = ENCODERS[encoder] ?? {};
  if (!pixFmt) throw new Error(`Unknown encoder "${encoder}"`);
  const args = ["-hide_banner", "-loglevel", "warning", "-nostats"];
  const videoFilters = [];

  if (capture === "ddagrab") {
    args.push("-f", "lavfi", "-i", `ddagrab=output_idx=${monitor}:framerate=${fps}:draw_mouse=${drawMouse ? 1 : 0}`);
    // ddagrab yields GPU frames; bring them to system memory for scaling.
    videoFilters.push("hwdownload", "format=bgra");
  } else if (capture === "gdigrab") {
    args.push("-f", "gdigrab", "-framerate", String(fps), "-draw_mouse", drawMouse ? "1" : "0", "-i", "desktop");
  } else if (capture === "testsrc") {
    args.push("-re", "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=${fps}`);
  } else {
    throw new Error(`Unknown capture method "${capture}"`);
  }

  if (audio?.pipe) {
    const { format, rate, channels } = audio.pipe;
    args.push("-thread_queue_size", "1024", "-f", format, "-ar", String(rate), "-ac", String(channels), "-i", "pipe:0");
  } else if (audio?.dshow) {
    args.push("-thread_queue_size", "1024", "-f", "dshow", "-audio_buffer_size", "50", "-i", `audio=${audio.dshow}`);
  } else {
    // Many renderers refuse a stream with no audio track, so send silence.
    args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  }

  videoFilters.push(`scale=-2:'trunc(min(${maxHeight},ih)/2)*2'`, `format=${pixFmt}`);
  args.push("-map", "0:v:0", "-map", "1:a:0", "-vf", videoFilters.join(","));
  args.push(...encoderArgs(encoder, { fps, bitrateKbps }));
  args.push("-af", "aresample=async=1000", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2");
  args.push(
    "-f", "mpegts",
    "-mpegts_flags", "+pat_pmt_at_frames+initial_discontinuity",
    "-pcr_period", "20",
    "-pat_period", "0.02",
    "-muxdelay", "0",
    "-muxpreload", "0",
    "-flush_packets", "1",
    "pipe:1",
  );
  return args;
}
