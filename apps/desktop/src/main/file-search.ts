/**
 * Find across files (docs/plans/file-editor-improvements.md §4.7) — the
 * main-process half.
 *
 * The engine is `@vscode/ripgrep`: the rg binary VS Code ships (MIT), which
 * this module locates ({@link resolveRgPath}) and drives, and which
 * already knows how to walk a checkout the way a developer expects — gitignore
 * rules honoured, binaries skipped, symlinks not followed. Nothing here
 * re-implements any of that. What this module owns is the four things a product
 * cannot inherit from a search tool:
 *
 *  1. **The root**, which is never a path the renderer handed over. It comes
 *     from `resolveFileScope`'s `{ projectId, ticketId }` pair in `volli-fs.ts`,
 *     the same seam a file READ resolves through, so Home searches the main
 *     checkout and a Ticket workspace searches its own worktree — and a click
 *     on a result can never open a file from the checkout you did not search.
 *  2. **The caps.** A search is an unbounded question asked of a directory an
 *     agent may be writing into. Both bounds are hard: {@link SEARCH_MATCH_CAP}
 *     matches, and {@link SEARCH_TIME_BUDGET_MS} of wall clock. Either one kills
 *     the process rather than letting main stream a repository into a rail.
 *  3. **Honesty about them**, the same posture as the 1 MiB read cap: the result
 *     says WHICH cap ended it (`limit`), so the page can say "the first 500
 *     matches" or "stopped after 5 seconds" instead of quietly presenting a
 *     truncated list as the whole answer.
 *  4. **A preview a rail can draw.** rg reports a matched line as it is on disk;
 *     a minified bundle's line is 400 KB of it. {@link previewForMatch} windows
 *     the line around the match and moves the offsets with it.
 *
 * FIND ONLY (v1). There is no replace here and no pattern syntax: the query is
 * passed with `--fixed-strings`, so what a person typed is what is looked for,
 * and it travels as one `execFile`-style argument — never through a shell.
 *
 * `.volli/**` is deliberately NOT force-included the way the file index
 * force-includes `.volli/artifacts/`. The rule for search is the one the plan
 * states — gitignore decides — and `.volli` self-ignores; a second rule here
 * would make "respect .gitignore" mean two different things on two surfaces.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { sep } from "node:path";
import { errorMessage } from "@volli/shared";

import type { FileSearchFile, FileSearchLimit, FileSearchMatch } from "../ipc/contract";

/** Hard cap on matches carried back (decision: the twin of the 1 MiB read cap). */
export const SEARCH_MATCH_CAP = 500;

/** Hard wall-clock budget for one search; the process is killed at it. */
export const SEARCH_TIME_BUDGET_MS = 5_000;

/** How much of a matched line a preview may carry before it is windowed. */
export const SEARCH_PREVIEW_CHARS = 240;

/** Leading context kept when a long line has to be windowed around its match. */
const PREVIEW_LEAD_CHARS = 40;

/** stdout bytes past which the search is abandoned — a guard for the pathological case. */
const SEARCH_OUTPUT_CAP_BYTES = 32 * 1024 * 1024;

/** The platform build `@vscode/ripgrep` would pick, and the file inside it. */
const RG_BINARY = process.platform === "win32" ? "rg.exe" : "rg";
const RG_PLATFORM_PACKAGE = `@vscode/ripgrep-${process.platform}-${process.arch}`;

/**
 * The real on-disk path of a binary `asarUnpack` put beside the archive.
 *
 * WHY A PACKAGED BUILD NEEDS THIS AND A DEVELOPMENT ONE DOES NOT. Electron
 * teaches `require`, `fs` and `execFile` to treat `app.asar` as a directory —
 * but NOT `spawn`, which its own documentation lists as unsupported for a
 * binary inside an archive ("only `execFile` is supported"). So the resolution
 * below answers with a path INSIDE `app.asar` even for a file electron-builder
 * unpacked to `app.asar.unpacked`, and spawning that path fails with `ENOTDIR`
 * — measured, in the packaged app, not deduced.
 *
 * Rewriting the one archive segment is the fix node-pty makes for its own
 * `spawn-helper` and VS Code makes for this very binary. It is a no-op
 * everywhere else: no development run or test has an `app.asar` segment, which
 * is exactly why the failure it prevents would have been invisible until a
 * release — `pnpm start` finds matches all day.
 */
export function unpackedBinaryPath(path: string): string {
  return path.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
}

