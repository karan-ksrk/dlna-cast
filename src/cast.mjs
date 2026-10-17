import path from "node:path";
import { localAddressFor } from "./lan.mjs";
import { startMediaServer } from "./media-server.mjs";
import { avTransport, invoke } from "./soap.mjs";
import { buildDidl, mimeTypeFor } from "./didl.mjs";
import { ENCODERS, ddagrabAvailable, detectEncoders } from "./ffmpeg.mjs";
import { startScreenStream, startSystemAudio } from "./screen-stream.mjs";

/** The protocolInfo entries the renderer accepts (ConnectionManager GetProtocolInfo Sink), or null if unknown. */
export async function rendererSinks(device) {
  if (!device.connectionManager) return null;
  try {
    const { Sink = "" } = await invoke(device.connectionManager, "GetProtocolInfo", [], { timeoutMs: 4000 });
    return Sink.split(",").map((entry) => entry.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Uses the renderer's own spelling of a MIME type (e.g. "video/MP2T"); some compare it case-sensitively.
 * `supported` is null when the renderer didn't say, false when its list excludes the type.
 */
export function pickMimeType(sinks, mimeType) {
  if (!sinks) return { mimeType, supported: null };
  const advertised = sinks.map((entry) => entry.split(":")[2]).filter(Boolean);
  const exact = advertised.find((m) => m.toLowerCase() === mimeType.toLowerCase());
  if (exact) return { mimeType: exact, supported: true };
  return { mimeType, supported: advertised.includes("*") };
}

async function startPlayback(device, media, metadata) {
  const transport = avTransport(device);
  // Some renderers reject a new URI while they still hold the previous one.
  await transport.stop().catch(() => {});
  await transport.setUri(media.url, metadata);
  await transport.play();
  return transport;
}

function reachableHost(device) {
  if (!device.avTransport) throw new Error(`${device.friendlyName} has no AVTransport service`);
  const host = localAddressFor(device.host);
  if (!host) throw new Error(`No local network address can reach ${device.host}`);
  return host;
}

// Serve the file on the interface the renderer can reach, then hand it the URL and start playback.
export async function castFile(
  device,
  filePath,
  { port = 0, title = path.parse(filePath).name, allow = [device.host], onRequest, onWarning = () => {} } = {},
) {
  const host = reachableHost(device);
  const { mimeType, supported } = pickMimeType(await rendererSinks(device), mimeTypeFor(filePath));
  if (supported === false) {
    onWarning(`${device.friendlyName} doesn't list ${mimeType} among its formats; it may refuse the file (UPnP 714).`);
  }

  const media = await startMediaServer({ filePath, host, port, mimeType, allow, onRequest });
  try {
    const transport = await startPlayback(
      device,
      media,
      buildDidl({ url: media.url, title, mimeType: media.mimeType, size: media.size }),
    );
    return { media, transport };
  } catch (error) {
    await media.close();
    throw error;
  }
}

/**
 * Streams the desktop live. Tries capture methods (ddagrab, then gdigrab) and encoders (GPU first) until ffmpeg
 * starts producing output: a GPU encoder can be present yet fail to open (busy, old driver, remote session).
 *
 * `audio`: "system" (WASAPI loopback, falls back to silence), "none", or a DirectShow device name.
 */
export async function castScreen(
  device,
  {
    ffmpegPath,
    capture = "auto",
    encoder = "auto",
    monitor = 0,
    fps = 30,
    bitrateKbps = 6000,
    maxHeight = 1080,
    drawMouse = true,
    audio = "system",
    port = 0,
    title = "Desktop",
    allow = [device.host],
    onRequest,
    onStatus = () => {},
  },
) {
  const host = reachableHost(device);
  const { mimeType } = pickMimeType(await rendererSinks(device), "video/mp2t");

  const captures =
    capture === "auto"
      ? (await ddagrabAvailable(ffmpegPath, monitor))
        ? ["ddagrab", "gdigrab"]
        : ["gdigrab"]
      : [capture];
  const encoders = encoder === "auto" ? await detectEncoders(ffmpegPath) : [encoder];
  if (!encoders.length) throw new Error("ffmpeg has no working H.264 encoder");

  let audioSource = null;
  if (audio === "system") {
    try {
      audioSource = await startSystemAudio();
    } catch (error) {
      onStatus(`System audio unavailable (${error.message}); streaming silence instead.`);
    }
  }
  const audioOption = audio !== "system" && audio !== "none" ? { dshow: audio } : null;

  let stream = null;
  let chosen = null;
  const failures = [];
  search: for (const captureMethod of captures) {
    for (const encoderKey of encoders) {
      const candidate = startScreenStream(
        ffmpegPath,
        { capture: captureMethod, encoder: encoderKey, monitor, fps, bitrateKbps, maxHeight, drawMouse, audio: audioOption },
        { audioSource },
      );
      try {
        await candidate.ready();
        stream = candidate;
        chosen = { capture: captureMethod, encoder: encoderKey };
        break search;
      } catch (error) {
        await candidate.stop();
        const lastLine = error.message.trim().split("\n").pop();
        failures.push(`${captureMethod} + ${ENCODERS[encoderKey].name}: ${lastLine}`);
        onStatus(`  ${captureMethod} with ${ENCODERS[encoderKey].name} failed; trying the next option`);
      }
    }
  }
  if (!stream) {
    await audioSource?.stop();
    throw new Error(`Could not start screen capture:\n  ${failures.join("\n  ")}`);
  }

  let media = null;
  const close = async () => {
    await media?.close();
    await stream.stop();
    await audioSource?.stop();
  };
  try {
    media = await startMediaServer({ live: stream.broadcast, host, port, mimeType, allow, onRequest });
    const transport = await startPlayback(device, media, buildDidl({ url: media.url, title, mimeType, live: true }));
    return { media, transport, stream, close, systemAudio: Boolean(audioSource), ...chosen };
  } catch (error) {
    await close();
    throw error;
  }
}
