/**
 * All Node fs work for the `.volli` per-project artifacts convention
 * (ticket-detail-mvp decisions #13-17): ensuring/self-gitignoring `.volli`,
 * listing both artifact tiers, read/write/create/promote, and a debounced
 * `fs.watch` broadcast. Mirrors pty.ts/ghostty-config.ts's shape: pure fs
 * helpers exported for direct testing against real temp dirs, thin Electron
 * IPC wiring at the bottom. Every mutation returns a typed `Result` rather
 * than throwing across the IPC boundary — same convention as data-ipc.ts.
 */
import { existsSync, promises as fsp, watch as fsWatch } from "node:fs";
import { join, sep } from "node:path";
import { ipcMain, shell } from "electron";
import type { WebContents } from "electron";
import type Database from "better-sqlite3";
import {
  artifactBaseName,
  artifactImageMimeType,
  classifyArtifactKind,
  compareArtifactEntries,
  displayTicketId,
  errorMessage,
  isSafeArtifactEntryName,
  isValidNewArtifactName,
  projectArtifactsDir,
  ticketArtifactsDir,
  volliDir,
  VOLLI_GITIGNORE_CONTENT,
  withMarkdownExtension,
} from "@volli/shared";
import type {
  ArtifactCreateResult,
  ArtifactEntry,
  ArtifactListResult,
  ArtifactPromoteResult,
  ArtifactReadImageResult,
  ArtifactReadResult,
  ArtifactsChangedEvent,
  ArtifactTier,
  Project,
  Result,
  RevealResult,
  VolliIpcChannel,
  VolliIpcEvent,
} from "@volli/shared";
import type { DbHandle } from "./data-ipc";
import { getProjectById } from "./db/projects-repo";
import { getTicketRow } from "./db/tickets-repo";

// ---- low-level fs helpers --------------------------------------------------

/** The `code` of a Node `ErrnoException`-shaped value, or undefined. */
function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** True when a directory-read failure means "no such tier" (empty), not a real fault. */
function isMissingDirError(error: unknown): boolean {
  const code = errnoCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fsp.access(path);
    return true;
  } catch {
    return false;
  }
}

/** Creates `.volli/` and writes its self-gitignore (`*`) if missing. Idempotent; never touches the user's root `.gitignore`. */
export async function ensureVolliDir(projectPath: string): Promise<void> {
  const dir = volliDir(projectPath);
  await fsp.mkdir(dir, { recursive: true });
  const gitignorePath = join(dir, ".gitignore");
  if (!(await pathExists(gitignorePath))) {
    await fsp.writeFile(gitignorePath, VOLLI_GITIGNORE_CONTENT, "utf8");
  }
}

/** Ensures `.volli/artifacts/` (and its `.volli` parent chain + self-gitignore). */
export async function ensureProjectArtifactsDir(projectPath: string): Promise<void> {
  await ensureVolliDir(projectPath);
  await fsp.mkdir(projectArtifactsDir(projectPath), { recursive: true });
}

/** Ensures `.volli/tickets/<displayId>/artifacts/` (and its parent chain + self-gitignore). */
export async function ensureTicketDir(projectPath: string, displayId: string): Promise<void> {
  await ensureVolliDir(projectPath);
  await fsp.mkdir(ticketArtifactsDir(projectPath, displayId), { recursive: true });
}

function tierDir(projectPath: string, tier: ArtifactTier, displayId: string): string {
  return tier === "project"
    ? projectArtifactsDir(projectPath)
    : ticketArtifactsDir(projectPath, displayId);
}

async function ensureTierDir(
  projectPath: string,
  tier: ArtifactTier,
  displayId: string,
): Promise<void> {
  if (tier === "project") await ensureProjectArtifactsDir(projectPath);
  else await ensureTicketDir(projectPath, displayId);
}

