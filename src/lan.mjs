import os from "node:os";
import net from "node:net";

function toUint32(ip) {
  return ip.split(".").reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

// Private, loopback, link-local and carrier-grade NAT IPv4 ranges.
export function isLanAddress(ip) {
  if (!net.isIPv4(ip)) return false;
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

export function lanInterfaces() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) =>
    (addresses ?? [])
      .filter((a) => a.family === "IPv4" && !a.internal && isLanAddress(a.address))
      .map((a) => ({ name, address: a.address, netmask: a.netmask })),
  );
}

// The local address a renderer can reach us on: the interface sharing its subnet, else the first LAN interface.
export function localAddressFor(remoteIp) {
  if (remoteIp.startsWith("127.")) return "127.0.0.1";
  const remote = toUint32(remoteIp);
  const interfaces = lanInterfaces();
  const sameSubnet = interfaces.find(({ address, netmask }) => {
    const mask = toUint32(netmask);
    return ((toUint32(address) & mask) >>> 0) === ((remote & mask) >>> 0);
  });
  return (sameSubnet ?? interfaces[0])?.address ?? null;
}
