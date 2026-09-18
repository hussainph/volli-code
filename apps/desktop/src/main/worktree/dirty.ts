/**
 * Dirty detection (worktree-support §7). The removal-safety predicate, and it
 * ERRS DIRTY on any ambiguity — a clean worktree dir is disposable cache, but
 * anything that might be unsaved work must be preserved (#16's no-destruction
 * law). A worktree is dirty when ANY of these hold:
 *
 *  1. `git status --porcelain` is non-empty (includes untracked files).
 *  2. Sequencer state exists — a mid-flight merge / rebase / cherry-pick /
 *     revert / bisect (detected via files in the worktree's PRIVATE gitdir,
 *     resolved with `git rev-parse --git-dir`).
 *  3. The branch has commits reachable from neither the base nor any remote:
 *     `git log <branch> --not <base> --not --remotes --max-count=1` is
 *     non-empty. Rule: unpushed local commits are unsaved work → dirty.
 *  4. `git worktree list --porcelain` marks the entry `locked` — respected
 *     absolutely.
 *  5. Submodule drift — `git submodule status` reports a `+` (different SHA) or
 *     `U` (conflict) line. `-` (uninitialized) is clean: `git worktree add`
 *     never inits submodules, so it holds no local work.
 *  6. ANY git invocation fails — an unreadable worktree is treated as dirty
 *     rather than assumed clean.
 *
 * The first matching rule short-circuits and its reason is returned.
 *
 * TWO DRIVERS, ONE RULE SET (VC-383). The predicate is asked from two kinds of
 * place. The confirmed orphan cleanup (`cleanup.ts`) asks it inside a gate that
 * must not yield between its last look and the delete, so it needs the
 * SYNCHRONOUS driver — that block is deliberate and short. Everything else that
 * asks — the launch-time orphan scan over every registered worktree, the
 * "Remove worktree…" click, the unattended retention reclaim — runs on the
 * Electron main process, where five serial `execFileSync` children per
 * worktree froze every window for the whole walk (VC-369 measured the shape:
 * zero event-loop turns for the length of the read). Those take the ASYNC
 * driver. Each rule is stated once, as a probe — the git args to run, the
 * verdict on its output, the verdict on its failure — and the drivers differ
 * only in how they execute a probe, so the two can never disagree on what
 * dirty means.
 */
import { parseWorktreeList, type WorktreeListEntry } from "./git";
import { canonicalize } from "./paths";
import { detectSequencerState, detectSequencerStateAsync, type SequencerState } from "./sequencer";
import type { RunGit, RunGitAsync } from "./types";

export interface DirtyResult {
  dirty: boolean;
  /** Human-readable reason when `dirty`, else `null`. */
  reason: string | null;
}

const CLEAN: DirtyResult = { dirty: false, reason: null };

function dirty(reason: string): DirtyResult {
  return { dirty: true, reason };
}

export interface DirtyInput {
  worktreePath: string;
  /** The worktree's branch (for the unreachable-commits check); `HEAD` when unknown. */
  branch: string | null;
  /** The base branch to measure unpushed commits against; skipped when unknown. */
  baseBranch: string | null;
  /**
   * A pre-parsed `git worktree list --porcelain` for the project. When supplied,
   * the lock check reuses it instead of re-spawning git — the sweep passes one
   * listing per project rather than one per orphan in its loop.
   */
  worktreeEntries?: readonly WorktreeListEntry[];
}

/**
 * One §7 rule that asks git a question: what to run, and how to read the
 * answer. `onFailure` is the errs-dirty arm (rule 6) with the reason that names
 * which read could not be made.
 */
interface GitProbe {
  args: readonly string[];
  cwd: string;
  onOutput(out: string): DirtyResult;
  onFailure: DirtyResult;
}

function statusProbe(cwd: string): GitProbe {
  return {
    args: ["status", "--porcelain"],
    cwd,
    onOutput: (status) =>
      status.trim().length > 0 ? dirty("uncommitted or untracked changes") : CLEAN,
    onFailure: dirty("could not read git status"),
  };
}

/**
 * Rule 2, read off the shared sequencer probe: `unknown` (git-dir unresolvable)
 * errs dirty — §7's rule that an unreadable worktree is never assumed clean;
 * `active` is the mid-flight operation.
 */
function sequencerVerdict(state: SequencerState): DirtyResult {
  switch (state) {
    case "unknown":
      return dirty("could not resolve the worktree's git directory");
    case "active":
      return dirty("an in-progress merge, rebase, cherry-pick, revert, or bisect");
    default:
      return CLEAN;
  }
}

function unreachableCommitsProbe(input: DirtyInput): GitProbe {
  // ONE `--not`: its negation persists over both the base and `--remotes`
  // (`--not` TOGGLES, so a second one would flip `--remotes` back to positive
  // and count every remote-only commit as "unpushed work" — verified against
  // real git).
  const args = ["log", input.branch ?? "HEAD", "--not"];
  if (input.baseBranch) args.push(input.baseBranch);
  args.push("--remotes", "--max-count=1", "--format=%H");
  return {
    args,
    cwd: input.worktreePath,
    onOutput: (out) =>
      out.trim().length > 0 ? dirty("commits not reachable from the base or any remote") : CLEAN,
    onFailure: dirty("could not compare the branch against its base and remotes"),
  };
}