/**
 * Where the rg binary is, found two ways because the two environments this app
 * runs in resolve packages differently. Exported so a test can assert that at
 * least one of them answers on the machine it is running on.
 *
 * 1. **The platform package, resolved as CommonJS.** `@vscode/ripgrep-<os>-<cpu>`
 *    is declared in this app's own `optionalDependencies` (electron-builder.yml
 *    explains why it must be), so it is a direct dependency here — and plain
 *    `require.resolve` is the lookup Electron's asar layer is known to handle,
 *    which an ESM `import()` from inside `app.asar` historically is not.
 * 2. **The package's own answer.** Where the platform build is only a
 *    TRANSITIVE optional dependency — CI on Linux, installing this same
 *    workspace — pnpm's strict layout puts it somewhere only `@vscode/ripgrep`
 *    can see, and its `rgPath` is that lookup.
 *
 * Either answer is then taken out of the archive ({@link unpackedBinaryPath}),
 * because what this module does with the path is spawn it.
 *
 * Both are lazy: this module is loaded during boot and a search may never be
 * run at all.
 */
export async function resolveRgPath(): Promise<string> {
  try {
    return unpackedBinaryPath(
      createRequire(import.meta.url).resolve(`${RG_PLATFORM_PACKAGE}/bin/${RG_BINARY}`),
    );
  } catch {
    const module = await import("@vscode/ripgrep");
    return unpackedBinaryPath(module.rgPath);
  }
}

/**
 * The exact argument vector one search runs with.
 *
 * Pure, and exported, because every decision that makes this search behave like
 * a developer's own `rg` is in this list, and a list is testable where a spawn
 * call is not:
 *
 *  - `--json` — the only output shape that carries line numbers AND match
 *    offsets. Anything else would have to be re-derived by string-matching the
 *    query against its own output.
 *  - `--fixed-strings` — v1 is find-only literal text (see the module header).
 *  - `--smart-case` — lower-case looks anywhere, a capital means it. The
 *    behaviour every search box in this class of tool has, and it needs no
 *    control on screen to explain it.
 *  - `--hidden` with an explicit `!.git` — `.github/workflows/ci.yml` is a file
 *    people search for; `.git`'s object store is not.
 *  - `!node_modules` — never searched, stated here rather than left to whatever
 *    the checkout's `.gitignore` happens to say (the plan's own words). It is
 *    also what keeps a fresh clone with no ignore file from walking an install.
 *  - `--no-follow`/`--no-messages`: a symlink out of the checkout is not part of
 *    it, and an unreadable directory is not news the rail can act on.
 *
 * gitignore handling is rg's DEFAULT and is deliberately not flagged either
 * way: the plan asks for exactly that behaviour.
 *
 * THE TRAILING `./` IS LOAD-BEARING. Given no path at all, rg decides between
 * the working directory and STDIN by inspecting stdin — and a spawned child's
 * stdin is a pipe nobody is going to write to, so the search would wait on it
 * forever. Naming the directory removes the guess; {@link stripPathPrefix} takes
 * the `./` back off the paths it prints.
 */
export function searchArgs(query: string): string[] {
  return [
    "--json",
    "--fixed-strings",
    "--smart-case",
    "--hidden",
    "--no-follow",
    "--no-messages",
    "--glob",
    "!.git",
    "--glob",
    "!node_modules",
    "--",
    query,
    "./",
  ];
}

/** `./src/app.ts` → `src/app.ts` — the spelling every other file channel uses. */
function stripPathPrefix(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

/** One rg `match` event, in the shape this module actually reads. */
interface RgMatchEvent {
  relPath: string;
  line: number;
  /** The matched line as rg read it, newline included. */
  text: string;
  /** Byte offsets of the first submatch within `text`. */
  byteStart: number;
  byteEnd: number;
}

/** Whether a value is a `{ text: string }` — rg's own "this was valid UTF-8" shape. */
function textOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const text = (value as { text?: unknown }).text;
  return typeof text === "string" ? text : null;
}

/**
 * One line of rg's `--json` stream, or `null` for every line this module has no
 * use for: `begin`/`end`/`summary` events, and any match whose path or line was
 * not valid UTF-8 (rg reports those as `{ bytes: "<base64>" }`, and a file whose
 * bytes are not text has nothing to show in a preview).
 *
 * Never throws. A malformed line is a line to skip, not a failed search — the
 * process is a stream, and one unparsable frame must not lose the matches that
 * already arrived.
 */
