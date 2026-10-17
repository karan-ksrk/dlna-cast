import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { isLanAddress } from "../src/lan.mjs";
import { parseDescription, fetchDescription } from "../src/description.mjs";
import dgram from "node:dgram";
import { PassThrough } from "node:stream";
import {
  acceptableLocation,
  advertisedLocation,
  buildSearchRequest,
  discoverRenderers,
  parseSsdpMessage,
  probeDevice,
} from "../src/ssdp.mjs";
import { parseRange, startMediaServer } from "../src/media-server.mjs";
import { buildDidl, contentFeatures } from "../src/didl.mjs";
import { avTransport, buildEnvelope, formatTime, invoke, parseActionResponse, parseFault, UpnpError } from "../src/soap.mjs";
import { castFile, castScreen, pickMimeType } from "../src/cast.mjs";
import { LiveBroadcast } from "../src/live-broadcast.mjs";
import { buildScreenArgs, findFfmpeg } from "../src/ffmpeg.mjs";
import { startFakeRenderer } from "../fixtures/fake-renderer.mjs";

let tmpDir;
let mediaFile;
let mediaBytes;

// A free UDP port for the NOTIFY listener, so tests never compete with the real port 1900.
async function freeUdpPort() {
  const socket = dgram.createSocket("udp4");
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

before(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dlna-cast-"));
  mediaFile = path.join(tmpDir, "Holiday Clip.mp4");
  mediaBytes = randomBytes(1000);
  await fs.promises.writeFile(mediaFile, mediaBytes);
});

after(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test("isLanAddress accepts private, loopback and link-local IPv4 only", () => {
  for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.20", "169.254.3.4", "100.64.0.1", "127.0.0.1"]) {
    assert.equal(isLanAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "::1", "example.com"]) {
    assert.equal(isLanAddress(ip), false, ip);
  }
});

test("SSDP request and reply parsing", () => {
  const request = buildSearchRequest("ssdp:all");
  assert.match(request, /^M-SEARCH \* HTTP\/1\.1\r\nHOST: 239\.255\.255\.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n$/);
  const { startLine, headers } = parseSsdpMessage("HTTP/1.1 200 OK\r\nLocation: http://192.168.1.5:8080/d.xml\r\nusn: uuid:x\r\n\r\n");
  assert.equal(startLine, "HTTP/1.1 200 OK");
  assert.equal(headers.location, "http://192.168.1.5:8080/d.xml");
  assert.equal(headers.usn, "uuid:x");
});

test("LOCATION must match the sender and be on the LAN", () => {
  assert.equal(acceptableLocation("http://192.168.1.5:8080/d.xml", "192.168.1.5"), true);
  assert.equal(acceptableLocation("http://192.168.1.9:8080/d.xml", "192.168.1.5"), false);
  assert.equal(acceptableLocation("http://8.8.8.8/d.xml", "8.8.8.8"), false);
  assert.equal(acceptableLocation("not a url", "192.168.1.5"), false);
});

test("parseDescription resolves control URLs and drops foreign hosts", () => {
  const xml = `<root><URLBase>http://203.0.113.1/</URLBase><device>
    <friendlyName>Living Room &amp; Den</friendlyName><UDN>uuid:abc</UDN>
    <serviceList>
      <service><serviceType>urn:schemas-upnp-org:service:AVTransport:2</serviceType><controlURL>ctl/av</controlURL></service>
      <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>http://203.0.113.1/rc</controlURL></service>
    </serviceList></device></root>`;
  const device = parseDescription(xml, "http://192.168.1.50:49152/desc/root.xml");
  assert.equal(device.friendlyName, "Living Room & Den");
  assert.equal(device.udn, "uuid:abc");
  assert.equal(device.host, "192.168.1.50");
  // The foreign URLBase is ignored, so the relative URL resolves against the description location.
  assert.deepEqual(device.avTransport, {
    serviceType: "urn:schemas-upnp-org:service:AVTransport:2",
    controlURL: "http://192.168.1.50:49152/desc/ctl/av",
  });
  assert.equal(device.renderingControl, null);
});

