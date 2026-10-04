import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  link as hardLink,
  mkdir,
  readFile,
  rename,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { FileChangedEvent } from "@volli/shared";
import { VOLLI_GITIGNORE_CONTENT } from "@volli/shared";
import { syncProjectRoots } from "./project-roots";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Hoisted above module evaluation so the mock factory can capture into them.
// Client and trash ports are injected explicitly. `node:fs` is PARTIALLY mocked: every
// real export passes through unchanged via `importOriginal` — only `watch` is
// replaced, so the FileWatchManager suite fires watch callbacks deterministically
// under `vi.useFakeTimers()` instead of racing a real fs.watch/OS debounce.
// Every other suite runs against real directories, real symlinks, and real disk
// I/O (and real `git`), untouched by this mock.
const { showItemInFolderMock, trashItemMock, watchMock } = vi.hoisted(() => ({
  showItemInFolderMock: vi.fn(),
  // Delete goes to the TRASH, so the test double is the real seam: an
  // implementation that unlinked instead would still pass a "the file is gone"
  // assertion, and this is the mock that would not have been called.
  trashItemMock: vi.fn(async (_path: string) => {}),
  watchMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, watch: watchMock };
});

import {
  buildFileIndex,
  createArtifact,
  createDirectory,
  createFile,
  duplicateEntryName,
  duplicateFile,
  ensureProjectArtifactsDir,
  ensureVolliDir,
  FileWatchManager,
  fsFaultText,
  readFile as readFsFile,
  renameEntry,
  revealFile as hostRevealFile,
  trashEntry as hostTrashEntry,
  writeFile as writeFsFile,
} from "./volli-fs";
import {
  GIT_MAX_CONCURRENT_CHILDREN,
  resetGitChildSlotsForTest,
  withGitChildSlot,
} from "./worktree/git";
import { clientCapabilities } from "./ports/client";
function trashEntry(project: string, worktree: string | null, relPath: string) {
  return hostTrashEntry(project, worktree, relPath, { trashItem: trashItemMock });
}
function revealFile(project: string, worktree: string | null, relPath: string) {
  return hostRevealFile(project, worktree, relPath, {
    ...clientCapabilities(undefined),
    revealInFolder: showItemInFolderMock,
  });
}

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
  showItemInFolderMock.mockClear();
  trashItemMock.mockClear();
  vi.useRealTimers();
});

