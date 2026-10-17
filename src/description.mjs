import { isLanAddress } from "./lan.mjs";
import { elementBlocks, elementText } from "./xml.mjs";

const MAX_DESCRIPTION_BYTES = 1024 * 1024;

// Control URLs must stay on the host that served the description, so a device can't redirect our SOAP calls elsewhere.
export function parseDescription(xml, location) {
  const origin = new URL(location);
  const sameHost = (url) => url.protocol === "http:" && url.hostname === origin.hostname;

  let base = origin;
  const urlBase = elementText(xml, "URLBase");
  if (urlBase) {
    try {
      const candidate = new URL(urlBase);
      if (sameHost(candidate)) base = candidate;
    } catch {
      // Malformed URLBase: resolve against the description location instead.
    }
  }

  const services = [];
  for (const block of elementBlocks(xml, "service")) {
    const serviceType = elementText(block, "serviceType");
    const control = elementText(block, "controlURL");
    if (!serviceType || !control) continue;
    let controlURL;
    try {
      controlURL = new URL(control, base);
    } catch {
      continue;
    }
    if (sameHost(controlURL)) services.push({ serviceType, controlURL: controlURL.href });
  }
  const service = (kind) =>
    services.find((s) => s.serviceType.startsWith(`urn:schemas-upnp-org:service:${kind}:`)) ?? null;

  return {
    friendlyName: elementText(xml, "friendlyName") ?? "Unknown device",
    manufacturer: elementText(xml, "manufacturer"),
    modelName: elementText(xml, "modelName"),
    deviceType: elementText(xml, "deviceType"),
    udn: elementText(xml, "UDN"),
    location: origin.href,
    host: origin.hostname,
    avTransport: service("AVTransport"),
    renderingControl: service("RenderingControl"),
    connectionManager: service("ConnectionManager"),
  };
}

async function readCapped(response, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`Device description exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function fetchDescription(location, { timeoutMs = 4000 } = {}) {
  const { hostname, protocol } = new URL(location);
  if (protocol !== "http:" || !isLanAddress(hostname)) {
    throw new Error(`Refusing non-LAN description URL ${location}`);
  }
  const response = await fetch(location, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  if (!response.ok) throw new Error(`Description ${location} returned HTTP ${response.status}`);
  return parseDescription(await readCapped(response, MAX_DESCRIPTION_BYTES), location);
}
