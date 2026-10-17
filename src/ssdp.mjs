import dgram from "node:dgram";
import { isLanAddress, lanInterfaces, localAddressFor } from "./lan.mjs";
import { fetchDescription } from "./description.mjs";

export const SSDP_ADDRESS = "239.255.255.250";
export const SSDP_PORT = 1900;
export const RENDERER_SEARCH_TARGETS = [
  "urn:schemas-upnp-org:device:MediaRenderer:1",
  "urn:schemas-upnp-org:service:AVTransport:1",
  "upnp:rootdevice",
];
const SEARCH_INTERVAL_MS = 3000;

// Description paths common renderers use, tried when a device answers HTTP but not SSDP.
const DESCRIPTION_PATHS = [
  "/",
  "/description.xml",
  "/desc.xml",
  "/rootDesc.xml",
  "/upnp/rootDesc.xml",
  "/upnp/dev/description.xml",
  "/dmr/SatipServerDesc.xml",
];

export function buildSearchRequest(searchTarget, { host = `${SSDP_ADDRESS}:${SSDP_PORT}`, mx = 2 } = {}) {
  return (
    "M-SEARCH * HTTP/1.1\r\n" +
    `HOST: ${host}\r\n` +
    'MAN: "ssdp:discover"\r\n' +
    `MX: ${mx}\r\n` +
    `ST: ${searchTarget}\r\n\r\n`
  );
}

export function parseSsdpMessage(text) {
  const [startLine = "", ...lines] = text.split(/\r?\n/);
  const headers = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { startLine: startLine.trim(), headers };
}

// Trust a LOCATION only on a LAN address matching the host that sent it.
export function acceptableLocation(location, senderIp) {
  try {
    const url = new URL(location);
    return url.protocol === "http:" && url.hostname === senderIp && isLanAddress(senderIp);
  } catch {
    return false;
  }
}

// A device's LOCATION from either an M-SEARCH reply or an ssdp:alive NOTIFY, or null.
export function advertisedLocation(text) {
  const { startLine, headers } = parseSsdpMessage(text);
  if (!headers.location) return null;
  if (/^HTTP\/1\.[01] 200/i.test(startLine)) return headers.location;
  if (/^NOTIFY /i.test(startLine) && /ssdp:alive/i.test(headers.nts ?? "")) return headers.location;
  return null;
}

function closeQuietly(socket) {
  try {
    socket.close();
  } catch {
    // Already closed.
  }
}

/**
 * Finds renderers two ways at once: active M-SEARCH (repeated every few seconds) and a
 * passive listener for the NOTIFY announcements devices multicast on their own. Some renderers only do the latter.
 *
 * - `ip` restricts discovery to one device: unicast M-SEARCH to it, and only its NOTIFYs count.
 * - `settleMs` ends discovery that long after the first renderer appears, instead of waiting for `timeoutMs`.
 */
export function discoverRenderers({
  timeoutMs = 8000,
  settleMs = null,
  ip = null,
  port = SSDP_PORT,
  notifyPort = SSDP_PORT,
  multicast = true,
  searchTargets = RENDERER_SEARCH_TARGETS,
  onDevice = () => {},
} = {}) {
  return new Promise((resolve) => {
    const devices = new Map();
    const seenLocations = new Set();
    const pending = new Set();
    const sockets = [];
    const timers = [];
    let settleTimer = null;
    let finished = false;

    const finish = async () => {
      if (finished) return;
      finished = true;
      timers.forEach((t) => clearTimeout(t));
      clearTimeout(settleTimer);
      sockets.forEach(closeQuietly);
      await Promise.allSettled([...pending]);
      resolve([...devices.values()]);
    };

    const consider = (location, from) => {
      if (finished || seenLocations.has(location)) return;
      if (ip && from !== ip) return;
      if (!acceptableLocation(location, from)) return;
      seenLocations.add(location);
      const lookup = fetchDescription(location)
        .then((device) => {
          if (!device.avTransport) return;
          const key = device.udn ?? device.location;
          if (devices.has(key)) return;
          devices.set(key, device);
          onDevice(device);
          if (settleMs !== null && !settleTimer) settleTimer = setTimeout(finish, settleMs);
        })
        .catch(() => {
          // Allow a later announcement to retry a description that failed to load.
          seenLocations.delete(location);
        });
      pending.add(lookup);
      lookup.finally(() => pending.delete(lookup));
    };

    const onMessage = (buffer, rinfo) => {
      const location = advertisedLocation(buffer.toString("utf8"));
      if (location) consider(location, rinfo.address);
    };

    // Passive: devices announce themselves to 239.255.255.250:1900 every few seconds.
    const listener = dgram.createSocket({ type: "udp4", reuseAddr: true });
    sockets.push(listener);
    listener.on("error", () => closeQuietly(listener));
    listener.on("message", onMessage);
    listener.bind(notifyPort, () => {
      const interfaces = lanInterfaces();
      for (const { address } of interfaces) {
        try {
          listener.addMembership(SSDP_ADDRESS, address);
        } catch {
          // Interface without multicast; others may still work.
        }
      }
      if (!interfaces.length) {
        try {
          listener.addMembership(SSDP_ADDRESS);
        } catch {
          // No multicast at all; unicast searches still work.
        }
      }
    });

    // Active: M-SEARCH from each interface, or unicast to one device.
    const searches = ip
      ? [{ bindAddress: localAddressFor(ip) ?? "0.0.0.0", destination: ip }]
      : multicast
        ? (lanInterfaces().length ? lanInterfaces().map((i) => i.address) : ["0.0.0.0"]).map((bindAddress) => ({
            bindAddress,
            destination: SSDP_ADDRESS,
          }))
        : [];
    for (const { bindAddress, destination } of searches) {
      const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
      sockets.push(socket);
      socket.on("error", () => closeQuietly(socket));
      socket.on("message", onMessage);
      socket.bind({ address: bindAddress, port: 0 }, () => {
        if (destination === SSDP_ADDRESS && bindAddress !== "0.0.0.0") {
          try {
            socket.setMulticastInterface(bindAddress);
            socket.setMulticastTTL(2);
          } catch {
            // Keep the OS default route.
          }
        }
        const sendAll = () => {
          if (finished) return;
          for (const target of searchTargets) {
            socket.send(buildSearchRequest(target, { host: `${destination}:${port}` }), port, destination, () => {});
          }
        };
        // UDP drops packets, and some devices wake up late: repeat the search until discovery ends.
        sendAll();
        timers.push(setTimeout(sendAll, 300));
        for (let at = SEARCH_INTERVAL_MS; at < timeoutMs; at += SEARCH_INTERVAL_MS) timers.push(setTimeout(sendAll, at));
      });
    }

    timers.push(setTimeout(finish, timeoutMs));
  });
}

// One known device: unicast M-SEARCH plus its NOTIFYs, then common description paths if an HTTP port is known.
export async function probeDevice(ip, { port = SSDP_PORT, notifyPort = SSDP_PORT, httpPort = null, timeoutMs = 8000 } = {}) {
  if (!isLanAddress(ip)) throw new Error(`${ip} is not a local network IPv4 address`);
  if (httpPort) {
    for (const path of DESCRIPTION_PATHS) {
      try {
        const device = await fetchDescription(`http://${ip}:${httpPort}${path}`, { timeoutMs: 1500 });
        if (device.avTransport) return [device];
      } catch {
        // Try the next path.
      }
    }
  }
  return discoverRenderers({
    ip,
    port,
    notifyPort,
    timeoutMs,
    settleMs: 0,
    searchTargets: ["ssdp:all", ...RENDERER_SEARCH_TARGETS],
  });
}
