// Small Windows integrations for the desktop app: a native file picker, the monitor list, and an app-mode window.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MEDIA_FILTER =
  "Videos and music|*.mp4;*.m4v;*.mov;*.mkv;*.webm;*.avi;*.ts;*.m2ts;*.mp3;*.m4a;*.aac;*.flac;*.wav;*.ogg|All files|*.*";

function runPowerShell(script, { sta = false, timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", ...(sta ? ["-STA"] : []), "-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `PowerShell exited with ${code}`));
    });
  });
}

/** Opens the Windows file dialog in front of other windows; resolves to the chosen path or null. */
export async function pickMediaFile(initialDirectory = null) {
  if (process.platform !== "win32") throw new Error("The file picker is only available on Windows; paste a path instead");
  const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }",
    "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
    "$dialog.Title = 'Choose a file to cast'",
    `$dialog.Filter = ${quote(MEDIA_FILTER)}`,
    initialDirectory ? `$dialog.InitialDirectory = ${quote(initialDirectory)}` : "",
    "if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.FileName) }",
  ].filter(Boolean).join("; ");
  const chosen = (await runPowerShell(script, { sta: true })).trim();
  return chosen || null;
}

/** Monitors in Windows' order, which matches ddagrab's output index on single-GPU machines. */
export async function listMonitors() {
  if (process.platform !== "win32") return [{ index: 0, label: "Screen", width: null, height: null, primary: true }];
  try {
    const output = await runPowerShell(
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { '{0}|{1}|{2}' -f $_.Bounds.Width, $_.Bounds.Height, $_.Primary }",
      { timeoutMs: 15000 },
    );
    return output
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line, index) => {
        const [width, height, primary] = line.split("|");
        return { index, width: Number(width), height: Number(height), primary: primary === "True" };
      });
  } catch {
    return [{ index: 0, width: null, height: null, primary: true }];
  }
}

function findAppBrowser() {
  const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = roots.flatMap((root) => [
    path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
  ]);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

/**
 * Opens the URL in its own app-mode window (Edge or Chrome) with a private profile, so it doesn't mix with the
 * user's browsing. Falls back to the default browser. Edge may hand the launch to another of its processes, so
 * the returned process (null for the fallback) is not a reliable signal that the window closed.
 */
export function openAppWindow(url, { width = 1280, height = 860 } = {}) {
  const browser = process.platform === "win32" ? findAppBrowser() : null;
  if (browser) {
    const profile = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "dlna-cast", "app-window");
    return spawn(
      browser,
      [`--app=${url}`, `--window-size=${width},${height}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check"],
      { stdio: "ignore", windowsHide: false },
    );
  }
  const opener = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).unref();
  return null;
}
