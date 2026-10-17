import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { fetchDescription } from "../src/description.mjs";
import { parseSeekInput, parseTime, renderingControl } from "../src/soap.mjs";
import { CastSession, IgnoredCommandError, pauseAndConfirm, readDeviceStatus } from "../src/session.mjs";
import { startFakeRenderer } from "../fixtures/fake-renderer.mjs";

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");

let tmpDir;
let mediaFile;

before(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dlna-cast-controls-"));
  // Keep the user's real ~/.dlna-cast.json out of the tests.
  process.env.DLNA_CAST_STORE = path.join(tmpDir, "store.json");
  mediaFile = path.join(tmpDir, "clip.mp4");
  await fs.promises.writeFile(mediaFile, Buffer.alloc(4096, 1));
});

after(async () => {
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

const waitFor = async (predicate, timeoutMs = 3000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test("parseTime reads renderer clocks", () => {
  assert.equal(parseTime("0:00:05"), 5);
  assert.equal(parseTime("01:02:03.500"), 3723.5);
  assert.equal(parseTime("NOT_IMPLEMENTED"), null);
  assert.equal(parseTime(""), null);
  assert.equal(parseTime(undefined), null);
});

test("parseSeekInput accepts absolute and relative times", () => {
  assert.deepEqual(parseSeekInput("90"), { seconds: 90, relative: false });
  assert.deepEqual(parseSeekInput("1:30"), { seconds: 90, relative: false });
  assert.deepEqual(parseSeekInput("0:01:30"), { seconds: 90, relative: false });
  assert.deepEqual(parseSeekInput("+30"), { seconds: 30, relative: true });
  assert.deepEqual(parseSeekInput("-1:00"), { seconds: -60, relative: true });
  assert.deepEqual(parseSeekInput(" 2:00:00 "), { seconds: 7200, relative: false });
  for (const bad of ["", "abc", "1:75", "1:2:3:4", "--5", "1::2"]) assert.equal(parseSeekInput(bad), null, bad);
});

test("renderingControl reads and sets volume and mute on the Master channel", async () => {
  const renderer = await startFakeRenderer();
  try {
    const rendering = renderingControl(await fetchDescription(renderer.location));
    assert.equal(rendering.supported, true);
    assert.equal(await rendering.getVolume(), 40);
    await rendering.setVolume(140);
    assert.equal(renderer.state.volume, 100, "volume is clamped to 0-100");
    await rendering.setMute(true);
    assert.equal(await rendering.getMute(), true);
    assert.equal(renderingControl({ renderingControl: null }).supported, false);
  } finally {
    await renderer.close();
  }
});

test("CastSession pauses, resumes, seeks, changes volume and stops", async () => {
  const renderer = await startFakeRenderer();
  try {
    const device = await fetchDescription(renderer.location);
    const session = await CastSession.startFile(device, mediaFile);
    const statuses = [];
    session.on("status", (snapshot) => statuses.push(snapshot));
    session.start(50);
    await waitFor(() => session.status.state === "PLAYING" && session.status.volume === 40);
    assert.equal(session.status.duration, 60);

    await session.pause();
    assert.equal(renderer.state.transport, "PAUSED_PLAYBACK");
    await session.togglePause();
    assert.equal(renderer.state.transport, "PLAYING");

    assert.equal(await session.seek(10, { relative: true }), 15);
    assert.equal(renderer.state.position, 15);
    assert.equal(await session.seek(500), 59, "seeks clamp to just before the end");

    assert.equal(await session.setVolume(70), 70);
    assert.equal(await session.changeVolume(-80), 0);
    assert.equal(renderer.state.volume, 0);
    assert.equal(await session.toggleMute(), true);
    assert.equal(renderer.state.muted, true);

    const ended = new Promise((resolve) => session.once("ended", resolve));
    await session.stop();
    assert.deepEqual(await ended, { reason: "stopped", error: null, detail: null });
    assert.equal(renderer.state.transport, "STOPPED");
    assert.equal(session.ended, true);
    assert.ok(statuses.some((s) => s.state === "PAUSED_PLAYBACK"));
    assert.equal((await fetch(session.media.url).catch(() => null))?.status, undefined, "media server is closed");
  } finally {
    await renderer.close();
  }
});

test("CastSession ends when the renderer stops playing for two polls", async () => {
  const renderer = await startFakeRenderer();
  try {
    const session = await CastSession.startFile(await fetchDescription(renderer.location), mediaFile);
    const ended = new Promise((resolve) => session.once("ended", resolve));
    session.start(40);
    await waitFor(() => session.status.state === "PLAYING");
    renderer.state.transport = "STOPPED";
    assert.equal((await ended).reason, "renderer-stopped");
  } finally {
    await renderer.close();
  }
});

test("pauseAndConfirm reports a renderer that ignores Pause", async () => {
  const renderer = await startFakeRenderer({ ignorePause: true });
  try {
    const device = await fetchDescription(renderer.location);
    const session = await CastSession.startFile(device, mediaFile);
    try {
      await assert.rejects(pauseAndConfirm(device), /accepted Pause but kept playing/);
    } finally {
      await session.stop();
    }
  } finally {
    await renderer.close();
  }
});

test("live sessions refuse to seek and count bytes from the broadcast", async () => {
  const renderer = await startFakeRenderer();
  try {
    const device = await fetchDescription(renderer.location);
    const stream = { events: new EventEmitter(), broadcast: { bytesSent: 1234 } };
    const session = new CastSession({ device, kind: "screen", title: "Desktop", media: {}, transport: {}, stream, close: async () => {} });
    await assert.rejects(session.seek(10), /can't be seeked/);
    assert.equal(session.snapshot().bytesSent, 1234);
    assert.equal(session.snapshot().seekable, false);
  } finally {
    await renderer.close();
  }
});

test("readDeviceStatus reports state, position and volume", async () => {
  const renderer = await startFakeRenderer();
  try {
    const status = await readDeviceStatus(await fetchDescription(renderer.location));
    assert.deepEqual(status, { state: "NO_MEDIA_PRESENT", position: 5, duration: 60, uri: null, volume: 40, muted: false });
  } finally {
    await renderer.close();
  }
});

test("CLI control commands drive the renderer", async () => {
  const renderer = await startFakeRenderer();
  const cli = (...args) =>
    run(process.execPath, [CLI, ...args, "--location", renderer.location], { env: { ...process.env } }).then((r) => r.stdout.trim());
  try {
    assert.equal(await cli("volume"), "Volume 40");
    assert.equal(await cli("volume", "65"), "Volume 65");
    assert.equal(await cli("volume", "-10"), "Volume 55");
    assert.equal(renderer.state.volume, 55);
    assert.equal(await cli("mute"), "Muted Fake Goggles & TV");
    assert.equal(renderer.state.muted, true);
    assert.equal(await cli("seek", "1:30"), "Seeked Fake Goggles & TV to 0:01:30");
    assert.equal(await cli("seek", "-30"), "Seeked Fake Goggles & TV to 0:01:00");
    assert.equal(renderer.state.position, 60);
    assert.match(await cli("status"), /^Fake Goggles & TV: Idle {2}0:01:00 \/ 0:01:00 {2}vol 55 \(muted\)$/);
    await assert.rejects(cli("seek", "soon"), (error) => error.code === 2 && /Usage: dlna-cast seek/.test(error.stderr));
  } finally {
    await renderer.close();
  }
});

test("a renderer that ignores volume and mute is reported, and the session stops offering them", async () => {
  const renderer = await startFakeRenderer({ ignoreVolume: true });
  try {
    const session = await CastSession.startFile(await fetchDescription(renderer.location), mediaFile);
    try {
      await assert.rejects(session.setVolume(70), (error) => error instanceof IgnoredCommandError && /still reports 40/.test(error.message));
      assert.equal(session.snapshot().volumeSupported, false);
      assert.equal(session.snapshot().volumeIgnored, true);
      assert.equal(session.status.volume, 40, "the reported volume is kept, not the requested one");
      await assert.rejects(session.toggleMute(), /ignores remote volume and mute/);
    } finally {
      await session.stop();
    }
  } finally {
    await renderer.close();
  }
});

test("CLI volume and mute say so when the renderer ignores them", async () => {
  const renderer = await startFakeRenderer({ ignoreVolume: true });
  const cli = (...args) => run(process.execPath, [CLI, ...args, "--location", renderer.location]);
  try {
    await assert.rejects(cli("volume", "20"), (error) => error.code === 2 && /accepted the volume change but still reports 40/.test(error.stderr));
    await assert.rejects(cli("mute"), (error) => error.code === 2 && /accepted mute but didn't change/.test(error.stderr));
  } finally {
    await renderer.close();
  }
});

test("CLI pause says so when nothing is playing", async () => {
  const renderer = await startFakeRenderer();
  try {
    await assert.rejects(
      run(process.execPath, [CLI, "pause", "--location", renderer.location]),
      (error) => error.code === 2 && /Nothing is playing on Fake Goggles & TV/.test(error.stderr),
    );
  } finally {
    await renderer.close();
  }
});