/**
 * Verifies `dir`'s realpath is still inside the project's `.volli` realpath —
 * the second path-safety layer beyond {@link isSafeArtifactEntryName}: a
 * symlink swapped in for the artifacts directory itself (or an ancestor)
 * would otherwise let a name-safe request resolve outside the sandbox.
 * Fails closed: either path failing to resolve (missing directory) is
 * reported as "not found", not silently ignored.
 */
async function assertDirWithinVolli(
  projectPath: string,
  dir: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let rootReal: string;
  try {
    rootReal = await fsp.realpath(volliDir(projectPath));
  } catch {
    return { ok: false, error: "The project's .volli directory was not found" };
  }
  let dirReal: string;
  try {
    dirReal = await fsp.realpath(dir);
  } catch {
    return { ok: false, error: "Artifacts directory was not found" };
  }
  if (dirReal !== rootReal && !dirReal.startsWith(rootReal + sep)) {
    return { ok: false, error: "Resolved path escapes the project's .volli directory" };
  }
  return { ok: true };
}

/**
 * Same escape guard as {@link assertDirWithinVolli}, one level down: an
 * existing file's realpath must stay inside `dir`'s realpath. A file that
 * doesn't exist yet (nothing to escape via) passes.
 *
 * A path that is itself a symlink is rejected outright, regardless of target:
 * lstat (which does NOT dereference) runs first, so even a *dangling* symlink
 * named like an artifact is caught here — previously its failed realpath was
 * treated as "safe", letting writeFile follow the link and write outside
 * `.volli`. A genuinely nonexistent path (lstat ENOENT) still passes.
 */
async function assertFileWithinDir(
  dir: string,
  filePath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const link = await fsp.lstat(filePath);
    if (link.isSymbolicLink()) {
      return { ok: false, error: "Artifact is a symlink" };
    }
  } catch {
    // Nothing at this path yet (ENOENT) — a brand-new file, nothing to escape via.
    return { ok: true };
  }
  let fileReal: string;
  try {
    fileReal = await fsp.realpath(filePath);
  } catch {
    return { ok: true };
  }
  let dirReal: string;
  try {
    dirReal = await fsp.realpath(dir);
  } catch {
    return { ok: false, error: "Artifacts directory was not found" };
  }
  if (fileReal !== dirReal && !fileReal.startsWith(dirReal + sep)) {
    return { ok: false, error: "Resolved path escapes the artifacts directory" };
  }
  return { ok: true };
}

/** Validates `name`, then resolves + realpath-guards its full path within `tier`'s (already-existing) artifacts directory. */
async function resolveSafeEntry(
  projectPath: string,
  tier: ArtifactTier,
  displayId: string,
  name: string,
): Promise<{ ok: true; dir: string; filePath: string } | { ok: false; error: string }> {
  if (!isSafeArtifactEntryName(name)) return { ok: false, error: "Invalid artifact name" };
  const dir = tierDir(projectPath, tier, displayId);
  const dirCheck = await assertDirWithinVolli(projectPath, dir);
  if (!dirCheck.ok) return dirCheck;
  const filePath = join(dir, name);
  const fileCheck = await assertFileWithinDir(dir, filePath);
  if (!fileCheck.ok) return fileCheck;
  return { ok: true, dir, filePath };
}

// ---- listing ----------------------------------------------------------------

/**
 * Files only (dirents, so symlinks are excluded — same stance as
 * list-directory's IPC handler), skipping dotfiles. Never creates `dir`; a
 * MISSING directory (ENOENT/ENOTDIR) is an empty tier. Any other readdir
 * failure (EACCES/EIO) is re-thrown rather than masked as "empty" — the IPC
 * handler wraps it into `{ ok: false, error }` so the UI surfaces it
 * (CLAUDE.md: never silently swallow errors). Per-entry stats run in parallel.
 */
