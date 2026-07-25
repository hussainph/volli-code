// Reads the user's Ghostty config from disk, layers Volli's own overlay files
// on top of it, and maps the result onto restty's appearance model. All
// parsing/merging logic lives in @volli/shared (pure, filesystem-free); this
// module supplies the filesystem and wires the IPC channel + a live-reload
// watch, mirroring pty.ts's shape: injected deps for testability, thin
// Electron wiring at the bottom.
//
// The chain is: the user's real ghostty config (both macOS locations, merged
// with ghostty's own precedence) → Volli's GLOBAL overlay → the current
// project's overlay. Every layer merges with the same last-wins semantics, so
// the precedence the user already knows from ghostty holds all the way up.
// This module still never WRITES anything — decision #67's read-only stance on
// the user's config is structural: the write path is theme-overlay.ts, which
// can only touch <userData>/volli/ghostty/.

import { watch as fsWatch } from "node:fs";
import { BrowserWindow, ipcMain } from "electron";
import {
  errorMessage,
  globalGhosttyOverlayPath,
  mergeGhosttyConfigTexts,
  parseGhosttyTerminalPrefs,
  projectGhosttyOverlayDir,
  projectGhosttyOverlayPath,
  resolveGhosttyConfigText,
  resolveGhosttyLayers,
  volliGhosttyOverlayDir,
} from "@volli/shared";
import type {
  GhosttyAppearancePayload,
  GhosttyConfigResult,
  GhosttyOverlayLayer,
  VolliIpcChannel,
  VolliIpcEvent,
} from "@volli/shared";
import type { FsDeps } from "./fs-deps";

/**
 * The resolution path's slice of {@link FsDeps} (`defaultFsDeps` supplies the
 * real one), so this logic is testable without touching disk.
 *
 * `writeFile`, `rename` and `tempName` are deliberately NOT in this slice:
 * this module resolves the user's own ghostty config, and decision #67 says
 * Volli never writes it. Leaving the writing verbs out means that is not a
 * rule this file has to remember — it has no way to write anything. `ensureDir`
 * is the one exception, used ONLY to create Volli's own overlay directories so
 * their watch can arm at boot.
 */
export type GhosttyConfigDeps = Pick<
  FsDeps,
  "readFile" | "exists" | "ensureDir" | "env" | "homeDir" | "userDataDir"
>;

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
 * A project's overlay path, or null when there is no project in scope or its
 * ticket prefix is unusable. Reads run on the terminal-appearance hot path
 * (every boot, every live reload), so a bad prefix must degrade to "no project
 * layer" rather than take the whole payload down.
 */
function projectOverlayPathFor(
  deps: GhosttyConfigDeps,
  ticketPrefix: string | null,
): string | null {
  if (ticketPrefix === null) return null;
  try {
    return projectGhosttyOverlayPath(deps.userDataDir, ticketPrefix);
  } catch {
    return null;
  }
}

/**
 * Reads one config file and resolves its `config-file` includes, logging any
 * warning rather than surfacing it.
 *
 * EVERY layer goes through here — ghostty's own entry configs and Volli's two
 * overlays alike. `OVERLAY_HEADER` promises the user that "any ghostty key
 * works" in an overlay, and `config-file` is a ghostty key: reading an overlay
 * with a bare `readFile` would make it the one directive that works in
 * Ghostty.app and silently does nothing in Volli — exactly the surprise
 * decision #68 exists to prevent.
 */
function resolveConfigText(entryPath: string, deps: GhosttyConfigDeps): string | null {
  const { text, warnings } = resolveGhosttyConfigText(entryPath, deps.readFile);
  for (const warning of warnings) {
    console.warn(`[ghostty-config] ${warning}`);
  }
  return text;
}

/**
 * Resolves the full appearance chain for a scope and maps it onto restty's
 * model: both of ghostty's entry configs (its macOS precedence — the
 * Application Support config overrides the XDG one on scalar conflicts), then
 * Volli's global overlay, then the project's overlay when `ticketPrefix` names
 * one. Later layers win, and `provenance` records which layer won each key so
 * Settings can label every value's origin honestly.
 *
 * Never throws: a missing config file (or missing theme/overlay file) is
 * normal, not an error — include-resolution warnings are logged, not surfaced.
 */
