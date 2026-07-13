// Reads the user's Ghostty config from disk and maps it onto restty's
// appearance model. All parsing/merging logic lives in @volli/shared
// (pure, filesystem-free); this module supplies the filesystem and wires the
// IPC channel + a live-reload watch, mirroring pty.ts's shape: injected deps
// for testability, thin Electron wiring at the bottom.

import { existsSync, readFileSync, watch as fsWatch } from "node:fs";
import { homedir } from "node:os";
import { BrowserWindow, ipcMain } from "electron";
import {
  errorMessage,
  mergeGhosttyConfigTexts,
  parseGhosttyTerminalPrefs,
  resolveGhosttyConfigText,
} from "@volli/shared";
import type {
  GhosttyAppearancePayload,
  GhosttyConfigResult,
  VolliIpcChannel,
  VolliIpcEvent,
} from "@volli/shared";

/** Injected filesystem/environment access, so the resolution logic is testable without touching disk. */
export interface GhosttyConfigDeps {
  /** Sync file reader; null on any error (missing file, permission, etc). */
  readFile(absPath: string): string | null;
  /** File existence probe, used for theme resolution. */
  exists(absPath: string): boolean;
  env: Record<string, string | undefined>;
  homeDir: string;
}

function defaultReadFile(absPath: string): string | null {
  try {
    return readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

function defaultDeps(): GhosttyConfigDeps {
  return { readFile: defaultReadFile, exists: existsSync, env: process.env, homeDir: homedir() };
}

/** The two ghostty config directories, macOS precedence order (later wins). */
function ghosttyDirs(deps: GhosttyConfigDeps): { xdgDir: string; appSupportDir: string } {
  return {
    xdgDir: deps.env["XDG_CONFIG_HOME"] ?? `${deps.homeDir}/.config`,
    appSupportDir: `${deps.homeDir}/Library/Application Support/com.mitchellh.ghostty`,
  };
}

/** The two entry config paths, in the same precedence order as `ghosttyDirs`. */
function entryConfigPaths(deps: GhosttyConfigDeps): string[] {
  const { xdgDir, appSupportDir } = ghosttyDirs(deps);
  return [`${xdgDir}/ghostty/config`, `${appSupportDir}/config`];
}

/**
 * Resolves the named theme (absolute path, or a name probed across ghostty's
 * theme directories) to its raw text. Null when `themeName` is unset, when
 * it's a builtin name with no on-disk file (the common case — the renderer
 * falls back to restty's builtin catalog), or when the resolved file fails
 * to read.
 */
function resolveThemeSource(themeName: string | null, deps: GhosttyConfigDeps): string | null {
  if (themeName === null) return null;
  if (themeName.startsWith("/")) return deps.readFile(themeName);

  const { xdgDir, appSupportDir } = ghosttyDirs(deps);
  const candidates = [
    `${xdgDir}/ghostty/themes/${themeName}`,
    `${appSupportDir}/themes/${themeName}`,
    `/Applications/Ghostty.app/Contents/Resources/ghostty/themes/${themeName}`,
  ];
  for (const candidate of candidates) {
    if (deps.exists(candidate)) return deps.readFile(candidate);
  }
  return null;
}

/**
 * Resolves and merges both entry configs (ghostty's macOS precedence: the
 * Application Support config overrides the XDG one on scalar conflicts),
 * parses the result, and resolves the named theme's source text. Never
 * throws: a missing config file (or missing theme file) is normal, not an
 * error — include-resolution warnings are logged, not surfaced.
 */
export function readGhosttyAppearance(deps: GhosttyConfigDeps): GhosttyAppearancePayload {
  const texts = entryConfigPaths(deps).map((entryPath) => {
    const { text, warnings } = resolveGhosttyConfigText(entryPath, deps.readFile);
    for (const warning of warnings) {
      console.warn(`[ghostty-config] ${warning}`);
    }
    return text;
  });

  const configText = mergeGhosttyConfigTexts(texts);
  const prefs = parseGhosttyTerminalPrefs(configText ?? "");
  const themeSource = resolveThemeSource(prefs.themeName, deps);

  return { prefs, configText, themeSource };
}

// ---- IPC + live reload ------------------------------------------------------

// Debounce window across both directory watchers: editors write config files
// via atomic rename (several fs events per save), and both watchers can fire
// for one logical change.
const WATCH_DEBOUNCE_MS = 250;

/** Pushes the freshly-read appearance to every non-destroyed window. */
function broadcastAppearance(deps: GhosttyConfigDeps): void {
  const payload = readGhosttyAppearance(deps);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send("volli:ghostty-config-changed" satisfies VolliIpcEvent, payload);
  }
}

/**
 * Watches one directory for changes to `filename`, debouncing across however
 * many watchers share `scheduleReload`. Isolated to a tiny function so the
 * genuinely untestable part — the raw `fs.watch` call — is one line; a
 * missing directory (no ghostty installed, or only one of the two config
 * locations exists) must not crash startup, hence the try/catch.
 */
function watchConfigDir(
  dir: string,
  filename: string,
  scheduleReload: () => void,
  deps: GhosttyConfigDeps,
): void {
  try {
    if (!deps.exists(dir)) return;

    fsWatch(dir, (_event, changedName) => {
      if (changedName === filename) scheduleReload();
    });
  } catch (error) {
    console.warn(`[ghostty-config] could not watch ${dir}: ${errorMessage(error)}`);
  }
}

/** Wires the debounced live-reload watch across both entry config directories. */
function watchForChanges(deps: GhosttyConfigDeps): void {
  let debounceTimer: NodeJS.Timeout | null = null;
  const scheduleReload = (): void => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      broadcastAppearance(deps);
    }, WATCH_DEBOUNCE_MS);
  };

  const { xdgDir, appSupportDir } = ghosttyDirs(deps);
  watchConfigDir(`${xdgDir}/ghostty`, "config", scheduleReload, deps);
  watchConfigDir(appSupportDir, "config", scheduleReload, deps);
}

/**
 * Registers the `volli:ghostty-config-get` handler and the live-reload watch.
 * Like every IPC handler, the result is a typed union rather than a thrown
 * error — `ipcMain.handle` rejections serialize into useless strings across
 * the boundary.
 */
export function registerGhosttyConfigIpc(): void {
  ipcMain.handle(
    "volli:ghostty-config-get" satisfies VolliIpcChannel,
    (_event): GhosttyConfigResult => {
      try {
        return { ok: true, value: readGhosttyAppearance(defaultDeps()) };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  watchForChanges(defaultDeps());
}
