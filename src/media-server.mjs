import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { contentFeatures, mimeTypeFor } from "./didl.mjs";

const SERVER_HEADER = "dlna-cast/0.2 UPnP/1.0 DLNADOC/1.50";

// Returns null to serve the whole file (no, malformed or multi-range header), "unsatisfiable", or {start, end} inclusive.
export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  if (match[2] !== "" && Number(match[2]) < start) return null;
  if (start >= size) return "unsatisfiable";
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  return { start, end };
}

const stripMappedPrefix = (ip) => (ip?.startsWith("::ffff:") ? ip.slice(7) : ip);

/**
 * Serves either one file (`filePath`, with byte ranges) or a live stream (`live`: a LiveBroadcast, sent chunked
 * from the current point with ranges ignored) at an unguessable path.
 */
export async function startMediaServer({
  filePath = null,
  live = null,
  host,
  port = 0,
  mimeType = filePath ? mimeTypeFor(filePath) : "video/mp2t",
  allow = null,
  onRequest = () => {},
}) {
  if (!filePath === !live) throw new Error("Provide exactly one of filePath or live");
  const size = filePath ? (await fs.promises.stat(filePath)).size : null;
  // An unguessable path so other devices on the network can't find the media.
  const nonce = randomBytes(16).toString("hex");
  const extension = filePath ? path.extname(filePath).toLowerCase() : ".ts";
  const mediaPath = `/media/${nonce}/media${extension}`;
  const allowed = allow ? new Set(allow) : null;
  const stats = { requests: 0, bytesServed: 0 };

  const server = http.createServer((req, res) => {
    stats.requests++;
    const remote = stripMappedPrefix(req.socket.remoteAddress);
    const report = (status) =>
      onRequest({ method: req.method, path: req.url, range: req.headers.range ?? null, status, remote });
    const reject = (status, headers = {}) => {
      res.writeHead(status, { "Content-Length": 0, Connection: "close", ...headers });
      res.end();
      report(status);
    };

    if (allowed && !allowed.has(remote)) return reject(403);
    if (new URL(req.url, "http://media.invalid").pathname !== mediaPath) return reject(404);
    if (req.method !== "GET" && req.method !== "HEAD") return reject(405, { Allow: "GET, HEAD" });

    const dlnaHeaders = {
      "Content-Type": mimeType,
      "transferMode.dlna.org": "Streaming",
      "contentFeatures.dlna.org": contentFeatures({ live: Boolean(live) }),
      Server: SERVER_HEADER,
    };

    if (live) {
      res.writeHead(200, { ...dlnaHeaders, "Accept-Ranges": "none", "Cache-Control": "no-cache" });
      report(200);
      if (req.method === "HEAD") return res.end();
      // Send headers now; otherwise Node holds them until the first video packet and the renderer waits.
      res.flushHeaders();
      live.subscribe(res);
      return;
    }

    const range = parseRange(req.headers.range, size);
    if (range === "unsatisfiable") return reject(416, { "Content-Range": `bytes */${size}` });

    const { start, end } = range ?? { start: 0, end: size - 1 };
    const length = size === 0 ? 0 : end - start + 1;
    const status = range ? 206 : 200;
    res.writeHead(status, {
      ...dlnaHeaders,
      "Content-Length": length,
      "Accept-Ranges": "bytes",
      ...(range && { "Content-Range": `bytes ${start}-${end}/${size}` }),
    });
    report(status);
    if (req.method === "HEAD" || length === 0) return res.end();

    const stream = fs.createReadStream(filePath, { start, end });
    stream.on("data", (chunk) => {
      stats.bytesServed += chunk.length;
    });
    // Renderers routinely drop a connection mid-file when they seek; that is not an error.
    pipeline(stream, res).catch(() => {});
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    url: `http://${host}:${server.address().port}${mediaPath}`,
    mimeType,
    size,
    stats,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