/** A HostClientEventSink double keyed by `id` (the FileWatchManager subscription key). */
function makeWebContents(id = 1) {
  const eventListeners = new Map<string, () => void>();
  return {
    id: String(id),
    publish: vi.fn(),
    destroyed: false,
    isClosed(): boolean {
      return this.destroyed;
    },
    onceClosed: vi.fn(function (this: unknown, cb: () => void) {
      eventListeners.set("destroyed", cb);
    }),
    removeCloseListener: vi.fn(),
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

describe("buildFileIndex and the shared git bound", () => {
  afterEach(() => resetGitChildSlotsForTest());

  it("lists through the bounded runner, not a private child of its own", async () => {
    // The file index used to spawn its own `execFileAsync` with no deadline and
    // no slot (VC-389). It now goes through the shared runner — with a longer
    // deadline of its own, because `--others` walks the whole working tree — so
    // opening several projects at once cannot outrun the bound.
    const project = makeGitRepoDir();
    await writeFile(join(project, "README.md"), "# hi", "utf8");

    const release: Array<() => void> = [];
    const holding = Array.from({ length: GIT_MAX_CONCURRENT_CHILDREN }, () =>
      withGitChildSlot(() => new Promise<void>((resolve) => release.push(resolve))),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    let settled = false;
    const index = buildFileIndex(project).then((result) => {
      settled = true;
      return result;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    // Not merely slow: with a free slot the same call finishes well inside this.
    expect(settled).toBe(false);

    for (const resolve of release) resolve();
    const { files } = await index;
    // And it really did list through git, rather than falling back to the walk.
    expect(files.map((file) => file.relPath)).toContain("README.md");
    await Promise.allSettled(holding);
  });
});

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
    const { files, truncated } = await buildFileIndex(project, { indexCap: 2 });
    expect(truncated).toBe(true);
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.relPath === ".volli/artifacts/art.md" && f.artifact)).toBe(true);
  });

  it("reports truncated:false when the entry count exactly equals the cap", async () => {
    const project = makeGitRepoDir();
    await writeFile(join(project, "a.md"), "a", "utf8");
    await writeFile(join(project, "b.md"), "b", "utf8");
    const { files, truncated } = await buildFileIndex(project, { indexCap: 2 });
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

  it("skips another ecosystem's dependency tree in that walk too, not just node_modules", async () => {
    // This walk runs precisely when `git ls-files` could NOT answer, so nothing
    // else keeps a Python `.venv` or a Rust `target` from eating the 20k cap
    // and burying the files a person would actually `@`-reference (VC-160).
    const project = makeTempProjectDir(); // NOT a git repo → git ls-files fails
    await writeFile(join(project, "main.py"), "print()", "utf8");
    for (const pruned of [".venv/lib/pkg", "__pycache__", ".tox/py312", "target/debug", "vendor"]) {
      await mkdir(join(project, pruned), { recursive: true });
      await writeFile(join(project, pruned, "generated"), "x", "utf8");
    }

    const { files } = await buildFileIndex(project);
    const paths = files.map((f) => f.relPath);

    expect(paths).toContain("main.py");
    expect(paths.some((p) => p.includes("generated"))).toBe(false);
  });

  // Quick-open's scope (VC-190). The split is decision #6's, the same one a
  // READ applies per path: repo files come from the worktree, `.volli/**`
  // never does — so a row the index offered and the read that follows it can
  // never name two different files.
  it("lists repo files from a worktree root while artifacts still come from Main", async () => {
    const project = makeGitRepoDir();
    const worktree = makeGitRepoDir();
    await writeFile(join(project, "main-only.ts"), "main", "utf8");
    await writeFile(join(worktree, "worktree-only.ts"), "worktree", "utf8");
    await createArtifact(project, "notes"); // Main's .volli/artifacts/notes.md
    await createArtifact(worktree, "never"); // must never be reached

    const { files } = await buildFileIndex(project, { worktreeRoot: worktree });
    const paths = files.map((f) => f.relPath);

    expect(paths).toContain("worktree-only.ts");
    expect(paths).not.toContain("main-only.ts");
    expect(paths).toContain(".volli/artifacts/notes.md");
    expect(paths).not.toContain(".volli/artifacts/never.md");
  });

  it("treats a null worktree root as the main checkout", async () => {
    const project = makeGitRepoDir();
    await writeFile(join(project, "main-only.ts"), "main", "utf8");
    const { files } = await buildFileIndex(project, { worktreeRoot: null });
    expect(files.map((f) => f.relPath)).toContain("main-only.ts");
  });

  it("falls back to a bounded walk of the WORKTREE when git can't answer there", async () => {
    const project = makeGitRepoDir();
    const worktree = makeTempProjectDir(); // NOT a git repo → git ls-files fails
    await writeFile(join(worktree, "walked.ts"), "x", "utf8");
    await mkdir(join(worktree, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(worktree, "node_modules", "pkg", "index.js"), "x", "utf8");

    const { files } = await buildFileIndex(project, { worktreeRoot: worktree });
    const paths = files.map((f) => f.relPath);
    expect(paths).toContain("walked.ts");
    expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
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

  it("returns an .svg as editable text, not a data URI", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "icon.svg"), '<svg viewBox="0 0 16 16"/>', "utf8");
    const result = await readFsFile(project, null, "icon.svg");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a successful read");
    expect(result.kind).toBe("other");
    expect(result.content).toEqual({
      type: "text",
      text: '<svg viewBox="0 0 16 16"/>',
      truncated: false,
    });
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

  // The pane renders this string verbatim (VC-120): a chat can name a path
  // that only exists in some other checkout, and the answer must be UI copy,
  // never `ENOENT: no such file or directory, stat '/abs/path'`.
  it("reports a missing file as 'File was not found', never raw errno text", async () => {
    const project = makeTempProjectDir();
    const result = await readFsFile(project, null, "missing.md");
    expect(result).toEqual({ ok: false, error: "File was not found" });
  });
});

// ---- fsFaultText -------------------------------------------------------------

const errnoError = (code: string): Error => Object.assign(new Error(`${code}: boom`), { code });

describe("fsFaultText", () => {
  it.each([
    ["ENOENT", "File was not found"],
    ["ENOTDIR", "File was not found"],
    ["EACCES", "Permission was denied"],
    ["EPERM", "Permission was denied"],
    ["EEXIST", "File already exists"],
    ["EISDIR", "Not a file"],
  ])("maps %s to %j", (code, expected) => {
    expect(fsFaultText(errnoError(code))).toBe(expected);
  });

  it("falls back to the raw message for an unmapped code, and for a bare value", () => {
    expect(fsFaultText(errnoError("EIO"))).toBe("EIO: boom");
    expect(fsFaultText("exploded")).toBe("exploded");
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

  it.each([["logo.png"], ["shot.webp"], ["anim.gif"]])(
    "rejects an image-kind path (%j) by extension, before touching disk",
    async (relPath) => {
      const project = makeTempProjectDir();
      await writeFile(join(project, relPath), "not really an image", "utf8");
      const result = await writeFsFile(project, null, relPath, "clobber");
      expect(result).toEqual({ ok: false, error: "Images cannot be edited" });
      expect(await readFile(join(project, relPath), "utf8")).toBe("not really an image");
    },
  );

  it("writes an .svg like any other source file — it is markup, not raster bytes", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "icon.svg"), "<svg/>", "utf8");
    const result = await writeFsFile(project, null, "icon.svg", '<svg width="16"/>');
    expect(result.ok).toBe(true);
    expect(await readFile(join(project, "icon.svg"), "utf8")).toBe('<svg width="16"/>');
  });

  it("rejects writing back a file that was served truncated (over the 1 MiB read cap)", async () => {
    const project = makeTempProjectDir();
    const onDisk = "a".repeat(1024 * 1024 + 1);
    await writeFile(join(project, "huge.md"), onDisk, "utf8");
    const result = await writeFsFile(project, null, "huge.md", "the truncated buffer");
    expect(result).toEqual({ ok: false, error: "File is too large to edit (over 1 MiB)" });
    expect((await stat(join(project, "huge.md"))).size).toBe(onDisk.length);
  });

  it("still allows editing a file exactly at the 1 MiB cap (over the cap, not at it, is refused)", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "exact.md"), "a".repeat(1024 * 1024), "utf8");
    const result = await writeFsFile(project, null, "exact.md", "trimmed");
    expect(result.ok).toBe(true);
    expect(await readFile(join(project, "exact.md"), "utf8")).toBe("trimmed");
  });

  // The write guard NUL-sniffs a bounded leading window rather than re-reading
  // the whole file on every autosave commit; a clean file past that window is
  // still perfectly writable.
  it("writes a text file larger than the binary-sniff window", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "big.ts"), `// ${"a".repeat(200 * 1024)}\n`, "utf8");
    const result = await writeFsFile(project, null, "big.ts", "export {}\n");
    expect(result.ok).toBe(true);
    expect(await readFile(join(project, "big.ts"), "utf8")).toBe("export {}\n");
  });

  it("still refuses a file whose NUL sits deep inside the sniff window", async () => {
    const project = makeTempProjectDir();
    const bytes = Buffer.concat([Buffer.alloc(32 * 1024, 0x41), Buffer.from([0x00, 0x42])]);
    await writeFile(join(project, "data.txt"), bytes);
    const result = await writeFsFile(project, null, "data.txt", "clobber");
    expect(result).toEqual({ ok: false, error: "Binary files cannot be edited" });
    expect(await readFile(join(project, "data.txt"))).toEqual(bytes);
  });

  // The write guard must scan as far as the reader does, not just the cheap
  // 64 KiB prefix: a NUL past that window is still a binary file, and stopping
  // early would let an overwrite clobber it.
  it("refuses a file whose first NUL sits PAST the binary-sniff window", async () => {
    const project = makeTempProjectDir();
    const bytes = Buffer.concat([Buffer.alloc(200 * 1024, 0x41), Buffer.from([0x00, 0x42])]);
    await writeFile(join(project, "late-nul.bin"), bytes);
    const result = await writeFsFile(project, null, "late-nul.bin", "clobber");
    expect(result).toEqual({ ok: false, error: "Binary files cannot be edited" });
    expect(await readFile(join(project, "late-nul.bin"))).toEqual(bytes);
  }, 15_000);

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

  it("maps a failed .volli self-heal to friendly copy, not a raw mkdir errno", async () => {
    // `.volli` occupied by a regular FILE: ensureVolliDir's recursive mkdir of
    // `.volli` throws EEXIST, and that fault reaches the same save toast the
    // write itself would — so it takes the same fsFaultText mapping (VC-120
    // review).
    const project = makeTempProjectDir();
    writeFileSync(join(project, ".volli"), "not a dir", "utf8");
    const result = await writeFsFile(project, null, ".volli/artifacts/notes.md", "# x");
    expect(result).toEqual({ ok: false, error: "File already exists" });
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

// ---- the creation track (VC-191) ---------------------------------------------

describe("createFile", () => {
  it("creates an empty file and resolves with the path it was asked for", async () => {
    const project = makeTempProjectDir();
    const result = await createFile(project, null, "notes.md");
    expect(result).toEqual({ ok: true, relPath: "notes.md" });
    expect(await readFile(join(project, "notes.md"), "utf8")).toBe("");
  });

  it("creates the missing parent folders on the way", async () => {
    const project = makeTempProjectDir();
    const result = await createFile(project, null, "src/deep/new.ts");
    expect(result).toEqual({ ok: true, relPath: "src/deep/new.ts" });
    expect(existsSync(join(project, "src", "deep", "new.ts"))).toBe(true);
  });

  it("refuses to overwrite an existing file, leaving its bytes alone", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "notes.md"), "original", "utf8");
    const result = await createFile(project, null, "notes.md");
    expect(result).toEqual({ ok: false, error: '"notes.md" already exists' });
    expect(await readFile(join(project, "notes.md"), "utf8")).toBe("original");
  });

  it("refuses to write through a symlink parked at the target name", async () => {
    const project = makeTempProjectDir();
    const outside = makeTempProjectDir();
    const outsideFile = join(outside, "target.md");
    writeFileSync(outsideFile, "untouched", "utf8");
    symlinkSync(outsideFile, join(project, "notes.md"), "file");
    const result = await createFile(project, null, "notes.md");
    expect(result).toEqual({ ok: false, error: "Path is a symlink" });
    expect(readFileSync(outsideFile, "utf8")).toBe("untouched");
  });

  it("refuses to create through a directory symlinked OUT of the project", async () => {
    const project = makeTempProjectDir();
    const outside = makeTempProjectDir();
    symlinkSync(outside, join(project, "escape"), "dir");
    const result = await createFile(project, null, "escape/planted.ts");
    expect(result).toEqual({ ok: false, error: "Resolved path escapes the project root" });
    expect(existsSync(join(outside, "planted.ts"))).toBe(false);
  });

  it("follows a directory symlinked WITHIN the project, exactly as a read does", async () => {
    const project = realpathSync(makeTempProjectDir());
    await mkdir(join(project, "real"));
    symlinkSync(join(project, "real"), join(project, "linked"), "dir");
    expect(await createFile(project, null, "linked/new.ts")).toEqual({
      ok: true,
      relPath: "linked/new.ts",
    });
    expect(existsSync(join(project, "real", "new.ts"))).toBe(true);
  });

  it("reports a dangling intermediate symlink rather than creating past it", async () => {
    const project = makeTempProjectDir();
    symlinkSync(join(makeTempProjectDir(), "gone"), join(project, "broken"), "dir");
    expect(await createFile(project, null, "broken/new.ts")).toEqual({
      ok: false,
      error: "File was not found",
    });
  });

  it.each([["../outside.md"], ["/etc/passwd"], [""], ["a/../../b"]])(
    "rejects the unsafe relPath %j before touching disk",
    async (relPath) => {
      const project = makeTempProjectDir();
      expect(await createFile(project, null, relPath)).toEqual({
        ok: false,
        error: "Invalid file path",
      });
    },
  );

  it("refuses a path whose middle segment is an existing FILE", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "notes.md"), "x", "utf8");
    expect(await createFile(project, null, "notes.md/child.ts")).toEqual({
      ok: false,
      error: "Not a directory",
    });
  });

  it("reports a missing project folder rather than resolving to a hole", async () => {
    const gone = join(makeTempProjectDir(), "never-existed");
    expect(await createFile(gone, null, "notes.md")).toEqual({
      ok: false,
      error: "Project folder was not found",
    });
  });

  it("resolves against the ticket worktree when one is given", async () => {
    const project = makeTempProjectDir();
    const worktree = makeTempProjectDir();
    const result = await createFile(project, worktree, "src/new.ts");
    expect(result.ok).toBe(true);
    expect(existsSync(join(worktree, "src", "new.ts"))).toBe(true);
    expect(existsSync(join(project, "src", "new.ts"))).toBe(false);
  });

  it("keeps .volli/** on Main even inside a worktree scope (decision #6)", async () => {
    const project = makeTempProjectDir();
    const worktree = makeTempProjectDir();
    await ensureProjectArtifactsDir(project);
    const result = await createFile(project, worktree, ".volli/artifacts/new.md");
    expect(result.ok).toBe(true);
    expect(existsSync(join(project, ".volli", "artifacts", "new.md"))).toBe(true);
  });
});

