/**
 * Find-across-files, against the real ripgrep binary in real temp checkouts
 * (VC-193, plan §4.7) — the same posture as `volli-fs.test.ts`'s file suites,
 * which run against real directories, real symlinks and real `git`.
 *
 * A mocked rg would test the parser and nothing else: every claim this feature
 * makes — gitignore is respected, node_modules is never walked, hidden files
 * are searched but `.git` is not — is a claim about how the binary was invoked,
 * and only the binary can answer it.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  parseRgLine,
  previewForMatch,
  resolveRgPath,
  searchArgs,
  searchFiles,
  unpackedBinaryPath,
  SEARCH_MATCH_CAP,
  SEARCH_PREVIEW_CHARS,
} from "./file-search";

const tempDirs: string[] = [];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "volli-search-test-"));
  tempDirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function write(root: string, relPath: string, content: string): void {
  const path = join(root, relPath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

/** The relPaths a run reported, for an assertion that does not care about order. */
function pathsOf(run: Awaited<ReturnType<typeof searchFiles>>): string[] {
  return run.ok ? run.value.files.map((file) => file.relPath).toSorted() : [];
}

/** One rg `--json` match frame, as the stub below prints them. */
function matchFrame(line: number): string {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: "./src/app.ts" },
      lines: { text: "const needle = 1;\n" },
      line_number: line,
      submatches: [{ start: 6, end: 12 }],
    },
  });
}

/**
 * A stand-in `rg` that writes `frames`, then blocks until it is killed.
 *
 * THE ONE PLACE THE REAL BINARY CANNOT BE USED. The time budget is a claim
 * about this module's own timer and kill, not about ripgrep, and pointing a
 * short budget at a real rg is a coin toss: rg can finish a small checkout —
 * matches, exit and all — before the event loop reaches its timers phase, and
 * the run then ends at the MATCH cap instead. That is exactly how the earlier
 * version of this test failed under a loaded full-suite run. A child that never
 * exits on its own removes the coin: only the budget can end this search, and a
 * regressed kill fails the test loudly instead of passing for the wrong reason.
 *
 * Three details are load-bearing:
 *
 *  - `cat` rather than a `printf` builtin — a shell's own stdout is block
 *    buffered into a pipe and SIGKILL throws that buffer away, so the frames
 *    have to be written by a process that exits and flushes.
 *  - `exec sleep` — without it the shell forks `sleep`, which inherits the
 *    stdout pipe and holds it open after the shell is killed, so `close` never
 *    fires and the search never settles.
 *  - the warm-up run — the FIRST exec of a newly written file costs hundreds of
 *    milliseconds on macOS (the kernel validates a binary it has not seen). Left
 *    inside the measured window that delay races the budget and the stub arrives
 *    after its own deadline; spending it up front leaves the budget measuring
 *    what it is meant to measure.
 */
function stubRg(frames: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "volli-search-stub-"));
  tempDirs.push(dir);
  const path = join(dir, "rg");
  writeFileSync(join(dir, "frames"), frames.map((frame) => `${frame}\n`).join(""), "utf8");
  writeFileSync(
    path,
    `#!/bin/sh\n[ "$1" = "--warm" ] && exit 0\ncat "$(dirname "$0")/frames"\nexec sleep 30\n`,
    "utf8",
  );
  chmodSync(path, 0o755);
  execFileSync(path, ["--warm"]);
  return path;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("resolveRgPath", () => {
  // Two lookups, because the two environments this app runs in resolve packages
  // differently (see the function's own note). This asserts only that ONE of
  // them answers with a runnable binary on the machine running the test — which
  // is the property every search below depends on.
  it("finds a runnable ripgrep on this machine", async () => {
    const path = await resolveRgPath();

    expect(path.endsWith(process.platform === "win32" ? "rg.exe" : "rg")).toBe(true);
    expect(execFileSync(path, ["--version"], { encoding: "utf8" })).toContain("ripgrep");
  });
});