async function listTierEntries(dir: string, tier: ArtifactTier): Promise<ArtifactEntry[]> {
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissingDirError(error)) return [];
    throw error;
  }
  const stated = await Promise.all(
    dirents.map(async (dirent): Promise<ArtifactEntry | null> => {
      if (dirent.name.startsWith(".")) return null;
      if (!dirent.isFile()) return null;
      try {
        const stat = await fsp.stat(join(dir, dirent.name));
        return {
          name: dirent.name,
          relPath: dirent.name,
          tier,
          size: stat.size,
          mtime: stat.mtimeMs,
          kind: classifyArtifactKind(dirent.name),
        };
      } catch {
        // Raced away between readdir and stat (deleted mid-listing) — skip it.
        return null;
      }
    }),
  );
  const entries = stated.filter((entry): entry is ArtifactEntry => entry !== null);
  entries.sort(compareArtifactEntries);
  return entries;
}

/** Both tiers for a ticket, ticket-tier entries first. Listing never creates directories — an absent tier is simply empty. */
export async function listArtifacts(
  projectPath: string,
  displayId: string,
): Promise<ArtifactEntry[]> {
  const [ticketEntries, projectEntries] = await Promise.all([
    listTierEntries(ticketArtifactsDir(projectPath, displayId), "ticket"),
    listTierEntries(projectArtifactsDir(projectPath), "project"),
  ]);
  return [...ticketEntries, ...projectEntries];
}

// ---- read / write / create / promote ----------------------------------------

