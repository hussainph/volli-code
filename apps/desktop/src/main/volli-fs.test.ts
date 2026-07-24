import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DirChangedEvent, FileChangedEvent, VolliIpcChannel } from "@volli/shared";
import { FILE_CHANNELS, VOLLI_GITIGNORE_CONTENT } from "@volli/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Hoisted above module evaluation, like pty.test.ts/data-ipc.test.ts, so the
// mock factories can capture into them. `electron` is fully mocked (never
// resolvable under plain-Node vitest). `node:fs` is PARTIALLY mocked: every
// real export passes through unchanged via `importOriginal` — only `watch` is
// replaced, so the FileWatchManager suite fires watch callbacks deterministically
// under `vi.useFakeTimers()` instead of racing a real fs.watch/OS debounce.
// Every other suite runs against real directories, real symlinks, and real disk
// I/O (and real `git`), untouched by this mock.
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
  buildFileIndex,
  createArtifact,
  ensureProjectArtifactsDir,
  ensureVolliDir,
  FileWatchManager,
  readFile as readFsFile,
  registerFileIpcHandlers,
  revealFile,
  writeFile as writeFsFile,
} from "./volli-fs";
import { insertProject } from "./db/projects-repo";
import { openTestDb, testProject, testTicket } from "./db/test-helpers";
import type { TestDb } from "./db/test-helpers";
import { insertTicket } from "./db/tickets-repo";

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
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  handlers.clear();
  showItemInFolderMock.mockClear();
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

// ---- ensure* -----------------------------------------------------------------

describe("ensureVolliDir", () => {
  it("creates .volli/ and .volli/.gitignore with the self-gitignore content", async () => {
    const project = makeTempProjectDir();
    await ensureVolliDir(project);
    expect(existsSync(join(project, ".volli"))).toBe(true);
    expect(readFileSync(join(project, ".volli", ".gitignore"), "utf8")).toBe(
      VOLLI_GITIGNORE_CONTENT,
    );
  });

  it("never touches the project's root .gitignore and is idempotent", async () => {
    const project = makeTempProjectDir();
    writeFileSync(join(project, ".gitignore"), "node_modules\n", "utf8");
    await ensureVolliDir(project);
    writeFileSync(join(project, ".volli", ".gitignore"), "custom\n", "utf8");
    await ensureVolliDir(project);
    expect(readFileSync(join(project, ".gitignore"), "utf8")).toBe("node_modules\n");
    expect(readFileSync(join(project, ".volli", ".gitignore"), "utf8")).toBe("custom\n");
  });
});

describe("ensureProjectArtifactsDir", () => {
  it("creates .volli/artifacts plus the .volli self-gitignore", async () => {
    const project = makeTempProjectDir();
    await ensureProjectArtifactsDir(project);
    expect(existsSync(join(project, ".volli", "artifacts"))).toBe(true);
    expect(existsSync(join(project, ".volli", ".gitignore"))).toBe(true);
  });
});

// ---- buildFileIndex ----------------------------------------------------------

