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

export function extractFailure(caught: unknown): ExecFailure {
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
 * `gh pr list --head <branch> --state open --json url --jq .[].url` — the OPEN
 * PR for the branch, or `url: null` when there is none (empty stdout is not an
 * error). NOT `gh pr view <branch>`: view resolves the branch's most recent PR
 * in ANY state, so a merged/closed PR would be "re-discovered" as existing and
 * silently block opening a fresh PR for the branch's new work. Failures are
 * classified like {@link ghCreateDraftPr}.
 */
export async function ghFindPr(
  run: RunNet,
  input: { worktreePath: string; branch: string },
): Promise<GhResult<{ url: string | null }>> {
  try {
    const { stdout } = await run(
      "gh",
      ["pr", "list", "--head", input.branch, "--state", "open", "--json", "url", "--jq", ".[].url"],
      input.worktreePath,
    );
    // GitHub allows at most one open PR per head branch; take the first line
    // defensively all the same.
    const url = stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return ghOk({ url: url ?? null });
  } catch (caught) {
    const { stderr } = extractFailure(caught);
    if (stderr.toLowerCase().includes("no pull requests found")) {
      return ghOk({ url: null });
    }
    return { ok: false, failure: classifyGh(caught) };
  }
}

// ---------------------------------------------------------------------------
// gh — retention merge-watch (issue #76)
// ---------------------------------------------------------------------------

/**
 * The parsed report the retention watch reads off `gh pr view` (issue #76).
 * `state` is normalized to lowercase; `hasConflicts` reflects a `DIRTY`
 * `mergeStateStatus` (the PR can't merge until rebased); `failingChecks` are the
 * human-readable names of the checks the rollup reports as failed/errored — so
 * the wrap-up prompt is never offered on a PR that can't actually merge (the
 * #44 surface-don't-gate contract). NOTE: `gh pr view`'s `statusCheckRollup`
 * does not expose per-check required-ness, so this counts ALL failing checks,
 * not only required ones — surfacing, not gating, is the point.
 */
export interface PrStatusReport {
  state: "open" | "merged" | "closed";
  /** ISO timestamp the PR merged, or `null` when it is not merged. */
  mergedAt: string | null;
  /** `mergeStateStatus === "DIRTY"` — the branch conflicts with its base. */
  hasConflicts: boolean;
  /** Names of the checks the rollup reports as failing/errored (may be empty). */
  failingChecks: string[];
}

/** The subset of a `gh pr view --json` body the watch reads (everything untyped-in). */
interface GhPrViewBody {
  state?: unknown;
  mergedAt?: unknown;
  mergeStateStatus?: unknown;
  statusCheckRollup?: unknown;
}

/** Normalizes gh's UPPERCASE PR state; anything but MERGED/CLOSED reads as open. */
function normalizePrState(raw: unknown): "open" | "merged" | "closed" {
  const s = typeof raw === "string" ? raw.toUpperCase() : "";
  if (s === "MERGED") return "merged";
  if (s === "CLOSED") return "closed";
  return "open";
}

/** A non-empty, real merge timestamp — gh omits/nulls it for unmerged PRs. */
function normalizeMergedAt(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  // gh renders an unset time field as the zero date on some paths; treat as null.
  return raw.startsWith("0001-01-01") ? null : raw;
}

// A CheckRun conclusion (COMPLETED runs) that means the check did not pass.
const FAILING_CHECK_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
]);
// A StatusContext (legacy commit-status) state that means the context failed.
const FAILING_STATUS_STATES = new Set(["FAILURE", "ERROR"]);

/** The failing checks' display names, from both the CheckRun and StatusContext rollup shapes. */
function extractFailingChecks(rollup: unknown): string[] {
  if (!Array.isArray(rollup)) return [];
  const names: string[] = [];
  for (const entry of rollup) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as {
      conclusion?: unknown;
      state?: unknown;
      name?: unknown;
      context?: unknown;
    };
    const failing =
      (typeof item.conclusion === "string" && FAILING_CHECK_CONCLUSIONS.has(item.conclusion)) ||
      (typeof item.state === "string" && FAILING_STATUS_STATES.has(item.state));
    if (!failing) continue;
    const name =
      typeof item.name === "string" && item.name.length > 0
        ? item.name
        : typeof item.context === "string" && item.context.length > 0
          ? item.context
          : "check";
    names.push(name);
  }
  return names;
}