/** Rule 4 over an already-parsed listing — the caller's, or the probe's own. */
function lockVerdict(entries: readonly WorktreeListEntry[], worktreePath: string): DirtyResult {
  const target = canonicalize(worktreePath);
  const entry = entries.find((e) => canonicalize(e.path) === target);
  return entry?.locked ? dirty("the worktree is locked (git worktree lock)") : CLEAN;
}

function lockProbe(input: DirtyInput): GitProbe {
  return {
    args: ["worktree", "list", "--porcelain"],
    cwd: input.worktreePath,
    onOutput: (listing) => lockVerdict(parseWorktreeList(listing), input.worktreePath),
    onFailure: dirty("could not read the worktree lock state"),
  };
}

function submodulesProbe(cwd: string): GitProbe {
  return {
    args: ["submodule", "status"],
    cwd,
    onOutput: (out) => {
      // Only `+` (a different SHA checked out — real local drift) and `U` (merge
      // conflicts) count. `-` (uninitialized) is NOT dirt: it holds no local work
      // and `git worktree add` never inits submodules, so EVERY worktree of a
      // submodule repo starts `-` — counting it would make non-forced remove and
      // the auto-sweep permanently refuse.
      const drifted = out.split("\n").some((line) => /^[+U]/.test(line));
      return drifted ? dirty("submodule drift") : CLEAN;
    },
    onFailure: dirty("could not read submodule status"),
  };
}

/** One ordered §7 rule, named by the only execution each driver may vary. */
type DirtyRule =
  | { kind: "probe"; probe: GitProbe }
  | { kind: "sequencer"; worktreePath: string }
  | { kind: "lock"; entries: readonly WorktreeListEntry[]; worktreePath: string };

/**
 * The ordered rule list, stated ONCE. In particular, the caller-provided
 * worktree listing occupies rule 4 in exactly the same place as a spawned
 * listing; neither driver gets a private opportunity to add, omit, or reorder
 * a dirty definition (VC-383).
 */
function orderedDirtyRules(input: DirtyInput): readonly DirtyRule[] {
  return [
    { kind: "probe", probe: statusProbe(input.worktreePath) },
    { kind: "sequencer", worktreePath: input.worktreePath },
    { kind: "probe", probe: unreachableCommitsProbe(input) },
    input.worktreeEntries === undefined
      ? { kind: "probe", probe: lockProbe(input) }
      : { kind: "lock", entries: input.worktreeEntries, worktreePath: input.worktreePath },
    { kind: "probe", probe: submodulesProbe(input.worktreePath) },
  ];
}

/** What differs between the two drivers: how one already-ordered rule runs. */
interface DirtyRuleDriver<Output> {
  probe(probe: GitProbe): Output;
  sequencer(worktreePath: string): Output;
  lock(entries: readonly WorktreeListEntry[], worktreePath: string): Output;
}

/** Dispatches one shared rule through either driver's implementation. */
function runOrderedDirtyRule<Output>(rule: DirtyRule, driver: DirtyRuleDriver<Output>): Output {
  switch (rule.kind) {
    case "probe":
      return driver.probe(rule.probe);
    case "sequencer":
      return driver.sequencer(rule.worktreePath);
    case "lock":
      return driver.lock(rule.entries, rule.worktreePath);
  }
}

function runProbe(git: RunGit, probe: GitProbe): DirtyResult {
  let out: string;
  try {
    out = git(probe.args, probe.cwd);
  } catch {
    return probe.onFailure;
  }
  return probe.onOutput(out);
}

async function runProbeAsync(git: RunGitAsync, probe: GitProbe): Promise<DirtyResult> {
  let out: string;
  try {
    out = await git(probe.args, probe.cwd);
  } catch {
    return probe.onFailure;
  }
  return probe.onOutput(out);
}

/**
 * Runs every §7 rule in order, returning the first that fires (errs dirty on
 * any ambiguity). SYNCHRONOUS — for the one caller whose gate may not yield
 * (`cleanup.ts`); everything on the main process's ordinary paths takes
 * {@link isWorktreeDirtyAsync}.
 */
export function isWorktreeDirty(git: RunGit, input: DirtyInput): DirtyResult {
  const driver: DirtyRuleDriver<DirtyResult> = {
    probe: (probe) => runProbe(git, probe),
    sequencer: (worktreePath) => sequencerVerdict(detectSequencerState(git, worktreePath)),
    lock: lockVerdict,
  };
  for (const rule of orderedDirtyRules(input)) {
    const result = runOrderedDirtyRule(rule, driver);
    if (result.dirty) return result;
  }
  return CLEAN;
}

/**
 * The same five rules, the same order, the same short-circuit — over the async
 * runner, so the main process keeps turning between the children. The reads
 * stay SERIAL on purpose: the point is that the event loop gets a turn between
 * them, not that five git children race on a machine that is already loaded
 * (the VC-369 reasoning, unchanged).
 */
export async function isWorktreeDirtyAsync(
  git: RunGitAsync,
  input: DirtyInput,
): Promise<DirtyResult> {
  const driver: DirtyRuleDriver<Promise<DirtyResult>> = {
    probe: (probe) => runProbeAsync(git, probe),
    sequencer: async (worktreePath) =>
      sequencerVerdict(await detectSequencerStateAsync(git, worktreePath)),
    lock: async (entries, worktreePath) => lockVerdict(entries, worktreePath),
  };
  for (const rule of orderedDirtyRules(input)) {
    const result = await runOrderedDirtyRule(rule, driver);
    if (result.dirty) return result;
  }
  return CLEAN;
}