describe("buildFileIndex", () => {
  it("lists git-tracked/untracked repo files plus force-included artifacts (classified, artifact-flagged)", async () => {
    const project = makeGitRepoDir();
    await writeFile(join(project, "README.md"), "# hi", "utf8");
    await mkdir(join(project, "src"));
    await writeFile(join(project, "src", "main.ts"), "export {}", "utf8");
    await createArtifact(project, "notes"); // → .volli/artifacts/notes.md

    const { files, truncated } = await buildFileIndex(project);
    expect(truncated).toBe(false);
    const byPath = new Map(files.map((f) => [f.relPath, f]));

    expect(byPath.get("README.md")).toEqual({
      relPath: "README.md",
      kind: "markdown",
      artifact: false,
    });
    expect(byPath.get("src/main.ts")).toEqual({
      relPath: "src/main.ts",
      kind: "other",
      artifact: false,
    });
    expect(byPath.get(".volli/artifacts/notes.md")).toEqual({
      relPath: ".volli/artifacts/notes.md",
      kind: "markdown",
      artifact: true,
    });
  });

  it("respects .gitignore (ignored files never enter the index)", async () => {
    const project = makeGitRepoDir();
    await writeFile(join(project, ".gitignore"), "secret.txt\n", "utf8");
    await writeFile(join(project, "secret.txt"), "nope", "utf8");
    await writeFile(join(project, "keep.md"), "# keep", "utf8");

    const { files } = await buildFileIndex(project);
    const paths = files.map((f) => f.relPath);
    expect(paths).toContain("keep.md");
    expect(paths).not.toContain("secret.txt");
  });

  it("does not surface the gitignored .volli dir as ordinary repo files (only the artifact walk includes it)", async () => {
    const project = makeGitRepoDir();
    await createArtifact(project, "a");
    const { files } = await buildFileIndex(project);
    // Exactly one .volli entry — the artifact — flagged as such.
    const volliEntries = files.filter((f) => f.relPath.startsWith(".volli/"));
    expect(volliEntries).toEqual([
      { relPath: ".volli/artifacts/a.md", kind: "markdown", artifact: true },
    ]);
  });

  it("caps the index and reports truncated, keeping artifacts (pushed first) and stopping early", async () => {
    const project = makeGitRepoDir();
    await writeFile(join(project, "a.md"), "a", "utf8");
    await writeFile(join(project, "b.md"), "b", "utf8");
    await writeFile(join(project, "c.md"), "c", "utf8");
    await createArtifact(project, "art"); // → .volli/artifacts/art.md (force-included, first)

    // A cap of 2 forces truncation: the artifact survives (pushed first), one
    // repo file fills the rest, the remainder is skipped without materializing.
    const { files, truncated } = await buildFileIndex(project, 2);
    expect(truncated).toBe(true);
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.relPath === ".volli/artifacts/art.md" && f.artifact)).toBe(true);
  });

  it("reports truncated:false when the entry count exactly equals the cap", async () => {
    const project = makeGitRepoDir();
    await writeFile(join(project, "a.md"), "a", "utf8");
    await writeFile(join(project, "b.md"), "b", "utf8");
    const { files, truncated } = await buildFileIndex(project, 2);
    expect(truncated).toBe(false);
    expect(files).toHaveLength(2);
  });

  it("falls back to a bounded walk when git is unavailable, skipping .git/node_modules/.volli", async () => {
    const project = makeTempProjectDir(); // NOT a git repo → git ls-files fails
    await writeFile(join(project, "a.md"), "a", "utf8");
    await mkdir(join(project, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(project, "node_modules", "pkg", "index.js"), "x", "utf8");
    await mkdir(join(project, ".git"));
    await writeFile(join(project, ".git", "HEAD"), "ref", "utf8");
    await createArtifact(project, "walked");

    const { files } = await buildFileIndex(project);
    const paths = files.map((f) => f.relPath);
    expect(paths).toContain("a.md");
    expect(paths).toContain(".volli/artifacts/walked.md");
    expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".git/"))).toBe(false);
  });
});

// ---- readFile ----------------------------------------------------------------

