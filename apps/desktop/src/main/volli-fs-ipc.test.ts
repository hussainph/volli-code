import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DirChangedEvent, FileChangedEvent, VolliIpcChannel } from "../ipc/contract";
import { FILE_CHANNELS } from "./ipc-descriptors";
import { syncProjectRoots } from "@volli/host-core/board";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Hoisted above module evaluation, like pty.test.ts/data-ipc.test.ts, so the
// mock factories can capture into them. `electron` is fully mocked (never
// resolvable under plain-Node vitest). `node:fs` is PARTIALLY mocked: every
// real export passes through unchanged via `importOriginal` — only `watch` is
// replaced, so the FileWatchManager suite fires watch callbacks deterministically
// under `vi.useFakeTimers()` instead of racing a real fs.watch/OS debounce.
// Every other suite runs against real directories, real symlinks, and real disk
// I/O (and real `git`), untouched by this mock.
const { handlers, showItemInFolderMock, trashItemMock, watchMock } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  showItemInFolderMock: vi.fn(),
  // Delete goes to the TRASH, so the test double is the real seam: an
  // implementation that unlinked instead would still pass a "the file is gone"
  // assertion, and this is the mock that would not have been called.
  trashItemMock: vi.fn(async (_path: string) => {}),
  watchMock: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: never[]) => unknown) {
      handlers.set(channel, handler);
    },
  },
  shell: { showItemInFolder: showItemInFolderMock, trashItem: trashItemMock },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, watch: watchMock };
});

import { registerFileIpcHandlers } from "./volli-fs-ipc";
import { createHostFileServices } from "@volli/host-core/files";
import { createElectronClientCapabilities } from "./client-capabilities";
import { insertProject, insertTicket } from "@volli/host-core/db";
import { openTestDb, testProject, testTicket, type TestDb } from "@volli/host-core/testing";
import type { ExternalAppGateway } from "./external-apps";

// ---- shared test scaffolding -------------------------------------------------

const tempDirs: string[] = [];

function makeTempProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "volli-fs-test-"));
  tempDirs.push(dir);
  return dir;
}

/** A real git repo temp dir (so `git ls-files` in buildFileIndex has something to list). */
function makeGitRepoDir(): string {
  const dir = makeTempProjectDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

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

interface WatchCall {
  dir: string;
  cb: (eventType: string, filename: string | null) => void;
  watcher: FakeWatcher;
}
let watchCalls: WatchCall[] = [];

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
  syncProjectRoots([]);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  handlers.clear();
  showItemInFolderMock.mockClear();
  trashItemMock.mockClear();
  vi.useRealTimers();
});

/** A WebContents double keyed by `id` (the FileWatchManager subscription key). */
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

// ---- IPC handler integration (real db + real temp project dirs) --------------

function setupDbAndHandlers(
  projectPath: string = makeGitRepoDir(),
  externalApps?: ExternalAppGateway,
): {
  ctx: TestDb;
  projectId: string;
  ticketId: string;
  projectPath: string;
  globalCommandsDir: string;
  globalSkillsDir: string;
} {
  const ctx = openTestDb();
  const project = testProject({ path: projectPath });
  insertProject(ctx.db, project);
  syncProjectRoots([projectPath]);
  const ticket = testTicket(project.id, { ticketNumber: 7 });
  insertTicket(ctx.db, ticket);
  // A real path inside a collected temp dir, so the global tier is genuinely
  // absent rather than accidentally pointing at someone's userData.
  const globalCommandsDir = join(makeTempProjectDir(), "commands");
  // Same stance for the personal skills tier: a real but absent path, never
  // the running user's own `~/.agents/skills`.
  const globalSkillsDir = join(makeTempProjectDir(), ".agents", "skills");
  registerFileIpcHandlers(
    { ok: true, db: ctx.db },
    {
      globalCommandsDir,
      globalSkillsDir,
      externalApps,
    },
    createTestFileServices(),
  );
  return {
    ctx,
    projectId: project.id,
    ticketId: ticket.id,
    projectPath,
    globalCommandsDir,
    globalSkillsDir,
  };
}