test("parseRange handles explicit, open, suffix, invalid and unsatisfiable ranges", () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=50-500", 100), { start: 50, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-500", 100), { start: 0, end: 99 });
  assert.equal(parseRange("bytes=9-3", 100), null);
  assert.equal(parseRange("bytes=0-1,5-6", 100), null);
  assert.equal(parseRange("items=0-1", 100), null);
  assert.equal(parseRange("bytes=100-", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 100), "unsatisfiable");
});

test("media server serves full files, ranges and HEAD, and rejects everything else", async () => {
  const seen = [];
  const media = await startMediaServer({ filePath: mediaFile, host: "127.0.0.1", onRequest: (r) => seen.push(r.status) });
  try {
    assert.match(media.url, /^http:\/\/127\.0\.0\.1:\d+\/media\/[0-9a-f]{32}\/media\.mp4$/);

    const full = await fetch(media.url);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "video/mp4");
    assert.equal(full.headers.get("accept-ranges"), "bytes");
    assert.equal(full.headers.get("transfermode.dlna.org"), "Streaming");
    assert.match(full.headers.get("contentfeatures.dlna.org"), /^DLNA\.ORG_OP=01;/);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), mediaBytes);

    const part = await fetch(media.url, { headers: { Range: "bytes=-100" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 900-999/1000");
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), mediaBytes.subarray(900));

    const head = await fetch(media.url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "1000");

    assert.equal((await fetch(media.url, { headers: { Range: "bytes=5000-" } })).status, 416);
    assert.equal((await fetch(media.url, { method: "POST" })).status, 405);
    assert.equal((await fetch(media.url.replace(/[0-9a-f]{32}/, "0".repeat(32)))).status, 404);
    assert.deepEqual(seen, [200, 206, 200, 416, 405, 404]);
  } finally {
    await media.close();
  }
});

test("media server only answers allowed addresses", async () => {
  const media = await startMediaServer({ filePath: mediaFile, host: "127.0.0.1", allow: ["192.168.1.77"] });
  try {
    assert.equal((await fetch(media.url)).status, 403);
  } finally {
    await media.close();
  }
});

test("DIDL metadata survives SOAP escaping", () => {
  const didl = buildDidl({ url: "http://192.168.1.2:9000/media/x/media.mp4?v=1&a=2", title: "Tom & Jerry <HD>", mimeType: "video/mp4", size: 1000 });
  assert.match(didl, /<dc:title>Tom &amp; Jerry &lt;HD&gt;<\/dc:title>/);
  assert.match(didl, /<upnp:class>object\.item\.videoItem<\/upnp:class>/);
  assert.match(didl, /protocolInfo="http-get:\*:video\/mp4:DLNA\.ORG_OP=01;DLNA\.ORG_CI=0;DLNA\.ORG_FLAGS=01700000000000000000000000000000" size="1000"/);
  assert.match(didl, /media\.mp4\?v=1&amp;a=2<\/res>/);

  const envelope = buildEnvelope("urn:schemas-upnp-org:service:AVTransport:1", "SetAVTransportURI", [["CurrentURIMetaData", didl]]);
  assert.ok(!envelope.includes("<DIDL-Lite"), "DIDL must be escaped inside the SOAP body");
  assert.ok(envelope.includes("&lt;DIDL-Lite"));
});

