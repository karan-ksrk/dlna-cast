import { decodeXml, elementContent, elementText, xmlEscape } from "./xml.mjs";

export class UpnpError extends Error {
  constructor(action, status, code, description) {
    const detail = code ? `UPnP ${code}${description ? ` ${description}` : ""}` : `HTTP ${status}`;
    super(`${action} failed: ${detail}`);
    this.name = "UpnpError";
    Object.assign(this, { action, status, code, description });
  }
}

export function buildEnvelope(serviceType, action, args) {
  const body = args.map(([name, value]) => `<${name}>${xmlEscape(value)}</${name}>`).join("");
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
    `<u:${action} xmlns:u="${xmlEscape(serviceType)}">${body}</u:${action}>` +
    "</s:Body></s:Envelope>"
  );
}

export function parseFault(xml) {
  const error = elementContent(xml, "UPnPError");
  if (error === null) return null;
  const code = Number(elementText(error, "errorCode"));
  return { code: Number.isFinite(code) ? code : null, description: elementText(error, "errorDescription") };
}

export function parseActionResponse(xml, action) {
  const block = elementContent(xml, `${action}Response`);
  if (block === null) return {};
  const values = {};
  for (const [, name] of block.matchAll(/<([\w-]+)\s*\/>/g)) values[name] = "";
  for (const [, name, value] of block.matchAll(/<([\w-]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) {
    values[name] = decodeXml(value);
  }
  return values;
}

export async function invoke(service, action, args = [], { timeoutMs = 8000 } = {}) {
  if (!service) throw new Error(`The device has no service for ${action}`);
  const response = await fetch(service.controlURL, {
    method: "POST",
    headers: {
      "Content-Type": 'text/xml; charset="utf-8"',
      SOAPACTION: `"${service.serviceType}#${action}"`,
    },
    body: buildEnvelope(service.serviceType, action, args),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  const text = await response.text();
  if (!response.ok) {
    const fault = parseFault(text);
    throw new UpnpError(action, response.status, fault?.code ?? null, fault?.description ?? null);
  }
  return parseActionResponse(text, action);
}

export function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const pad = (n) => String(n).padStart(2, "0");
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

// AVTransport calls use the service type the device advertised (AVTransport:1 or :2), on instance 0.
export function avTransport(device) {
  const service = device.avTransport;
  const call = (action, args = []) => invoke(service, action, [["InstanceID", "0"], ...args]);
  return {
    setUri: (uri, metadata = "") =>
      call("SetAVTransportURI", [
        ["CurrentURI", uri],
        ["CurrentURIMetaData", metadata],
      ]),
    play: () => call("Play", [["Speed", "1"]]),
    pause: () => call("Pause"),
    stop: () => call("Stop"),
    seek: (seconds) =>
      call("Seek", [
        ["Unit", "REL_TIME"],
        ["Target", formatTime(seconds)],
      ]),
    transportInfo: () => call("GetTransportInfo"),
    positionInfo: () => call("GetPositionInfo"),
  };
}

/** Parses a renderer time ("1:02:03", "00:01:05.500") into seconds; null for "NOT_IMPLEMENTED" or blanks. */
export function parseTime(text) {
  const match = /^\s*(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)\s*$/.exec(text ?? "");
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/**
 * Parses a seek target typed by a person: "90", "1:30", "0:01:30" are absolute; "+30" and "-1:00" are relative.
 * Returns { seconds, relative } or null.
 */
export function parseSeekInput(text) {
  const match = /^\s*([+-]?)\s*([\d:.]+)\s*$/.exec(String(text ?? ""));
  if (!match) return null;
  const [, sign, clock] = match;
  const parts = clock.split(":");
  if (parts.length > 3 || parts.some((part) => !/^\d+(\.\d+)?$/.test(part))) return null;
  const numbers = parts.map(Number);
  // Minutes and seconds after the first field must be below 60.
  if (numbers.slice(1).some((n) => n >= 60)) return null;
  const magnitude = numbers.reduce((total, n) => total * 60 + n, 0);
  if (!sign) return { seconds: magnitude, relative: false };
  return { seconds: sign === "-" ? -magnitude : magnitude, relative: true };
}

// RenderingControl volume and mute on the Master channel. Volume is 0–100 on virtually every renderer.
export function renderingControl(device) {
  const service = device.renderingControl;
  const call = (action, args = []) => invoke(service, action, [["InstanceID", "0"], ["Channel", "Master"], ...args]);
  return {
    supported: Boolean(service),
    getVolume: async () => Number((await call("GetVolume")).CurrentVolume),
    setVolume: (level) => call("SetVolume", [["DesiredVolume", String(Math.round(Math.min(100, Math.max(0, level))))]]),
    getMute: async () => ["1", "true"].includes(String((await call("GetMute")).CurrentMute).toLowerCase()),
    setMute: (muted) => call("SetMute", [["DesiredMute", muted ? "1" : "0"]]),
  };
}