describe("unpackedBinaryPath", () => {
  // The bug this exists for is invisible in development and fatal in a
  // release: Electron resolves a path INSIDE `app.asar` for a binary
  // electron-builder unpacked beside it, and `spawn` on that path fails with
  // ENOTDIR (Electron supports only `execFile` inside an archive).
  it("takes a packaged binary out of the archive", () => {
    const packaged = ["", "Applications", "V.app", "Contents", "Resources", "app.asar"].join(sep);
    const rg = [packaged, "node_modules", "@vscode", "ripgrep-darwin-arm64", "bin", "rg"].join(sep);

    expect(unpackedBinaryPath(rg)).toBe(rg.replace("app.asar", "app.asar.unpacked"));
  });

  it("leaves a development path exactly as it was", () => {
    const dev = ["", "repo", "node_modules", "@vscode", "ripgrep-darwin-arm64", "bin", "rg"].join(
      sep,
    );

    expect(unpackedBinaryPath(dev)).toBe(dev);
  });

  it("rewrites the archive segment only, never a directory that merely reads like one", () => {
    const lookalike = ["", "repo", "app.asarium", "bin", "rg"].join(sep);

    expect(unpackedBinaryPath(lookalike)).toBe(lookalike);
  });
});

describe("searchArgs", () => {
  it("passes the query as a literal, after the argument terminator", () => {
    const args = searchArgs("foo(bar)");

    expect(args).toContain("--fixed-strings");
    // The `--` matters: a query that starts with a dash is a query, not a flag.
    // The directory after it matters too — without a path, rg waits on the
    // stdin pipe a spawned child always has.
    expect(args.slice(-3)).toEqual(["--", "foo(bar)", "./"]);
  });

  it("searches hidden files but never .git or node_modules", () => {
    const args = searchArgs("needle");

    expect(args).toContain("--hidden");
    expect(args).toContain("!.git");
    expect(args).toContain("!node_modules");
  });

  it("leaves gitignore handling at ripgrep's default rather than flagging it either way", () => {
    const args = searchArgs("needle");

    expect(args).not.toContain("--no-ignore");
    expect(args).not.toContain("--no-ignore-vcs");
    expect(args).not.toContain("-u");
  });

  it("never follows a symlink out of the checkout", () => {
    expect(searchArgs("needle")).toContain("--no-follow");
  });
});

describe("parseRgLine", () => {
  const match = JSON.stringify({
    type: "match",
    data: {
      path: { text: "src/app.ts" },
      lines: { text: "const needle = 1;\n" },
      line_number: 12,
      submatches: [{ match: { text: "needle" }, start: 6, end: 12 }],
    },
  });

  it("reads a match event", () => {
    expect(parseRgLine(match)).toEqual({
      relPath: "src/app.ts",
      line: 12,
      text: "const needle = 1;\n",
      byteStart: 6,
      byteEnd: 12,
    });
  });

  it("skips the frames a search has no use for", () => {
    expect(parseRgLine("")).toBeNull();
    expect(parseRgLine("{not json")).toBeNull();
    expect(parseRgLine("null")).toBeNull();
    expect(
      parseRgLine(JSON.stringify({ type: "begin", data: { path: { text: "a" } } })),
    ).toBeNull();
    expect(parseRgLine(JSON.stringify({ type: "match" }))).toBeNull();
  });

  it("skips a match whose path or line was not valid UTF-8", () => {
    const bytes = JSON.stringify({
      type: "match",
      data: {
        path: { bytes: "3q2+7w==" },
        lines: { text: "x\n" },
        line_number: 1,
        submatches: [{ start: 0, end: 1 }],
      },
    });
    expect(parseRgLine(bytes)).toBeNull();
  });

  it("skips a match with no usable submatch offsets", () => {
    const noSubmatch = {
      type: "match",
      data: {
        path: { text: "a.ts" },
        lines: { text: "x\n" },
        line_number: 1,
        submatches: [] as unknown[],
      },
    };
    expect(parseRgLine(JSON.stringify(noSubmatch))).toBeNull();
    expect(
      parseRgLine(
        JSON.stringify({
          ...noSubmatch,
          data: { ...noSubmatch.data, submatches: [{ start: "0", end: 1 }] },
        }),
      ),
    ).toBeNull();
  });
});