export function readGhosttyAppearance(
  deps: GhosttyConfigDeps,
  ticketPrefix: string | null = null,
): GhosttyAppearancePayload {
  const entryPaths = entryConfigPaths(deps);
  const ghosttyTexts = entryPaths.map((entryPath) => resolveConfigText(entryPath, deps));

  const globalOverlayPath = globalGhosttyOverlayPath(deps.userDataDir);
  const projectOverlayPath = projectOverlayPathFor(deps, ticketPrefix);
  const layers: GhosttyOverlayLayer[] = [
    // The user's own config, already include-resolved, collapsed to one layer:
    // ghostty's two locations are its own precedence, not Volli's.
    { origin: "ghostty", text: mergeGhosttyConfigTexts(ghosttyTexts) },
    // Overlays resolve their own includes too, and an included file's keys stay
    // attributed to the layer that included them: `resolveGhosttyConfigText`
    // emits an include's text BEFORE the including file's, so within a layer
    // the overlay itself still wins, and `resolveGhosttyLayers` sees one text
    // per origin exactly as before.
    { origin: "volli-global", text: resolveConfigText(globalOverlayPath, deps) },
    {
      origin: "volli-project",
      text: projectOverlayPath === null ? null : resolveConfigText(projectOverlayPath, deps),
    },
  ];

  const { text: configText, provenance } = resolveGhosttyLayers(layers);
  const prefs = parseGhosttyTerminalPrefs(configText ?? "");
  // Resolved from the EFFECTIVE theme name, so a theme an overlay selected
  // resolves against ghostty's own theme directories exactly like one the
  // user's config selected.
  const themeSource = resolveThemeSource(prefs.themeName, deps);

  return {
    prefs,
    configText,
    themeSource,
    provenance,
    overlayPaths: { global: globalOverlayPath, project: projectOverlayPath },
    // The config that actually contributed, preferring the location whose
    // values WIN (Application Support over XDG); else ghostty's canonical
    // location so "Open Ghostty config" still works before the user has
    // written one — the same rationale as overlayPaths.
    ghosttyConfigPath:
      entryPaths.findLast((_path, index) => ghosttyTexts[index] !== null) ?? entryPaths[0]!,
  };
}

// ---- IPC + live reload ------------------------------------------------------

// Debounce window across both directory watchers: editors write config files
// via atomic rename (several fs events per save), and both watchers can fire
// for one logical change.
const WATCH_DEBOUNCE_MS = 250;

/** The entry-config basename every ghostty config dir (and Volli's global overlay dir) is watched for. */
function isConfigFile(name: string): boolean {
  return name === "config";
}

/** One project overlay per file — any `<PREFIX>.config` in the projects dir may be hand-edited. */
function isProjectOverlayFile(name: string): boolean {
  return name.endsWith(".config");
}

/** Pushes the freshly-read appearance to every non-destroyed window. */
function broadcastAppearance(deps: GhosttyConfigDeps): void {
  const payload = readGhosttyAppearance(deps);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send("volli:ghostty-config-changed" satisfies VolliIpcEvent, payload);
  }
}

/**
 * Watches one directory, debouncing across however many watchers share
 * `scheduleReload`. `matches` filters the changed basename — a predicate
 * rather than a literal because the per-project overlay directory holds one
 * file per project (`<PREFIX>.config`), any of which may be hand-edited.
 * Isolated to a tiny function so the genuinely untestable part — the raw
 * `fs.watch` call — is one line; a missing directory (no ghostty installed, or
 * only one of the two config locations exists) must not crash startup, hence
 * the try/catch.
 */
function watchConfigDir(
  dir: string,
  matches: (changedName: string) => boolean,
  scheduleReload: () => void,
  deps: GhosttyConfigDeps,
): void {
  try {
    if (!deps.exists(dir)) return;

    fsWatch(dir, (_event, changedName) => {
      if (changedName !== null && matches(changedName)) scheduleReload();
    });
  } catch (error) {
    console.warn(`[ghostty-config] could not watch ${dir}: ${errorMessage(error)}`);
  }
}

/**
 * Wires the debounced live-reload watch across every layer's directory: both
 * ghostty entry config dirs, plus Volli's two overlay dirs — hand-editing an
 * overlay must re-theme live terminals exactly like editing the real config
 * does (#68: the file keeps full power available without the UI tracking
 * ghostty's key set).
 *
 * Volli's own overlay dirs are CREATED first. They are ours, and a watch can
 * only arm on a directory that exists: without this, the first overlay written
 * in a session would land in a brand-new directory nothing was watching, and
 * every hand-edit until the next relaunch would go unnoticed.
 */
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
  watchConfigDir(`${xdgDir}/ghostty`, isConfigFile, scheduleReload, deps);
  watchConfigDir(appSupportDir, isConfigFile, scheduleReload, deps);

  const overlayDir = volliGhosttyOverlayDir(deps.userDataDir);
  const projectsDir = projectGhosttyOverlayDir(deps.userDataDir);
  try {
    deps.ensureDir(projectsDir); // recursive — creates `overlayDir` on the way
  } catch (error) {
    console.warn(`[ghostty-config] could not create ${projectsDir}: ${errorMessage(error)}`);
  }
  watchConfigDir(overlayDir, isConfigFile, scheduleReload, deps);
  watchConfigDir(projectsDir, isProjectOverlayFile, scheduleReload, deps);
}

/**
 * Registers the `volli:ghostty-config-get` handler and the live-reload watch.
 * Like every IPC handler, the result is a typed union rather than a thrown
 * error — `ipcMain.handle` rejections serialize into useless strings across
 * the boundary.
 *
 * Both the handler and the broadcast resolve the GLOBAL scope (no project
 * layer): this channel has no project context and the watch broadcast goes to
 * every window at once. A project-scoped resolution comes from
 * `volli:theme-state` (theme-ipc.ts), which can map a project id to its ticket
 * prefix through the db — so a renderer showing a project's terminal
 * re-requests that on a `volli:ghostty-config-changed` event.
 */
export function registerGhosttyConfigIpc(deps: GhosttyConfigDeps): void {
  ipcMain.handle(
    "volli:ghostty-config-get" satisfies VolliIpcChannel,
    (_event): GhosttyConfigResult => {
      try {
        return { ok: true, value: readGhosttyAppearance(deps) };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  watchForChanges(deps);
}