describe("createDirectory", () => {
  it("creates one directory", async () => {
    const project = makeTempProjectDir();
    expect(await createDirectory(project, null, "src/components")).toEqual({
      ok: true,
      relPath: "src/components",
    });
    expect((await stat(join(project, "src", "components"))).isDirectory()).toBe(true);
  });

  it("refuses a name that is already taken, rather than reporting success for it", async () => {
    const project = makeTempProjectDir();
    await mkdir(join(project, "src"));
    expect(await createDirectory(project, null, "src")).toEqual({
      ok: false,
      error: '"src" already exists',
    });
  });

  it("refuses when a FILE already holds the name", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "src"), "x", "utf8");
    expect(await createDirectory(project, null, "src")).toEqual({
      ok: false,
      error: '"src" already exists',
    });
  });

  it("rejects an unsafe relPath", async () => {
    const project = makeTempProjectDir();
    expect(await createDirectory(project, null, "../escape")).toEqual({
      ok: false,
      error: "Invalid file path",
    });
  });
});

describe("renameEntry", () => {
  it("renames a file and resolves with its new path", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "old.md"), "body", "utf8");
    expect(await renameEntry(project, null, "old.md", "new.md")).toEqual({
      ok: true,
      relPath: "new.md",
    });
    expect(existsSync(join(project, "old.md"))).toBe(false);
    expect(await readFile(join(project, "new.md"), "utf8")).toBe("body");
  });

  it("renames a directory", async () => {
    const project = makeTempProjectDir();
    await mkdir(join(project, "old"));
    await writeFile(join(project, "old", "a.ts"), "x", "utf8");
    expect((await renameEntry(project, null, "old", "new")).ok).toBe(true);
    expect(existsSync(join(project, "new", "a.ts"))).toBe(true);
  });

  it("refuses to clobber an occupied destination", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "a.md"), "a", "utf8");
    await writeFile(join(project, "b.md"), "b", "utf8");
    expect(await renameEntry(project, null, "a.md", "b.md")).toEqual({
      ok: false,
      error: '"b.md" already exists',
    });
    expect(await readFile(join(project, "b.md"), "utf8")).toBe("b");
    expect(existsSync(join(project, "a.md"))).toBe(true);
  });

  // macOS's default volume is case-insensitive but case-preserving, so the
  // occupied-destination `lstat` answers for a spelling that is really the file
  // being renamed. These three pin the seam that tells that apart from a real
  // collision, and each asserts the same thing on either kind of volume.
  it("changes only the letter case of a name, which is not an overwrite", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "readme.md"), "body", "utf8");
    expect(await renameEntry(project, null, "readme.md", "README.md")).toEqual({
      ok: true,
      relPath: "README.md",
    });
    expect(await readFile(join(project, "README.md"), "utf8")).toBe("body");
    expect(readdirSync(project)).toEqual(["README.md"]);
  });

  it("still refuses a HARDLINK of the same file — one inode, but two names", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "a.md"), "a", "utf8");
    await hardLink(join(project, "a.md"), join(project, "b.md"));
    expect(await renameEntry(project, null, "a.md", "b.md")).toEqual({
      ok: false,
      error: '"b.md" already exists',
    });
    expect(existsSync(join(project, "a.md"))).toBe(true);
  });

  it("refuses a case variant that is a second real file, where the volume keeps them apart", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "a.md"), "a", "utf8");
    await writeFile(join(project, "A.md"), "A", "utf8");
    if ((await readFile(join(project, "a.md"), "utf8")) !== "a") {
      // A case-insensitive volume folded the two writes into one file, so there
      // is no second file here for the refusal to be about.
      expect(readdirSync(project)).toHaveLength(1);
      return;
    }
    expect(await renameEntry(project, null, "a.md", "A.md")).toEqual({
      ok: false,
      error: '"A.md" already exists',
    });
    expect(await readFile(join(project, "A.md"), "utf8")).toBe("A");
  });

  it("refuses a destination in a folder that does not exist", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "a.md"), "a", "utf8");
    expect(await renameEntry(project, null, "a.md", "nope/a.md")).toEqual({
      ok: false,
      error: "Destination folder was not found",
    });
    expect(existsSync(join(project, "a.md"))).toBe(true);
  });

  it("refuses a rename that would cross checkouts (.volli always resolves to Main)", async () => {
    const project = makeTempProjectDir();
    const worktree = makeTempProjectDir();
    await writeFile(join(worktree, "a.md"), "a", "utf8");
    await ensureProjectArtifactsDir(project);
    expect(await renameEntry(project, worktree, "a.md", ".volli/artifacts/a.md")).toEqual({
      ok: false,
      error: "A rename cannot move a file between checkouts",
    });
    expect(existsSync(join(worktree, "a.md"))).toBe(true);
    expect(existsSync(join(project, ".volli", "artifacts", "a.md"))).toBe(false);
  });

  it("reports a source that is not there", async () => {
    const project = makeTempProjectDir();
    expect(await renameEntry(project, null, "ghost.md", "other.md")).toEqual({
      ok: false,
      error: "File was not found",
    });
  });

  it("rejects an unsafe destination path", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "a.md"), "a", "utf8");
    expect(await renameEntry(project, null, "a.md", "../escaped.md")).toEqual({
      ok: false,
      error: "Invalid file path",
    });
  });

  it("rejects an unsafe source path", async () => {
    const project = makeTempProjectDir();
    expect(await renameEntry(project, null, "../outside.md", "a.md")).toEqual({
      ok: false,
      error: "Invalid file path",
    });
  });

  it("refuses to rename a symlink (the read path refuses to open one too)", async () => {
    const project = makeTempProjectDir();
    const outside = makeTempProjectDir();
    const outsideFile = join(outside, "target.md");
    writeFileSync(outsideFile, "untouched", "utf8");
    symlinkSync(outsideFile, join(project, "link.md"), "file");
    expect(await renameEntry(project, null, "link.md", "moved.md")).toEqual({
      ok: false,
      error: "Path is a symlink",
    });
    expect(existsSync(outsideFile)).toBe(true);
  });
});

