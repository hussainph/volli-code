import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { compileIncludePattern, copyIncludedFiles, isIncluded } from "./include";

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `volli-${prefix}-`));
  dirs.push(dir);
  return dir;
}

function write(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function compileAll(lines: string[]) {
  return lines
    .map((line) => compileIncludePattern(line))
    .filter((p): p is NonNullable<typeof p> => p !== null);
}

function matches(lines: string[], path: string): boolean {
  return isIncluded(compileAll(lines), path);
}

describe("compileIncludePattern (parsing)", () => {
  it("ignores blank lines and comments", () => {
    expect(compileIncludePattern("")).toBeNull();
    expect(compileIncludePattern("   ")).toBeNull();
    expect(compileIncludePattern("# a comment")).toBeNull();
  });
});

describe("isIncluded (matching subset)", () => {
  it("matches an unanchored basename pattern at any depth", () => {
    expect(matches([".env*"], ".env")).toBe(true);
    expect(matches([".env*"], ".env.local")).toBe(true);
    expect(matches([".env*"], "config/.env.production")).toBe(true);
    expect(matches([".env*"], "envfile")).toBe(false);
  });

  it("anchors a pattern that contains a slash to the repo root", () => {
    expect(matches([".claude/settings.local.json"], ".claude/settings.local.json")).toBe(true);
    expect(matches([".claude/settings.local.json"], "sub/.claude/settings.local.json")).toBe(false);
  });

  it("anchors a leading-slash pattern and matches a directory's contents", () => {
    expect(matches(["/build/"], "build/app.js")).toBe(true);
    expect(matches(["/build/"], "src/build/app.js")).toBe(false);
    // A dir pattern needs something beneath it — the bare dir path doesn't match.
    expect(matches(["/build/"], "build")).toBe(false);
  });

  it("matches an unanchored directory pattern at any depth", () => {
    expect(matches(["node_modules/"], "node_modules/pkg/index.js")).toBe(true);
    expect(matches(["node_modules/"], "packages/a/node_modules/pkg/x")).toBe(true);
  });

  it("supports ? and * within a single segment, and a doubled star across segments", () => {
    expect(matches(["file?.txt"], "fileA.txt")).toBe(true);
    expect(matches(["file?.txt"], "fileAB.txt")).toBe(false);
    expect(matches(["*.log"], "deep/dir/error.log")).toBe(true);
    expect(matches(["a/**/z"], "a/b/c/z")).toBe(true);
    expect(matches(["a/**/z"], "a/z")).toBe(true);
  });

  it("applies last-match-wins so a later ! negation re-excludes", () => {
    expect(matches([".env*", "!.env.local"], ".env.local")).toBe(false);
    expect(matches([".env*", "!.env.local"], ".env")).toBe(true);
    // Order matters: a positive after a negation re-includes.
    expect(matches(["!.env.local", ".env*"], ".env.local")).toBe(true);
  });
});

describe("copyIncludedFiles", () => {
  it("copies the built-in defaults even with no .worktreeinclude file", () => {
    const project = tempDir("proj");
    const worktree = tempDir("wt");
    write(project, ".env", "SECRET=1");
    write(project, ".claude/settings.local.json", "{}");
    write(project, "README.md", "tracked");

    const { copied } = copyIncludedFiles(project, worktree);

    expect(copied.toSorted()).toEqual([".claude/settings.local.json", ".env"]);
    expect(readFileSync(join(worktree, ".env"), "utf8")).toBe("SECRET=1");
    // A non-matched file is never transported.
    expect(copied).not.toContain("README.md");
  });

  it("honors file includes and a ! negation that suppresses a default", () => {
    const project = tempDir("proj");
    const worktree = tempDir("wt");
    write(project, ".env", "A");
    write(project, ".env.local", "B");
    write(project, "config/local.ini", "C");
    write(project, ".worktreeinclude", "config/\n!.env.local\n");

    const { copied } = copyIncludedFiles(project, worktree);

    expect(copied.toSorted()).toEqual([".env", "config/local.ini"]);
    expect(copied).not.toContain(".env.local"); // default suppressed by the ! line
  });

  it("never overwrites an existing worktree file (covers tracked files)", () => {
    const project = tempDir("proj");
    const worktree = tempDir("wt");
    write(project, ".worktreeinclude", "src/\n");
    write(project, "src/keep.ts", "MAIN version");
    write(project, "src/new.ts", "brand new");
    // `git worktree add` already materialized the tracked file:
    write(worktree, "src/keep.ts", "WORKTREE version");

    const { copied } = copyIncludedFiles(project, worktree);

    expect(copied).toEqual(["src/new.ts"]);
    expect(readFileSync(join(worktree, "src/keep.ts"), "utf8")).toBe("WORKTREE version");
  });

  it("copies a symlink AS a symlink, never following it outside the root", () => {
    const project = tempDir("proj");
    const worktree = tempDir("wt");
    const outside = tempDir("outside");
    write(outside, "secret.txt", "TOP SECRET");
    symlinkSync(join(outside, "secret.txt"), join(project, "link.txt"));
    write(project, ".worktreeinclude", "link.txt\n");

    const { copied } = copyIncludedFiles(project, worktree);

    expect(copied).toEqual(["link.txt"]);
    const dest = join(worktree, "link.txt");
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(readlinkSync(dest)).toBe(join(outside, "secret.txt"));
  });

  it("skips a destination that is already a (dangling) symlink instead of throwing EEXIST", () => {
    const project = tempDir("proj");
    const worktree = tempDir("wt");
    const outside = tempDir("outside");
    write(outside, "secret.txt", "S");
    symlinkSync(join(outside, "secret.txt"), join(project, "link.txt"));
    write(project, ".worktreeinclude", "link.txt\n");
    // git already materialized link.txt in the worktree as a symlink whose
    // target doesn't exist yet — existsSync follows it and reads "absent", so
    // the copy's symlinkSync would throw EEXIST and fail the ensure (fix 4).
    symlinkSync(join(worktree, "does-not-exist"), join(worktree, "link.txt"));

    const { copied } = copyIncludedFiles(project, worktree);

    expect(copied).not.toContain("link.txt"); // never overwritten, never threw
    expect(readlinkSync(join(worktree, "link.txt"))).toBe(join(worktree, "does-not-exist"));
  });

  it("cannot transport a file from outside the project root via a ../ pattern", () => {
    const project = tempDir("proj");
    const worktree = tempDir("wt");
    const outside = tempDir("outside");
    write(outside, "secret.txt", "TOP SECRET");
    write(project, ".worktreeinclude", "../outside/secret.txt\n");

    const { copied } = copyIncludedFiles(project, worktree);

    // The walk never leaves the project root, so nothing outside is matched.
    expect(copied).toEqual([]);
  });
});