/**
 * `gh pr view <url> --json state,mergedAt,mergeStateStatus,statusCheckRollup`,
 * parsed into a {@link PrStatusReport}. A body that won't parse is an `unknown`
 * GhFailure (never a throw) so the caller treats it as a transient read error,
 * not clean truth. Failures are classified like the other gh verbs.
 */
export async function ghPrStatus(
  run: RunNet,
  input: { worktreePath: string; prUrl: string },
): Promise<GhResult<PrStatusReport>> {
  try {
    const { stdout } = await run(
      "gh",
      ["pr", "view", input.prUrl, "--json", "state,mergedAt,mergeStateStatus,statusCheckRollup"],
      input.worktreePath,
    );
    let body: GhPrViewBody;
    try {
      body = JSON.parse(stdout) as GhPrViewBody;
    } catch {
      return {
        ok: false,
        failure: { kind: "unknown", message: `Unparseable gh pr view output: ${stdout}` },
      };
    }
    return ghOk({
      state: normalizePrState(body.state),
      mergedAt: normalizeMergedAt(body.mergedAt),
      hasConflicts: body.mergeStateStatus === "DIRTY",
      failingChecks: extractFailingChecks(body.statusCheckRollup),
    });
  } catch (caught) {
    return { ok: false, failure: classifyGh(caught) };
  }
}

/** One row of `gh pr list --json url,state,updatedAt`. */
interface GhPrListRow {
  url?: unknown;
  state?: unknown;
  updatedAt?: unknown;
}

/**
 * Picks the PR the watch should adopt for a branch: an OPEN one wins (there is
 * at most one), else the most recently updated. `null` when the list is empty
 * or unparseable — a discovery read must never invent a URL.
 */
function pickDiscoveredPr(stdout: string): string | null {
  let rows: GhPrListRow[];
  try {
    const parsed = JSON.parse(stdout) as unknown;
    rows = Array.isArray(parsed) ? (parsed as GhPrListRow[]) : [];
  } catch {
    return null;
  }
  const withUrl = rows.filter((r): r is GhPrListRow & { url: string } => typeof r.url === "string");
  if (withUrl.length === 0) return null;
  const open = withUrl.find((r) => typeof r.state === "string" && r.state.toUpperCase() === "OPEN");
  if (open) return open.url;
  const mostRecent = withUrl.reduce((best, r) => {
    const a = typeof r.updatedAt === "string" ? r.updatedAt : "";
    const b = typeof best.updatedAt === "string" ? best.updatedAt : "";
    return a > b ? r : best;
  });
  return mostRecent.url;
}

/**
 * `gh pr list --head <branch> --state all --json url,state,updatedAt` — the
 * merge-watch's PR DISCOVERY for a branch that has no stored `pr_url` yet
 * (an agent may have opened the PR itself). Unlike {@link ghFindPr} (open-only,
 * by design, so a dead PR never blocks a fresh one), this looks at ALL states
 * because the watch must also see an already-merged PR. Returns the adopted url
 * or `null`; "no pull requests found" is an empty result, not an error.
 */
export async function ghDiscoverPr(
  run: RunNet,
  input: { worktreePath: string; branch: string },
): Promise<GhResult<{ url: string | null }>> {
  try {
    const { stdout } = await run(
      "gh",
      ["pr", "list", "--head", input.branch, "--state", "all", "--json", "url,state,updatedAt"],
      input.worktreePath,
    );
    return ghOk({ url: pickDiscoveredPr(stdout) });
  } catch (caught) {
    const { stderr } = extractFailure(caught);
    if (stderr.toLowerCase().includes("no pull requests found")) {
      return ghOk({ url: null });
    }
    return { ok: false, failure: classifyGh(caught) };
  }
}
