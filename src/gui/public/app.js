// dlna-cast desktop app: renders the controller's state and sends user actions to the local API.
const token = document.querySelector('meta[name="api-token"]').content;
const $ = (id) => document.getElementById(id);

const STATE_WORDS = {
  PLAYING: "Playing",
  PAUSED_PLAYBACK: "Paused",
  STOPPED: "Stopped",
  TRANSITIONING: "Starting",
  NO_MEDIA_PRESENT: "Idle",
};
const QUALITY = {
  light: { maxHeight: 720, fps: 30, bitrateKbps: 3000 },
  balanced: { maxHeight: 1080, fps: 30, bitrateKbps: 6000 },
  smooth: { maxHeight: 1080, fps: 60, bitrateKbps: 10000 },
};
const ENCODER_LABELS = {
  nvenc: "NVIDIA graphics (NVENC)",
  qsv: "Intel graphics (Quick Sync)",
  amf: "AMD graphics (AMF)",
  x264: "Processor (x264)",
  openh264: "Processor (OpenH264)",
};

let current = null;
let seeking = false;
let volumeDragging = false;
let volumeTimer = null;
let throughput = { bytes: 0, time: 0, mbps: 0 };
let optionsLoaded = false;

// ---------- API ----------

async function api(path, body) {
  const init = body === undefined
    ? { headers: { "x-dlna-cast-token": token } }
    : { method: "POST", headers: { "x-dlna-cast-token": token, "content-type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `The app didn't answer (HTTP ${response.status})`);
  return data;
}

function showNotice(message) {
  $("noticeText").textContent = message;
  $("notice").hidden = false;
}

async function run(action, button) {
  if (button) button.disabled = true;
  try {
    return await action();
  } catch (error) {
    showNotice(error.message);
  } finally {
    if (button) button.disabled = false;
    if (current) render(current);
  }
}

const control = (action, value) => run(() => api("/api/control", { action, value }));

// ---------- Formatting ----------

function clock(seconds, { long = false } = {}) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return long ? "-:--:--" : "--:--";
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return h || long ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

const megabytes = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`);

// Writes a clock string with its colons in their own spans, so they can stay proportional (see app.css).
function setClock(element, text) {
  element.replaceChildren(
    ...text.split(":").flatMap((part, index) => {
      if (index === 0) return [part];
      const colon = document.createElement("span");
      colon.className = "colon";
      colon.textContent = ":";
      return [colon, part];
    }),
  );
}

function setRangeFill(input) {
  const max = Number(input.max) || 0;
  input.style.setProperty("--pct", `${max ? (Number(input.value) / max) * 100 : 0}%`);
}

// ---------- Rendering ----------

function renderDevices(state) {
  const list = $("deviceList");
  list.replaceChildren(
    ...state.devices.map((device) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "device";
      button.setAttribute("aria-pressed", String(device.key === state.selectedKey));
      const name = document.createElement("span");
      name.className = "device-name";
      name.textContent = device.friendlyName;
      const meta = document.createElement("span");
      meta.className = "device-meta";
      meta.textContent = [device.modelName, device.host].filter(Boolean).join(", ");
      button.append(name, meta);
      if (state.session && state.session.device.udn === device.key) {
        const live = document.createElement("span");
        live.className = "device-live";
        live.textContent = "Casting";
        button.append(live);
      }
      button.addEventListener("click", () => run(() => api("/api/devices/select", { key: device.key })));
      item.append(button);
      return item;
    }),
  );
  $("deviceEmpty").hidden = state.devices.length > 0;
  $("deviceEmpty").textContent = state.discovering
    ? "Searching the network. Renderers appear here as they answer."
    : "No renderers yet. Turn on your goggles; they show up here within a few seconds.";

  const search = $("searchButton");
  search.disabled = state.discovering;
  search.textContent = state.discovering ? "Searching…" : "Search";

  const selected = state.devices.find((d) => d.key === state.selectedKey);
  const target = $("target");
  target.replaceChildren();
  if (selected) {
    const strong = document.createElement("strong");
    strong.textContent = selected.friendlyName;
    target.append(state.session ? "Casting to " : "Renderer: ", strong);
  } else {
    target.textContent = "No renderer selected";
  }
}

function renderSession(state) {
  const session = state.session;
  const goggles = $("goggles");
  const playButton = $("playButton");
  const hasSession = Boolean(session);

  let mode = "idle";
  if (state.starting) mode = "starting";
  else if (session?.state === "PAUSED_PLAYBACK") mode = "paused";
  else if (session?.state === "PLAYING") mode = session.live ? "live" : "playing";
  else if (session) mode = "starting";
  goggles.dataset.state = mode;

  const selected = state.devices.find((d) => d.key === state.selectedKey);
  if (session) {
    $("nowKind").textContent = session.live ? (session.details.capture === "testsrc" ? "Test pattern" : "Your screen") : "File";
    $("nowTitle").textContent = session.title;
    $("nowDevice").textContent = `on ${session.device.friendlyName}`;
  } else if (state.starting) {
    $("nowKind").textContent = "Starting";
    $("nowTitle").textContent = "Getting the stream ready";
    $("nowDevice").textContent = selected ? `on ${selected.friendlyName}` : "";
  } else {
    const ended = state.lastEnded;
    $("nowKind").textContent = ended ? (ended.error ? "Stopped with a problem" : "Finished") : "Ready";
    $("nowTitle").textContent = ended ? ended.title : "Nothing is casting";
    $("nowDevice").textContent = selected ? `${selected.friendlyName} is ready` : "Choose a renderer on the left";
  }

  if (session?.live) {
    setClock($("clock"), clock(session.elapsed, { long: true }));
    $("clockSub").textContent = "live, since you started";
  } else if (session) {
    setClock($("clock"), clock(session.position, { long: true }));
    $("clockSub").textContent = session.duration ? `of ${clock(session.duration, { long: true })}` : "length unknown";
  } else {
    setClock($("clock"), "0:00:00");
    $("clockSub").textContent = state.starting ? "Waiting for the renderer" : "Pick a file or your screen below";
  }
  $("stateWord").textContent = state.starting ? "Starting" : session ? (STATE_WORDS[session.state] ?? session.state) : "Idle";

  // The lamp ring around both lenses shows how far through the file playback is.
  const pct = session && !session.live && session.duration ? Math.min(100, (session.position ?? 0) / session.duration * 100) : 0;
  goggles.style.setProperty("--ring-offset", String(100 - pct));

  const seekable = Boolean(session?.seekable && session.duration);
  $("scrubRow").hidden = Boolean(session?.live);
  const seekBar = $("seekBar");
  seekBar.disabled = !seekable;
  if (!seeking) {
    seekBar.max = String(Math.floor(session?.duration ?? 0));
    seekBar.value = String(Math.floor(session?.position ?? 0));
    setClock($("positionLabel"), clock(session?.position ?? 0));
  }
  setClock($("durationLabel"), clock(session?.duration ?? 0));
  setRangeFill(seekBar);

  playButton.disabled = !hasSession;
  const paused = session?.state !== "PLAYING";
  playButton.classList.toggle("paused", paused);
  playButton.setAttribute("aria-label", paused ? "Resume" : "Pause");
  $("backButton").disabled = !seekable;
  $("forwardButton").disabled = !seekable;
  $("stopButton").disabled = !hasSession;

  const volumeOk = Boolean(session?.volumeSupported);
  const volumeBar = $("volumeBar");
  volumeBar.disabled = !volumeOk;
  volumeBar.closest(".volume").title = session?.volumeIgnored
    ? `${session.device.friendlyName} ignores remote volume and mute; use its own buttons`
    : "";
  $("muteButton").disabled = !volumeOk;
  if (!volumeDragging && session?.volume !== null && session?.volume !== undefined) {
    volumeBar.value = String(session.volume);
  }
  $("volumeValue").textContent = volumeOk && session.volume !== null ? volumeBar.value : "--";
  setRangeFill(volumeBar);
  $("muteButton").setAttribute("aria-pressed", String(Boolean(session?.muted)));
  $("muteButton").setAttribute("aria-label", session?.muted ? "Unmute" : "Mute");

  // Throughput from the change in bytes sent between updates, smoothed so the number doesn't jitter.
  if (session) {
    const now = performance.now();
    if (throughput.time && session.bytesSent >= throughput.bytes) {
      const seconds = (now - throughput.time) / 1000;
      if (seconds > 0.5) {
        const mbps = ((session.bytesSent - throughput.bytes) * 8) / seconds / 1e6;
        throughput.mbps = throughput.mbps ? throughput.mbps * 0.6 + mbps * 0.4 : mbps;
        throughput.bytes = session.bytesSent;
        throughput.time = now;
      }
    } else {
      throughput = { bytes: session.bytesSent, time: now, mbps: 0 };
    }
  } else {
    throughput = { bytes: 0, time: 0, mbps: 0 };
  }

  $("statState").textContent = session ? (STATE_WORDS[session.state] ?? session.state) : state.starting ? "Starting" : "Nothing playing";
  $("statSent").textContent = megabytes(session?.bytesSent ?? 0);
  $("statRate").textContent = `${throughput.mbps.toFixed(1)} Mbps`;
  $("statVideo").textContent = session?.live
    ? `${ENCODER_LABELS[session.details.encoder] ?? session.details.encoder}, ${session.details.fps} fps`
    : session?.details?.mimeType ?? "—";
}

function renderSources(state) {
  const busy = state.starting;
  $("castFileButton").disabled = busy || !state.selectedKey;
  $("castScreenButton").disabled = busy || !state.selectedKey || !state.ffmpeg;
  $("castFileButton").textContent = busy ? "Starting…" : "Cast file";
  $("castScreenButton").textContent = busy ? "Starting…" : $("testPatternCheck").checked ? "Cast test pattern" : "Cast screen";
  $("browseButton").hidden = !state.filePicker;
  $("ffmpegMissing").hidden = state.ffmpeg;

  const recent = state.recentFiles ?? [];
  $("recentBlock").hidden = recent.length === 0;
  $("recentList").replaceChildren(
    ...recent.map((file) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      const split = Math.max(file.lastIndexOf("\\"), file.lastIndexOf("/"));
      const name = document.createElement("span");
      name.className = "file-name";
      name.textContent = file.slice(split + 1);
      const dir = document.createElement("span");
      dir.className = "file-dir";
      dir.textContent = file.slice(0, split);
      button.append(name, dir);
      button.title = `Cast ${file}`;
      button.addEventListener("click", () => {
        $("filePath").value = file;
        castFile();
      });
      item.append(button);
      return item;
    }),
  );
}

function render(state) {
  current = state;
  renderDevices(state);
  renderSession(state);
  renderSources(state);
}

// ---------- Activity log ----------

function appendLog(entry, { live = true } = {}) {
  const item = document.createElement("li");
  item.className = entry.level;
  const time = document.createElement("time");
  time.dateTime = new Date(entry.time).toISOString();
  time.textContent = new Date(entry.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const text = document.createElement("span");
  text.textContent = entry.message;
  item.append(time, text);
  const list = $("logList");
  list.append(item);
  while (list.children.length > 200) list.firstElementChild.remove();
  list.scrollTop = list.scrollHeight;
  if (entry.level !== "detail") $("lastLog").textContent = entry.message;
  if (live && entry.level === "error") showNotice(entry.message);
}

// ---------- Actions ----------

async function castFile() {
  const filePath = $("filePath").value.trim();
  if (!filePath) return showNotice("Choose a file first, or paste its full path.");
  $("notice").hidden = true;
  await run(() => api("/api/cast/file", { path: filePath }), $("castFileButton"));
}

async function castScreen() {
  $("notice").hidden = true;
  const quality = QUALITY[document.querySelector('input[name="quality"]:checked')?.value ?? "balanced"];
  await run(
    () =>
      api("/api/cast/screen", {
        ...quality,
        monitor: Number($("monitorSelect").value) || 0,
        audio: $("audioSelect").value,
        encoder: $("encoderSelect").value,
        capture: $("testPatternCheck").checked ? "testsrc" : "auto",
        drawMouse: $("mouseCheck").checked,
      }),
    $("castScreenButton"),
  );
}

async function loadScreenOptions() {
  if (optionsLoaded) return;
  optionsLoaded = true;
  try {
    const { monitors, audioDevices, encoders } = await api("/api/options");
    $("monitorSelect").replaceChildren(
      ...monitors.map((monitor) => {
        const size = monitor.width ? `, ${monitor.width} × ${monitor.height}` : "";
        return new Option(`${monitor.primary ? "Main display" : `Display ${monitor.index + 1}`}${size}`, String(monitor.index));
      }),
    );
    const audio = $("audioSelect");
    for (const name of audioDevices) audio.append(new Option(name, name));
    const encoder = $("encoderSelect");
    for (const { key } of encoders) encoder.append(new Option(ENCODER_LABELS[key] ?? key, key));
  } catch (error) {
    optionsLoaded = false;
    $("monitorSelect").replaceChildren(new Option("Main display", "0"));
    showNotice(`Couldn't read this PC's displays: ${error.message}`);
  }
}

function selectTab(tab) {
  for (const other of document.querySelectorAll('[role="tab"]')) {
    const selected = other === tab;
    other.setAttribute("aria-selected", String(selected));
    other.tabIndex = selected ? 0 : -1;
    $(other.getAttribute("aria-controls")).hidden = !selected;
  }
  if (tab.id === "tabScreen") loadScreenOptions();
}

function wire() {
  $("noticeDismiss").addEventListener("click", () => ($("notice").hidden = true));
  $("searchButton").addEventListener("click", () => run(() => api("/api/discover", {})));

  $("probeForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const address = $("probeAddress").value.trim();
    if (!address) return;
    run(async () => {
      await api("/api/devices/probe", { address });
      $("probeAddress").value = "";
    }, event.submitter);
  });

  $("browseButton").addEventListener("click", () =>
    run(async () => {
      const { path } = await api("/api/pick-file", {});
      if (path) $("filePath").value = path;
    }, $("browseButton")),
  );
  $("filePath").addEventListener("keydown", (event) => event.key === "Enter" && castFile());
  $("castFileButton").addEventListener("click", castFile);
  $("castScreenButton").addEventListener("click", castScreen);
  $("testPatternCheck").addEventListener("change", () => current && renderSources(current));

  const tabs = [...document.querySelectorAll('[role="tab"]')];
  for (const tab of tabs) {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const next = tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      selectTab(next);
    });
  }

  $("playButton").addEventListener("click", () => control("toggle"));
  $("stopButton").addEventListener("click", () => control("stop"));
  $("backButton").addEventListener("click", () => control("skip", -10));
  $("forwardButton").addEventListener("click", () => control("skip", 10));

  const seekBar = $("seekBar");
  seekBar.addEventListener("input", () => {
    seeking = true;
    setClock($("positionLabel"), clock(Number(seekBar.value)));
    setRangeFill(seekBar);
  });
  seekBar.addEventListener("change", async () => {
    await control("seek", Number(seekBar.value));
    seeking = false;
  });

  const volumeBar = $("volumeBar");
  volumeBar.addEventListener("input", () => {
    volumeDragging = true;
    $("volumeValue").textContent = volumeBar.value;
    setRangeFill(volumeBar);
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(async () => {
      await control("volume", Number(volumeBar.value));
      volumeDragging = false;
    }, 150);
  });
  $("muteButton").addEventListener("click", () => control("mute", !current?.session?.muted));

  $("detailCheck").addEventListener("change", (event) => $("logList").classList.toggle("show-detail", event.target.checked));

  // Keyboard shortcuts, except while typing in a field.
  document.addEventListener("keydown", (event) => {
    if (event.target.closest("input, select, textarea, [role='tab']") || event.ctrlKey || event.metaKey || event.altKey) return;
    const session = current?.session;
    if (!session) return;
    const actions = {
      " ": () => control("toggle"),
      ArrowLeft: () => session.seekable && control("skip", -10),
      ArrowRight: () => session.seekable && control("skip", 10),
      ArrowUp: () => session.volumeSupported && control("volume", Math.min(100, (session.volume ?? 0) + 5)),
      ArrowDown: () => session.volumeSupported && control("volume", Math.max(0, (session.volume ?? 0) - 5)),
      m: () => session.volumeSupported && control("mute", !session.muted),
    };
    const act = actions[event.key];
    if (!act || event.target.closest("button")) return;
    event.preventDefault();
    act();
  });
}

function connect() {
  // EventSource reconnects on its own; the notice clears once state flows again.
  let connectionLost = false;
  const events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  events.addEventListener("state", (event) => {
    if (connectionLost) {
      connectionLost = false;
      $("notice").hidden = true;
    }
    render(JSON.parse(event.data));
  });
  events.addEventListener("log", (event) => appendLog(JSON.parse(event.data)));
  events.addEventListener("error", () => {
    connectionLost = true;
    showNotice("Lost the connection to dlna-cast. If you closed it, start it again with: node src/cli.mjs gui");
  });
}

wire();
api("/api/log").then((entries) => entries.forEach((entry) => appendLog(entry, { live: false }))).catch(() => {});
connect();