describe("readFile", () => {
  it("reads utf8 text (markdown), reporting source main and not truncated", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "README.md"), "# Hello", "utf8");
    const result = await readFsFile(project, null, "README.md");
    expect(result).toEqual({
      ok: true,
      source: "main",
      kind: "markdown",
      size: 7,
      mtime: expect.any(Number) as unknown as number,
      content: { type: "text", text: "# Hello", truncated: false },
    });
  });

  it("reads any text file (code) read-only, kind 'other'", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "index.ts"), "export {}", "utf8");
    const result = await readFsFile(project, null, "index.ts");
    expect(result.ok && result.kind).toBe("other");
    expect(result.ok && result.content).toEqual({
      type: "text",
      text: "export {}",
      truncated: false,
    });
  });

  it("truncates text past the 1 MiB cap", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "big.md"), "a".repeat(1024 * 1024 + 10), "utf8");
    const result = await readFsFile(project, null, "big.md");
    expect(result.ok).toBe(true);
    if (!result.ok || result.content.type !== "text") throw new Error("expected text");
    expect(result.content.truncated).toBe(true);
    expect(result.content.text.length).toBe(1024 * 1024);
  });

  it("reads a file exactly at the 1 MiB cap in full, not truncated", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "exact.md"), "a".repeat(1024 * 1024), "utf8");
    const result = await readFsFile(project, null, "exact.md");
    expect(result.ok).toBe(true);
    if (!result.ok || result.content.type !== "text") throw new Error("expected text");
    expect(result.content.truncated).toBe(false);
    expect(result.content.text.length).toBe(1024 * 1024);
  });

  it("reads a file one byte over the cap as truncated to exactly the cap", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "over.md"), "a".repeat(1024 * 1024 + 1), "utf8");
    const result = await readFsFile(project, null, "over.md");
    expect(result.ok).toBe(true);
    if (!result.ok || result.content.type !== "text") throw new Error("expected text");
    expect(result.content.truncated).toBe(true);
    expect(result.content.text.length).toBe(1024 * 1024);
  });

  it("returns an image as an inline data URI", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "logo.png"), Buffer.from([1, 2, 3]));
    const result = await readFsFile(project, null, "logo.png");
    expect(result.ok).toBe(true);
    if (!result.ok || result.content.type !== "image") throw new Error("expected image");
    expect(result.content.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("classifies a NUL-containing file as binary", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "data.bin"), Buffer.from([0x41, 0x00, 0x42]));
    const result = await readFsFile(project, null, "data.bin");
    expect(result.ok && result.content).toEqual({ type: "binary" });
  });

  it("resolves a non-.volli path to the worktree copy when a worktree root is given (source: worktree)", async () => {
    const main = makeTempProjectDir();
    const worktree = makeTempProjectDir();
    await writeFile(join(main, "file.md"), "main copy", "utf8");
    await writeFile(join(worktree, "file.md"), "worktree copy", "utf8");
    const result = await readFsFile(main, worktree, "file.md");
    expect(result.ok).toBe(true);
    if (!result.ok || result.content.type !== "text") throw new Error("expected text");
    expect(result.source).toBe("worktree");
    expect(result.content.text).toBe("worktree copy");
  });

  it("always resolves a .volli path to the main checkout even when a worktree root is given", async () => {
    const main = makeTempProjectDir();
    const worktree = makeTempProjectDir();
    await createArtifact(main, "shared"); // main .volli/artifacts/shared.md
    const result = await readFsFile(main, worktree, ".volli/artifacts/shared.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("main");
  });

  it.each([["../../etc/passwd"], ["/etc/passwd"], [".."], [""], ["a/../b.md"]])(
    "rejects the unsafe relPath %j",
    async (relPath) => {
      const project = makeTempProjectDir();
      const result = await readFsFile(project, null, relPath);
      expect(result).toEqual({ ok: false, error: "Invalid file path" });
    },
  );

  it("rejects reading a file that is itself a symlink", async () => {
    const project = makeTempProjectDir();
    const outside = makeTempProjectDir();
    writeFileSync(join(outside, "secret"), "top secret", "utf8");
    symlinkSync(join(outside, "secret"), join(project, "link.md"), "file");
    const result = await readFsFile(project, null, "link.md");
    expect(result).toEqual({ ok: false, error: "Path is a symlink" });
  });

  it("rejects reading through a directory symlink that escapes the root", async () => {
    const project = makeTempProjectDir();
    const outside = makeTempProjectDir();
    writeFileSync(join(outside, "secret.md"), "top secret", "utf8");
    symlinkSync(outside, join(project, "escape"), "dir");
    const result = await readFsFile(project, null, "escape/secret.md");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("escapes");
  });
});

// ---- writeFile ---------------------------------------------------------------

