/**
 * The async network seam for the Done flow (§8). `RunGit` is `execFileSync` — a
 * synchronous network call would FREEZE the main process for the length of a
 * push or a `gh` round-trip, so every verb that touches the network lives here
 * instead, over a `promisify(execFile)` runner (the `park.ts`/`agent-tools.ts`
 * pattern): args-array, no shell, injectable so the suite drives a fake.
 *
 * Two error philosophies coexist by design:
 *  - `fetchBase`/`pushBranch` return the module's plain-string {@link
 *    WorktreeResult}. Push classifies the two failures the user must understand
 *    differently — a non-fast-forward REJECTION (the remote branch moved; we
 *    never suggest force-push, which would clobber it) and a missing remote —
 *    but still as human strings.
 *  - `ghCreateDraftPr`/`ghFindPr` return a structured {@link GhResult}: the IPC
 *    layer branches on `failure.kind` (Vibe Kanban's error-taxonomy model) to,
 *    e.g., turn a `pr-exists` into a follow-up `ghFindPr` rather than an error
 *    dialog. Keeping the taxonomy typed (not a string) is what makes that
 *    re-entry possible.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { err, ok, type WorktreeResult } from "./types";

/**
 * The injectable async runner: `(file, args, cwd) → { stdout, stderr }`,
 * rejecting on a non-zero exit or spawn failure (the rejection carries
 * `stdout`/`stderr`/`code`, which the verbs classify). Same discipline as
 * `RunGit`: args array, never a shell string.
 */
export type RunNet = (
  file: string,
  args: readonly string[],
  cwd: string,
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);

/** The default runner over Node's `execFile` (utf8, no shell). */
export const runNet: RunNet = async (file, args, cwd) => {
  const { stdout, stderr } = await execFileAsync(file, [...args], { cwd, encoding: "utf8" });
  return { stdout, stderr };
};

/** The `stdout`/`stderr`/`code` scraped off a rejected {@link RunNet} call. */
interface ExecFailure {
  stdout: string;
  stderr: string;
  /** Exit code (number) or a spawn error string like `"ENOENT"`; `null` if absent. */
  code: number | string | null;
}

function extractFailure(caught: unknown): ExecFailure {
  const e = caught as { stdout?: unknown; stderr?: unknown; code?: unknown };
  const stderr =
    typeof e.stderr === "string" && e.stderr.length > 0
      ? e.stderr
      : caught instanceof Error
        ? caught.message
        : String(caught);
  return {
    stdout: typeof e.stdout === "string" ? e.stdout : "",
    stderr,
    code: typeof e.code === "number" || typeof e.code === "string" ? e.code : null,
  };
}

/** The last non-empty, trimmed line of `stdout` (gh prints the PR URL there). */
function lastLine(stdout: string): string {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.length > 0 ? lines[lines.length - 1]! : "";
}

// ---------------------------------------------------------------------------
// fetch / push — plain-string WorktreeResult
// ---------------------------------------------------------------------------

/**
 * `git fetch origin <base>`. Whether a failure should degrade to stale-local
 * info (it should, per §3) is the CALLER's policy — this just reports ok/err.
 */
export async function fetchBase(
  run: RunNet,
  input: { worktreePath: string; baseBranch: string | null },
): Promise<WorktreeResult<void>> {
  if (!input.baseBranch) return err("No base branch is known to fetch.");
  try {
    await run("git", ["fetch", "origin", input.baseBranch], input.worktreePath);
    return ok(undefined);
  } catch (caught) {
    return err(extractFailure(caught).stderr);
  }
}

/** stderr fragments that mark a push rejected because the remote branch advanced. */
const NON_FAST_FORWARD = ["non-fast-forward", "fetch first", "[rejected]"];
/**
 * stderr fragments that mark "there is no remote to push to". Deliberately
 * NARROW: "could not read from remote repository" / "does not appear to be a
 * git repository" are NOT here — git emits those for SSH-auth failures and bad
 * remote URLs too, where "add an `origin` remote" would be wrong advice. Those
 * fall through to the raw stderr, which carries git's own remediation hint.
 */
const NO_REMOTE = ["no configured push destination", "no such remote"];

function includesAny(haystack: string, needles: readonly string[]): boolean {
  const lower = haystack.toLowerCase();
  return needles.some((n) => lower.includes(n));
}

/**
 * `git push -u origin <branch>`. A non-fast-forward rejection and a missing
 * remote get their own messages; a rejection NEVER suggests force-push (that
 * would destroy the commits the remote gained).
 */