describe("duplicateEntryName", () => {
  it("puts the suffix before the extension so the copy stays the same kind of file", () => {
    expect(duplicateEntryName("plan.md", 1)).toBe("plan copy.md");
    expect(duplicateEntryName("plan.md", 2)).toBe("plan copy 2.md");
  });

  it("keeps a dotfile whole and handles a name with no extension", () => {
    expect(duplicateEntryName(".gitignore", 1)).toBe(".gitignore copy");
    expect(duplicateEntryName("Makefile", 3)).toBe("Makefile copy 3");
  });
});

describe("duplicateFile", () => {
  it("copies a file to the first free copy name and resolves with it", async () => {
    const project = makeTempProjectDir();
    await mkdir(join(project, "src"));
    await writeFile(join(project, "src", "plan.md"), "body", "utf8");
    expect(await duplicateFile(project, null, "src/plan.md")).toEqual({
      ok: true,
      relPath: "src/plan copy.md",
    });
    expect(await readFile(join(project, "src", "plan copy.md"), "utf8")).toBe("body");
  });

  it("walks past taken copy names instead of overwriting one", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "plan.md"), "body", "utf8");
    await writeFile(join(project, "plan copy.md"), "first", "utf8");
    expect(await duplicateFile(project, null, "plan.md")).toEqual({
      ok: true,
      relPath: "plan copy 2.md",
    });
    expect(await readFile(join(project, "plan copy.md"), "utf8")).toBe("first");
  });

  it("refuses a directory out loud", async () => {
    const project = makeTempProjectDir();
    await mkdir(join(project, "src"));
    expect(await duplicateFile(project, null, "src")).toEqual({
      ok: false,
      error: "Only files can be duplicated",
    });
  });

  it("reports a source that is not there", async () => {
    const project = makeTempProjectDir();
    expect(await duplicateFile(project, null, "ghost.md")).toEqual({
      ok: false,
      error: "File was not found",
    });
  });

  it("rejects an unsafe relPath", async () => {
    const project = makeTempProjectDir();
    expect(await duplicateFile(project, null, "../outside.md")).toEqual({
      ok: false,
      error: "Invalid file path",
    });
  });
});