describe("writeFile", () => {
  it("round-trips markdown content and returns the fresh mtime", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "notes.md"), "old", "utf8");
    const result = await writeFsFile(project, null, "notes.md", "# New");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.mtime).toBe("number");
    expect(await readFile(join(project, "notes.md"), "utf8")).toBe("# New");
  });

  it("writes a non-markdown utf8 text file and returns the fresh post-write mtime", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "app.ts"), "export const a = 1;\n", "utf8");
    const result = await writeFsFile(project, null, "app.ts", "export const a = 2;\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await readFile(join(project, "app.ts"), "utf8")).toBe("export const a = 2;\n");
    expect(result.mtime).toBe((await stat(join(project, "app.ts"))).mtimeMs);
  });

  it("refuses to overwrite a file whose on-disk bytes are binary (NUL-sniffed), leaving it intact", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "data.txt"), Buffer.from([0x41, 0x00, 0x42]));
    const result = await writeFsFile(project, null, "data.txt", "clobber");
    expect(result).toEqual({ ok: false, error: "Binary files cannot be edited" });
    expect(await readFile(join(project, "data.txt"))).toEqual(Buffer.from([0x41, 0x00, 0x42]));
  });

  it.each([["logo.png"], ["diagram.svg"]])(
    "rejects an image-kind path (%j) by extension, before touching disk",
    async (relPath) => {
      const project = makeTempProjectDir();
      await writeFile(join(project, relPath), "<svg/>", "utf8");
      const result = await writeFsFile(project, null, relPath, "clobber");
      expect(result).toEqual({ ok: false, error: "Images cannot be edited" });
      expect(await readFile(join(project, relPath), "utf8")).toBe("<svg/>");
    },
  );

  it("rejects writing back a file that was served truncated (over the 1 MiB read cap)", async () => {
    const project = makeTempProjectDir();
    const onDisk = "a".repeat(1024 * 1024 + 1);
    await writeFile(join(project, "huge.md"), onDisk, "utf8");
    const result = await writeFsFile(project, null, "huge.md", "the truncated buffer");
    expect(result).toEqual({ ok: false, error: "File is too large to edit (over 1 MiB)" });
    expect((await stat(join(project, "huge.md"))).size).toBe(onDisk.length);
  });

  it("rejects incoming content past the 1 MiB cap without touching the file", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "notes.md"), "small", "utf8");
    const result = await writeFsFile(project, null, "notes.md", "a".repeat(1024 * 1024 + 1));
    expect(result).toEqual({ ok: false, error: "Content is too large to save (over 1 MiB)" });
    expect(await readFile(join(project, "notes.md"), "utf8")).toBe("small");
  });

  it("passes the expectedMtime guard when it matches the current mtime", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "notes.md"), "old", "utf8");
    const current = (await stat(join(project, "notes.md"))).mtimeMs;
    const result = await writeFsFile(project, null, "notes.md", "new", current);
    expect(result.ok).toBe(true);
  });

  it("fails the expectedMtime guard on a mismatch, without clobbering", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "notes.md"), "on disk", "utf8");
    const result = await writeFsFile(project, null, "notes.md", "mine", 12345);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("changed on disk");
    expect(await readFile(join(project, "notes.md"), "utf8")).toBe("on disk");
  });

  it("refuses to create a repo file that does not exist yet (editing only, never creation)", async () => {
    const project = makeTempProjectDir();
    const result = await writeFsFile(project, null, "brand-new.ts", "export {}");
    expect(result).toEqual({ ok: false, error: "File does not exist on disk" });
    expect(existsSync(join(project, "brand-new.ts"))).toBe(false);
  });

  it("refuses to write to a directory with the same message the read path uses", async () => {
    const project = makeTempProjectDir();
    await mkdir(join(project, "src"));
    const result = await writeFsFile(project, null, "src", "x");
    expect(result).toEqual({ ok: false, error: "Not a file" });
  });

  it("reports a file that vanished under an armed conflict guard", async () => {
    const project = makeTempProjectDir();
    const result = await writeFsFile(project, null, "gone.md", "x", 12345);
    expect(result).toEqual({ ok: false, error: "File no longer exists on disk" });
  });

  it("self-heals a deleted .volli/ before writing an artifact (recreates the dir + gitignore)", async () => {
    const project = makeTempProjectDir();
    await createArtifact(project, "notes"); // → .volli/artifacts/notes.md
    // `git clean -xdf` removes `.volli` (it self-gitignores) out from under the tab.
    rmSync(join(project, ".volli"), { recursive: true, force: true });

    const result = await writeFsFile(project, null, ".volli/artifacts/notes.md", "# recovered");
    expect(result.ok).toBe(true);
    expect(existsSync(join(project, ".volli", ".gitignore"))).toBe(true);
    expect(await readFile(join(project, ".volli", "artifacts", "notes.md"), "utf8")).toBe(
      "# recovered",
    );
  });

  it("does not create parent dirs for a non-.volli path (never mkdirs arbitrary repo paths)", async () => {
    const project = makeTempProjectDir();
    const result = await writeFsFile(project, null, "missing/dir/file.md", "x");
    expect(result.ok).toBe(false);
    expect(existsSync(join(project, "missing"))).toBe(false);
  });

  // Containment is asserted against the WIDENED path (issue #106): the guards
  // used to be reachable only for `.md`, so a code path escaping the root would
  // not have been caught by the markdown-only suite above.
  it.each([["../../etc/hosts"], ["/etc/hosts"], ["src/../../escape.ts"], [""]])(
    "rejects the unsafe relPath %j on write",
    async (relPath) => {
      const project = makeTempProjectDir();
      const result = await writeFsFile(project, null, relPath, "pwned");
      expect(result).toEqual({ ok: false, error: "Invalid file path" });
    },
  );

  it("refuses to write through a symlinked code file, leaving the target untouched", async () => {
    const project = makeTempProjectDir();
    const outside = makeTempProjectDir();
    const target = join(outside, "secret.ts");
    writeFileSync(target, "untouched", "utf8");
    symlinkSync(target, join(project, "link.ts"), "file");
    const result = await writeFsFile(project, null, "link.ts", "pwned");
    expect(result).toEqual({ ok: false, error: "Path is a symlink" });
    expect(readFileSync(target, "utf8")).toBe("untouched");
  });

  it("refuses to write through a directory symlink that escapes the root", async () => {
    const project = makeTempProjectDir();
    const outside = makeTempProjectDir();
    const target = join(outside, "secret.ts");
    writeFileSync(target, "untouched", "utf8");
    symlinkSync(outside, join(project, "escape"), "dir");
    const result = await writeFsFile(project, null, "escape/secret.ts", "pwned");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("escapes");
    expect(readFileSync(target, "utf8")).toBe("untouched");
  });

  it("writes to the worktree copy for a non-.volli path when a worktree root is given", async () => {
    const main = makeTempProjectDir();
    const worktree = makeTempProjectDir();
    await writeFile(join(main, "file.md"), "main", "utf8");
    await writeFile(join(worktree, "file.md"), "worktree", "utf8");
    await writeFsFile(main, worktree, "file.md", "edited");
    expect(await readFile(join(worktree, "file.md"), "utf8")).toBe("edited");
    expect(await readFile(join(main, "file.md"), "utf8")).toBe("main");
  });
});