describe("previewForMatch", () => {
  it("keeps a short line whole, without its trailing newline", () => {
    expect(previewForMatch("const needle = 1;\n", 6, 12)).toEqual({
      preview: "const needle = 1;",
      start: 6,
      end: 12,
    });
  });

  it("windows a minified line around the match and moves the offsets with it", () => {
    const filler = "x".repeat(2_000);
    const line = `${filler}needle${filler}`;
    const result = previewForMatch(line, filler.length, filler.length + 6);

    expect(result.preview.length).toBeLessThanOrEqual(SEARCH_PREVIEW_CHARS + 2);
    expect(result.preview.startsWith("…")).toBe(true);
    expect(result.preview.endsWith("…")).toBe(true);
    // The whole point: the offsets still name the match inside what is drawn.
    expect(result.preview.slice(result.start, result.end)).toBe("needle");
  });

  it("keeps a long line's leading match flush against the start", () => {
    const line = `needle${"x".repeat(2_000)}`;
    const result = previewForMatch(line, 0, 6);

    expect(result.preview.startsWith("needle")).toBe(true);
    expect(result.preview.slice(result.start, result.end)).toBe("needle");
  });
});

describe("searchFiles", () => {
  it("finds literal text and reports the line, column and preview a click needs", async () => {
    const root = makeRepo();
    write(root, "src/app.ts", "const first = 1;\nconst needle = 2;\n");

    const run = await searchFiles({ root, query: "needle" });

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.value.matches).toBe(1);
    expect(run.value.limit).toBe("none");
    expect(run.value.files).toEqual([
      {
        relPath: "src/app.ts",
        matches: [{ line: 2, column: 7, preview: "const needle = 2;", start: 6, end: 12 }],
      },
    ]);
  });

  it("groups every match of one file under that file", async () => {
    const root = makeRepo();
    write(root, "a.ts", "needle\nother\nneedle\n");
    write(root, "b.ts", "needle\n");

    const run = await searchFiles({ root, query: "needle" });

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.value.files).toHaveLength(2);
    expect(run.value.matches).toBe(3);
    const a = run.value.files.find((file) => file.relPath === "a.ts");
    expect(a?.matches.map((match) => match.line)).toEqual([1, 3]);
  });

  it("counts a column in characters, not bytes, so a highlight lands on the word", async () => {
    const root = makeRepo();
    write(root, "unicode.ts", "const café = needle;\n");

    const run = await searchFiles({ root, query: "needle" });

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const match = run.value.files[0]?.matches[0];
    // "const café = " is 13 characters (and 14 bytes) — 1-based column 14.
    expect(match?.column).toBe(14);
    expect(match?.preview.slice(match.start, match.end)).toBe("needle");
  });

  it("is literal: a query with regex metacharacters means itself", async () => {
    const root = makeRepo();
    write(root, "a.ts", "foo(bar)\nfooXbar\n");

    const run = await searchFiles({ root, query: "foo(bar)" });

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.value.matches).toBe(1);
    expect(run.value.files[0]?.matches[0]?.line).toBe(1);
  });

  it("is smart-case: lower-case looks anywhere, a capital means it", async () => {
    const root = makeRepo();
    write(root, "a.ts", "Needle\nneedle\n");

    const loose = await searchFiles({ root, query: "needle" });
    const exact = await searchFiles({ root, query: "Needle" });

    expect(loose.ok && loose.value.matches).toBe(2);
    expect(exact.ok && exact.value.matches).toBe(1);
  });

  it("respects .gitignore", async () => {
    const root = makeRepo();
    write(root, ".gitignore", "build/\n");
    write(root, "kept.ts", "needle\n");
    write(root, "build/generated.ts", "needle\n");

    expect(pathsOf(await searchFiles({ root, query: "needle" }))).toEqual(["kept.ts"]);
  });

  it("never searches node_modules, even where nothing ignores it", async () => {
    const root = makeRepo();
    write(root, "kept.ts", "needle\n");
    write(root, "node_modules/left-pad/index.js", "needle\n");

    expect(pathsOf(await searchFiles({ root, query: "needle" }))).toEqual(["kept.ts"]);
  });

  it("searches hidden files but not .git's own store", async () => {
    const root = makeRepo();
    write(root, ".github/workflows/ci.yml", "needle\n");
    write(root, ".git/volli-probe", "needle\n");

    expect(pathsOf(await searchFiles({ root, query: "needle" }))).toEqual([
      ".github/workflows/ci.yml",
    ]);
  });

  it("answers an empty or whitespace query with nothing, without running anything", async () => {
    const root = makeRepo();
    write(root, "a.ts", "needle\n");

    // A binary that does not exist: reaching it at all would fail the run, so a
    // successful empty answer is the proof that nothing was spawned.
    const empty = await searchFiles({ root, query: "   ", rgPath: join(root, "no-such-rg") });

    expect(empty).toEqual({ ok: true, value: { files: [], matches: 0, limit: "none" } });
  });

  it("reports no matches as an empty, uncapped answer rather than a failure", async () => {
    const root = makeRepo();
    write(root, "a.ts", "haystack\n");

    expect(await searchFiles({ root, query: "needle" })).toEqual({
      ok: true,
      value: { files: [], matches: 0, limit: "none" },
    });
  });

  it("caps the match count and says so", async () => {
    const root = makeRepo();
    write(root, "many.ts", "needle\n".repeat(SEARCH_MATCH_CAP + 200));

    const run = await searchFiles({ root, query: "needle" });

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.value.matches).toBe(SEARCH_MATCH_CAP);
    expect(run.value.limit).toBe("matches");
    // Honest, not empty: the matches that DID arrive are still the answer.
    expect(run.value.files[0]?.matches).toHaveLength(SEARCH_MATCH_CAP);
  });

  it("caps the search time, keeps what had arrived, and names THAT cap", async () => {
    const root = makeRepo();

    const run = await searchFiles({
      root,
      query: "needle",
      rgPath: stubRg([matchFrame(1), matchFrame(2)]),
      timeBudgetMs: 500,
    });

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.value.limit).toBe("time");
    // Honest, not empty: the matches that DID arrive are still the answer, and
    // `limit` is the only thing saying the list is not the whole of it.
    expect(run.value.matches).toBe(2);
    expect(run.value.files).toEqual([
      {
        relPath: "src/app.ts",
        matches: [
          { line: 1, column: 7, preview: "const needle = 1;", start: 6, end: 12 },
          { line: 2, column: 7, preview: "const needle = 1;", start: 6, end: 12 },
        ],
      },
    ]);
  });

  it("spawns the binary rather than a shell, so a query can never be a command", async () => {
    const root = makeRepo();
    write(root, "a.ts", "needle\n");
    write(root, "marker.txt", "untouched\n");

    // Shell metacharacters in the query: under a shell this would run `touch`
    // and redirect. Spawned directly with the query after `--`, it is text.
    const run = await searchFiles({ root, query: "needle; touch pwned > marker.txt #" });

    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.value.matches).toBe(0);
    expect(existsSync(join(root, "pwned"))).toBe(false);
    expect(readFileSync(join(root, "marker.txt"), "utf8")).toBe("untouched\n");
  });

  it("reports an unavailable engine rather than pretending there were no matches", async () => {
    const root = makeRepo();
    write(root, "a.ts", "needle\n");

    const run = await searchFiles({ root, query: "needle", rgPath: join(root, "no-such-rg") });

    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.error).toContain("Search is unavailable");
  });

  it("reports ripgrep's own failure text when it refuses to run", async () => {
    const run = await searchFiles({
      root: join(mkdtempSync(join(tmpdir(), "volli-search-gone-")), "not-a-directory"),
      query: "needle",
    });

    expect(run.ok).toBe(false);
  });
});
