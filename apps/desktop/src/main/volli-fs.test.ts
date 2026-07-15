import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactsChangedEvent, VolliIpcChannel } from "@volli/shared";
import { VOLLI_GITIGNORE_CONTENT } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Hoisted above module evaluation, like pty.test.ts/data-ipc.test.ts, so the
// mock factories can capture into them. `electron` is fully mocked (never
// resolvable under plain-Node vitest). `node:fs` is PARTIALLY mocked: every
// real export (mkdtempSync/realpath/…) passes through unchanged via
// `importOriginal` — only `watch` is replaced, so the ArtifactWatchManager
// suite below fires watch callbacks deterministically under
// `vi.useFakeTimers()` instead of racing a real fs.watch/OS debounce
// (ghostty-config.test.ts's `watchMock` is the same idea — real fs.watch
// timing proved flaky here even with a short debounce). Every other suite in
// this file (ensure*/list/read/write/create/promote/symlink-escape) runs
// against real directories, real symlinks, and real disk I/O, untouched by
// this mock.
const { handlers, showItemInFolderMock, watchMock } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  showItemInFolderMock: vi.fn(),
  watchMock: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: never[]) => unknown) {
      handlers.set(channel, handler);
    },
  },
  shell: { showItemInFolder: showItemInFolderMock },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, watch: watchMock };
});

import {
  ArtifactWatchManager,
  createArtifact,
  ensureTicketDir,
  ensureVolliDir,
  listArtifacts,
  promoteArtifact,
  readArtifactImage,
  readArtifactText,
  registerArtifactIpcHandlers,
  revealArtifactsDir,
  writeArtifactText,
} from "./volli-fs";
import { insertProject } from "./db/projects-repo";
import { openTestDb, testProject, testTicket } from "./db/test-helpers";
import type { TestDb } from "./db/test-helpers";
import { insertTicket } from "./db/tickets-repo";

// ---- shared test scaffolding -------------------------------------------------

const tempDirs: string[] = [];

/** A real, throwaway project directory — every fs op under test runs against real disk. */
function makeTempProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "volli-fs-test-"));
  tempDirs.push(dir);
  return dir;
}

/** A captured watcher double: `close` is asserted on, `emitError` fires the 'error' handler openWatcher attaches. */
interface FakeWatcher {
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  emitError: (error: unknown) => void;
}

function makeFakeWatcher(): FakeWatcher {
  const errorHandlers: ((error: unknown) => void)[] = [];
  return {
    close: vi.fn(),
    on: vi.fn((event: string, handler: (error: unknown) => void) => {
      if (event === "error") errorHandlers.push(handler);
    }),
    emitError: (error: unknown) => {
      for (const handler of errorHandlers) handler(error);
    },
  };
}

/** One captured `fs.watch(dir, cb)` call: `cb` can be fired manually, `watcher.close`/errors asserted on. */
interface WatchCall {
  dir: string;
  cb: (eventType: string, filename: string | null) => void;
  watcher: FakeWatcher;
}
let watchCalls: WatchCall[] = [];

/**
 * Polls `predicate` until it holds (or the timeout elapses), so a test can await
 * the settling of a fire-and-forget re-arm without a flaky fixed sleep — the
 * re-arm's real-fs ensure* can run long under full-suite CPU contention.
 */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  watchCalls = [];
  watchMock.mockReset();
  watchMock.mockImplementation((dir: string, cb: WatchCall["cb"]) => {
    const watcher = makeFakeWatcher();
    watchCalls.push({ dir, cb, watcher });
    return watcher;
  });
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  handlers.clear();
  showItemInFolderMock.mockClear();
  vi.useRealTimers();
});

/** A WebContents double keyed by `id` (ArtifactWatchManager's subscription key) — same shape as pty.test.ts's double, plus `id`. */
function makeWebContents(id = 1) {
  const eventListeners = new Map<string, () => void>();
  return {
    id,
    send: vi.fn(),
    destroyed: false,
    isDestroyed(): boolean {
      return this.destroyed;
    },
    once: vi.fn(function (this: unknown, event: string, cb: () => void) {
      eventListeners.set(event, cb);
    }),
    removeListener: vi.fn(),
    fireDestroyed() {
      eventListeners.get("destroyed")?.();
    },
  };
}

// ---- ensureVolliDir / ensureTicketDir ----------------------------------------