// ---- createArtifact ----------------------------------------------------------

describe("createArtifact", () => {
  it("creates a templated .md in .volli/artifacts, forcing the extension, and returns its relPath", async () => {
    const project = makeTempProjectDir();
    const result = await createArtifact(project, "Design Notes");
    expect(result).toEqual({ ok: true, relPath: ".volli/artifacts/Design Notes.md" });
    const content = await readFile(join(project, ".volli", "artifacts", "Design Notes.md"), "utf8");
    expect(content).toContain("# Design Notes");
  });

  it("leaves an already-.md name untouched", async () => {
    const project = makeTempProjectDir();
    const result = await createArtifact(project, "notes.md");
    expect(result).toEqual({ ok: true, relPath: ".volli/artifacts/notes.md" });
  });

  it.each([[""], ["   "], [".."], ["sub/notes"], [".hidden"]])(
    "rejects an invalid raw name %j",
    async (raw) => {
      const project = makeTempProjectDir();
      const result = await createArtifact(project, raw);
      expect(result).toEqual({ ok: false, error: "Invalid artifact name" });
    },
  );

  it("fails on a name collision without overwriting the original", async () => {
    const project = makeTempProjectDir();
    await createArtifact(project, "notes");
    const filePath = join(project, ".volli", "artifacts", "notes.md");
    await writeFile(filePath, "original", "utf8");
    const result = await createArtifact(project, "notes");
    expect(result.ok).toBe(false);
    expect(await readFile(filePath, "utf8")).toBe("original");
  });

  it("refuses to write through a pre-existing symlink at the target name (no follow)", async () => {
    const project = makeTempProjectDir();
    await ensureProjectArtifactsDir(project);
    const outside = makeTempProjectDir();
    const outsideFile = join(outside, "target.md");
    writeFileSync(outsideFile, "untouched", "utf8");
    symlinkSync(outsideFile, join(project, ".volli", "artifacts", "notes.md"), "file");
    const result = await createArtifact(project, "notes");
    expect(result.ok).toBe(false);
    expect(readFileSync(outsideFile, "utf8")).toBe("untouched");
  });
});

