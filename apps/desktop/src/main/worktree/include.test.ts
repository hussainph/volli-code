import {
  existsSync,
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

import {
  DEFAULT_PRUNED_DIRS,
  compileIncludePattern,
  copyIncludedFiles,
  isIncluded,
} from "./include";

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
  it("copies the built-in defaults even with no .worktreeinclude file", async () => {
    const project = tempDir("proj");
    const worktree = tempDir("wt");
    write(project, ".env", "SECRET=1");
    write(project, ".claude/settings.local.json", "{}");
    write(project, "README.md", "tracked");

    const { copied } = await copyIncludedFiles(project, worktree);

    expect(copied.toSorted()).toEqual([".claude/settings.local.json", ".env"]);
    expect(readFileSync(join(worktree, ".env"), "utf8")).toBe("SECRET=1");
    // A non-matched file is never transported.
    expect(copied).not.toContain("README.md");
  });

  it("honors file includes and a ! negation that suppresses a default", async () => {
    const project = tempDir("proj");
    const worktree = tempDir("wt");
    write(project, ".env", "A");
    write(project, ".env.local", "B");
    write(project, "config/local.ini", "C");
    write(project, ".worktreeinclude", "config/\n!.env.local\n");

    const { copied } = await copyIncludedFiles(project, worktree);

    expect(copied.toSorted()).toEqual([".env", "config/local.ini"]);
    expect(copied).not.toContain(".env.local"); // default suppressed by the ! line
  });

  it("never overwrites an existing worktree file (covers tracked files)", async () => {
    const project = tempDir("proj");
    const worktree = tempDir("wt");
    write(project, ".worktreeinclude", "src/\n");
    write(project, "src/keep.ts", "MAIN version");
    write(project, "src/new.ts", "brand new");
    // `git worktree add` already materialized the tracked file:
    write(worktree, "src/keep.ts", "WORKTREE version");

    const { copied } = await copyIncludedFiles(project, worktree);

    expect(copied).toEqual(["src/new.ts"]);
    expect(readFileSync(join(worktree, "src/keep.ts"), "utf8")).toBe("WORKTREE version");
  });

  it("copies a symlink AS a symlink, never following it outside the root", async () => {
    const project = tempDir("proj");
    const worktree = tempDir("wt");
    const outside = tempDir("outside");
    write(outside, "secret.txt", "TOP SECRET");
    symlinkSync(join(outside, "secret.txt"), join(project, "link.txt"));
    write(project, ".worktreeinclude", "link.txt\n");

    const { copied } = await copyIncludedFiles(project, worktree);

    expect(copied).toEqual(["link.txt"]);
    const dest = join(worktree, "link.txt");
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(readlinkSync(dest)).toBe(join(outside, "secret.txt"));
  });

  it("skips a destination that is already a (dangling) symlink instead of throwing EEXIST", async () => {
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

    const { copied } = await copyIncludedFiles(project, worktree);

    expect(copied).not.toContain("link.txt"); // never overwritten, never threw
    expect(readlinkSync(join(worktree, "link.txt"))).toBe(join(worktree, "does-not-exist"));
  });

  it("never descends into node_modules — the walk's dominant cost on a JS checkout", async () => {
    const project = tempDir("proj");
    const worktree = tempDir("wt");
    write(project, ".env", "SECRET=1");
    // Packages ship `.env.example` files of their own, and `.env*` is an
    // unanchored default, so the old whole-tree walk did not merely COST the
    // seconds VC-16 reported — it also transported other people's samples into
    // the agent's checkout.
    write(project, "node_modules/some-pkg/.env.example", "NOT_MINE=1");

    const { copied } = await copyIncludedFiles(project, worktree);

    expect(copied).toEqual([".env"]);
    expect(existsSync(join(worktree, "node_modules"))).toBe(false);
  });

  it("never descends into another ecosystem's dependency or build tree either", async () => {
    const project = tempDir("proj");
    const worktree = tempDir("wt");
    write(project, ".env", "SECRET=1");
    // The same walk cost and the same `.env*` correctness trap as node_modules,
    // on the checkouts whose ecosystem nobody measured here (VC-160): a Python
    // virtualenv, a Rust/Maven target dir, Go's vendored source, bundler's gems.
    write(project, ".venv/lib/python3.12/site-packages/pkg/.env.example", "NOT_MINE=1");
    write(project, "venv/lib/pkg/.env", "NOT_MINE=1");
    write(project, "__pycache__/module.cpython-312.pyc", "\0");
    write(project, ".tox/py312/bin/.env", "NOT_MINE=1");
    write(project, "target/debug/build/.env", "NOT_MINE=1");
    write(project, "vendor/github.com/pkg/.env", "NOT_MINE=1");
    write(project, ".gradle/8.5/checksums/.env", "NOT_MINE=1");
    write(project, ".bundle/gems/rails/.env", "NOT_MINE=1");

    const { copied } = await copyIncludedFiles(project, worktree);

    expect(copied).toEqual([".env"]);
    // Every name on the list, not the subset that happened to get fixtures.
    for (const pruned of DEFAULT_PRUNED_DIRS) {
      expect(existsSync(join(worktree, pruned))).toBe(false);
    }
  });

  it("descends into a pruned directory a .worktreeinclude line asks for by name", async () => {
    const project = tempDir("proj");
    const worktree = tempDir("wt");
    write(project, ".worktreeinclude", "node_modules/.bin/\n");
    write(project, "node_modules/.bin/local-tool", "#!/bin/sh\n");
    write(project, "node_modules/some-pkg/index.js", "x");

    const { copied } = await copyIncludedFiles(project, worktree);

    // The named path is reachable again; the rest of the directory is not
    // suddenly walked back in as a side effect of asking for one corner.
    expect(copied).toEqual(["node_modules/.bin/local-tool"]);
  });

  it.each([...DEFAULT_PRUNED_DIRS])(
    "honors that escape hatch for %s, as for every name on the widened prune list",
    async (pruned) => {
      const project = tempDir("proj");
      const worktree = tempDir("wt");
      // Real, uncommitted local config genuinely can live under one of these: a
      // `.pth` or hand-edited activate hook in a virtualenv, or `.bundle/config`
      // holding a private gem server's credentials — the stated exception to the
      // membership rule, and the reason this hatch has to work for EVERY name
      // rather than the one that happened to get a fixture.
      write(project, ".worktreeinclude", `${pruned}/keep/mine.local\n`);
      write(project, `${pruned}/keep/mine.local`, "API=1\n");
      write(project, `${pruned}/lib/theirs.cfg`, "NOT_MINE=1");

      const { copied } = await copyIncludedFiles(project, worktree);

      expect(copied).toEqual([`${pruned}/keep/mine.local`]);
    },
  );

  it("keeps the prune when the only mention of the directory is a negation", async () => {
    const project = tempDir("proj");
    const worktree = tempDir("wt");
    // `!node_modules/` can only ever EXCLUDE, so honoring it as a request to
    // descend would make writing it slower than leaving it out — the one
    // reading of the line that is never what the author meant.
    write(project, ".worktreeinclude", "!node_modules/\n");
    write(project, ".env", "SECRET=1");
    write(project, "node_modules/some-pkg/.env", "NOT_MINE=1");

    const { copied } = await copyIncludedFiles(project, worktree);

    expect(copied).toEqual([".env"]);
  });

  it("yields to the event loop mid-walk instead of starving the main process", async () => {
    const project = tempDir("proj");
    const worktree = tempDir("wt");
    // A wide tree, standing in for a real Main checkout's node_modules: the
    // walk visits every directory (unanchored patterns are depth-agnostic),
    // and doing that synchronously is VC-16's rainbow wheel — the whole app
    // freezes because Electron main cannot serve events while it runs.
    for (let i = 0; i < 200; i++) write(project, `pkg/dir-${i}/index.js`, "x");
    write(project, ".env", "SECRET=1");

    let turned = false;
    setImmediate(() => {
      turned = true;
    });
    const { copied } = await copyIncludedFiles(project, worktree);

    expect(copied).toContain(".env");
    // The macrotask above must have run BEFORE the walk finished — a fully
    // synchronous walk completes without ever handing the loop back.
    expect(turned).toBe(true);
  });

  it("cannot transport a file from outside the project root via a ../ pattern", async () => {
    const project = tempDir("proj");
    const worktree = tempDir("wt");
    const outside = tempDir("outside");
    write(outside, "secret.txt", "TOP SECRET");
    write(project, ".worktreeinclude", "../outside/secret.txt\n");

    const { copied } = await copyIncludedFiles(project, worktree);

    // The walk never leaves the project root, so nothing outside is matched.
    expect(copied).toEqual([]);
  });
});
