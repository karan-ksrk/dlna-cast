// A loopback DLNA renderer for tests. It serves a description, answers unicast M-SEARCH (unless `silentSearch`,
// like renderers that only send NOTIFY), can announce itself with NOTIFY, advertises formats through
// ConnectionManager, and on Play pulls the media like a TV would: HEAD, then a range and the full body for files,
// or the first packets of a live stream.
import http from "node:http";
import dgram from "node:dgram";

const decode = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

const SINK = "http-get:*:video/mp4:*,http-get:*:video/MP2T:*,http-get:*:audio/mpeg:*";
const LIVE_SAMPLE_BYTES = 188 * 200;

function description(port) {
  return `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <URLBase>http://203.0.113.9:${port}/</URLBase>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>Fake Goggles &amp; TV</friendlyName>
    <manufacturer>Test Co</manufacturer>
    <modelName>FR-1</modelName>
    <UDN>uuid:fake-renderer-0001</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:2</serviceType>
        <serviceId>urn:upnp-org:serviceId:Decoy</serviceId>
        <controlURL>http://198.51.100.7/hijack</controlURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>
        <controlURL>/RenderingControl/control</controlURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>
        <controlURL>/ConnectionManager/control</controlURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>
        <controlURL>/AVTransport/control</controlURL>
      </service>
    </serviceList>
  </device>
</root>`;
}

function soapReply(action, body = "") {
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">${body}</u:${action}Response></s:Body></s:Envelope>`;
}

function soapFault(code, description) {
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${description}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readPrefix(response, bytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    chunks.push(chunk);
    total += chunk.length;
    if (total >= bytes) break;
  }
  return Buffer.concat(chunks);
}

async function pull(uri) {
  const head = await fetch(uri, { method: "HEAD" });
  const headInfo = { status: head.status, headers: Object.fromEntries(head.headers) };
  if (head.headers.get("accept-ranges") === "none") {
    const controller = new AbortController();
    const live = await fetch(uri, { signal: controller.signal });
    const sample = await readPrefix(live, LIVE_SAMPLE_BYTES);
    controller.abort();
    return { head: headInfo, live: { status: live.status, headers: Object.fromEntries(live.headers), sample } };
  }
  const range = await fetch(uri, { headers: { Range: "bytes=10-19" } });
  const full = await fetch(uri);
  return {
    head: headInfo,
    range: {
      status: range.status,
      contentRange: range.headers.get("content-range"),
      body: Buffer.from(await range.arrayBuffer()),
    },
    full: { status: full.status, body: Buffer.from(await full.arrayBuffer()) },
  };
}