// ---- revealFile --------------------------------------------------------------

describe("revealFile", () => {
  it("reveals the resolved file via shell.showItemInFolder", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "notes.md"), "x", "utf8");
    const result = await revealFile(project, null, "notes.md");
    expect(result).toEqual({ ok: true });
    expect(showItemInFolderMock).toHaveBeenCalledWith(join(project, "notes.md"));
  });
});

// ---- FileWatchManager --------------------------------------------------------

/** Subscribes the manager to a real (existing) directory + basename. */
async function watchFile(
  manager: FileWatchManager,
  webContents: ReturnType<typeof makeWebContents>,
  project: string,
  relPath = "notes.md",
) {
  await writeFile(join(project, relPath), "x", "utf8");
  return manager.watch(
    webContents as never,
    "proj-1",
    "ticket-1",
    relPath,
    "main",
    project,
    relPath,
    project,
  );
}

describe("FileWatchManager", () => {
  it("watches the file's parent directory", async () => {
    const project = makeTempProjectDir();
    const manager = new FileWatchManager();
    await watchFile(manager, makeWebContents(), project);
    expect(watchCalls.map((c) => c.dir)).toEqual([project]);
  });

  it("broadcasts a debounced volli:file-changed for an event on the watched basename", async () => {
    const project = makeTempProjectDir();
    const manager = new FileWatchManager(250);
    const webContents = makeWebContents();
    await watchFile(manager, webContents, project);

    vi.useFakeTimers();
    watchCalls[0]?.cb("change", "notes.md");
    vi.advanceTimersByTime(250);

    expect(webContents.send).toHaveBeenCalledWith("volli:file-changed", {
      projectId: "proj-1",
      relPath: "notes.md",
      source: "main",
    } satisfies FileChangedEvent);
  });

  it("ignores an event for a different basename in the same directory", async () => {
    const project = makeTempProjectDir();
    const manager = new FileWatchManager(250);
    const webContents = makeWebContents();
    await watchFile(manager, webContents, project);

    vi.useFakeTimers();
    watchCalls[0]?.cb("change", "other.md");
    vi.advanceTimersByTime(250);

    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("broadcasts conservatively when the platform reports a null filename", async () => {
    const project = makeTempProjectDir();
    const manager = new FileWatchManager(250);
    const webContents = makeWebContents();
    await watchFile(manager, webContents, project);

    vi.useFakeTimers();
    watchCalls[0]?.cb("rename", null);
    vi.advanceTimersByTime(250);

    expect(webContents.send).toHaveBeenCalledTimes(1);
  });

  it("does not broadcast before the debounce window elapses", async () => {
    const project = makeTempProjectDir();
    const manager = new FileWatchManager(250);
    const webContents = makeWebContents();
    await watchFile(manager, webContents, project);

    vi.useFakeTimers();
    watchCalls[0]?.cb("change", "notes.md");
    vi.advanceTimersByTime(200);
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("closes the watcher and clears the pending timer on unwatch — no late broadcast", async () => {
    const project = makeTempProjectDir();
    const manager = new FileWatchManager(250);
    const webContents = makeWebContents();
    await watchFile(manager, webContents, project);

    vi.useFakeTimers();
    watchCalls[0]?.cb("change", "notes.md");
    manager.unwatch(webContents as never, "proj-1", "ticket-1", "notes.md");
    vi.advanceTimersByTime(1000);

    expect(watchCalls[0]?.watcher.close).toHaveBeenCalledTimes(1);
    expect(webContents.send).not.toHaveBeenCalled();
  });

  it("tears down when the owning webContents is destroyed", async () => {
    const project = makeTempProjectDir();
    const manager = new FileWatchManager(250);
    const webContents = makeWebContents();
    await watchFile(manager, webContents, project);

    webContents.fireDestroyed();
    expect(watchCalls[0]?.watcher.close).toHaveBeenCalledTimes(1);
  });

  it("watching the same tab twice wires only one watcher", async () => {
    const project = makeTempProjectDir();
    const manager = new FileWatchManager();
    const webContents = makeWebContents();
    await watchFile(manager, webContents, project);
    await watchFile(manager, webContents, project);
    expect(watchMock).toHaveBeenCalledTimes(1);
  });

  it("re-arms the watcher on a watcher 'error' (never crashes) and nudges a refetch", async () => {
    const project = makeTempProjectDir();
    const manager = new FileWatchManager(0);
    const webContents = makeWebContents();
    await watchFile(manager, webContents, project);
    expect(watchMock).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    watchCalls[0]?.watcher.emitError(new Error("kqueue fd pressure"));
    // Close + rewire happen synchronously; the refetch nudge is debounced.
    expect(watchCalls[0]?.watcher.close).toHaveBeenCalledTimes(1);
    expect(watchMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(0);

    expect(webContents.send).toHaveBeenCalledWith("volli:file-changed", {
      projectId: "proj-1",
      relPath: "notes.md",
      source: "main",
    } satisfies FileChangedEvent);
  });

  it("retries a vanished non-.volli watch dir, then tears down + sends one final broadcast", async () => {
    const project = makeTempProjectDir();
    const manager = new FileWatchManager(0);
    const webContents = makeWebContents();
    const sub = join(project, "sub");
    await mkdir(sub);
    await writeFile(join(sub, "notes.md"), "x", "utf8");
    manager.watch(
      webContents as never,
      "proj-1",
      "ticket-1",
      "sub/notes.md",
      "main",
      sub,
      "notes.md",
      project,
    );

    rmSync(sub, { recursive: true, force: true });
    vi.useFakeTimers();
    watchCalls[0]?.watcher.emitError(new Error("boom"));

    // A non-.volli dir is never mkdir'd; the manager retries (~1s apart) in case
    // it is mid-regeneration before giving up — no broadcast until exhausted.
    expect(webContents.send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(webContents.send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);

    expect(webContents.send).toHaveBeenCalledWith("volli:file-changed", {
      projectId: "proj-1",
      relPath: "sub/notes.md",
      source: "main",
    } satisfies FileChangedEvent);
    // Torn down: a subsequent unwatch is a harmless no-op.
    expect(() =>
      manager.unwatch(webContents as never, "proj-1", "ticket-1", "sub/notes.md"),
    ).not.toThrow();
  });

  it("re-homes onto a recreated non-.volli dir when it reappears within the retry window", async () => {
    const project = makeTempProjectDir();
    const manager = new FileWatchManager(0);
    const webContents = makeWebContents();
    const sub = join(project, "sub");
    await mkdir(sub);
    await writeFile(join(sub, "notes.md"), "x", "utf8");
    manager.watch(
      webContents as never,
      "proj-1",
      "ticket-1",
      "sub/notes.md",
      "main",
      sub,
      "notes.md",
      project,
    );
    expect(watchMock).toHaveBeenCalledTimes(1);

    rmSync(sub, { recursive: true, force: true });
    vi.useFakeTimers();
    watchCalls[0]?.watcher.emitError(new Error("boom"));

    // The build regenerates the dir before the retries run out: the watch re-homes.
    mkdirSync(sub);
    vi.advanceTimersByTime(1000);
    expect(watchMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(webContents.send).toHaveBeenCalledWith("volli:file-changed", {
      projectId: "proj-1",
      relPath: "sub/notes.md",
      source: "main",
    } satisfies FileChangedEvent);
  });

  it("recreates a wiped .volli watch dir and re-arms instead of tearing down", async () => {
    const project = makeTempProjectDir();
    const manager = new FileWatchManager(0);
    const webContents = makeWebContents();
    await ensureProjectArtifactsDir(project);
    const artifactsDir = join(project, ".volli", "artifacts");
    await writeFile(join(artifactsDir, "notes.md"), "x", "utf8");
    manager.watch(
      webContents as never,
      "proj-1",
      "ticket-1",
      ".volli/artifacts/notes.md",
      "main",
      artifactsDir,
      "notes.md",
      project,
    );
    expect(watchMock).toHaveBeenCalledTimes(1);

    // An agent runs `rm -rf .volli && mkdir -p .volli/artifacts`; the watcher faults.
    rmSync(join(project, ".volli"), { recursive: true, force: true });
    watchCalls[0]?.watcher.emitError(new Error("boom"));

    // The manager recreates .volli/artifacts (with its self-gitignore) and rewires.
    await vi.waitFor(() => {
      expect(existsSync(join(project, ".volli", "artifacts"))).toBe(true);
      expect(existsSync(join(project, ".volli", ".gitignore"))).toBe(true);
      expect(watchMock).toHaveBeenCalledTimes(2);
    });
  });
});

// ---- IPC handler integration (real db + real temp project dirs) --------------

function setupDbAndHandlers(): {
  ctx: TestDb;
  projectId: string;
  ticketId: string;
  projectPath: string;
} {
  const ctx = openTestDb();
  const projectPath = makeGitRepoDir();
  const project = testProject({ path: projectPath });
  insertProject(ctx.db, project);
  const ticket = testTicket(project.id, { ticketNumber: 7 });
  insertTicket(ctx.db, ticket);
  registerFileIpcHandlers({ ok: true, db: ctx.db });
  return { ctx, projectId: project.id, ticketId: ticket.id, projectPath };
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
    expect(watchCalls.map((c) => c.dir)).toEqual([setup.projectPath]);
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

  // `worktree_path` IS populated in production (pty/manager.ts stamps it when a
  // ticket's worktree is created), so main-vs-ticket resolution is live behavior,
  // not future work — asserted end-to-end through the read channel.
  it("resolves a repo path to the ticket's live worktree while .volli stays on main", async () => {
    const setup = setupDbAndHandlers();
    ctx = setup.ctx;
    const worktree = makeTempProjectDir();
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
    "volli:file-write",
    "volli:artifact-create",
    "volli:file-reveal",
    "volli:file-watch",
    "volli:file-unwatch",
    "volli:dir-watch",
    "volli:dir-unwatch",
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
    registerFileIpcHandlers({ ok: false, error: "disk full" });
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
      relPath: ".volli/artifacts/sender-check.md",
      source: "main",
    } satisfies FileChangedEvent);
    expect(bystander.send).not.toHaveBeenCalled();
  });
});