test("SOAP response and fault parsing", () => {
  const reply = `<s:Envelope><s:Body><u:GetPositionInfoResponse xmlns:u="x"><Track>1</Track><TrackURI/><RelTime>0:00:05</RelTime><TrackMetaData>&lt;DIDL-Lite/&gt;</TrackMetaData></u:GetPositionInfoResponse></s:Body></s:Envelope>`;
  assert.deepEqual(parseActionResponse(reply, "GetPositionInfo"), { Track: "1", TrackURI: "", RelTime: "0:00:05", TrackMetaData: "<DIDL-Lite/>" });
  const fault = `<s:Fault><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>714</errorCode><errorDescription>Illegal MIME-type</errorDescription></UPnPError></detail></s:Fault>`;
  assert.deepEqual(parseFault(fault), { code: 714, description: "Illegal MIME-type" });
  assert.equal(parseFault("<html>500</html>"), null);
  assert.equal(formatTime(3725.9), "1:02:05");
});

test("unicast SSDP probe finds the fake renderer", async () => {
  const renderer = await startFakeRenderer();
  try {
    const devices = await probeDevice("127.0.0.1", {
      port: renderer.ssdpPort,
      notifyPort: await freeUdpPort(),
      timeoutMs: 2000,
    });
    assert.equal(devices.length, 1);
    assert.equal(devices[0].friendlyName, "Fake Goggles & TV");
    assert.equal(devices[0].avTransport.controlURL, `${new URL(renderer.location).origin}/AVTransport/control`);
    assert.match(renderer.state.searches[0], /^M-SEARCH \* HTTP\/1\.1\r\n.*ST: ssdp:all/s);
  } finally {
    await renderer.close();
  }
});