export function parseRgLine(line: string): RgMatchEvent | null {
  if (line === "") return null;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof event !== "object" || event === null) return null;
  const { type, data } = event as { type?: unknown; data?: unknown };
  if (type !== "match" || typeof data !== "object" || data === null) return null;
  const record = data as {
    path?: unknown;
    lines?: unknown;
    line_number?: unknown;
    submatches?: unknown;
  };
  const relPath = textOf(record.path);
  const text = textOf(record.lines);
  const lineNumber = record.line_number;
  if (relPath === null || text === null || typeof lineNumber !== "number") return null;
  if (!Array.isArray(record.submatches) || record.submatches.length === 0) return null;
  const [first] = record.submatches as { start?: unknown; end?: unknown }[];
  if (typeof first?.start !== "number" || typeof first.end !== "number") return null;
  return {
    relPath: stripPathPrefix(relPath),
    line: lineNumber,
    text,
    byteStart: first.start,
    byteEnd: first.end,
  };
}

/**
 * rg reports match offsets in BYTES into the matched line; a renderer needs
 * character offsets into a JavaScript string. The two agree until the line
 * holds a `é` or an emoji before the match, and then they do not — this is the
 * one conversion that keeps a highlight over the word it belongs to.
 */
function charOffset(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  return Buffer.from(text, "utf8").subarray(0, byteOffset).toString("utf8").length;
}

/**
 * The rail-sized preview of one matched line, and where the match sits in it.
 *
 * A matched line is shown whole when it is short enough to be one. When it is
 * not — a minified bundle, a base64 blob, a 4000-column data table — a window
 * is taken around the match instead, with a leading run of context so the match
 * is not flush against the left edge, and an ellipsis on each side that was cut.
 * The offsets travel with the window, because a highlight computed against the
 * original line would land in the wrong place the moment anything was trimmed.
 *
 * Trailing newline and carriage return are dropped first: they are rg's frame,
 * not part of the line.
 */
export function previewForMatch(
  rawText: string,
  charStart: number,
  charEnd: number,
): { preview: string; start: number; end: number } {
  const text = rawText.replace(/\r?\n$/, "");
  const start = Math.min(charStart, text.length);
  const end = Math.min(Math.max(charEnd, start), text.length);
  if (text.length <= SEARCH_PREVIEW_CHARS) {
    return { preview: text, start, end };
  }
  const windowStart = Math.max(0, start - PREVIEW_LEAD_CHARS);
  const windowEnd = Math.min(text.length, windowStart + SEARCH_PREVIEW_CHARS);
  const head = windowStart > 0 ? "…" : "";
  const tail = windowEnd < text.length ? "…" : "";
  const sliced = text.slice(windowStart, windowEnd);
  const offset = head.length - windowStart;
  return {
    preview: `${head}${sliced}${tail}`,
    start: Math.max(0, start + offset),
    end: Math.min(head.length + sliced.length, end + offset),
  };
}

/** One rg match event, as the contract's renderer-facing shape. */
function toMatch(event: RgMatchEvent): FileSearchMatch {
  const charStart = charOffset(event.text, event.byteStart);
  const charEnd = charOffset(event.text, event.byteEnd);
  const { preview, start, end } = previewForMatch(event.text, charStart, charEnd);
  return {
    line: event.line,
    // 1-based, because Monaco counts columns from 1 and this number exists to
    // be handed to it.
    column: charStart + 1,
    preview,
    start,
    end,
  };
}

/**
 * Groups matches by file, in the order rg reported them (rg walks a directory
 * tree in a stable order, so this is the order the page draws), and stops
 * accepting them at the cap.
 *
 * A collector rather than a post-pass: the cap has to be enforced as the stream
 * arrives, since the whole point of it is not to hold a repository's worth of
 * matches in main before deciding there were too many.
 */
class MatchCollector {
  private readonly byPath = new Map<string, FileSearchMatch[]>();
  private total = 0;

  /** Records one match; returns false once the cap has been reached. */
  add(event: RgMatchEvent): boolean {
    if (this.total >= SEARCH_MATCH_CAP) return false;
    const existing = this.byPath.get(event.relPath);
    if (existing === undefined) this.byPath.set(event.relPath, [toMatch(event)]);
    else existing.push(toMatch(event));
    this.total += 1;
    return this.total < SEARCH_MATCH_CAP;
  }

  get matches(): number {
    return this.total;
  }

  get full(): boolean {
    return this.total >= SEARCH_MATCH_CAP;
  }

  files(): FileSearchFile[] {
    return [...this.byPath].map(([relPath, matches]) => ({ relPath, matches }));
  }
}

/** What one completed search resolved to, before the IPC envelope. */
export interface FileSearchOutcome {
  files: FileSearchFile[];
  matches: number;
  limit: FileSearchLimit;
}

export type FileSearchRun = { ok: true; value: FileSearchOutcome } | { ok: false; error: string };