function invoke<T>(channel: VolliIpcChannel, sender: unknown, ...args: unknown[]): T {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler registered for ${channel}`);
  return (handler as (...callArgs: unknown[]) => T)({ sender }, ...args);
}

// The Project Files tree refreshes only the directories the user has expanded
// (issue #106) — these exercise that subscription through its IPC channels, the
// public interface, rather than the manager class behind them.
describe("directory watch channels", () => {
  let ctx: TestDb | null = null;

  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
  });

  it("watches one expanded directory and broadcasts a debounced volli:dir-changed", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    await mkdir(join(setup.projectPath, "src"));
    const webContents = makeWebContents();

    const watched = await invoke<{ ok: boolean }>("volli:dir-watch", webContents, {
      projectId: setup.projectId,
      relPath: "src",
    });
    expect(watched).toEqual({ ok: true });
    expect(watchCalls.map((c) => c.dir)).toEqual([join(setup.projectPath, "src")]);

    vi.useFakeTimers();
    watchCalls[0]?.cb("rename", "added.ts");
    vi.advanceTimersByTime(250);
    expect(webContents.send).toHaveBeenCalledWith("volli:dir-changed", {
      projectId: setup.projectId,
      relPath: "src",
    } satisfies DirChangedEvent);
  });

  it("watches the project root as the empty relPath, non-recursively", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const webContents = makeWebContents();

    const watched = await invoke<{ ok: boolean }>("volli:dir-watch", webContents, {
      projectId: setup.projectId,
      relPath: "",
    });
    expect(watched).toEqual({ ok: true });
    // Canonicalized (a temp dir on macOS already sits under a symlinked /var).
    expect(watchCalls.map((c) => c.dir)).toEqual([realpathSync(setup.projectPath)]);
    // Exactly `(dir, listener)` — no `{ recursive: true }`, which would hydrate
    // the whole repo into one watcher (the explicit non-goal of issue #106).
    expect(watchMock.mock.calls[0]).toHaveLength(2);

    vi.useFakeTimers();
    watchCalls[0]?.cb("rename", "README.md");
    vi.advanceTimersByTime(250);
    expect(webContents.send).toHaveBeenCalledWith("volli:dir-changed", {
      projectId: setup.projectId,
      relPath: "",
    } satisfies DirChangedEvent);
  });

  // A project folder is whatever path the user picked, and picking a symlink to
  // the real checkout is ordinary (`~/code/app` → an external volume). The root
  // watch canonicalizes it; rejecting it as "Path is a symlink" would have
  // killed live updates for the whole project.
  it("watches the root of a project folder that is itself a symlink", async () => {
    const real = makeGitRepoDir();
    const link = join(makeTempProjectDir(), "project-link");
    symlinkSync(real, link, "dir");
    const setup = setupDbAndHandlers(link);
    ctx = setup.ctx;
    const webContents = makeWebContents();

    const watched = await invoke<{ ok: boolean }>("volli:dir-watch", webContents, {
      projectId: setup.projectId,
      relPath: "",
    });
    expect(watched).toEqual({ ok: true });
    expect(watchCalls.map((c) => c.dir)).toEqual([realpathSync(real)]);

    // Deeper paths keep both safety layers: the symlinked root resolves through.
    await writeFile(join(real, "README.md"), "# hi", "utf8");
    expect(
      await invoke<{ ok: boolean; error?: string }>("volli:dir-watch", makeWebContents(2), {
        projectId: setup.projectId,
        relPath: "README.md",
      }),
    ).toEqual({ ok: false, error: "Not a directory" });
  });

  it("reports a project folder that is gone when the root watch is armed", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    rmSync(setup.projectPath, { recursive: true, force: true });
    const result = await invoke<{ ok: boolean; error?: string }>(
      "volli:dir-watch",
      makeWebContents(),
      { projectId: setup.projectId, relPath: "" },
    );
    expect(result).toEqual({ ok: false, error: "Project folder was not found" });
    expect(watchMock).not.toHaveBeenCalled();
  });

  // The root watch stays armed for the whole life of the sidebar tree, so a
  // repo under an agent would otherwise re-list the root every debounce window
  // purely from git's own bookkeeping — which the tree never shows.
  it("ignores .git and deep node_modules churn, but not the node_modules row itself", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const webContents = makeWebContents();
    await invoke("volli:dir-watch", webContents, { projectId: setup.projectId, relPath: "" });

    vi.useFakeTimers();
    watchCalls[0]?.cb("change", ".git");
    watchCalls[0]?.cb("rename", ".git/index.lock");
    watchCalls[0]?.cb("change", "node_modules/.package-lock.json");
    // Same reasoning, same flood, other ecosystems (VC-160): a `pip install`
    // populating `.venv`, a `cargo build` writing `target`, `go mod vendor`.
    watchCalls[0]?.cb("change", ".venv/lib/python3.12/site-packages/pkg.py");
    watchCalls[0]?.cb("change", "target/debug/build.rs");
    watchCalls[0]?.cb("change", "vendor/github.com/pkg/go.mod");
    vi.advanceTimersByTime(250);
    expect(webContents.send).not.toHaveBeenCalled();

    // The entry itself IS a visible row — installing/removing it must refresh.
    watchCalls[0]?.cb("rename", "node_modules");
    vi.advanceTimersByTime(250);
    expect(webContents.send).toHaveBeenCalledTimes(1);

    // True of every widened name, for the same reason.
    watchCalls[0]?.cb("rename", ".venv");
    vi.advanceTimersByTime(250);
    expect(webContents.send).toHaveBeenCalledTimes(2);

    // A null filename is unfilterable, so it still broadcasts conservatively.
    watchCalls[0]?.cb("rename", null);
    vi.advanceTimersByTime(250);
    expect(webContents.send).toHaveBeenCalledTimes(3);
  });

  it("rejects '.' as a spelling of the root — the empty string is the only one", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const result = await invoke<{ ok: boolean; error?: string }>(
      "volli:dir-watch",
      makeWebContents(),
      { projectId: setup.projectId, relPath: "." },
    );
    expect(result).toEqual({ ok: false, error: "Invalid file path" });
    expect(watchMock).not.toHaveBeenCalled();
  });

  it.each([["../.."], ["/etc"], ["src/../.."]])(
    "rejects the unsafe directory %j",
    async (relPath) => {
      const setup = setupDbAndHandlers();
      ctx = setup.ctx;
      const result = await invoke<{ ok: boolean; error?: string }>(
        "volli:dir-watch",
        makeWebContents(),
        { projectId: setup.projectId, relPath },
      );
      expect(result).toEqual({ ok: false, error: "Invalid file path" });
      expect(watchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects a symlinked directory that escapes the project root", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const outside = makeTempProjectDir();
    symlinkSync(outside, join(setup.projectPath, "escape"), "dir");
    const result = await invoke<{ ok: boolean; error?: string }>(
      "volli:dir-watch",
      makeWebContents(),
      { projectId: setup.projectId, relPath: "escape" },
    );
    expect(result).toEqual({ ok: false, error: "Path is a symlink" });
    expect(watchMock).not.toHaveBeenCalled();
  });

  it("rejects a file path and a directory that does not exist", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    await writeFile(join(setup.projectPath, "README.md"), "# hi", "utf8");

    expect(
      await invoke<{ ok: boolean; error?: string }>("volli:dir-watch", makeWebContents(), {
        projectId: setup.projectId,
        relPath: "README.md",
      }),
    ).toEqual({ ok: false, error: "Not a directory" });
    expect(
      await invoke<{ ok: boolean; error?: string }>("volli:dir-watch", makeWebContents(), {
        projectId: setup.projectId,
        relPath: "nope",
      }),
    ).toEqual({ ok: false, error: "Directory was not found" });
  });

  it("rejects an unknown project", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const result = await invoke<{ ok: boolean; error?: string }>(
      "volli:dir-watch",
      makeWebContents(),
      { projectId: "nope", relPath: "" },
    );
    expect(result).toEqual({ ok: false, error: "Unknown project" });
  });

  it("is idempotent: watching the same directory twice wires one watcher", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const webContents = makeWebContents();
    const input = { projectId: setup.projectId, relPath: "" };
    expect(await invoke<{ ok: boolean }>("volli:dir-watch", webContents, input)).toEqual({
      ok: true,
    });
    expect(await invoke<{ ok: boolean }>("volli:dir-watch", webContents, input)).toEqual({
      ok: true,
    });
    expect(watchMock).toHaveBeenCalledTimes(1);
  });

  it("unwatch closes the watcher and drops a pending broadcast", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const webContents = makeWebContents();
    const input = { projectId: setup.projectId, relPath: "" };
    await invoke("volli:dir-watch", webContents, input);

    vi.useFakeTimers();
    watchCalls[0]?.cb("rename", "added.ts");
    expect(invoke<{ ok: boolean }>("volli:dir-unwatch", webContents, input)).toEqual({ ok: true });
    vi.advanceTimersByTime(1000);

    expect(watchCalls[0]?.watcher.close).toHaveBeenCalledTimes(1);
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("unwatching a directory that was never watched is a harmless no-op", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const result = invoke<{ ok: boolean }>("volli:dir-unwatch", makeWebContents(), {
      projectId: setup.projectId,
      relPath: "never/watched",
    });
    expect(result).toEqual({ ok: true });
  });

  it("delivers only to the subscribing window, and tears down when it is destroyed", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const subscriber = makeWebContents(101);
    const bystander = makeWebContents(202);
    await invoke("volli:dir-watch", subscriber, { projectId: setup.projectId, relPath: "" });

    vi.useFakeTimers();
    watchCalls[0]?.cb("rename", "added.ts");
    vi.advanceTimersByTime(250);
    expect(subscriber.send).toHaveBeenCalledTimes(1);
    expect(bystander.send).not.toHaveBeenCalled();

    subscriber.fireDestroyed();
    expect(watchCalls[0]?.watcher.close).toHaveBeenCalledTimes(1);
  });

  it("re-arms on a watcher fault and nudges the tree to re-list", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const webContents = makeWebContents();
    await invoke("volli:dir-watch", webContents, { projectId: setup.projectId, relPath: "" });

    vi.useFakeTimers();
    watchCalls[0]?.watcher.emitError(new Error("kqueue fd pressure"));
    expect(watchCalls[0]?.watcher.close).toHaveBeenCalledTimes(1);
    expect(watchMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(250);

    expect(webContents.send).toHaveBeenCalledWith("volli:dir-changed", {
      projectId: setup.projectId,
      relPath: "",
    } satisfies DirChangedEvent);
  });

  it("flags the last broadcast when the re-arm throws over a directory that is still there", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const webContents = makeWebContents();
    await invoke("volli:dir-watch", webContents, { projectId: setup.projectId, relPath: "" });

    // Nothing about the payload distinguishes this from ordinary news — the
    // directory is intact and its listing is still worth refetching — so the
    // expanded row learns its watch is gone from `final` alone (issue #134).
    watchMock.mockImplementationOnce(() => {
      throw new Error("EMFILE: too many open files");
    });
    watchCalls[0]?.watcher.emitError(new Error("boom"));

    expect(webContents.send).toHaveBeenCalledWith("volli:dir-changed", {
      projectId: setup.projectId,
      relPath: "",
      final: true,
    } satisfies DirChangedEvent);
  });

  it("retries a deleted-and-recreated directory, re-homing onto the new inode", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const webContents = makeWebContents();
    const built = join(setup.projectPath, "dist");
    mkdirSync(built);
    await invoke("volli:dir-watch", webContents, { projectId: setup.projectId, relPath: "dist" });

    // A build wipes and regenerates the directory under the expanded row.
    rmSync(built, { recursive: true, force: true });
    vi.useFakeTimers();
    watchCalls[0]?.watcher.emitError(new Error("boom"));
    expect(webContents.send).not.toHaveBeenCalled();

    mkdirSync(built);
    vi.advanceTimersByTime(1000);
    expect(watchMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(250);
    expect(webContents.send).toHaveBeenCalledWith("volli:dir-changed", {
      projectId: setup.projectId,
      relPath: "dist",
    } satisfies DirChangedEvent);
  });
});

describe("registerFileIpcHandlers", () => {
  let ctx: TestDb | null = null;

  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
  });

  it("round-trips artifact-create → file-write → file-read → file-index", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;

    const created = await invoke<{ ok: true; relPath: string } | { ok: false }>(
      "volli:artifact-create",
      {},
      { projectId: setup.projectId, name: "notes" },
    );
    expect(created).toEqual({ ok: true, relPath: ".volli/artifacts/notes.md" });

    const written = await invoke<{ ok: true; mtime: number } | { ok: false }>(
      "volli:file-write",
      {},
      { projectId: setup.projectId, relPath: ".volli/artifacts/notes.md", content: "updated" },
    );
    expect(written.ok).toBe(true);

    const read = await invoke<
      { ok: true; content: { type: string; text?: string }; source: string } | { ok: false }
    >("volli:file-read", {}, { projectId: setup.projectId, relPath: ".volli/artifacts/notes.md" });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.source).toBe("main");
      expect(read.content).toEqual({ type: "text", text: "updated", truncated: false });
    }

    const index = await invoke<{ ok: true; files: { relPath: string }[] } | { ok: false }>(
      "volli:file-index",
      {},
      { projectId: setup.projectId },
    );
    expect(index.ok).toBe(true);
    if (index.ok) {
      expect(index.files.some((f) => f.relPath === ".volli/artifacts/notes.md")).toBe(true);
    }
  });

  it("runs the whole creation track through the ticket's worktree, never Main", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const worktree = join(setup.projectPath, "ticket-worktree");
    await mkdir(worktree, { recursive: true });
    const ticket = testTicket(setup.projectId, { worktreePath: worktree });
    insertTicket(ctx.db, ticket);
    const scope = { projectId: setup.projectId, ticketId: ticket.id };

    expect(
      await invoke<{ ok: boolean }>("volli:dir-create", {}, { ...scope, relPath: "src" }),
    ).toEqual({ ok: true, relPath: "src" });
    expect(
      await invoke<{ ok: boolean }>("volli:file-create", {}, { ...scope, relPath: "src/a.ts" }),
    ).toEqual({ ok: true, relPath: "src/a.ts" });
    expect(
      await invoke<{ ok: boolean }>("volli:file-duplicate", {}, { ...scope, relPath: "src/a.ts" }),
    ).toEqual({ ok: true, relPath: "src/a copy.ts" });
    expect(
      await invoke<{ ok: boolean }>(
        "volli:file-rename",
        {},
        { ...scope, relPath: "src/a.ts", toRelPath: "src/b.ts" },
      ),
    ).toEqual({ ok: true, relPath: "src/b.ts" });
    expect(
      await invoke<{ ok: boolean }>("volli:file-delete", {}, { ...scope, relPath: "src/b.ts" }),
    ).toEqual({ ok: true });

    // Everything landed in the worktree; the main checkout never grew a `src`.
    expect(existsSync(join(worktree, "src", "a copy.ts"))).toBe(true);
    expect(existsSync(join(setup.projectPath, "src"))).toBe(false);
    expect(trashItemMock).toHaveBeenCalledWith(join(worktree, "src", "b.ts"));
  });

  it("refuses a creation-track call for a ticket that belongs to another project", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const otherProject = testProject({ path: makeGitRepoDir() });
    insertProject(ctx.db, otherProject);
    const foreign = testTicket(otherProject.id, { ticketNumber: 3 });
    insertTicket(ctx.db, foreign);

    for (const channel of [
      "volli:file-create",
      "volli:dir-create",
      "volli:file-duplicate",
      "volli:file-delete",
    ] as const) {
      expect(
        await invoke<{ ok: boolean; error?: string }>(
          channel,
          {},
          { projectId: setup.projectId, ticketId: foreign.id, relPath: "a.ts" },
        ),
      ).toEqual({ ok: false, error: "Ticket does not belong to project" });
    }
    expect(
      await invoke<{ ok: boolean; error?: string }>(
        "volli:file-rename",
        {},
        {
          projectId: setup.projectId,
          ticketId: foreign.id,
          relPath: "a.ts",
          toRelPath: "b.ts",
        },
      ),
    ).toEqual({ ok: false, error: "Ticket does not belong to project" });
    expect(trashItemMock).not.toHaveBeenCalled();
  });

  it("refuses a create that would overwrite, and a rename that would clobber", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    await writeFile(join(setup.projectPath, "a.md"), "a", "utf8");
    await writeFile(join(setup.projectPath, "b.md"), "b", "utf8");

    expect(
      await invoke<{ ok: boolean; error?: string }>(
        "volli:file-create",
        {},
        { projectId: setup.projectId, relPath: "a.md" },
      ),
    ).toEqual({ ok: false, error: '"a.md" already exists' });
    expect(
      await invoke<{ ok: boolean; error?: string }>(
        "volli:file-rename",
        {},
        { projectId: setup.projectId, relPath: "a.md", toRelPath: "b.md" },
      ),
    ).toEqual({ ok: false, error: '"b.md" already exists' });
    expect(await readFile(join(setup.projectPath, "a.md"), "utf8")).toBe("a");
    expect(await readFile(join(setup.projectPath, "b.md"), "utf8")).toBe("b");
  });

  it("reveals a file via the IPC channel", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    await invoke("volli:artifact-create", {}, { projectId: setup.projectId, name: "r" });
    const result = await invoke<{ ok: boolean }>(
      "volli:file-reveal",
      {},
      { projectId: setup.projectId, relPath: ".volli/artifacts/r.md" },
    );
    expect(result).toEqual({ ok: true });
    expect(showItemInFolderMock).toHaveBeenCalled();
  });

  it("opens a ticket file's worktree copy through the external-app IPC", async () => {
    const opened: { appId: string; path: string }[] = [];
    const externalApps: ExternalAppGateway = {
      async list() {
        return [];
      },
      async open(appId, path) {
        opened.push({ appId, path });
        return { ok: true };
      },
    };
    const setup = setupDbAndHandlers(makeGitRepoDir(), externalApps);
    ctx = setup.ctx;
    const worktree = join(setup.projectPath, "ticket-worktree");
    await mkdir(join(setup.projectPath, "src"));
    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(join(setup.projectPath, "src", "main.ts"), "main copy", "utf8");
    await writeFile(join(worktree, "src", "main.ts"), "worktree copy", "utf8");
    const ticket = testTicket(setup.projectId, { worktreePath: worktree });
    insertTicket(ctx.db, ticket);

    const result = await invoke<{ ok: boolean; error?: string }>(
      "volli:external-app-open-file",
      {},
      {
        projectId: setup.projectId,
        ticketId: ticket.id,
        relPath: "src/main.ts",
        appId: "vscode",
      },
    );
    const revealed = await invoke<{ ok: boolean; error?: string }>(
      "volli:file-reveal",
      {},
      { projectId: setup.projectId, ticketId: ticket.id, relPath: "src/main.ts" },
    );

    const resolvedFile = realpathSync(join(worktree, "src", "main.ts"));
    expect(result).toEqual({ ok: true });
    expect(revealed).toEqual({ ok: true });
    expect(opened).toEqual([{ appId: "vscode", path: resolvedFile }]);
    expect(showItemInFolderMock).toHaveBeenCalledWith(resolvedFile);
  });

  it("refuses a ticket file launch when its required worktree is missing", async () => {
    const opened: { appId: string; path: string }[] = [];
    const externalApps: ExternalAppGateway = {
      async list() {
        return [];
      },
      async open(appId, path) {
        opened.push({ appId, path });
        return { ok: true };
      },
    };
    const setup = setupDbAndHandlers(makeGitRepoDir(), externalApps);
    ctx = setup.ctx;
    await mkdir(join(setup.projectPath, "src"));
    await writeFile(join(setup.projectPath, "src", "main.ts"), "main copy", "utf8");
    const ticket = testTicket(setup.projectId, {
      worktreePath: join(makeTempProjectDir(), "missing-worktree"),
    });
    insertTicket(ctx.db, ticket);

    const result = await invoke<{ ok: boolean; error?: string }>(
      "volli:external-app-open-file",
      {},
      {
        projectId: setup.projectId,
        ticketId: ticket.id,
        relPath: "src/main.ts",
        appId: "vscode",
      },
    );
    const revealed = await invoke<{ ok: boolean; error?: string }>(
      "volli:file-reveal",
      {},
      { projectId: setup.projectId, ticketId: ticket.id, relPath: "src/main.ts" },
    );

    expect(result).toEqual({ ok: false, error: "Worktree folder was not found" });
    expect(revealed).toEqual({ ok: false, error: "Worktree folder was not found" });
    expect(opened).toEqual([]);
    expect(showItemInFolderMock).not.toHaveBeenCalled();
  });

  it("opens Main for a ticket that opted out of worktrees", async () => {
    const opened: { appId: string; path: string }[] = [];
    const externalApps: ExternalAppGateway = {
      async list() {
        return [];
      },
      async open(appId, path) {
        opened.push({ appId, path });
        return { ok: true };
      },
    };
    const setup = setupDbAndHandlers(makeGitRepoDir(), externalApps);
    ctx = setup.ctx;
    await mkdir(join(setup.projectPath, "src"));
    await writeFile(join(setup.projectPath, "src", "main.ts"), "main copy", "utf8");
    const ticket = testTicket(setup.projectId, {
      usesWorktree: false,
      worktreePath: makeTempProjectDir(),
    });
    insertTicket(ctx.db, ticket);

    const result = await invoke<{ ok: boolean; error?: string }>(
      "volli:external-app-open-file",
      {},
      {
        projectId: setup.projectId,
        ticketId: ticket.id,
        relPath: "src/main.ts",
        appId: "vscode",
      },
    );

    expect(result).toEqual({ ok: true });
    expect(opened).toEqual([{ appId: "vscode", path: join(setup.projectPath, "src", "main.ts") }]);
  });

  it("opens and reveals the live ticket worktree through safe main-process targets", async () => {
    const opened: { appId: string; path: string }[] = [];
    const externalApps: ExternalAppGateway = {
      async list() {
        return [];
      },
      async open(appId, path) {
        opened.push({ appId, path });
        return { ok: true };
      },
    };
    const setup = setupDbAndHandlers(makeGitRepoDir(), externalApps);
    ctx = setup.ctx;
    const worktree = join(setup.projectPath, "ticket-worktree");
    await mkdir(worktree);
    const ticket = testTicket(setup.projectId, { worktreePath: worktree });
    insertTicket(ctx.db, ticket);

    const openedResult = await invoke<{ ok: boolean; error?: string }>(
      "volli:external-app-open-worktree",
      {},
      { projectId: setup.projectId, ticketId: ticket.id, appId: "terminal" },
    );
    const revealedResult = await invoke<{ ok: boolean; error?: string }>(
      "volli:worktree-reveal",
      {},
      { projectId: setup.projectId, ticketId: ticket.id },
    );

    const resolvedWorktree = realpathSync(worktree);
    expect(openedResult).toEqual({ ok: true });
    expect(revealedResult).toEqual({ ok: true });
    expect(opened).toEqual([{ appId: "terminal", path: resolvedWorktree }]);
    expect(showItemInFolderMock).toHaveBeenCalledWith(resolvedWorktree);
  });

  it("opens a worktree inside the app-owned worktree home", async () => {
    const opened: { appId: string; path: string }[] = [];
    const externalApps: ExternalAppGateway = {
      async list() {
        return [];
      },
      async open(appId, path) {
        opened.push({ appId, path });
        return { ok: true };
      },
    };
    const previousHome = process.env["VOLLI_WORKTREE_HOME_DIR"];
    const home = makeTempProjectDir();
    process.env["VOLLI_WORKTREE_HOME_DIR"] = home;
    try {
      const setup = setupDbAndHandlers(makeGitRepoDir(), externalApps);
      ctx = setup.ctx;
      const worktree = join(home, ".volli", "worktrees", "project", "VC-1-worktree");
      await mkdir(worktree, { recursive: true });
      const ticket = testTicket(setup.projectId, { worktreePath: worktree });
      insertTicket(ctx.db, ticket);

      const result = await invoke<{ ok: boolean; error?: string }>(
        "volli:external-app-open-worktree",
        {},
        { projectId: setup.projectId, ticketId: ticket.id, appId: "terminal" },
      );

      expect(result).toEqual({ ok: true });
      expect(opened).toEqual([{ appId: "terminal", path: realpathSync(worktree) }]);
    } finally {
      if (previousHome === undefined) delete process.env["VOLLI_WORKTREE_HOME_DIR"];
      else process.env["VOLLI_WORKTREE_HOME_DIR"] = previousHome;
    }
  });

  it("refuses Finder and external apps for a worktree outside known roots", async () => {
    const opened: { appId: string; path: string }[] = [];
    const externalApps: ExternalAppGateway = {
      async list() {
        return [];
      },
      async open(appId, path) {
        opened.push({ appId, path });
        return { ok: true };
      },
    };
    const setup = setupDbAndHandlers(makeGitRepoDir(), externalApps);
    ctx = setup.ctx;
    const ticket = testTicket(setup.projectId, { worktreePath: makeTempProjectDir() });
    insertTicket(ctx.db, ticket);

    const openedResult = await invoke<{ ok: boolean; error?: string }>(
      "volli:external-app-open-worktree",
      {},
      { projectId: setup.projectId, ticketId: ticket.id, appId: "terminal" },
    );
    const revealedResult = await invoke<{ ok: boolean; error?: string }>(
      "volli:worktree-reveal",
      {},
      { projectId: setup.projectId, ticketId: ticket.id },
    );
    const revealedFileResult = await invoke<{ ok: boolean; error?: string }>(
      "volli:file-reveal",
      {},
      { projectId: setup.projectId, ticketId: ticket.id, relPath: "src/main.ts" },
    );

    expect(openedResult).toEqual({
      ok: false,
      error: "Worktree folder is outside known projects",
    });
    expect(revealedResult).toEqual({
      ok: false,
      error: "Worktree folder is outside known projects",
    });
    expect(revealedFileResult).toEqual({
      ok: false,
      error: "Worktree folder is outside known projects",
    });
    expect(opened).toEqual([]);
    expect(showItemInFolderMock).not.toHaveBeenCalled();
  });

  it("lists the installed external-app subset without exposing bundle ids", async () => {
    const externalApps: ExternalAppGateway = {
      async list() {
        return [
          { id: "vscode", label: "VS Code", kind: "editor" },
          { id: "ghostty", label: "Ghostty", kind: "terminal" },
        ];
      },
      async open() {
        return { ok: true };
      },
    };
    const setup = setupDbAndHandlers(makeGitRepoDir(), externalApps);
    ctx = setup.ctx;

    await expect(invoke("volli:external-app-list", {})).resolves.toEqual({
      ok: true,
      apps: [
        { id: "vscode", label: "VS Code", kind: "editor" },
        { id: "ghostty", label: "Ghostty", kind: "terminal" },
      ],
    });
  });

  it("reports a failed app scan as an error rather than an empty menu", async () => {
    const externalApps: ExternalAppGateway = {
      async list() {
        throw new Error("Couldn't check which apps are installed on this Mac.");
      },
      async open() {
        return { ok: true };
      },
    };
    const setup = setupDbAndHandlers(makeGitRepoDir(), externalApps);
    ctx = setup.ctx;

    // `{ ok: true, apps: [] }` here would render as "no supported apps" — a
    // completed scan finding nothing, which is not what happened.
    await expect(invoke("volli:external-app-list", {})).resolves.toEqual({
      ok: false,
      error: "Couldn't check which apps are installed on this Mac.",
    });
  });

  it("refuses an unsafe external-app path before it reaches a launcher", async () => {
    const opened: { appId: string; path: string }[] = [];
    const externalApps: ExternalAppGateway = {
      async list() {
        return [];
      },
      async open(appId, path) {
        opened.push({ appId, path });
        return { ok: true };
      },
    };
    const setup = setupDbAndHandlers(makeGitRepoDir(), externalApps);
    ctx = setup.ctx;

    const result = await invoke<{ ok: boolean; error?: string }>(
      "volli:external-app-open-file",
      {},
      { projectId: setup.projectId, relPath: "../../outside", appId: "vscode" },
    );

    expect(result).toEqual({ ok: false, error: "Invalid file path" });
    expect(opened).toEqual([]);
  });

  it("refuses worktree actions when no live worktree exists instead of opening main", async () => {
    const opened: { appId: string; path: string }[] = [];
    const externalApps: ExternalAppGateway = {
      async list() {
        return [];
      },
      async open(appId, path) {
        opened.push({ appId, path });
        return { ok: true };
      },
    };
    const setup = setupDbAndHandlers(makeGitRepoDir(), externalApps);
    ctx = setup.ctx;

    const result = await invoke<{ ok: boolean; error?: string }>(
      "volli:external-app-open-worktree",
      {},
      { projectId: setup.projectId, ticketId: setup.ticketId, appId: "terminal" },
    );

    expect(result).toEqual({ ok: false, error: "Worktree folder was not found" });
    expect(opened).toEqual([]);
  });

  it("watches and unwatches a file through the IPC channels", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    await invoke("volli:artifact-create", {}, { projectId: setup.projectId, name: "w" });
    const webContents = makeWebContents();

    const watched = await invoke<{ ok: boolean }>("volli:file-watch", webContents, {
      projectId: setup.projectId,
      relPath: ".volli/artifacts/w.md",
    });
    expect(watched).toEqual({ ok: true });

    const unwatched = invoke<{ ok: boolean }>("volli:file-unwatch", webContents, {
      projectId: setup.projectId,
      relPath: ".volli/artifacts/w.md",
    });
    expect(unwatched).toEqual({ ok: true });
  });

  it("falls back to the main checkout for a ticket with no live worktree", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    await invoke("volli:artifact-create", {}, { projectId: setup.projectId, name: "t" });
    const read = await invoke<{ ok: true; source: string } | { ok: false }>(
      "volli:file-read",
      {},
      { projectId: setup.projectId, ticketId: setup.ticketId, relPath: ".volli/artifacts/t.md" },
    );
    expect(read.ok && read.source).toBe("main");
  });

  it("normalizes a Main file event to null ticket identity when a ticket view requested it", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    await invoke("volli:artifact-create", {}, { projectId: setup.projectId, name: "shared" });
    const subscriber = makeWebContents();
    const relPath = ".volli/artifacts/shared.md";
    const revision = (await stat(join(setup.projectPath, relPath))).mtimeMs;

    expect(
      await invoke<{ ok: boolean }>("volli:file-watch", subscriber, {
        projectId: setup.projectId,
        ticketId: setup.ticketId,
        relPath,
      }),
    ).toEqual({ ok: true });

    vi.useFakeTimers();
    watchCalls[0]?.cb("change", "shared.md");
    vi.advanceTimersByTime(250);

    expect(subscriber.send).toHaveBeenCalledWith("volli:file-changed", {
      projectId: setup.projectId,
      ticketId: null,
      relPath,
      source: "main",
      revision,
    } satisfies FileChangedEvent);
  });

  // `worktree_path` IS populated in production (pty/manager.ts stamps it when a
  // ticket's worktree is created), so main-vs-ticket resolution is live behavior,
  // not future work — asserted end-to-end through the read channel.
  it("resolves a repo path to the ticket's live worktree while .volli stays on main", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const worktree = join(setup.projectPath, "ticket-worktree");
    await mkdir(worktree);
    await writeFile(join(setup.projectPath, "app.ts"), "main copy", "utf8");
    await writeFile(join(worktree, "app.ts"), "worktree copy", "utf8");
    const ticket = testTicket(setup.projectId, { worktreePath: worktree });
    insertTicket(ctx.db, ticket);
    await invoke("volli:artifact-create", {}, { projectId: setup.projectId, name: "shared" });

    const code = await invoke<
      { ok: true; source: string; content: { type: string; text?: string } } | { ok: false }
    >(
      "volli:file-read",
      {},
      { projectId: setup.projectId, ticketId: ticket.id, relPath: "app.ts" },
    );
    expect(code.ok).toBe(true);
    if (code.ok) {
      expect(code.source).toBe("worktree");
      expect(code.content).toEqual({ type: "text", text: "worktree copy", truncated: false });
    }

    const artifact = await invoke<{ ok: true; source: string } | { ok: false }>(
      "volli:file-read",
      {},
      {
        projectId: setup.projectId,
        ticketId: ticket.id,
        relPath: ".volli/artifacts/shared.md",
      },
    );
    expect(artifact.ok && artifact.source).toBe("main");
  });

  it.each([
    "volli:file-index",
    "volli:file-read",
    "volli:search",
    "volli:file-write",
    "volli:artifact-create",
    "volli:file-reveal",
    "volli:external-app-list",
    "volli:external-app-open-file",
    "volli:external-app-open-worktree",
    "volli:worktree-reveal",
    "volli:file-watch",
    "volli:file-unwatch",
    "volli:dir-watch",
    "volli:dir-unwatch",
    "volli:prompt-templates",
  ] satisfies VolliIpcChannel[])("rejects a malformed %s payload", async (channel) => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const result = await invoke<{ ok: boolean }>(channel, {}, { nonsense: true });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown project", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const result = await invoke<{ ok: boolean; error?: string }>(
      "volli:file-index",
      {},
      { projectId: "nope" },
    );
    expect(result).toEqual({ ok: false, error: "Unknown project" });
  });

  // ---- file-index scope (VC-190) --------------------------------------------
  // The index now takes the SAME `{ projectId, ticketId }` pair a read takes,
  // through the same `resolveFileScope` seam — so quick-open in a Ticket
  // workspace offers that worktree's files, and the read behind the row it
  // picked resolves to the same checkout.

  it("indexes the ticket's live worktree when given the scope pair", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const worktree = join(setup.projectPath, "ticket-worktree");
    await mkdir(worktree);
    await writeFile(join(setup.projectPath, "main-only.ts"), "main", "utf8");
    await writeFile(join(worktree, "worktree-only.ts"), "worktree", "utf8");
    const ticket = testTicket(setup.projectId, { worktreePath: worktree });
    insertTicket(ctx.db, ticket);
    await invoke("volli:artifact-create", {}, { projectId: setup.projectId, name: "shared" });

    const scoped = await invoke<{ ok: true; files: { relPath: string }[] } | { ok: false }>(
      "volli:file-index",
      {},
      { projectId: setup.projectId, ticketId: ticket.id },
    );
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) return;
    const paths = scoped.files.map((f) => f.relPath);
    expect(paths).toContain("worktree-only.ts");
    expect(paths).not.toContain("main-only.ts");
    // `.volli/**` stays on Main whatever the scope (decision #6), so an
    // artifact is `@`-referenceable from either surface.
    expect(paths).toContain(".volli/artifacts/shared.md");

    const unscoped = await invoke<{ ok: true; files: { relPath: string }[] } | { ok: false }>(
      "volli:file-index",
      {},
      { projectId: setup.projectId },
    );
    expect(unscoped.ok).toBe(true);
    if (!unscoped.ok) return;
    const mainPaths = unscoped.files.map((f) => f.relPath);
    expect(mainPaths).toContain("main-only.ts");
    expect(mainPaths).not.toContain("worktree-only.ts");
  });

  it("degrades a ticket whose worktree folder is gone to the main checkout, exactly as a read does", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    await writeFile(join(setup.projectPath, "main-only.ts"), "main", "utf8");
    const ticket = testTicket(setup.projectId, {
      worktreePath: join(makeTempProjectDir(), "missing-worktree"),
    });
    insertTicket(ctx.db, ticket);

    const result = await invoke<{ ok: true; files: { relPath: string }[] } | { ok: false }>(
      "volli:file-index",
      {},
      { projectId: setup.projectId, ticketId: ticket.id },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.files.map((f) => f.relPath)).toContain("main-only.ts");
  });

  it("rejects an unknown ticket rather than silently indexing Main", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const result = await invoke<{ ok: boolean; error?: string }>(
      "volli:file-index",
      {},
      { projectId: setup.projectId, ticketId: "nope" },
    );
    expect(result).toEqual({ ok: false, error: "Unknown ticket" });
  });

  it("rejects a ticket that belongs to another project", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const otherProject = testProject({ path: makeGitRepoDir() });
    insertProject(ctx.db, otherProject);
    const foreign = testTicket(otherProject.id, { ticketNumber: 3 });
    insertTicket(ctx.db, foreign);

    const result = await invoke<{ ok: boolean; error?: string }>(
      "volli:file-index",
      {},
      { projectId: setup.projectId, ticketId: foreign.id },
    );
    expect(result).toEqual({ ok: false, error: "Ticket does not belong to project" });
  });

  // ---- search scope (VC-193, plan §4.7) -------------------------------------
  // `volli:search` resolves through the SAME `resolveFileScope` seam a read
  // does, which is the property that keeps a result row honest: the checkout
  // that answered the search is the checkout the click on that row opens. The
  // ripgrep run itself is `file-search.test.ts`'s subject; what these assert is
  // the scope, the refusals, and the truncation flag crossing the boundary.

  it("searches the ticket's live worktree when given the scope pair, and Main without one", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const worktree = join(makeTempProjectDir(), "ticket-worktree");
    mkdirSync(worktree, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: worktree });
    await writeFile(join(setup.projectPath, "main-only.ts"), "const needle = 1;\n", "utf8");
    await writeFile(join(worktree, "worktree-only.ts"), "const needle = 2;\n", "utf8");
    const ticket = testTicket(setup.projectId, { worktreePath: worktree });
    insertTicket(ctx.db, ticket);

    const scoped = await invoke<{ ok: true; files: { relPath: string }[] } | { ok: false }>(
      "volli:search",
      {},
      { projectId: setup.projectId, ticketId: ticket.id, query: "needle" },
    );
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) return;
    expect(scoped.files.map((file) => file.relPath)).toEqual(["worktree-only.ts"]);

    const home = await invoke<{ ok: true; files: { relPath: string }[] } | { ok: false }>(
      "volli:search",
      {},
      { projectId: setup.projectId, query: "needle" },
    );
    expect(home.ok).toBe(true);
    if (!home.ok) return;
    expect(home.files.map((file) => file.relPath)).toEqual(["main-only.ts"]);
  });

  it("degrades a ticket whose worktree folder is gone to the main checkout, exactly as a read does", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    await writeFile(join(setup.projectPath, "main-only.ts"), "const needle = 1;\n", "utf8");
    const ticket = testTicket(setup.projectId, {
      worktreePath: join(makeTempProjectDir(), "missing-worktree"),
    });
    insertTicket(ctx.db, ticket);

    const result = await invoke<{ ok: true; files: { relPath: string }[] } | { ok: false }>(
      "volli:search",
      {},
      { projectId: setup.projectId, ticketId: ticket.id, query: "needle" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.files.map((file) => file.relPath)).toEqual(["main-only.ts"]);
  });

  it("reports the cap that ended a search rather than presenting a partial list as the whole", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    await writeFile(join(setup.projectPath, "many.ts"), "needle\n".repeat(600), "utf8");

    const result = await invoke<
      { ok: true; matches: number; limit: string } | { ok: false; error: string }
    >("volli:search", {}, { projectId: setup.projectId, query: "needle" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matches).toBe(500);
    expect(result.limit).toBe("matches");
  });

  it("answers an empty query with nothing rather than listing the checkout", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    await writeFile(join(setup.projectPath, "a.ts"), "const needle = 1;\n", "utf8");

    expect(
      await invoke<unknown>("volli:search", {}, { projectId: setup.projectId, query: "  " }),
    ).toEqual({ ok: true, files: [], matches: 0, limit: "none" });
  });

  it("refuses a search scoped to an unknown or foreign ticket instead of searching Main", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const otherProject = testProject({ path: makeGitRepoDir() });
    insertProject(ctx.db, otherProject);
    const foreign = testTicket(otherProject.id, { ticketNumber: 4 });
    insertTicket(ctx.db, foreign);

    expect(
      await invoke<unknown>(
        "volli:search",
        {},
        { projectId: setup.projectId, ticketId: "nope", query: "needle" },
      ),
    ).toEqual({ ok: false, error: "Unknown ticket" });
    expect(
      await invoke<unknown>(
        "volli:search",
        {},
        { projectId: setup.projectId, ticketId: foreign.id, query: "needle" },
      ),
    ).toEqual({ ok: false, error: "Ticket does not belong to project" });
    expect(
      await invoke<unknown>("volli:search", {}, { projectId: "nope", query: "needle" }),
    ).toEqual({ ok: false, error: "Unknown project" });
  });

  it("answers prompt-templates with both tiers, the project's name winning", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    mkdirSync(join(setup.projectPath, ".volli", "commands"), { recursive: true });
    writeFileSync(
      join(setup.projectPath, ".volli", "commands", "review.md"),
      "---\ndescription: Project review\n---\nReview $1.\n",
      "utf8",
    );
    mkdirSync(setup.globalCommandsDir, { recursive: true });
    writeFileSync(join(setup.globalCommandsDir, "review.md"), "Global review body\n", "utf8");
    writeFileSync(join(setup.globalCommandsDir, "ship.md"), "Ship it.\n", "utf8");

    const result = await invoke<{ ok: boolean; templates?: { name: string; content: string }[] }>(
      "volli:prompt-templates",
      {},
      { projectId: setup.projectId },
    );

    expect(result.ok).toBe(true);
    expect(result.templates?.map((entry) => entry.name)).toEqual(["review", "ship"]);
    expect(result.templates?.find((entry) => entry.name === "review")?.content).toBe("Review $1.");
  });

  it("answers prompt-templates with BOTH skill tiers beside the templates", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    mkdirSync(join(setup.projectPath, ".agents", "skills", "logos"), { recursive: true });
    writeFileSync(
      join(setup.projectPath, ".agents", "skills", "logos", "SKILL.md"),
      "---\ndescription: Draw logos\n---\n# Logos\n",
      "utf8",
    );
    // The personal tier the same picker has to offer.
    mkdirSync(join(setup.globalSkillsDir, "pdf"), { recursive: true });
    writeFileSync(
      join(setup.globalSkillsDir, "pdf", "SKILL.md"),
      "---\ndescription: Fill PDFs\n---\n# PDF\n",
      "utf8",
    );

    const result = await invoke<{
      ok: boolean;
      skills?: {
        name: string;
        description: string;
        body: string;
        authorPolicy: { modelDiscoverable: boolean; userInvokable: boolean };
        effectivePolicy: { modelDiscoverable: boolean; userInvokable: boolean };
        policyDiagnostic: string | null;
        root: string;
      }[];
    }>("volli:prompt-templates", {}, { projectId: setup.projectId });

    expect(result.ok).toBe(true);
    expect(result.skills).toEqual([
      {
        name: "logos",
        description: "Draw logos",
        body: "# Logos",
        authorPolicy: { modelDiscoverable: true, userInvokable: true },
        effectivePolicy: { modelDiscoverable: true, userInvokable: true },
        policyDiagnostic: null,
        root: ".agents/skills/logos",
      },
      {
        name: "pdf",
        description: "Fill PDFs",
        body: "# PDF",
        authorPolicy: { modelDiscoverable: true, userInvokable: true },
        effectivePolicy: { modelDiscoverable: true, userInvokable: true },
        policyDiagnostic: null,
        root: `${setup.globalSkillsDir}/pdf`,
      },
    ]);
  });

  it("answers prompt-templates with an empty list when neither directory exists", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;

    const result = await invoke<{ ok: boolean; templates?: unknown[] }>(
      "volli:prompt-templates",
      {},
      { projectId: setup.projectId },
    );

    expect(result).toEqual({ ok: true, templates: [], skills: [] });
  });

  it("rejects prompt-templates for an unknown project", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const result = await invoke<{ ok: boolean; error?: string }>(
      "volli:prompt-templates",
      {},
      { projectId: "nope" },
    );
    expect(result).toEqual({ ok: false, error: "Unknown project" });
  });

  it("rejects a ticket that does not belong to the project", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const result = await invoke<{ ok: boolean; error?: string }>(
      "volli:file-read",
      {},
      { projectId: setup.projectId, ticketId: "not-this-projects-ticket", relPath: "x.md" },
    );
    expect(result).toEqual({ ok: false, error: "Unknown ticket" });
  });

  it("degrades every channel to a typed error when the db failed to open", async () => {
    handlers.clear();
    registerFileIpcHandlers(
      { ok: false, error: "disk full" },
      { globalCommandsDir: "/nowhere", globalSkillsDir: "/nowhere/skills" },
      createTestFileServices(),
    );
    const result = await invoke<{ ok: boolean; error?: string }>(
      "volli:file-index",
      {},
      { projectId: "p" },
    );
    expect(result).toEqual({ ok: false, error: "disk full" });

    // Every FILE_CHANNELS member, not just file-index — the degraded path
    // ignores its arguments entirely, so an empty payload exercises them all.
    for (const channel of FILE_CHANNELS) {
      const outcome = await invoke<{ ok: boolean; error?: string }>(channel, {});
      expect(outcome).toEqual({ ok: false, error: "disk full" });
    }
  });

  it("registers a handler for every FILE_CHANNELS member", () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    for (const channel of FILE_CHANNELS) {
      expect(handlers.has(channel)).toBe(true);
    }
  });

  it("yields the exact envelope 'Invalid request' reply for a malformed payload", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const result = await invoke<{ ok: boolean; error?: string }>(
      "volli:file-read",
      {},
      { nonsense: true },
    );
    expect(result).toEqual({ ok: false, error: "Invalid request" });
  });

  it("threads the invoking WebContents through file-watch to FileWatchManager.watch (the trailing sender param)", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    await invoke("volli:artifact-create", {}, { projectId: setup.projectId, name: "sender-check" });
    const subscriber = makeWebContents(101);
    const bystander = makeWebContents(202);

    const watched = await invoke<{ ok: boolean }>("volli:file-watch", subscriber, {
      projectId: setup.projectId,
      relPath: ".volli/artifacts/sender-check.md",
    });
    expect(watched).toEqual({ ok: true });

    vi.useFakeTimers();
    watchCalls[0]?.cb("change", "sender-check.md");
    vi.advanceTimersByTime(250);

    expect(subscriber.send).toHaveBeenCalledWith("volli:file-changed", {
      projectId: setup.projectId,
      ticketId: null,
      relPath: ".volli/artifacts/sender-check.md",
      source: "main",
      revision: expect.any(Number),
    } satisfies FileChangedEvent);
    expect(bystander.send).not.toHaveBeenCalled();
  });
});

function createTestFileServices() {
  return createHostFileServices({
    client: createElectronClientCapabilities(),
    trash: { trashItem: trashItemMock },
  });
}