/** Markdown-or-not content read as utf8 text (the Doc/Artifacts-tab viewer path). */
export async function readArtifactText(
  projectPath: string,
  tier: ArtifactTier,
  displayId: string,
  name: string,
): Promise<ArtifactReadResult> {
  const resolved = await resolveSafeEntry(projectPath, tier, displayId, name);
  if (!resolved.ok) return resolved;
  try {
    const content = await fsp.readFile(resolved.filePath, "utf8");
    return { ok: true, content };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** An image artifact's content as an inline `data:` URI (base64) — the CSP-safe path for `<img>` rendering. */
export async function readArtifactImage(
  projectPath: string,
  tier: ArtifactTier,
  displayId: string,
  name: string,
): Promise<ArtifactReadImageResult> {
  const mime = artifactImageMimeType(name);
  if (mime === null) return { ok: false, error: "Not an image artifact" };
  const resolved = await resolveSafeEntry(projectPath, tier, displayId, name);
  if (!resolved.ok) return resolved;
  try {
    const buffer = await fsp.readFile(resolved.filePath);
    return { ok: true, dataUrl: `data:${mime};base64,${buffer.toString("base64")}` };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** Writes markdown content (utf8); creates the tier's directory chain on demand. Rejects a non-markdown `name`. */
export async function writeArtifactText(
  projectPath: string,
  tier: ArtifactTier,
  displayId: string,
  name: string,
  content: string,
): Promise<Result> {
  if (!isSafeArtifactEntryName(name)) return { ok: false, error: "Invalid artifact name" };
  if (classifyArtifactKind(name) !== "markdown") {
    return { ok: false, error: "Only markdown artifacts can be edited" };
  }
  await ensureTierDir(projectPath, tier, displayId);
  const resolved = await resolveSafeEntry(projectPath, tier, displayId, name);
  if (!resolved.ok) return resolved;
  try {
    await fsp.writeFile(resolved.filePath, content, "utf8");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Creates a new, minimally-templated `.md` artifact in the ticket tier.
 * `rawName` is validated (no separators/`..`/empty/leading-dot) then forced to
 * a `.md` extension. The sandbox guards run through the shared
 * {@link resolveSafeEntry} (dir + file realpath/symlink checks live once), and
 * the write uses the `wx` (`O_EXCL`) flag: a name collision — even one an agent
 * created concurrently — fails with EEXIST rather than silently overwriting,
 * and O_EXCL additionally refuses to follow a dangling symlink.
 */
export async function createArtifact(
  projectPath: string,
  displayId: string,
  rawName: string,
): Promise<ArtifactCreateResult> {
  if (!isValidNewArtifactName(rawName)) return { ok: false, error: "Invalid artifact name" };
  const name = withMarkdownExtension(rawName.trim());

  await ensureTicketDir(projectPath, displayId);
  const resolved = await resolveSafeEntry(projectPath, "ticket", displayId, name);
  if (!resolved.ok) return resolved;

  // Friendly fast path for the common collision; the `wx` flag below is the
  // real, race-free guard (closes the TOCTOU window between this check and the
  // write, where an agent could create the same file).
  if (await pathExists(resolved.filePath)) {
    return { ok: false, error: `An artifact named "${name}" already exists` };
  }
  try {
    const content = `# ${artifactBaseName(name)}\n\n`;
    await fsp.writeFile(resolved.filePath, content, { encoding: "utf8", flag: "wx" });
    const stat = await fsp.stat(resolved.filePath);
    return {
      ok: true,
      entry: {
        name,
        relPath: name,
        tier: "ticket",
        size: stat.size,
        mtime: stat.mtimeMs,
        kind: "markdown",
      },
    };
  } catch (error) {
    if (errnoCode(error) === "EEXIST") {
      return { ok: false, error: `An artifact named "${name}" already exists` };
    }
    return { ok: false, error: errorMessage(error) };
  }
}

/**
 * Moves a ticket-tier artifact up to the project tier. Both endpoints run
 * through the shared {@link resolveSafeEntry} sandbox guard (the checks live
 * once, not re-implemented inline). The move is a hardlink + unlink rather than
 * `fsp.rename`: rename silently REPLACES an existing destination, clobbering a
 * project-tier artifact created concurrently; `fsp.link` is atomic and fails
 * with EEXIST if the destination exists (no-replace on the same volume), so a
 * collision always surfaces as a typed error — never a silent overwrite.
 */
export async function promoteArtifact(
  projectPath: string,
  displayId: string,
  name: string,
): Promise<ArtifactPromoteResult> {
  if (!isSafeArtifactEntryName(name)) return { ok: false, error: "Invalid artifact name" };

  const sourcePath = join(ticketArtifactsDir(projectPath, displayId), name);
  if (!(await pathExists(sourcePath))) {
    return { ok: false, error: `"${name}" was not found in the ticket's artifacts` };
  }
  const source = await resolveSafeEntry(projectPath, "ticket", displayId, name);
  if (!source.ok) return source;

  await ensureProjectArtifactsDir(projectPath);
  const dest = await resolveSafeEntry(projectPath, "project", displayId, name);
  if (!dest.ok) return dest;

  try {
    await fsp.link(source.filePath, dest.filePath);
    await fsp.unlink(source.filePath);
    const stat = await fsp.stat(dest.filePath);
    return {
      ok: true,
      entry: {
        name,
        relPath: name,
        tier: "project",
        size: stat.size,
        mtime: stat.mtimeMs,
        kind: classifyArtifactKind(name),
      },
    };
  } catch (error) {
    if (errnoCode(error) === "EEXIST") {
      return {
        ok: false,
        error: `An artifact named "${name}" already exists at the project level`,
      };
    }
    return { ok: false, error: errorMessage(error) };
  }
}

/** Reveals a tier's artifacts directory in Finder (creating it first if needed) — same `shell.showItemInFolder` call as `volli:reveal-in-finder`, just server-resolved so the renderer never sends an absolute path. */
export async function revealArtifactsDir(
  projectPath: string,
  tier: ArtifactTier,
  displayId: string,
): Promise<RevealResult> {
  try {
    await ensureTierDir(projectPath, tier, displayId);
    shell.showItemInFolder(tierDir(projectPath, tier, displayId));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

// ---- live watch --------------------------------------------------------------

const WATCH_DEBOUNCE_MS = 250;

interface WatchSubscription {
  webContents: WebContents;
  /** Everything a re-arm needs to rebuild the two watchers for this key. */
  projectPath: string;
  projectId: string;
  ticketId: string;
  displayId: string;
  projectWatcher: ReturnType<typeof fsWatch> | null;
  ticketWatcher: ReturnType<typeof fsWatch> | null;
  debounceTimer: NodeJS.Timeout | null;
  onDestroyed: () => void;
  /** Guards against overlapping re-arms (both watchers can fault together). */
  reArming: boolean;
}

/**
 * Watches a subscribed ticket's two artifact-tier directories and broadcasts
 * a debounced `volli:artifacts-changed` event to the subscribing window only
 * (window-scoped, same stance as PtyManager) — never to every window, since
 * artifacts are per-project. One subscription per `(webContents, ticketId)`
 * pair; a window teardown tears down every subscription it owns, mirroring
 * pty.ts's `destroyed`-listener cleanup.
 */
export class ArtifactWatchManager {
  private readonly subs = new Map<string, WatchSubscription>();

  constructor(private readonly debounceMs: number = WATCH_DEBOUNCE_MS) {}

  private keyFor(webContents: WebContents, ticketId: string): string {
    return `${webContents.id}:${ticketId}`;
  }

  /** Idempotent: subscribing an already-subscribed `(webContents, ticketId)` pair is a no-op. */
  async subscribe(
    webContents: WebContents,
    projectPath: string,
    projectId: string,
    ticketId: string,
    displayId: string,
  ): Promise<Result> {
    const key = this.keyFor(webContents, ticketId);
    if (this.subs.has(key)) return { ok: true };

    // Reserve the key with a pending entry BEFORE the awaited ensure* calls: an
    // unsubscribe (or a window teardown) arriving during those awaits would
    // otherwise be a silent no-op, and we'd then install watchers nothing ever
    // tears down. `teardown` drops this pending marker too; we detect that below
    // and abort.
    const sub: WatchSubscription = {
      webContents,
      projectPath,
      projectId,
      ticketId,
      displayId,
      projectWatcher: null,
      ticketWatcher: null,
      debounceTimer: null,
      onDestroyed: () => this.teardown(key),
      reArming: false,
    };
    this.subs.set(key, sub);

    try {
      await ensureProjectArtifactsDir(projectPath);
      await ensureTicketDir(projectPath, displayId);
    } catch (error) {
      // ensure* threw (e.g. EACCES). Drop our pending reservation — but only if
      // it is still ours (an unsubscribe during the await may have replaced it,
      // in which case teardown already cleaned up) — so a retry isn't poisoned
      // by a stale entry that short-circuits `this.subs.has(key)` above with
      // zero watchers installed. Surface the failure (CLAUDE.md).
      if (this.subs.get(key) === sub) this.subs.delete(key);
      return { ok: false, error: errorMessage(error) };
    }

    // If an unsubscribe/teardown removed (or replaced) our pending entry during
    // the awaits, abort — teardown already cleaned up, nothing to wire.
    if (this.subs.get(key) !== sub) return { ok: true };
    // The window can close during the awaited ensure* calls above — same race
    // pty.ts's create() guards against. Drop our own pending marker (the
    // destroyed listener isn't attached yet) and bail.
    if (webContents.isDestroyed()) {
      this.subs.delete(key);
      return { ok: true };
    }

    try {
      this.wireWatchers(key, sub);
    } catch (error) {
      // A watcher failed to install. Surface it rather than silently swallowing
      // (CLAUDE.md) and leaving the tab believing live updates are on: close any
      // watcher we already opened, deregister, and report a typed failure.
      sub.projectWatcher?.close();
      sub.ticketWatcher?.close();
      this.subs.delete(key);
      return { ok: false, error: errorMessage(error) };
    }

    webContents.once("destroyed", sub.onDestroyed);
    return { ok: true };
  }

  /** Debounced, window-scoped `volli:artifacts-changed` broadcast for `sub`. */
  private scheduleBroadcast(sub: WatchSubscription): void {
    if (sub.debounceTimer !== null) clearTimeout(sub.debounceTimer);
    sub.debounceTimer = setTimeout(() => {
      sub.debounceTimer = null;
      if (sub.webContents.isDestroyed()) return;
      const payload: ArtifactsChangedEvent = { projectId: sub.projectId, ticketId: sub.ticketId };
      sub.webContents.send("volli:artifacts-changed" satisfies VolliIpcEvent, payload);
    }, this.debounceMs);
  }

  /** (Re)creates both tier watchers for an already-registered `sub`; assumes the dirs exist. */
  private wireWatchers(key: string, sub: WatchSubscription): void {
    sub.projectWatcher = this.openWatcher(key, sub, projectArtifactsDir(sub.projectPath));
    sub.ticketWatcher = this.openWatcher(
      key,
      sub,
      ticketArtifactsDir(sub.projectPath, sub.displayId),
    );
  }

  private openWatcher(
    key: string,
    sub: WatchSubscription,
    dir: string,
  ): ReturnType<typeof fsWatch> {
    const watcher = fsWatch(dir, () => {
      // fs.watch stays bound to the ORIGINAL inode after a `rm -rf .volli &&
      // mkdir -p ...`: if the watched dir no longer exists, the events we're
      // getting are for a dead directory — re-arm onto the freshly-created one.
      // A normal change just broadcasts.
      if (!existsSync(dir)) {
        void this.reArm(key, sub);
        return;
      }
      this.scheduleBroadcast(sub);
    });
    // An async watch failure (volume ejected, kqueue fd pressure) surfaces as an
    // EventEmitter 'error'; UNHANDLED, it would crash the whole main process.
    // The fd is dead, so re-arm; a failed re-arm falls back to teardown + one
    // final broadcast (see reArm).
    watcher.on("error", () => {
      void this.reArm(key, sub);
    });
    return watcher;
  }

  /**
   * Rebuilds a subscription's watchers in place after the watched tree changed
   * underneath them (deleted-and-recreated dir) or a watcher faulted. Single
   * attempt — no retry loop. On success it broadcasts once so the renderer
   * refetches the post-recreate list; on failure it tears the subscription down
   * and sends one final broadcast, the honest tradeoff being: we lose live
   * updates but never leave the tab believing they're still flowing, and we
   * never crash (CLAUDE.md).
   */
  private async reArm(key: string, sub: WatchSubscription): Promise<void> {
    if (sub.reArming) return;
    if (this.subs.get(key) !== sub) return; // torn down while the event was queued
    sub.reArming = true;

    // Close the dead watchers but keep the subscription (and its destroyed
    // listener) registered so a concurrent teardown still finds it.
    sub.projectWatcher?.close();
    sub.ticketWatcher?.close();
    sub.projectWatcher = null;
    sub.ticketWatcher = null;

    try {
      await ensureProjectArtifactsDir(sub.projectPath);
      await ensureTicketDir(sub.projectPath, sub.displayId);
      // The subscription may have been torn down (or the window closed) during
      // the awaits — bail without re-wiring anything nothing would tear down.
      if (this.subs.get(key) !== sub || sub.webContents.isDestroyed()) return;
      this.wireWatchers(key, sub);
      sub.reArming = false;
      // The tree changed under us; nudge the renderer to refetch.
      this.scheduleBroadcast(sub);
    } catch {
      // Re-arm failed: we can no longer honestly claim live updates. Tear down
      // and send one final broadcast so the renderer refetches a
      // stale-but-correct list rather than trusting a watch that's gone.
      this.teardown(key);
      if (!sub.webContents.isDestroyed()) {
        const payload: ArtifactsChangedEvent = { projectId: sub.projectId, ticketId: sub.ticketId };
        sub.webContents.send("volli:artifacts-changed" satisfies VolliIpcEvent, payload);
      }
    }
  }

  unsubscribe(webContents: WebContents, ticketId: string): void {
    this.teardown(this.keyFor(webContents, ticketId));
  }

  private teardown(key: string): void {
    const sub = this.subs.get(key);
    if (sub === undefined) return;
    sub.projectWatcher?.close();
    sub.ticketWatcher?.close();
    if (sub.debounceTimer !== null) clearTimeout(sub.debounceTimer);
    if (!sub.webContents.isDestroyed()) {
      sub.webContents.removeListener("destroyed", sub.onDestroyed);
    }
    this.subs.delete(key);
  }
}

// ---- IPC wiring ---------------------------------------------------------------

const ARTIFACT_CHANNELS: readonly VolliIpcChannel[] = [
  "volli:artifact-list",
  "volli:artifact-read",
  "volli:artifact-read-image",
  "volli:artifact-write",
  "volli:artifact-create",
  "volli:artifact-promote",
  "volli:artifact-reveal-dir",
  "volli:artifact-subscribe",
  "volli:artifact-unsubscribe",
];

interface ArtifactScopeInput {
  projectId: string;
  ticketId: string;
}

function isArtifactScopeInput(value: unknown): value is ArtifactScopeInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["projectId"] === "string" && typeof candidate["ticketId"] === "string";
}

function isArtifactTier(value: unknown): value is ArtifactTier {
  return value === "project" || value === "ticket";
}

interface ArtifactEntryInput extends ArtifactScopeInput {
  tier: ArtifactTier;
  name: string;
}

function isArtifactEntryInput(value: unknown): value is ArtifactEntryInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["projectId"] === "string" &&
    typeof candidate["ticketId"] === "string" &&
    isArtifactTier(candidate["tier"]) &&
    typeof candidate["name"] === "string"
  );
}

interface ArtifactWriteInput extends ArtifactEntryInput {
  content: string;
}

function isArtifactWriteInput(value: unknown): value is ArtifactWriteInput {
  if (!isArtifactEntryInput(value)) return false;
  return typeof (value as unknown as Record<string, unknown>)["content"] === "string";
}

interface ArtifactNameInput extends ArtifactScopeInput {
  name: string;
}

function isArtifactNameInput(value: unknown): value is ArtifactNameInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["projectId"] === "string" &&
    typeof candidate["ticketId"] === "string" &&
    typeof candidate["name"] === "string"
  );
}

interface ArtifactTierScopeInput extends ArtifactScopeInput {
  tier: ArtifactTier;
}

function isArtifactTierScopeInput(value: unknown): value is ArtifactTierScopeInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["projectId"] === "string" &&
    typeof candidate["ticketId"] === "string" &&
    isArtifactTier(candidate["tier"])
  );
}

interface TicketContext {
  project: Project;
  displayId: string;
}

/** Resolves `ticketId` → its project + display id, checked against the caller-supplied `projectId` (defense-in-depth — a mismatched pair is rejected rather than trusted). */
function resolveTicketContext(
  db: Database.Database,
  projectId: string,
  ticketId: string,
): { ok: true; value: TicketContext } | { ok: false; error: string } {
  const row = getTicketRow(db, ticketId);
  if (!row) return { ok: false, error: "Unknown ticket" };
  if (row.project_id !== projectId) {
    return { ok: false, error: "Ticket does not belong to project" };
  }
  const project = getProjectById(db, projectId);
  if (!project) return { ok: false, error: "Unknown project" };
  return {
    ok: true,
    value: { project, displayId: displayTicketId(project.ticketPrefix, row.ticket_number) },
  };
}

/**
 * Registers every `volli:artifact-*` handler. When the db failed to open,
 * every channel resolves with a typed `{ ok: false, error }` instead — same
 * degraded-DB stance as `registerDataIpcHandlers`. Returns the watch manager
 * so the caller can (optionally) hold a reference; watchers are otherwise
 * self-cleaning on window `destroyed`/explicit unsubscribe.
 */
export function registerArtifactIpcHandlers(handle: DbHandle): ArtifactWatchManager {
  const manager = new ArtifactWatchManager();

  if (!handle.ok) {
    const error = handle.error;
    for (const channel of ARTIFACT_CHANNELS) {
      ipcMain.handle(channel, () => ({ ok: false, error }));
    }
    return manager;
  }

  const db = handle.db;

  ipcMain.handle(
    "volli:artifact-list" satisfies VolliIpcChannel,
    async (_event, input: unknown): Promise<ArtifactListResult> => {
      if (!isArtifactScopeInput(input)) return { ok: false, error: "Invalid request" };
      try {
        const ctx = resolveTicketContext(db, input.projectId, input.ticketId);
        if (!ctx.ok) return { ok: false, error: ctx.error };
        const entries = await listArtifacts(ctx.value.project.path, ctx.value.displayId);
        return { ok: true, entries };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:artifact-read" satisfies VolliIpcChannel,
    async (_event, input: unknown): Promise<ArtifactReadResult> => {
      if (!isArtifactEntryInput(input)) return { ok: false, error: "Invalid request" };
      try {
        const ctx = resolveTicketContext(db, input.projectId, input.ticketId);
        if (!ctx.ok) return { ok: false, error: ctx.error };
        return await readArtifactText(
          ctx.value.project.path,
          input.tier,
          ctx.value.displayId,
          input.name,
        );
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:artifact-read-image" satisfies VolliIpcChannel,
    async (_event, input: unknown): Promise<ArtifactReadImageResult> => {
      if (!isArtifactEntryInput(input)) return { ok: false, error: "Invalid request" };
      try {
        const ctx = resolveTicketContext(db, input.projectId, input.ticketId);
        if (!ctx.ok) return { ok: false, error: ctx.error };
        return await readArtifactImage(
          ctx.value.project.path,
          input.tier,
          ctx.value.displayId,
          input.name,
        );
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:artifact-write" satisfies VolliIpcChannel,
    async (_event, input: unknown): Promise<Result> => {
      if (!isArtifactWriteInput(input)) return { ok: false, error: "Invalid request" };
      try {
        const ctx = resolveTicketContext(db, input.projectId, input.ticketId);
        if (!ctx.ok) return { ok: false, error: ctx.error };
        return await writeArtifactText(
          ctx.value.project.path,
          input.tier,
          ctx.value.displayId,
          input.name,
          input.content,
        );
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:artifact-create" satisfies VolliIpcChannel,
    async (_event, input: unknown): Promise<ArtifactCreateResult> => {
      if (!isArtifactNameInput(input)) return { ok: false, error: "Invalid request" };
      try {
        const ctx = resolveTicketContext(db, input.projectId, input.ticketId);
        if (!ctx.ok) return { ok: false, error: ctx.error };
        return await createArtifact(ctx.value.project.path, ctx.value.displayId, input.name);
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:artifact-promote" satisfies VolliIpcChannel,
    async (_event, input: unknown): Promise<ArtifactPromoteResult> => {
      if (!isArtifactNameInput(input)) return { ok: false, error: "Invalid request" };
      try {
        const ctx = resolveTicketContext(db, input.projectId, input.ticketId);
        if (!ctx.ok) return { ok: false, error: ctx.error };
        return await promoteArtifact(ctx.value.project.path, ctx.value.displayId, input.name);
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:artifact-reveal-dir" satisfies VolliIpcChannel,
    async (_event, input: unknown): Promise<RevealResult> => {
      if (!isArtifactTierScopeInput(input)) return { ok: false, error: "Invalid request" };
      try {
        const ctx = resolveTicketContext(db, input.projectId, input.ticketId);
        if (!ctx.ok) return { ok: false, error: ctx.error };
        return await revealArtifactsDir(ctx.value.project.path, input.tier, ctx.value.displayId);
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:artifact-subscribe" satisfies VolliIpcChannel,
    async (event, input: unknown): Promise<Result> => {
      if (!isArtifactScopeInput(input)) return { ok: false, error: "Invalid request" };
      try {
        const ctx = resolveTicketContext(db, input.projectId, input.ticketId);
        if (!ctx.ok) return { ok: false, error: ctx.error };
        return await manager.subscribe(
          event.sender,
          ctx.value.project.path,
          input.projectId,
          input.ticketId,
          ctx.value.displayId,
        );
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:artifact-unsubscribe" satisfies VolliIpcChannel,
    (event, input: unknown): Result => {
      if (!isArtifactScopeInput(input)) return { ok: false, error: "Invalid request" };
      manager.unsubscribe(event.sender, input.ticketId);
      return { ok: true };
    },
  );

  return manager;
}