describe("trashEntry", () => {
  it("refuses on a headless host and leaves the file intact", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "notes.md"), "keep me", "utf8");
    expect(await hostTrashEntry(project, null, "notes.md")).toEqual({
      ok: false,
      error:
        "Moving a file to Trash needs the Volli desktop host. This host cannot trash files; nothing was deleted.",
    });
    expect(await readFile(join(project, "notes.md"), "utf8")).toBe("keep me");
    expect(trashItemMock).not.toHaveBeenCalled();
  });

  it("hands the resolved path to shell.trashItem — never an in-place unlink", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "notes.md"), "x", "utf8");
    expect(await trashEntry(project, null, "notes.md")).toEqual({ ok: true });
    expect(trashItemMock).toHaveBeenCalledWith(join(project, "notes.md"));
  });

  it("reports a file that is not there without calling the Trash", async () => {
    const project = makeTempProjectDir();
    expect(await trashEntry(project, null, "ghost.md")).toEqual({
      ok: false,
      error: "File was not found",
    });
    expect(trashItemMock).not.toHaveBeenCalled();
  });

  it("surfaces a Trash failure rather than swallowing it", async () => {
    const project = makeTempProjectDir();
    await writeFile(join(project, "notes.md"), "x", "utf8");
    trashItemMock.mockRejectedValueOnce(new Error("Trash is full"));
    expect(await trashEntry(project, null, "notes.md")).toEqual({
      ok: false,
      error: "Trash is full",
    });
  });

  it("rejects an unsafe relPath before resolving anything", async () => {
    const project = makeTempProjectDir();
    expect(await trashEntry(project, null, "../outside.md")).toEqual({
      ok: false,
      error: "Invalid file path",
    });
    expect(trashItemMock).not.toHaveBeenCalled();
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

    expect(webContents.publish).toHaveBeenCalledWith("file-changed", {
      projectId: "proj-1",
      ticketId: null,
      relPath: "notes.md",
      source: "main",
      revision: expect.any(Number),
    } satisfies FileChangedEvent);
  });

  it("identifies a changed worktree document and reports its current revision", async () => {
    const project = makeTempProjectDir();
    const worktree = makeTempProjectDir();
    const filePath = join(worktree, "src", "app.ts");
    await mkdir(join(worktree, "src"));
    await writeFile(filePath, "export const answer = 42;", "utf8");
    const revision = (await stat(filePath)).mtimeMs;
    const manager = new FileWatchManager(250);
    const webContents = makeWebContents();
    manager.watch(
      webContents as never,
      "proj-1",
      "ticket-1",
      "src/app.ts",
      "worktree",
      dirname(filePath),
      basename(filePath),
      project,
    );

    vi.useFakeTimers();
    watchCalls[0]?.cb("change", "app.ts");
    vi.advanceTimersByTime(250);

    expect(webContents.publish).toHaveBeenCalledWith("file-changed", {
      projectId: "proj-1",
      ticketId: "ticket-1",
      relPath: "src/app.ts",
      source: "worktree",
      revision,
    } satisfies FileChangedEvent);
  });

  it("reports a null revision when the watched file was deleted before delivery", async () => {
    const project = makeTempProjectDir();
    const manager = new FileWatchManager(250);
    const webContents = makeWebContents();
    await watchFile(manager, webContents, project);

    vi.useFakeTimers();
    rmSync(join(project, "notes.md"));
    watchCalls[0]?.cb("rename", "notes.md");
    vi.advanceTimersByTime(250);

    expect(webContents.publish).toHaveBeenCalledWith("file-changed", {
      projectId: "proj-1",
      ticketId: null,
      relPath: "notes.md",
      source: "main",
      revision: null,
    } satisfies FileChangedEvent);
  });

  it("reports the replacement revision after an atomic file save", async () => {
    const project = makeTempProjectDir();
    const manager = new FileWatchManager(250);
    const webContents = makeWebContents();
    await watchFile(manager, webContents, project);
    const filePath = join(project, "notes.md");
    const oldRevision = (await stat(filePath)).mtimeMs;
    const replacementPath = join(project, "notes.md.tmp");
    await writeFile(replacementPath, "replacement", "utf8");
    await utimes(replacementPath, oldRevision / 1000 + 10, oldRevision / 1000 + 10);
    await rename(replacementPath, filePath);
    const revision = (await stat(filePath)).mtimeMs;

    vi.useFakeTimers();
    watchCalls[0]?.cb("rename", "notes.md");
    vi.advanceTimersByTime(250);

    expect(revision).not.toBe(oldRevision);
    expect(webContents.publish).toHaveBeenCalledWith("file-changed", {
      projectId: "proj-1",
      ticketId: null,
      relPath: "notes.md",
      source: "main",
      revision,
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

    expect(webContents.publish).not.toHaveBeenCalled();
  });

  it("broadcasts conservatively when the platform reports a null filename", async () => {
    const project = makeTempProjectDir();
    const manager = new FileWatchManager(250);
    const webContents = makeWebContents();
    await watchFile(manager, webContents, project);

    vi.useFakeTimers();
    watchCalls[0]?.cb("rename", null);
    vi.advanceTimersByTime(250);

    expect(webContents.publish).toHaveBeenCalledTimes(1);
  });

  it("does not broadcast before the debounce window elapses", async () => {
    const project = makeTempProjectDir();
    const manager = new FileWatchManager(250);
    const webContents = makeWebContents();
    await watchFile(manager, webContents, project);

    vi.useFakeTimers();
    watchCalls[0]?.cb("change", "notes.md");
    vi.advanceTimersByTime(200);
    expect(webContents.publish).not.toHaveBeenCalled();
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
    expect(webContents.publish).not.toHaveBeenCalled();
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

  it("keeps the watcher alive when one of two holders unwatches", async () => {
    const project = makeTempProjectDir();
    const manager = new FileWatchManager(250);
    const webContents = makeWebContents();
    await watchFile(manager, webContents, project);
    await watchFile(manager, webContents, project);
    expect(watchMock).toHaveBeenCalledTimes(1);

    manager.unwatch(webContents as never, "proj-1", "ticket-1", "notes.md");
    expect(watchCalls[0]?.watcher.close).not.toHaveBeenCalled();

    // The remaining holder still receives broadcasts.
    vi.useFakeTimers();
    watchCalls[0]?.cb("change", "notes.md");
    vi.advanceTimersByTime(250);
    expect(webContents.publish).toHaveBeenCalledWith("file-changed", {
      projectId: "proj-1",
      ticketId: null,
      relPath: "notes.md",
      source: "main",
      revision: expect.any(Number),
    } satisfies FileChangedEvent);
  });

  it("tears down only after the last of two holders unwatches", async () => {
    const project = makeTempProjectDir();
    const manager = new FileWatchManager(250);
    const webContents = makeWebContents();
    await watchFile(manager, webContents, project);
    await watchFile(manager, webContents, project);

    manager.unwatch(webContents as never, "proj-1", "ticket-1", "notes.md");
    expect(watchCalls[0]?.watcher.close).not.toHaveBeenCalled();

    vi.useFakeTimers();
    watchCalls[0]?.cb("change", "notes.md");
    manager.unwatch(webContents as never, "proj-1", "ticket-1", "notes.md");
    vi.advanceTimersByTime(1000);

    expect(watchCalls[0]?.watcher.close).toHaveBeenCalledTimes(1);
    expect(webContents.publish).not.toHaveBeenCalled();
  });

  it("unwatching a key that was never watched is a harmless no-op", () => {
    const manager = new FileWatchManager();
    expect(() =>
      manager.unwatch(makeWebContents() as never, "proj-1", "ticket-1", "never.md"),
    ).not.toThrow();
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

    expect(webContents.publish).toHaveBeenCalledWith("file-changed", {
      projectId: "proj-1",
      ticketId: null,
      relPath: "notes.md",
      source: "main",
      revision: expect.any(Number),
    } satisfies FileChangedEvent);
  });

  it("sends one final broadcast when the re-arm itself throws, instead of going silent", async () => {
    const project = makeTempProjectDir();
    const manager = new FileWatchManager(0);
    const webContents = makeWebContents();
    await watchFile(manager, webContents, project);

    // The dir is still there, so the re-arm takes the synchronous rewire path —
    // but arming fails outright (fd exhaustion). Torn down either way, the
    // subscription owes the tab the same nudge the retry-exhausted path sends.
    watchMock.mockImplementationOnce(() => {
      throw new Error("EMFILE: too many open files");
    });
    watchCalls[0]?.watcher.emitError(new Error("boom"));

    // The file outlived the watcher, so `revision` reads like ordinary news
    // (issue #134): only `final` tells the holders their watch is gone.
    expect(webContents.publish).toHaveBeenCalledWith("file-changed", {
      projectId: "proj-1",
      ticketId: null,
      relPath: "notes.md",
      source: "main",
      revision: expect.any(Number),
      final: true,
    } satisfies FileChangedEvent);
    // Torn down: a subsequent unwatch is a harmless no-op.
    expect(() =>
      manager.unwatch(webContents as never, "proj-1", "ticket-1", "notes.md"),
    ).not.toThrow();
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
    expect(webContents.publish).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(webContents.publish).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);

    expect(webContents.publish).toHaveBeenCalledWith("file-changed", {
      projectId: "proj-1",
      ticketId: null,
      relPath: "sub/notes.md",
      source: "main",
      revision: null,
      final: true,
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
    expect(webContents.publish).toHaveBeenCalledWith("file-changed", {
      projectId: "proj-1",
      ticketId: null,
      relPath: "sub/notes.md",
      source: "main",
      revision: null,
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