const formatClock = (seconds) => {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export async function startFakeRenderer({ silentSearch = false, ignorePause = false, ignoreVolume = false } = {}) {
  const state = {
    transport: "NO_MEDIA_PRESENT",
    uri: null,
    metadata: null,
    actions: [],
    soapActions: [],
    pulled: null,
    searches: [],
    position: 5,
    duration: 60,
    volume: 40,
    muted: false,
    renderingActions: [],
  };
  let port;

  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/description.xml") {
      res.writeHead(200, { "Content-Type": "text/xml" });
      return res.end(description(port));
    }
    if (req.method !== "POST") return res.writeHead(404).end();

    const body = await readBody(req);
    const action = /#(\w+)"?$/.exec(req.headers.soapaction ?? "")?.[1];
    const ok = (inner) => res.writeHead(200, { "Content-Type": 'text/xml; charset="utf-8"' }).end(soapReply(action, inner));
    const fault = (code, text) => res.writeHead(500, { "Content-Type": "text/xml" }).end(soapFault(code, text));

    const arg = (name) => decode(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1] ?? "");
    if (req.url === "/ConnectionManager/control") {
      return action === "GetProtocolInfo" ? ok(`<Source></Source><Sink>${SINK}</Sink>`) : fault(401, "Invalid Action");
    }
    if (req.url === "/RenderingControl/control") {
      state.renderingActions.push(action);
      if (arg("Channel") !== "Master") return fault(402, "Invalid Args");
      switch (action) {
        case "GetVolume":
          return ok(`<CurrentVolume>${state.volume}</CurrentVolume>`);
        // With ignoreVolume, both setters answer 200 and change nothing, like the Platinum-based goggles.
        case "SetVolume":
          if (!ignoreVolume) state.volume = Number(arg("DesiredVolume"));
          return ok();
        case "GetMute":
          return ok(`<CurrentMute>${state.muted ? 1 : 0}</CurrentMute>`);
        case "SetMute":
          if (!ignoreVolume) state.muted = arg("DesiredMute") === "1";
          return ok();
        default:
          return fault(401, "Invalid Action");
      }
    }
    if (req.url !== "/AVTransport/control") return res.writeHead(404).end();

    state.soapActions.push(req.headers.soapaction);
    state.actions.push(action);
    switch (action) {
      case "Stop":
        state.transport = state.uri ? "STOPPED" : "NO_MEDIA_PRESENT";
        return ok();
      case "SetAVTransportURI":
        state.uri = arg("CurrentURI");
        state.metadata = arg("CurrentURIMetaData");
        state.transport = "STOPPED";
        return ok();
      case "Pause":
        if (state.transport !== "PLAYING") return fault(701, "Transition not available");
        if (!ignorePause) state.transport = "PAUSED_PLAYBACK";
        return ok();
      case "Seek":
        if (arg("Unit") !== "REL_TIME") return fault(710, "Seek mode not supported");
        state.position = arg("Target").split(":").reduce((total, part) => total * 60 + Number(part), 0);
        return ok();
      case "Play":
        if (!state.uri) return fault(701, "Transition not available");
        if (state.transport === "PAUSED_PLAYBACK") {
          state.transport = "PLAYING";
          return ok();
        }
        try {
          state.pulled = await pull(state.uri);
        } catch (error) {
          state.pulled = { error: error.message };
          return fault(716, "Resource not found");
        }
        state.transport = "PLAYING";
        return ok();
      case "GetTransportInfo":
        return ok(
          `<CurrentTransportState>${state.transport}</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed>`,
        );
      case "GetPositionInfo":
        return ok(
          `<Track>1</Track><TrackDuration>${formatClock(state.duration)}</TrackDuration><TrackURI/><RelTime>${formatClock(state.position)}</RelTime>`,
        );
      default:
        return fault(401, "Invalid Action");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  const location = `http://127.0.0.1:${port}/description.xml`;

  const ssdp = dgram.createSocket("udp4");
  ssdp.on("message", (msg, rinfo) => {
    const text = msg.toString("utf8");
    if (!text.startsWith("M-SEARCH")) return;
    state.searches.push(text);
    if (silentSearch) return;
    const reply =
      "HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nEXT:\r\n" +
      `LOCATION: ${location}\r\nSERVER: Fake/1.0 UPnP/1.0\r\n` +
      "ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n" +
      "USN: uuid:fake-renderer-0001::urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n";
    ssdp.send(reply, rinfo.port, rinfo.address);
  });
  await new Promise((resolve) => ssdp.bind(0, "127.0.0.1", resolve));

  return {
    state,
    location,
    ssdpPort: ssdp.address().port,
    /** Sends an ssdp:alive NOTIFY to a listener port on loopback, as a device does on its own. */
    announce(notifyPort) {
      const notify =
        "NOTIFY * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nCACHE-CONTROL: max-age=1800\r\n" +
        `LOCATION: ${location}\r\nNT: urn:schemas-upnp-org:device:MediaRenderer:1\r\nNTS: ssdp:alive\r\n` +
        "SERVER: Fake/1.0 UPnP/1.0\r\nUSN: uuid:fake-renderer-0001::urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n";
      ssdp.send(notify, notifyPort, "127.0.0.1");
    },
    close: () =>
      new Promise((resolve) => {
        ssdp.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