describe("ensureVolliDir", () => {
  it("creates .volli/ and .volli/.gitignore with the self-gitignore content", async () => {
    const project = makeTempProjectDir();
    await ensureVolliDir(project);
    expect(existsSync(join(project, ".volli"))).toBe(true);
    expect(readFileSync(join(project, ".volli", ".gitignore"), "utf8")).toBe(
      VOLLI_GITIGNORE_CONTENT,
    );
  });

  it("never touches the project's root .gitignore", async () => {
    const project = makeTempProjectDir();
    writeFileSync(join(project, ".gitignore"), "node_modules\n", "utf8");
    await ensureVolliDir(project);
    expect(readFileSync(join(project, ".gitignore"), "utf8")).toBe("node_modules\n");
  });

  it("is idempotent: a second call does not clobber an existing .volli/.gitignore", async () => {
    const project = makeTempProjectDir();
    await ensureVolliDir(project);
    writeFileSync(join(project, ".volli", ".gitignore"), "custom\n", "utf8");
    await ensureVolliDir(project);
    expect(readFileSync(join(project, ".volli", ".gitignore"), "utf8")).toBe("custom\n");
  });
});

describe("ensureTicketDir", () => {
  it("creates the full tickets/<id>/artifacts chain plus the .volli self-gitignore", async () => {
    const project = makeTempProjectDir();
    await ensureTicketDir(project, "VC-1");
    expect(existsSync(join(project, ".volli", "tickets", "VC-1", "artifacts"))).toBe(true);
    expect(existsSync(join(project, ".volli", ".gitignore"))).toBe(true);
  });

  it("is idempotent", async () => {
    const project = makeTempProjectDir();
    await ensureTicketDir(project, "VC-1");
    await expect(ensureTicketDir(project, "VC-1")).resolves.toBeUndefined();
  });
});

// ---- listArtifacts ------------------------------------------------------------

describe("listArtifacts", () => {
  it("returns an empty list without creating any directory when neither tier exists", async () => {
    const project = makeTempProjectDir();
    const entries = await listArtifacts(project, "VC-1");
    expect(entries).toEqual([]);
    expect(existsSync(join(project, ".volli"))).toBe(false);
  });

  it("lists both tiers, classifies kind by extension, and skips dotfiles and subdirectories", async () => {
    const project = makeTempProjectDir();
    await ensureTicketDir(project, "VC-1");
    const ticketDir = join(project, ".volli", "tickets", "VC-1", "artifacts");
    await writeFile(join(ticketDir, "notes.md"), "# hi", "utf8");
    await writeFile(join(ticketDir, ".hidden.md"), "nope", "utf8");
    await mkdir(join(ticketDir, "subdir"));

    const projectArtifacts = join(project, ".volli", "artifacts");
    await mkdir(projectArtifacts, { recursive: true });
    await writeFile(join(projectArtifacts, "diagram.png"), "binary", "utf8");
    await writeFile(join(projectArtifacts, "raw.json"), "{}", "utf8");

    const entries = await listArtifacts(project, "VC-1");
    expect(entries).toHaveLength(3);

    const ticketEntry = entries.find((e) => e.name === "notes.md");
    expect(ticketEntry).toMatchObject({ tier: "ticket", kind: "markdown", relPath: "notes.md" });
    expect(ticketEntry?.size).toBeGreaterThan(0);

    const image = entries.find((e) => e.name === "diagram.png");
    expect(image).toMatchObject({ tier: "project", kind: "image" });

    const other = entries.find((e) => e.name === "raw.json");
    expect(other).toMatchObject({ tier: "project", kind: "other" });

    expect(entries.some((e) => e.name === ".hidden.md")).toBe(false);
    expect(entries.some((e) => e.name === "subdir")).toBe(false);
  });

  it("sorts each tier case-insensitively", async () => {
    const project = makeTempProjectDir();
    await ensureTicketDir(project, "VC-1");
    const ticketDir = join(project, ".volli", "tickets", "VC-1", "artifacts");
    await writeFile(join(ticketDir, "banana.md"), "b", "utf8");
    await writeFile(join(ticketDir, "Apple.md"), "a", "utf8");

    const entries = await listArtifacts(project, "VC-1");
    expect(entries.map((e) => e.name)).toEqual(["Apple.md", "banana.md"]);
  });
});

// ---- read / write --------------------------------------------------------------