export async function pushBranch(
  run: RunNet,
  input: { worktreePath: string; branch: string | null },
): Promise<WorktreeResult<void>> {
  if (!input.branch) return err("No branch is set on this worktree to push.");
  try {
    await run("git", ["push", "-u", "origin", input.branch], input.worktreePath);
    return ok(undefined);
  } catch (caught) {
    const { stderr } = extractFailure(caught);
    if (includesAny(stderr, NON_FAST_FORWARD)) {
      return err(
        "The remote branch has moved on since you last pushed. Pull or rebase onto the " +
          "updated remote branch, then push again.",
      );
    }
    if (includesAny(stderr, NO_REMOTE)) {
      return err("No git remote is configured to push to. Add an `origin` remote and try again.");
    }
    return err(stderr);
  }
}

// ---------------------------------------------------------------------------
// gh — structured GhResult taxonomy
// ---------------------------------------------------------------------------

/** The failure taxonomy the `gh` verbs expose so the IPC layer can branch on it. */
export type GhFailureKind =
  | "not-installed"
  | "not-authenticated"
  | "no-remote"
  | "pr-exists"
  | "network"
  | "unknown";

/** A classified `gh` failure. Kept local to main (never crosses IPC as-is). */
export interface GhFailure {
  kind: GhFailureKind;
  /** The real stderr (or a fallback), for logging/toasting the underlying cause. */
  message: string;
}

/** The `gh` verbs' Result: structured failure side so callers branch on `kind`. */
export type GhResult<T> = { ok: true; value: T } | { ok: false; failure: GhFailure };

function ghOk<T>(value: T): GhResult<T> {
  return { ok: true, value };
}

const GH_AUTH = ["auth login", "not logged in", "authentication", "gh auth"];
const GH_NO_REMOTE = [
  "none of the git remotes",
  "no git remotes",
  "could not determine the base repository",
  "unable to determine base repository",
];
const GH_NETWORK = [
  "dial tcp",
  "no such host",
  "could not resolve host",
  "connection refused",
  "network is unreachable",
  "timeout",
  "error connecting",
];

/** Maps an execFile failure to the `gh` taxonomy (see {@link GhFailureKind}). */
function classifyGh(caught: unknown): GhFailure {
  const { stderr, code } = extractFailure(caught);
  if (code === "ENOENT") {
    return {
      kind: "not-installed",
      message: "GitHub CLI (`gh`) is not installed or not on PATH.",
    };
  }
  const lower = stderr.toLowerCase();
  if (lower.includes("already exists")) return { kind: "pr-exists", message: stderr };
  if (GH_AUTH.some((n) => lower.includes(n))) return { kind: "not-authenticated", message: stderr };
  if (GH_NO_REMOTE.some((n) => lower.includes(n))) return { kind: "no-remote", message: stderr };
  if (GH_NETWORK.some((n) => lower.includes(n))) return { kind: "network", message: stderr };
  return { kind: "unknown", message: stderr };
}

/**
 * `gh pr create --draft` for the branch. On success the PR URL is the last line
 * of stdout. A `pr-exists` failure is expected on re-entry — the caller answers
 * it with {@link ghFindPr} rather than surfacing an error.
 */
export async function ghCreateDraftPr(
  run: RunNet,
  input: {
    worktreePath: string;
    base: string;
    branch: string;
    title: string;
    body: string;
  },
): Promise<GhResult<{ url: string }>> {
  try {
    const { stdout } = await run(
      "gh",
      [
        "pr",
        "create",
        "--draft",
        "--base",
        input.base,
        "--head",
        input.branch,
        "--title",
        input.title,
        "--body",
        input.body,
      ],
      input.worktreePath,
    );
    return ghOk({ url: lastLine(stdout) });
  } catch (caught) {
    return { ok: false, failure: classifyGh(caught) };
  }
}

/**
 * `gh pr view <branch> --json url --jq .url`. A "no pull requests found" exit is
 * NOT an error — it resolves `url: null` so the caller knows to create one. Any
 * other failure is classified like {@link ghCreateDraftPr}.
 */
export async function ghFindPr(
  run: RunNet,
  input: { worktreePath: string; branch: string },
): Promise<GhResult<{ url: string | null }>> {
  try {
    const { stdout } = await run(
      "gh",
      ["pr", "view", input.branch, "--json", "url", "--jq", ".url"],
      input.worktreePath,
    );
    const url = stdout.trim();
    return ghOk({ url: url.length > 0 ? url : null });
  } catch (caught) {
    const { stderr } = extractFailure(caught);
    if (stderr.toLowerCase().includes("no pull requests found")) {
      return ghOk({ url: null });
    }
    return { ok: false, failure: classifyGh(caught) };
  }
}