test("castFile serves the file, sets the URI with DIDL and plays end to end", async () => {
  const renderer = await startFakeRenderer();
  try {
    const device = await fetchDescription(renderer.location);
    const { media, transport } = await castFile(device, mediaFile);
    try {
      const { state } = renderer;
      assert.deepEqual(state.actions, ["Stop", "SetAVTransportURI", "Play"]);
      assert.equal(state.soapActions[1], '"urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI"');
      assert.equal(state.uri, media.url);
      assert.match(state.metadata, /^<DIDL-Lite .*<dc:title>Holiday Clip<\/dc:title>.*<res protocolInfo="http-get:\*:video\/mp4:DLNA\.ORG_OP=01;/s);

      assert.equal(state.pulled.head.status, 200);
      assert.equal(state.pulled.range.status, 206);
      assert.equal(state.pulled.range.contentRange, "bytes 10-19/1000");
      assert.deepEqual(state.pulled.range.body, mediaBytes.subarray(10, 20));
      assert.deepEqual(state.pulled.full.body, mediaBytes);

      assert.equal((await transport.transportInfo()).CurrentTransportState, "PLAYING");
      assert.equal((await transport.positionInfo()).RelTime, "0:00:05");
      await transport.stop();
      assert.equal((await transport.transportInfo()).CurrentTransportState, "STOPPED");
    } finally {
      await media.close();
    }
  } finally {
    await renderer.close();
  }
});

test("renderer faults surface as UpnpError with the UPnP code", async () => {
  const renderer = await startFakeRenderer();
  try {
    const transport = avTransport(await fetchDescription(renderer.location));
    await assert.rejects(transport.play(), (error) => error instanceof UpnpError && error.code === 701 && error.status === 500);
    await assert.rejects(transport.pause(), (error) => error instanceof UpnpError && error.code === 701);
    const device = await fetchDescription(renderer.location);
    await assert.rejects(invoke(device.avTransport, "Bogus", []), (error) => error instanceof UpnpError && error.code === 401);
  } finally {
    await renderer.close();
  }
});

test("advertisedLocation accepts search replies and ssdp:alive, ignores byebye and searches", () => {
  const alive = "NOTIFY * HTTP/1.1\r\nLOCATION: http://192.168.1.42:2039/\r\nNTS: ssdp:alive\r\n\r\n";
  const byebye = "NOTIFY * HTTP/1.1\r\nLOCATION: http://192.168.1.42:2039/\r\nNTS: ssdp:byebye\r\n\r\n";
  const reply = "HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.42:2039/\r\n\r\n";
  assert.equal(advertisedLocation(alive), "http://192.168.1.42:2039/");
  assert.equal(advertisedLocation(reply), "http://192.168.1.42:2039/");
  assert.equal(advertisedLocation(byebye), null);
  assert.equal(advertisedLocation(buildSearchRequest("ssdp:all")), null);
});

test("discovery finds a renderer that only announces itself with NOTIFY", async () => {
  const renderer = await startFakeRenderer({ silentSearch: true });
  try {
    const notifyPort = await freeUdpPort();
    const found = [];
    const discovery = discoverRenderers({ multicast: false, notifyPort, timeoutMs: 3000, settleMs: 0, onDevice: (d) => found.push(d) });
    setTimeout(() => renderer.announce(notifyPort), 200);
    const devices = await discovery;
    assert.equal(devices.length, 1);
    assert.equal(devices[0].friendlyName, "Fake Goggles & TV");
    assert.deepEqual(found.map((d) => d.udn), ["uuid:fake-renderer-0001"]);
  } finally {
    await renderer.close();
  }
});

test("probing a NOTIFY-only device by IP still finds it", async () => {
  const renderer = await startFakeRenderer({ silentSearch: true });
  try {
    const notifyPort = await freeUdpPort();
    const probing = probeDevice("127.0.0.1", { port: renderer.ssdpPort, notifyPort, timeoutMs: 3000 });
    setTimeout(() => renderer.announce(notifyPort), 300);
    const [device] = await probing;
    assert.equal(device?.udn, "uuid:fake-renderer-0001");
    assert.ok(renderer.state.searches.length > 0, "a unicast M-SEARCH was still sent");
  } finally {
    await renderer.close();
  }
});

test("pickMimeType uses the renderer's spelling and flags unsupported types", () => {
  const sinks = ["http-get:*:video/mp4:*", "http-get:*:video/MP2T:*"];
  assert.deepEqual(pickMimeType(sinks, "video/mp2t"), { mimeType: "video/MP2T", supported: true });
  assert.deepEqual(pickMimeType(sinks, "video/x-matroska"), { mimeType: "video/x-matroska", supported: false });
  assert.deepEqual(pickMimeType(["http-get:*:*:*"], "video/webm"), { mimeType: "video/webm", supported: true });
  assert.deepEqual(pickMimeType(null, "video/mp4"), { mimeType: "video/mp4", supported: null });
});

test("LiveBroadcast sends whole TS packets and drops data for clients that fall behind", () => {
  const live = new LiveBroadcast({ maxBacklogBytes: 1000 });
  const fast = { writableLength: 0, written: [], write(b) { this.written.push(Buffer.from(b)); }, once() {}, end() { this.ended = true; } };
  const slow = { writableLength: 5000, written: [], write(b) { this.written.push(Buffer.from(b)); }, once() {}, end() { this.ended = true; } };
  live.subscribe(fast);
  live.subscribe(slow);

  const packets = Buffer.alloc(188 * 3, 0x47);
  live.push(packets.subarray(0, 300)); // 1 whole packet + 112 bytes held back
  live.push(packets.subarray(300)); // completes the remaining 2 packets
  assert.deepEqual(fast.written.map((b) => b.length), [188, 376]);
  assert.equal(slow.written.length, 0);
  assert.equal(live.skippedBytes, 564);
  assert.equal(live.bytesSent, 564);

  live.end();
  assert.ok(fast.ended && slow.ended);
  const late = { written: [], write() {}, once() {}, end() { this.ended = true; } };
  live.subscribe(late);
  assert.ok(late.ended, "subscribing after the end closes the client at once");
});

test("live media server streams chunked MPEG-TS with live DLNA headers", async () => {
  const live = new LiveBroadcast();
  const media = await startMediaServer({ live, host: "127.0.0.1", mimeType: "video/MP2T" });
  try {
    assert.match(media.url, /\/media\/[0-9a-f]{32}\/media\.ts$/);
    const head = await fetch(media.url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("accept-ranges"), "none");
    assert.equal(head.headers.get("content-type"), "video/MP2T");
    assert.equal(head.headers.get("contentfeatures.dlna.org"), contentFeatures({ live: true }));
    assert.match(contentFeatures({ live: true }), /^DLNA\.ORG_OP=00;DLNA\.ORG_CI=1;DLNA\.ORG_FLAGS=8D1/);

    const response = await fetch(media.url, { headers: { Range: "bytes=0-" } });
    assert.equal(response.status, 200, "live streams ignore Range");
    const reader = response.body.getReader();
    await new Promise((resolve) => setTimeout(resolve, 50));
    live.push(Buffer.alloc(188 * 2, 0x47));
    const { value } = await reader.read();
    assert.equal(value.length, 376);
    await reader.cancel();
  } finally {
    live.end();
    await media.close();
  }
});

test("buildScreenArgs wires capture, audio, encoder and the MPEG-TS muxer", () => {
  const gpu = buildScreenArgs({ capture: "ddagrab", monitor: 1, fps: 60, encoder: "nvenc", bitrateKbps: 8000, audio: { pipe: { format: "f32le", rate: 48000, channels: 2 } } });
  const joined = gpu.join(" ");
  assert.match(joined, /-f lavfi -i ddagrab=output_idx=1:framerate=60:draw_mouse=1/);
  assert.match(joined, /-f f32le -ar 48000 -ac 2 -i pipe:0/);
  assert.match(joined, /-vf hwdownload,format=bgra,scale=-2:'trunc\(min\(1080,ih\)\/2\)\*2',format=nv12/);
  assert.match(joined, /-c:v h264_nvenc .*-b:v 8000k .*-g 60 -bf 0/);
  assert.match(joined, /-f mpegts .*pipe:1$/);

  const software = buildScreenArgs({ capture: "gdigrab", encoder: "x264", drawMouse: false });
  assert.match(software.join(" "), /-f gdigrab -framerate 30 -draw_mouse 0 -i desktop/);
  assert.match(software.join(" "), /anullsrc=channel_layout=stereo:sample_rate=48000/);
  assert.match(software.join(" "), /-c:v libx264 -preset veryfast -tune zerolatency/);
  assert.ok(!software.join(" ").includes("hwdownload"));

  assert.match(buildScreenArgs({ capture: "gdigrab", audio: { dshow: "Stereo Mix (Realtek)" } }).join(" "), /-f dshow -audio_buffer_size 50 -i audio=Stereo Mix \(Realtek\)/);
  assert.throws(() => buildScreenArgs({ encoder: "vp9" }), /Unknown encoder/);
});

const ffmpegPath = findFfmpeg();
test("castScreen streams a live ffmpeg test pattern to the renderer", { skip: !ffmpegPath && "ffmpeg not found" }, async () => {
  const renderer = await startFakeRenderer();
  try {
    const device = await fetchDescription(renderer.location);
    const session = await castScreen(device, { ffmpegPath, capture: "testsrc", encoder: "x264", audio: "none", fps: 15, bitrateKbps: 800 });
    try {
      assert.equal(session.capture, "testsrc");
      assert.equal(session.encoder, "x264");
      const { state } = renderer;
      assert.deepEqual(state.actions, ["Stop", "SetAVTransportURI", "Play"]);
      assert.match(state.metadata, /protocolInfo="http-get:\*:video\/MP2T:DLNA\.ORG_OP=00;DLNA\.ORG_CI=1;/);
      assert.ok(!/ size=/.test(state.metadata), "live streams have no size");

      const { head, live } = state.pulled;
      assert.equal(head.headers["content-type"], "video/MP2T");
      assert.equal(live.status, 200);
      assert.ok(live.sample.length >= 188 * 200);
      for (let offset = 0; offset < 188 * 200; offset += 188) {
        assert.equal(live.sample[offset], 0x47, `TS sync byte at ${offset}`);
      }
    } finally {
      await session.close();
    }
  } finally {
    await renderer.close();
  }
});
