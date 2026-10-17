import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { fetchDescription } from "../src/description.mjs";
import { CastController, startGuiServer } from "../src/gui/server.mjs";
import { startFakeRenderer } from "../fixtures/fake-renderer.mjs";

let tmpDir;
let mediaFile;

before(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dlna-cast-gui-"));
  process.env.DLNA_CAST_STORE = path.join(tmpDir, "store.json");
  mediaFile = path.join(tmpDir, "Lake Swim.mp4");
  await fs.promises.writeFile(mediaFile, Buffer.alloc(8192, 2));
});

after(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

async function startApp() {
  const renderer = await startFakeRenderer();
  const controller = new CastController({ discover: async () => [] });
  const gui = await startGuiServer({ controller });
  const call = async (pathname, body, headers = {}) => {
    const response = await fetch(new URL(pathname, gui.url), {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-dlna-cast-token": gui.token, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return {
    renderer,
    controller,
    gui,
    call,
    close: async () => {
      await controller.shutdown();
      await gui.close();
      await renderer.close();
    },
  };
}

// fetch() refuses to set Host, so use http.request for the DNS-rebinding check.
function requestWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
}

test("the page carries the token and every API call requires it", async () => {
  const app = await startApp();
  try {
    const page = await fetch(app.gui.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    const html = await page.text();
    assert.ok(html.includes(`content="${app.gui.token}"`));
    assert.ok(!html.includes("__API_TOKEN__"));

    assert.equal((await app.call("/api/state", undefined, { "x-dlna-cast-token": "wrong" })).status, 403);
    assert.equal((await fetch(new URL("/api/state", app.gui.url))).status, 403);
    assert.equal(await requestWithHost(new URL("/api/state", app.gui.url), "evil.example:80"), 421);
    for (const asset of ["/app.css", "/app.js", "/icon.svg"]) {
      assert.equal((await fetch(new URL(asset, app.gui.url))).status, 200, asset);
    }
  } finally {
    await app.close();
  }
});

test("state, selection and input validation", async () => {
  const app = await startApp();
  try {
    let { status, body } = await app.call("/api/state");
    assert.equal(status, 200);
    assert.deepEqual(body.devices, []);
    assert.equal(body.session, null);

    assert.equal((await app.call("/api/cast/file", { path: mediaFile })).status, 409, "no renderer chosen yet");
    assert.equal((await app.call("/api/control", { action: "toggle" })).status, 409, "nothing casting");
    assert.equal((await app.call("/api/devices/select", { key: "uuid:missing" })).status, 404);
    assert.equal((await app.call("/api/devices/probe", { address: "8.8.8.8" })).status, 400);

    app.controller.addDevice(await fetchDescription(app.renderer.location));
    ({ body } = await app.call("/api/state"));
    assert.equal(body.devices.length, 1);
    assert.equal(body.selectedKey, "uuid:fake-renderer-0001");
    assert.equal(body.devices[0].volumeSupported, true);

    assert.equal((await app.call("/api/cast/file", { path: "relative.mp4" })).status, 400);
    assert.equal((await app.call("/api/cast/file", { path: path.join(tmpDir, "missing.mp4") })).status, 400);
    assert.equal((await app.call("/api/cast/screen", { fps: 500 })).status, 409, "no ffmpeg configured");
  } finally {
    await app.close();
  }
});

test("casting a file and controlling it through the API, with live events", async () => {
  const app = await startApp();
  try {
    app.controller.addDevice(await fetchDescription(app.renderer.location));

    const events = [];
    const stream = await fetch(new URL(`/api/events?token=${app.gui.token}`, app.gui.url));
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        events.push(decoder.decode(value));
      }
    })();

    assert.equal((await app.call("/api/cast/file", { path: mediaFile })).status, 200);
    assert.deepEqual(app.renderer.state.actions.slice(0, 3), ["Stop", "SetAVTransportURI", "Play"]);

    let { body } = await app.call("/api/state");
    assert.equal(body.session.title, "Lake Swim");
    assert.equal(body.session.kind, "file");
    assert.deepEqual(body.recentFiles, [mediaFile]);

    assert.equal((await app.call("/api/control", { action: "volume", value: 25 })).status, 200);
    assert.equal(app.renderer.state.volume, 25);
    assert.equal((await app.call("/api/control", { action: "seek", value: 30 })).status, 200);
    assert.equal(app.renderer.state.position, 30);
    assert.equal((await app.call("/api/control", { action: "toggle" })).status, 200);
    assert.equal(app.renderer.state.transport, "PAUSED_PLAYBACK");
    assert.equal((await app.call("/api/control", { action: "warp" })).status, 400);
    assert.equal((await app.call("/api/control", { action: "stop" })).status, 200);
    assert.equal(app.renderer.state.transport, "STOPPED");

    ({ body } = await app.call("/api/state"));
    assert.equal(body.session, null);
    assert.equal(body.lastEnded.reason, "stopped");

    const log = (await app.call("/api/log")).body.map((entry) => entry.message);
    assert.ok(log.includes("Casting Lake Swim to Fake Goggles & TV"));
    assert.ok(log.includes("Stopped Lake Swim"));

    await reader.cancel();
    await pump.catch(() => {});
    const text = events.join("");
    assert.match(text, /^event: state\ndata: /);
    assert.match(text, /event: log\ndata: .*Casting Lake Swim/);
  } finally {
    await app.close();
  }
});