describe("readArtifactText / writeArtifactText", () => {
  it("round-trips markdown content, creating the ticket-tier chain on demand", async () => {
    const project = makeTempProjectDir();
    const write = await writeArtifactText(project, "ticket", "VC-1", "notes.md", "# Hello");
    expect(write).toEqual({ ok: true });

    const read = await readArtifactText(project, "ticket", "VC-1", "notes.md");
    expect(read).toEqual({ ok: true, content: "# Hello" });
  });

  it("round-trips through the project tier too", async () => {
    const project = makeTempProjectDir();
    await writeArtifactText(project, "project", "VC-1", "shared.md", "shared content");
    const read = await readArtifactText(project, "project", "VC-1", "shared.md");
    expect(read).toEqual({ ok: true, content: "shared content" });
  });

  it("rejects writing a non-markdown name", async () => {
    const project = makeTempProjectDir();
    const result = await writeArtifactText(project, "ticket", "VC-1", "notes.txt", "hi");
    expect(result).toEqual({ ok: false, error: expect.stringContaining("markdown") as unknown });
  });

  it("returns a typed error reading a file that does not exist", async () => {
    const project = makeTempProjectDir();
    await ensureTicketDir(project, "VC-1");
    const result = await readArtifactText(project, "ticket", "VC-1", "missing.md");
    expect(result.ok).toBe(false);
  });

  it.each([["../../etc/passwd"], ["/etc/passwd"], [".."], ["."], [""]])(
    "rejects an unsafe name %s on read",
    async (name) => {
      const project = makeTempProjectDir();
      const result = await readArtifactText(project, "ticket", "VC-1", name);
      expect(result).toEqual({ ok: false, error: "Invalid artifact name" });
    },
  );

  it("rejects an unsafe name on write", async () => {
    const project = makeTempProjectDir();
    const result = await writeArtifactText(project, "ticket", "VC-1", "../escape.md", "x");
    expect(result).toEqual({ ok: false, error: "Invalid artifact name" });
  });
});

