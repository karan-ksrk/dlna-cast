import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Remembers the last renderer and recent files, so the next cast can skip discovery and browsing.
const storePath = () => process.env.DLNA_CAST_STORE ?? path.join(os.homedir(), ".dlna-cast.json");
const MAX_RECENT_FILES = 8;

function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(storePath(), "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function writeStore(update) {
  try {
    fs.writeFileSync(storePath(), JSON.stringify({ ...readStore(), ...update }, null, 2));
  } catch {
    // Remembering is a convenience; casting already succeeded.
  }
}

export function loadLastDevice() {
  const { location, udn, friendlyName } = readStore().lastDevice ?? {};
  return location ? { location, udn: udn ?? null, friendlyName: friendlyName ?? null } : null;
}

export function saveLastDevice({ location, udn, friendlyName }) {
  writeStore({ lastDevice: { location, udn, friendlyName } });
}

export function loadRecentFiles() {
  const recent = readStore().recentFiles;
  return Array.isArray(recent) ? recent.filter((file) => typeof file === "string") : [];
}

export function addRecentFile(filePath) {
  const recent = [filePath, ...loadRecentFiles().filter((file) => file !== filePath)].slice(0, MAX_RECENT_FILES);
  writeStore({ recentFiles: recent });
  return recent;
}
