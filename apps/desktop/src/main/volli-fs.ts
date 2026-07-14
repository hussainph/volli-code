/**
 * All Node fs work for the `.volli` per-project artifacts convention
 * (ticket-detail-mvp decisions #13-17): ensuring/self-gitignoring `.volli`,
 * listing both artifact tiers, read/write/create/promote, and a debounced
 * `fs.watch` broadcast. Mirrors pty.ts/ghostty-config.ts's shape: pure fs
 * helpers exported for direct testing against real temp dirs, thin Electron
 * IPC wiring at the bottom. Every mutation returns a typed `Result` rather
 * than throwing across the IPC boundary — same convention as data-ipc.ts.
 */
import { promises as fsp, watch as fsWatch } from "node:fs";
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

/** Same escape guard as {@link assertDirWithinVolli}, one level down: an existing file's realpath must stay inside `dir`'s realpath. A file that doesn't exist yet (nothing to escape via) passes. */
async function assertFileWithinDir(
  dir: string,
  filePath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
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

/** Files only (dirents, so symlinks are excluded — same stance as list-directory's IPC handler), skipping dotfiles. Never creates `dir`; a missing directory is an empty tier, not an error. */
async function listTierEntries(dir: string, tier: ArtifactTier): Promise<ArtifactEntry[]> {
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const entries: ArtifactEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith(".")) continue;
    if (!dirent.isFile()) continue;
    try {
      const stat = await fsp.stat(join(dir, dirent.name));
      entries.push({
        name: dirent.name,
        relPath: dirent.name,
        tier,
        size: stat.size,
        mtime: stat.mtimeMs,
        kind: classifyArtifactKind(dirent.name),
      });
    } catch {
      // Raced away between readdir and stat (deleted mid-listing) — skip it.
    }
  }
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

/** Creates a new, minimally-templated `.md` artifact in the ticket tier. `rawName` is validated (no separators/`..`/empty) then forced to a `.md` extension; a name collision fails rather than silently overwriting. */
export async function createArtifact(
  projectPath: string,
  displayId: string,
  rawName: string,
): Promise<ArtifactCreateResult> {
  if (!isValidNewArtifactName(rawName)) return { ok: false, error: "Invalid artifact name" };
  const name = withMarkdownExtension(rawName.trim());
  if (!isSafeArtifactEntryName(name)) return { ok: false, error: "Invalid artifact name" };

  await ensureTicketDir(projectPath, displayId);
  const dir = ticketArtifactsDir(projectPath, displayId);
  const dirCheck = await assertDirWithinVolli(projectPath, dir);
  if (!dirCheck.ok) return dirCheck;

  const filePath = join(dir, name);
  if (await pathExists(filePath)) {
    return { ok: false, error: `An artifact named "${name}" already exists` };
  }
  try {
    const content = `# ${artifactBaseName(name)}\n\n`;
    await fsp.writeFile(filePath, content, "utf8");
    const stat = await fsp.stat(filePath);
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
    return { ok: false, error: errorMessage(error) };
  }
}

/** Moves a ticket-tier artifact up to the project tier via rename. A name collision at the destination fails with a typed error — never a silent overwrite. */
export async function promoteArtifact(
  projectPath: string,
  displayId: string,
  name: string,
): Promise<ArtifactPromoteResult> {
  if (!isSafeArtifactEntryName(name)) return { ok: false, error: "Invalid artifact name" };

  const sourceDir = ticketArtifactsDir(projectPath, displayId);
  const sourcePath = join(sourceDir, name);
  if (!(await pathExists(sourcePath))) {
    return { ok: false, error: `"${name}" was not found in the ticket's artifacts` };
  }
  const sourceDirCheck = await assertDirWithinVolli(projectPath, sourceDir);
  if (!sourceDirCheck.ok) return sourceDirCheck;
  const sourceFileCheck = await assertFileWithinDir(sourceDir, sourcePath);
  if (!sourceFileCheck.ok) return sourceFileCheck;

  await ensureProjectArtifactsDir(projectPath);
  const destDir = projectArtifactsDir(projectPath);
  const destPath = join(destDir, name);
  if (await pathExists(destPath)) {
    return { ok: false, error: `An artifact named "${name}" already exists at the project level` };
  }

  try {
    await fsp.rename(sourcePath, destPath);
    const stat = await fsp.stat(destPath);
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
  projectWatcher: ReturnType<typeof fsWatch> | null;
  ticketWatcher: ReturnType<typeof fsWatch> | null;
  debounceTimer: NodeJS.Timeout | null;
  onDestroyed: () => void;
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
  ): Promise<void> {
    const key = this.keyFor(webContents, ticketId);
    if (this.subs.has(key)) return;

    await ensureProjectArtifactsDir(projectPath);
    await ensureTicketDir(projectPath, displayId);
    // The window can close during the awaited ensure* calls above — same race
    // pty.ts's create() guards against.
    if (webContents.isDestroyed()) return;

    const sub: WatchSubscription = {
      webContents,
      projectWatcher: null,
      ticketWatcher: null,
      debounceTimer: null,
      onDestroyed: () => this.teardown(key),
    };

    const scheduleBroadcast = (): void => {
      if (sub.debounceTimer !== null) clearTimeout(sub.debounceTimer);
      sub.debounceTimer = setTimeout(() => {
        sub.debounceTimer = null;
        if (webContents.isDestroyed()) return;
        const payload: ArtifactsChangedEvent = { projectId, ticketId };
        webContents.send("volli:artifacts-changed" satisfies VolliIpcEvent, payload);
      }, this.debounceMs);
    };

    try {
      sub.projectWatcher = fsWatch(projectArtifactsDir(projectPath), () => scheduleBroadcast());
    } catch (error) {
      console.warn(`[volli-fs] could not watch project artifacts dir: ${errorMessage(error)}`);
    }
    try {
      sub.ticketWatcher = fsWatch(ticketArtifactsDir(projectPath, displayId), () =>
        scheduleBroadcast(),
      );
    } catch (error) {
      console.warn(`[volli-fs] could not watch ticket artifacts dir: ${errorMessage(error)}`);
    }

    webContents.once("destroyed", sub.onDestroyed);
    this.subs.set(key, sub);
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
        await manager.subscribe(
          event.sender,
          ctx.value.project.path,
          input.projectId,
          input.ticketId,
          ctx.value.displayId,
        );
        return { ok: true };
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