describe("readArtifactImage", () => {
  it("returns a base64 data: URI for a recognized image extension", async () => {
    const project = makeTempProjectDir();
    await ensureTicketDir(project, "VC-1");
    const dir = join(project, ".volli", "tickets", "VC-1", "artifacts");
    await writeFile(join(dir, "photo.png"), Buffer.from([1, 2, 3]));

    const result = await readArtifactImage(project, "ticket", "VC-1", "photo.png");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("rejects a non-image name", async () => {
    const project = makeTempProjectDir();
    const result = await readArtifactImage(project, "ticket", "VC-1", "notes.md");
    expect(result).toEqual({ ok: false, error: "Not an image artifact" });
  });
});

// ---- create ----------------------------------------------------------------

describe("createArtifact", () => {
  it("creates a new templated .md in the ticket tier, forcing the extension", async () => {
    const project = makeTempProjectDir();
    const result = await createArtifact(project, "VC-1", "Design Notes");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry).toMatchObject({
      name: "Design Notes.md",
      tier: "ticket",
      kind: "markdown",
    });

    const content = await readFile(
      join(project, ".volli", "tickets", "VC-1", "artifacts", "Design Notes.md"),
      "utf8",
    );
    expect(content).toContain("# Design Notes");
  });

  it("leaves an already-.md name untouched", async () => {
    const project = makeTempProjectDir();
    const result = await createArtifact(project, "VC-1", "notes.md");
    expect(result.ok && result.entry.name).toBe("notes.md");
  });

  it.each([[""], ["   "], [".."], ["sub/notes"]])("rejects an invalid raw name %s", async (raw) => {
    const project = makeTempProjectDir();
    const result = await createArtifact(project, "VC-1", raw);
    expect(result).toEqual({ ok: false, error: "Invalid artifact name" });
  });

  it("fails with a typed error on a name collision, without overwriting the original", async () => {
    const project = makeTempProjectDir();
    await createArtifact(project, "VC-1", "notes");
    const filePath = join(project, ".volli", "tickets", "VC-1", "artifacts", "notes.md");
    await writeFile(filePath, "original", "utf8");

    const result = await createArtifact(project, "VC-1", "notes");
    expect(result.ok).toBe(false);
    expect(await readFile(filePath, "utf8")).toBe("original");
  });
});

// ---- promote -----------------------------------------------------------------

describe("promoteArtifact", () => {
  it("moves a ticket-tier artifact up to the project tier", async () => {
    const project = makeTempProjectDir();
    await writeArtifactText(project, "ticket", "VC-1", "notes.md", "content");

    const result = await promoteArtifact(project, "VC-1", "notes.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry).toMatchObject({ name: "notes.md", tier: "project" });

    expect(existsSync(join(project, ".volli", "tickets", "VC-1", "artifacts", "notes.md"))).toBe(
      false,
    );
    expect(await readFile(join(project, ".volli", "artifacts", "notes.md"), "utf8")).toBe(
      "content",
    );
  });

  it("fails with a typed error when the ticket-tier artifact does not exist", async () => {
    const project = makeTempProjectDir();
    const result = await promoteArtifact(project, "VC-1", "missing.md");
    expect(result).toEqual({
      ok: false,
      error: `"missing.md" was not found in the ticket's artifacts`,
    });
  });

  it("fails with a typed error on a project-tier name collision, leaving the source untouched", async () => {
    const project = makeTempProjectDir();
    await writeArtifactText(project, "ticket", "VC-1", "notes.md", "ticket content");
    await writeArtifactText(project, "project", "VC-1", "notes.md", "project content");

    const result = await promoteArtifact(project, "VC-1", "notes.md");
    expect(result.ok).toBe(false);

    expect(
      await readFile(join(project, ".volli", "tickets", "VC-1", "artifacts", "notes.md"), "utf8"),
    ).toBe("ticket content");
    expect(await readFile(join(project, ".volli", "artifacts", "notes.md"), "utf8")).toBe(
      "project content",
    );
  });

  it("rejects an unsafe name", async () => {
    const project = makeTempProjectDir();
    const result = await promoteArtifact(project, "VC-1", "..");
    expect(result).toEqual({ ok: false, error: "Invalid artifact name" });
  });
});

// ---- path-safety: symlink escapes ----------------------------------------------

describe("symlink-escape guards", () => {
  it("rejects reading through a ticket artifacts directory that has been swapped for a symlink escaping .volli", async () => {
    const project = makeTempProjectDir();
    await ensureTicketDir(project, "VC-1");
    const ticketArtifacts = join(project, ".volli", "tickets", "VC-1", "artifacts");
    rmSync(ticketArtifacts, { recursive: true });

    const outside = mkdtempSync(join(tmpdir(), "volli-fs-outside-"));
    tempDirs.push(outside);
    writeFileSync(join(outside, "secret.md"), "top secret", "utf8");
    symlinkSync(outside, ticketArtifacts, "dir");

    const result = await readArtifactText(project, "ticket", "VC-1", "secret.md");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("escapes");
  });

  it("rejects reading a file that is itself a symlink (rejected outright, before target resolution)", async () => {
    const project = makeTempProjectDir();
    await ensureTicketDir(project, "VC-1");
    const ticketArtifacts = join(project, ".volli", "tickets", "VC-1", "artifacts");

    const outsideFile = join(mkdtempSync(join(tmpdir(), "volli-fs-outside-")), "secret.md");
    tempDirs.push(join(outsideFile, ".."));
    writeFileSync(outsideFile, "top secret", "utf8");
    symlinkSync(outsideFile, join(ticketArtifacts, "link.md"), "file");

    const result = await readArtifactText(project, "ticket", "VC-1", "link.md");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("symlink");
  });

  it("rejects reading through a DANGLING symlink named like an artifact (no silent escape)", async () => {
    const project = makeTempProjectDir();
    await ensureTicketDir(project, "VC-1");
    const ticketArtifacts = join(project, ".volli", "tickets", "VC-1", "artifacts");
    // Points nowhere: previously realpath() threw and the path was treated as
    // "safe", letting a writeFile follow it out of .volli.
    symlinkSync(
      join(project, "nonexistent-target.md"),
      join(ticketArtifacts, "dangling.md"),
      "file",
    );

    const result = await readArtifactText(project, "ticket", "VC-1", "dangling.md");
    expect(result).toEqual({ ok: false, error: "Artifact is a symlink" });
  });

  it("createArtifact refuses to write through a pre-existing symlink at the target name", async () => {
    const project = makeTempProjectDir();
    await ensureTicketDir(project, "VC-1");
    const ticketArtifacts = join(project, ".volli", "tickets", "VC-1", "artifacts");
    const outside = mkdtempSync(join(tmpdir(), "volli-fs-outside-"));
    tempDirs.push(outside);
    const outsideFile = join(outside, "target.md");
    writeFileSync(outsideFile, "untouched", "utf8");
    symlinkSync(outsideFile, join(ticketArtifacts, "notes.md"), "file");

    const result = await createArtifact(project, "VC-1", "notes");
    expect(result).toEqual({ ok: false, error: "Artifact is a symlink" });
    // The symlink was NOT followed — the outside file is untouched.
    expect(readFileSync(outsideFile, "utf8")).toBe("untouched");
  });
});

// ---- revealArtifactsDir ---------------------------------------------------------

describe("revealArtifactsDir", () => {
  it("ensures the directory exists, then reveals it via shell.showItemInFolder", async () => {
    const project = makeTempProjectDir();
    const result = await revealArtifactsDir(project, "ticket", "VC-1");
    expect(result).toEqual({ ok: true });
    const dir = join(project, ".volli", "tickets", "VC-1", "artifacts");
    expect(existsSync(dir)).toBe(true);
    expect(showItemInFolderMock).toHaveBeenCalledWith(dir);
  });

  it("reveals the project tier", async () => {
    const project = makeTempProjectDir();
    const result = await revealArtifactsDir(project, "project", "VC-1");
    expect(result).toEqual({ ok: true });
    expect(showItemInFolderMock).toHaveBeenCalledWith(join(project, ".volli", "artifacts"));
  });
});

// ---- ArtifactWatchManager --------------------------------------------------------

describe("ArtifactWatchManager", () => {
  it("ensures both tier directories exist on subscribe", async () => {
    const project = makeTempProjectDir();
    const manager = new ArtifactWatchManager();
    const webContents = makeWebContents();

    await manager.subscribe(webContents as never, project, "proj-1", "ticket-1", "VC-1");

    expect(existsSync(join(project, ".volli", "artifacts"))).toBe(true);
    expect(existsSync(join(project, ".volli", "tickets", "VC-1", "artifacts"))).toBe(true);
  });

  it("watches both tier directories", async () => {
    const project = makeTempProjectDir();
    const manager = new ArtifactWatchManager();
    const webContents = makeWebContents();

    await manager.subscribe(webContents as never, project, "proj-1", "ticket-1", "VC-1");

    expect(watchCalls.map((c) => c.dir)).toEqual([
      join(project, ".volli", "artifacts"),
      join(project, ".volli", "tickets", "VC-1", "artifacts"),
    ]);
  });

  it("broadcasts a debounced volli:artifacts-changed event when a watcher fires", async () => {
    const project = makeTempProjectDir();
    const manager = new ArtifactWatchManager(250);
    const webContents = makeWebContents();
    await manager.subscribe(webContents as never, project, "proj-1", "ticket-1", "VC-1");

    vi.useFakeTimers();
    watchCalls[1]?.cb("change", "notes.md");
    vi.advanceTimersByTime(250);

    expect(webContents.send).toHaveBeenCalledWith("volli:artifacts-changed", {
      projectId: "proj-1",
      ticketId: "ticket-1",
    } satisfies ArtifactsChangedEvent);
  });

  it("does not broadcast before the debounce window elapses", async () => {
    const project = makeTempProjectDir();
    const manager = new ArtifactWatchManager(250);
    const webContents = makeWebContents();
    await manager.subscribe(webContents as never, project, "proj-1", "ticket-1", "VC-1");

    vi.useFakeTimers();
    watchCalls[1]?.cb("change", "notes.md");
    vi.advanceTimersByTime(200);

    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("collapses a burst across both watched dirs into a single broadcast", async () => {
    const project = makeTempProjectDir();
    const manager = new ArtifactWatchManager(250);
    const webContents = makeWebContents();
    await manager.subscribe(webContents as never, project, "proj-1", "ticket-1", "VC-1");

    vi.useFakeTimers();
    watchCalls[0]?.cb("change", "a.md"); // project-tier watcher
    vi.advanceTimersByTime(100);
    watchCalls[1]?.cb("change", "b.md"); // ticket-tier watcher — resets the shared debounce timer
    vi.advanceTimersByTime(100);
    expect(webContents.send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);

    expect(webContents.send).toHaveBeenCalledTimes(1);
  });

  it("does not broadcast to a webContents destroyed before the debounce timer fires", async () => {
    const project = makeTempProjectDir();
    const manager = new ArtifactWatchManager(250);
    const webContents = makeWebContents();
    await manager.subscribe(webContents as never, project, "proj-1", "ticket-1", "VC-1");

    vi.useFakeTimers();
    watchCalls[1]?.cb("change", "notes.md");
    webContents.destroyed = true;
    vi.advanceTimersByTime(250);

    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("clears any pending debounce timer on unsubscribe — no late broadcast", async () => {
    const project = makeTempProjectDir();
    const manager = new ArtifactWatchManager(250);
    const webContents = makeWebContents();
    await manager.subscribe(webContents as never, project, "proj-1", "ticket-1", "VC-1");

    vi.useFakeTimers();
    watchCalls[1]?.cb("change", "notes.md");
    manager.unsubscribe(webContents as never, "ticket-1");
    vi.advanceTimersByTime(1000);

    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("closes both watchers on unsubscribe", async () => {
    const project = makeTempProjectDir();
    const manager = new ArtifactWatchManager();
    const webContents = makeWebContents();
    await manager.subscribe(webContents as never, project, "proj-1", "ticket-1", "VC-1");

    manager.unsubscribe(webContents as never, "ticket-1");

    expect(watchCalls[0]?.watcher.close).toHaveBeenCalledTimes(1);
    expect(watchCalls[1]?.watcher.close).toHaveBeenCalledTimes(1);
  });

  it("tears down watchers and clears the pending timer when the owning webContents is destroyed", async () => {
    const project = makeTempProjectDir();
    const manager = new ArtifactWatchManager(250);
    const webContents = makeWebContents();
    await manager.subscribe(webContents as never, project, "proj-1", "ticket-1", "VC-1");

    vi.useFakeTimers();
    watchCalls[1]?.cb("change", "notes.md");
    webContents.fireDestroyed();

    expect(watchCalls[0]?.watcher.close).toHaveBeenCalledTimes(1);
    expect(watchCalls[1]?.watcher.close).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("subscribing twice for the same (webContents, ticketId) wires only one pair of watchers", async () => {
    const project = makeTempProjectDir();
    const manager = new ArtifactWatchManager();
    const webContents = makeWebContents();
    await manager.subscribe(webContents as never, project, "proj-1", "ticket-1", "VC-1");
    await manager.subscribe(webContents as never, project, "proj-1", "ticket-1", "VC-1");

    expect(watchMock).toHaveBeenCalledTimes(2);
  });

  it("wires an independent pair of watchers per distinct (webContents, ticketId)", async () => {
    const project = makeTempProjectDir();
    const manager = new ArtifactWatchManager();
    const webContentsA = makeWebContents(1);
    const webContentsB = makeWebContents(2);
    await manager.subscribe(webContentsA as never, project, "proj-1", "ticket-1", "VC-1");
    await manager.subscribe(webContentsB as never, project, "proj-1", "ticket-2", "VC-2");

    expect(watchMock).toHaveBeenCalledTimes(4);
  });

  it("bails without wiring watchers once ensure* resolves against an already-destroyed webContents", async () => {
    const project = makeTempProjectDir();
    const manager = new ArtifactWatchManager();
    const webContents = makeWebContents();
    webContents.destroyed = true;

    await manager.subscribe(webContents as never, project, "proj-1", "ticket-1", "VC-1");

    expect(watchMock).not.toHaveBeenCalled();
  });

  it("returns ok:false and closes the partial watcher when a fs.watch call throws", async () => {
    const project = makeTempProjectDir();
    const manager = new ArtifactWatchManager();
    const webContents = makeWebContents();
    // Project-tier watcher installs fine; the ticket-tier one throws.
    watchMock
      .mockImplementationOnce((dir: string, cb: WatchCall["cb"]) => {
        const watcher = makeFakeWatcher();
        watchCalls.push({ dir, cb, watcher });
        return watcher;
      })
      .mockImplementationOnce(() => {
        throw new Error("EMFILE");
      });

    const result = await manager.subscribe(
      webContents as never,
      project,
      "proj-1",
      "ticket-1",
      "VC-1",
    );

    // Surfaced as a typed failure (never a silent swallow), and the watcher we
    // already installed was closed — no partial watch is left behind.
    expect(result).toEqual({ ok: false, error: "EMFILE" });
    expect(watchCalls[0]?.watcher.close).toHaveBeenCalledTimes(1);
    // Fully deregistered: the destroyed listener was never attached.
    expect(webContents.once).not.toHaveBeenCalled();
  });

  it("a subscribe interrupted by an unsubscribe mid-await wires zero live watchers", async () => {
    const project = makeTempProjectDir();
    const manager = new ArtifactWatchManager();
    const webContents = makeWebContents();

    // Start the async subscribe but DON'T await it: it runs synchronously up to
    // the first `await ensure*`, reserving the key, then suspends. Unsubscribe
    // before the awaits resolve — the pending reservation lets it cancel.
    const pending = manager.subscribe(webContents as never, project, "proj-1", "ticket-1", "VC-1");
    manager.unsubscribe(webContents as never, "ticket-1");
    await expect(pending).resolves.toEqual({ ok: true });

    // No watcher was ever installed, so a later change can't broadcast — the
    // race that would strand an untearable watcher is closed.
    expect(watchMock).not.toHaveBeenCalled();
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("unsubscribing an unknown pair does not throw", () => {
    const manager = new ArtifactWatchManager();
    expect(() => manager.unsubscribe(makeWebContents() as never, "nope")).not.toThrow();
  });

  it("returns ok:false and drops the pending entry when ensure* throws, so a retry isn't poisoned", async () => {
    // A project path whose ancestor is a FILE — the recursive mkdir inside
    // ensure* fails with ENOTDIR.
    const fileParent = mkdtempSync(join(tmpdir(), "volli-fs-file-"));
    tempDirs.push(fileParent);
    const filePath = join(fileParent, "not-a-dir");
    writeFileSync(filePath, "x", "utf8");
    const badProject = join(filePath, "project");

    const manager = new ArtifactWatchManager();
    const webContents = makeWebContents();

    const first = await manager.subscribe(webContents as never, badProject, "p", "t", "VC-1");
    expect(first.ok).toBe(false);
    expect(watchMock).not.toHaveBeenCalled();
    // Not poisoned: a second attempt re-runs ensure* (and fails the same way)
    // rather than short-circuiting to a bogus { ok: true } with no watchers.
    const second = await manager.subscribe(webContents as never, badProject, "p", "t", "VC-1");
    expect(second.ok).toBe(false);
  });

  it("re-arms both watchers on a watcher 'error' (never crashes the process) and refetches", async () => {
    const project = makeTempProjectDir();
    const manager = new ArtifactWatchManager(0);
    const webContents = makeWebContents();
    await manager.subscribe(webContents as never, project, "proj-1", "ticket-1", "VC-1");
    expect(watchMock).toHaveBeenCalledTimes(2);
    const [projectWatcher, ticketWatcher] = [watchCalls[0], watchCalls[1]];

    // An async fs.watch fault would otherwise be an unhandled EventEmitter
    // 'error' that crashes main. Here it tears down + rebuilds the watchers.
    projectWatcher?.watcher.emitError(new Error("kqueue fd pressure"));
    await waitUntil(() => webContents.send.mock.calls.length > 0);

    expect(projectWatcher?.watcher.close).toHaveBeenCalledTimes(1);
    expect(ticketWatcher?.watcher.close).toHaveBeenCalledTimes(1);
    // Two fresh watchers wired for the same key.
    expect(watchMock).toHaveBeenCalledTimes(4);
    // The tree may have changed under us, so the renderer is nudged to refetch.
    expect(webContents.send).toHaveBeenCalledWith("volli:artifacts-changed", {
      projectId: "proj-1",
      ticketId: "ticket-1",
    } satisfies ArtifactsChangedEvent);
  });

  it("re-arms onto the new inode when the watched dir was deleted and recreated", async () => {
    const project = makeTempProjectDir();
    const manager = new ArtifactWatchManager(0);
    const webContents = makeWebContents();
    await manager.subscribe(webContents as never, project, "proj-1", "ticket-1", "VC-1");
    const ticketDir = join(project, ".volli", "tickets", "VC-1", "artifacts");

    // `rm -rf` the watched dir; fs.watch would keep watching the dead inode.
    rmSync(ticketDir, { recursive: true, force: true });
    // The ticket-tier watcher fires for the now-missing dir → re-arm.
    watchCalls[1]?.cb("rename", null);
    await waitUntil(() => existsSync(ticketDir) && watchMock.mock.calls.length >= 4);

    // The dir was recreated (ensure* during re-arm) and a fresh pair wired.
    expect(existsSync(ticketDir)).toBe(true);
    expect(watchMock).toHaveBeenCalledTimes(4);
  });

  it("falls back to teardown + one final broadcast when a re-arm cannot re-install watchers", async () => {
    const project = makeTempProjectDir();
    const manager = new ArtifactWatchManager(0);
    const webContents = makeWebContents();
    await manager.subscribe(webContents as never, project, "proj-1", "ticket-1", "VC-1");

    // Make the re-arm's re-wire fail: the next fs.watch throws.
    watchMock.mockImplementation(() => {
      throw new Error("EMFILE");
    });
    watchCalls[0]?.watcher.emitError(new Error("boom"));
    await waitUntil(() => webContents.send.mock.calls.length > 0);

    // Honest fallback: the subscription is torn down and the renderer gets one
    // final refetch nudge rather than trusting a watch that's gone.
    expect(webContents.send).toHaveBeenCalledWith("volli:artifacts-changed", {
      projectId: "proj-1",
      ticketId: "ticket-1",
    } satisfies ArtifactsChangedEvent);
    // Torn down: a subsequent unsubscribe is a harmless no-op (no double close).
    expect(() => manager.unsubscribe(webContents as never, "ticket-1")).not.toThrow();
  });
});

// ---- IPC handler integration (real db + real temp project dirs) -----------------

function setupDbAndHandlers(): {
  ctx: TestDb;
  projectId: string;
  ticketId: string;
  projectPath: string;
} {
  const ctx = openTestDb();
  const projectPath = makeTempProjectDir();
  const project = testProject({ path: projectPath });
  insertProject(ctx.db, project);
  const ticket = testTicket(project.id, { ticketNumber: 7 });
  insertTicket(ctx.db, ticket);
  registerArtifactIpcHandlers({ ok: true, db: ctx.db });
  return { ctx, projectId: project.id, ticketId: ticket.id, projectPath };
}

function invoke<T>(channel: VolliIpcChannel, sender: unknown, ...args: unknown[]): T {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler registered for ${channel}`);
  return (handler as (...callArgs: unknown[]) => T)({ sender }, ...args);
}

describe("registerArtifactIpcHandlers", () => {
  let ctx: TestDb | null = null;

  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
  });

  it("round-trips create → write → read → list → promote through the IPC surface", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;

    const created = await invoke<{ ok: true; entry: { name: string } } | { ok: false }>(
      "volli:artifact-create",
      {},
      { projectId: setup.projectId, ticketId: setup.ticketId, name: "notes" },
    );
    expect(created.ok).toBe(true);

    const written = await invoke<{ ok: boolean }>(
      "volli:artifact-write",
      {},
      {
        projectId: setup.projectId,
        ticketId: setup.ticketId,
        tier: "ticket",
        name: "notes.md",
        content: "updated",
      },
    );
    expect(written).toEqual({ ok: true });

    const read = await invoke<{ ok: true; content: string } | { ok: false }>(
      "volli:artifact-read",
      {},
      { projectId: setup.projectId, ticketId: setup.ticketId, tier: "ticket", name: "notes.md" },
    );
    expect(read).toEqual({ ok: true, content: "updated" });

    const listed = await invoke<
      { ok: true; entries: { name: string; tier: string }[] } | { ok: false }
    >("volli:artifact-list", {}, { projectId: setup.projectId, ticketId: setup.ticketId });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.entries).toEqual([
        expect.objectContaining({ name: "notes.md", tier: "ticket" }),
      ]);
    }

    const promoted = await invoke<{ ok: true; entry: { tier: string } } | { ok: false }>(
      "volli:artifact-promote",
      {},
      { projectId: setup.projectId, ticketId: setup.ticketId, name: "notes.md" },
    );
    expect(promoted).toEqual({
      ok: true,
      entry: expect.objectContaining({ tier: "project" }) as unknown,
    });
  });

  it("reveals a tier's directory via the IPC channel", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const result = await invoke<{ ok: boolean }>(
      "volli:artifact-reveal-dir",
      {},
      { projectId: setup.projectId, ticketId: setup.ticketId, tier: "ticket" },
    );
    expect(result).toEqual({ ok: true });
    expect(showItemInFolderMock).toHaveBeenCalled();
  });

  it("subscribes and broadcasts to the invoking webContents, then unsubscribes cleanly", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const webContents = makeWebContents();

    const subscribed = await invoke<{ ok: boolean }>("volli:artifact-subscribe", webContents, {
      projectId: setup.projectId,
      ticketId: setup.ticketId,
    });
    expect(subscribed).toEqual({ ok: true });

    const unsubscribed = invoke<{ ok: boolean }>("volli:artifact-unsubscribe", webContents, {
      projectId: setup.projectId,
      ticketId: setup.ticketId,
    });
    expect(unsubscribed).toEqual({ ok: true });
  });

  it.each([
    "volli:artifact-list",
    "volli:artifact-read",
    "volli:artifact-read-image",
    "volli:artifact-write",
    "volli:artifact-create",
    "volli:artifact-promote",
    "volli:artifact-reveal-dir",
    "volli:artifact-subscribe",
    "volli:artifact-unsubscribe",
  ] satisfies VolliIpcChannel[])("rejects a malformed %s payload", async (channel) => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const result = await invoke<{ ok: boolean; error?: string }>(channel, {}, { nonsense: true });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown ticket id", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const result = await invoke<{ ok: boolean; error?: string }>(
      "volli:artifact-list",
      {},
      { projectId: setup.projectId, ticketId: "not-a-real-ticket" },
    );
    expect(result).toEqual({ ok: false, error: "Unknown ticket" });
  });

  it("rejects a ticket/project id mismatch", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const result = await invoke<{ ok: boolean; error?: string }>(
      "volli:artifact-list",
      {},
      { projectId: "some-other-project", ticketId: setup.ticketId },
    );
    expect(result).toEqual({ ok: false, error: "Ticket does not belong to project" });
  });

  it("degrades every channel to a typed error when the db failed to open", async () => {
    handlers.clear();
    registerArtifactIpcHandlers({ ok: false, error: "disk full" });
    const result = await invoke<{ ok: boolean; error?: string }>(
      "volli:artifact-list",
      {},
      { projectId: "p", ticketId: "t" },
    );
    expect(result).toEqual({ ok: false, error: "disk full" });
  });
});