/** The empty answer: no query, nothing searched, nothing capped. */
const EMPTY_OUTCOME: FileSearchOutcome = { files: [], matches: 0, limit: "none" };

/**
 * Runs one search under `root`.
 *
 * `root` is an absolute directory main resolved itself (see the module header);
 * this function never accepts a path from a renderer. An empty or
 * whitespace-only query returns the empty answer WITHOUT spawning anything —
 * a Search page holds one every time it opens, and "list the entire checkout"
 * is not what it means.
 *
 * Both caps end the run the same way: kill the child, keep what arrived, and
 * name the cap in `limit`. The process is killed rather than merely unsubscribed
 * from, because an rg walking a monorepo will happily keep walking it.
 */
export async function searchFiles(input: {
  root: string;
  query: string;
  /** Overrides for tests; production resolves the binary through the package. */
  rgPath?: string;
  /** Wall-clock budget; defaults to {@link SEARCH_TIME_BUDGET_MS}. */
  timeBudgetMs?: number;
}): Promise<FileSearchRun> {
  const query = input.query.trim();
  if (query === "") return { ok: true, value: EMPTY_OUTCOME };

  let binary: string;
  try {
    binary = input.rgPath ?? (await resolveRgPath());
  } catch (error) {
    return { ok: false, error: `Search is unavailable: ${errorMessage(error)}` };
  }

  const budget = input.timeBudgetMs ?? SEARCH_TIME_BUDGET_MS;
  const collector = new MatchCollector();

  return await new Promise<FileSearchRun>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, searchArgs(query), {
        cwd: input.root,
        // Nothing is ever written to this search: stdin stays closed so the
        // child cannot end up waiting on a pipe (see {@link searchArgs}).
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, error: `Search is unavailable: ${errorMessage(error)}` });
      return;
    }

    let limit: FileSearchLimit = "none";
    let settled = false;
    let pending = "";
    let stderr = "";
    let stdoutBytes = 0;

    /**
     * Ends the run at `reached` and kills the child — LATCHED: the first cap to
     * fire is the one reported.
     *
     * A kill does not empty the pipe. stdout written before the signal is still
     * delivered and still parsed, so without the latch a search that ran out of
     * time while 500 matches sat buffered would settle as `"matches"` — "the
     * first 500", a list that merely stops — when the truth is that it never
     * reached most of the checkout. WHICH cap ended a search is the honest half
     * of this feature; it is not a field a late frame gets to rewrite.
     */
    const stopAt = (reached: FileSearchLimit): void => {
      if (limit === "none") limit = reached;
      child.kill("SIGKILL");
    };

    const timer = setTimeout(() => stopAt("time"), budget);
    // A search must never keep an otherwise idle app alive at quit.
    timer.unref?.();

    /** Ends the run once, whichever way it ended. */
    const settle = (run: FileSearchRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };

    // Optional only because naming `stdio` costs the never-null child type;
    // both pipes are asked for above and are always there.
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > SEARCH_OUTPUT_CAP_BYTES) {
        stopAt("matches");
        return;
      }
      pending += chunk;
      const lines = pending.split("\n");
      // The last element is whatever came before the chunk boundary; it is not
      // a complete JSON frame yet.
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseRgLine(line);
        if (event === null) continue;
        if (!collector.add(event)) {
          stopAt("matches");
          return;
        }
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      // Bounded: a broken invocation can print without end, and the only use
      // for this text is one sentence on screen.
      if (stderr.length < 4_000) stderr += chunk;
    });

    child.on("error", (error) => {
      settle({ ok: false, error: `Search is unavailable: ${errorMessage(error)}` });
    });

    child.on("close", (code) => {
      // rg: 0 = matches, 1 = none, 2 = a real error. A run WE killed reports
      // whatever the signal left behind, and its partial answer is the honest
      // one — `limit` already says why it is partial.
      if (limit === "none" && code === 2) {
        const detail = stderr.trim();
        settle({ ok: false, error: detail === "" ? "Search failed" : detail });
        return;
      }
      if (limit === "none") {
        const event = parseRgLine(pending);
        if (event !== null) collector.add(event);
      }
      settle({
        ok: true,
        value: {
          files: collector.files(),
          matches: collector.matches,
          // A run that filled the cap on its very last match is not truncated
          // by it unless the collector actually turned one away — but there is
          // no way to know that from here, and claiming completeness we cannot
          // prove is the dishonest direction. A full collector reports the cap.
          limit: limit === "none" && collector.full ? "matches" : limit,
        },
      });
    });
  });
}
