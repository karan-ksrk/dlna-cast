import path from "node:path";
import { xmlEscape } from "./xml.mjs";

const MIME_TYPES = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".ts": "video/mp2t",
  ".m2ts": "video/mp2t",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

export function mimeTypeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

// Files: OP=01 (byte-range seeking); flags for streaming transfer, background transfer, connection stall, DLNA 1.5.
export const DLNA_FILE_FLAGS = "01700000000000000000000000000000";
// Live: OP=00 (no seeking), CI=1 (transcoded); flags add sender-paced, as DLNA describes for live streams.
export const DLNA_LIVE_FLAGS = "8D100000000000000000000000000000";

export function contentFeatures({ live = false } = {}) {
  return live
    ? `DLNA.ORG_OP=00;DLNA.ORG_CI=1;DLNA.ORG_FLAGS=${DLNA_LIVE_FLAGS}`
    : `DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${DLNA_FILE_FLAGS}`;
}

function upnpClass(mimeType) {
  if (mimeType.startsWith("audio/")) return "object.item.audioItem.musicTrack";
  if (mimeType.startsWith("image/")) return "object.item.imageItem.photo";
  return "object.item.videoItem";
}

export function buildDidl({ url, title, mimeType, size, live = false }) {
  const sizeAttribute = Number.isFinite(size) ? ` size="${size}"` : "";
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="0" parentID="-1" restricted="1">' +
    `<dc:title>${xmlEscape(title)}</dc:title>` +
    `<upnp:class>${upnpClass(mimeType)}</upnp:class>` +
    `<res protocolInfo="http-get:*:${xmlEscape(mimeType)}:${contentFeatures({ live })}"${sizeAttribute}>${xmlEscape(url)}</res>` +
    "</item></DIDL-Lite>"
  );
}
