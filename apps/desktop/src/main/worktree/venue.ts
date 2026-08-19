/**
 * The VENUE read (VC-55): what git says is in the checkout a Session runs in.
 *
 * The empty chat and the Home rail both ask one question — how much of this
 * tree is in play, and how much work is in it — and neither can be answered by
 * the Change Set. A Change Set folds committed and uncommitted work into one
 * file list on purpose, because it answers "what would the PR contain"; this
 * answers "what is the state of the tree I am standing in", which needs the two
 * kept apart. See {@link import("@volli/shared").VenueFileState}.
 *
 * WHICH DIRECTORY is not decided here. {@link readVenue} resolves it with
 * exactly the rule `session-runtime/location.ts` resolves a Session's own
 * directory by — `ticket.worktreePath ?? project.path` — so the tree drawn is
 * always the tree the agent would write to, including for a ticket that runs in
 * the main checkout (VC-96) and for one whose worktree has not materialised yet.
 *
 * Async git throughout, like the Change Set reads and for the same reason: this
 * runs on the main process, and a status over a big tree is not something to
 * block a cursor on.
 */
import type Database from "better-sqlite3";
import type { VenueFileCounts, VenueKind, VenueSnapshot } from "@volli/shared";

import { getProjectById } from "../db/projects-repo";
import { getTicketRow } from "../db/tickets-repo";
import { resolveChangeSetBaseRevision } from "./comparison-ref";
import { runGitCapturingAsync, stderrOf } from "./git";
import { err, ok, type RunGitAsync, type WorktreeResult } from "./types";

export interface VenueSnapshotInput {
  /** The checkout to measure. */
  path: string;
  kind: VenueKind;
  /**
   * The branch committed work is measured against, or `null` for no
   * measurement at all.
   *
   * A main checkout always passes `null`, and that is a decision rather than
   * missing data: the main checkout is normally standing ON the base branch, so
   * a diff against it is empty — and an empty hairline reads as "no work",
   * which is the opposite of what a dirty main checkout means. Dropping the
   * measurement is the honest drawing.
   */
  baseBranch: string | null;
}

/**
 * The concrete revision committed work is measured from, or `null` when there
 * is none to measure from.
 *
 * A base that cannot be resolved DEGRADES rather than failing the read: the
 * branch a worktree was cut from can be deleted, renamed or never fetched, and
 * none of that makes the tree in front of the user unmeasurable. The venue
 * simply loses its hairline, which is the same drawing a main checkout gets and
 * already means "no base to compare with".
 */
async function resolveBase(git: RunGitAsync, input: VenueSnapshotInput): Promise<string | null> {
  if (input.baseBranch === null) return null;
  try {
    const revision = await resolveChangeSetBaseRevision(git, input.path, input.baseBranch);
    return revision !== null && revision.length > 0 ? revision : null;
  } catch {
    return null;
  }
}

/** The narrow deps {@link readVenue} needs — a structural subset of `WorktreeDeps`. */
export interface VenueReadDeps {
  db: Database.Database;
  /** The non-blocking runner; defaults to the real one, never to a sync wrapper. */
  gitAsync?: RunGitAsync;
}

/** Which venue a Session of this scope stands in, before git is asked anything. */
export interface VenueTarget {
  projectId: string;
  /** The ticket that owns the Session, or `null` for one of the project's own. */
  ticketId: string | null;
}

/**
 * The venue a Session of this scope runs in, measured.
 *
 * The directory is resolved by the SAME rule the Session runtime binds one by
 * (`session-runtime/location.ts`: `ticket.worktreePath ?? project.path`), so
 * this can never draw a tree the agent is not standing in. Three cases fall out
 * of that one rule rather than needing branches of their own: a Project Session
 * (no ticket), a Ticket Session in its worktree, and a Ticket Session in the
 * main checkout — whether because the ticket runs unisolated (VC-96) or because
 * its worktree has not been materialised yet.
 *
 * A ticket from another project is refused rather than silently measured under
 * the project it was asked for; a git failure (including a stamped worktree
 * somebody deleted) surfaces as the error git gave, and the caller draws
 * nothing rather than a shape with no measurement behind it.
 */
export async function readVenue(
  deps: VenueReadDeps,
  target: VenueTarget,
): Promise<WorktreeResult<VenueSnapshot>> {
  const project = getProjectById(deps.db, target.projectId);
  if (project === undefined) return err("Unknown project");
  const ticket = target.ticketId === null ? undefined : getTicketRow(deps.db, target.ticketId);
  if (target.ticketId !== null && ticket === undefined) return err("Unknown ticket");
  if (ticket !== undefined && ticket.project_id !== project.id) {
    return err("Ticket belongs to another project");
  }
  const worktreePath = ticket?.worktree_path ?? null;
  return venueSnapshot(
    deps.gitAsync ?? runGitCapturingAsync,
    worktreePath === null
      ? { path: project.path, kind: "main-checkout", baseBranch: null }
      : { path: worktreePath, kind: "worktree", baseBranch: ticket?.base_branch ?? null },
  );
}

/** One dirty path and which of the three loose states it is in. */
interface DirtyEntry {
  path: string;
  state: "modified" | "added" | "untracked";
}

/**
 * Measures a venue: the branch, the four-state file partition, and the lines
 * moved against the base.
 *
 * Three git reads, and the two big ones overlap — `status` and the base diff
 * are independent of each other, so the snapshot costs one round trip rather
 * than two, and the tree cannot move between them any more than it could
 * between two sequential spawns.
 */
export async function venueSnapshot(
  git: RunGitAsync,
  input: VenueSnapshotInput,
): Promise<WorktreeResult<VenueSnapshot>> {
  try {
    // `--show-current` rather than `rev-parse --abbrev-ref HEAD`: it prints
    // nothing on a detached HEAD (instead of the literal string "HEAD", which a
    // caller then has to know is not a branch name) and still answers on an
    // unborn branch in a repository with no commits.
    const branchOut = await git(["branch", "--show-current"], input.path);
    const branch = branchOut.trim();

    const baseRevision = await resolveBase(git, input);

    const [statusOut, numstatOut] = await Promise.all([
      git(["status", "--porcelain=v2", "-z", "-uall"], input.path),
      baseRevision === null
        ? Promise.resolve("")
        : git(["diff", "--numstat", "-z", "-M", baseRevision], input.path),
    ]);

    const dirty = parseDirty(statusOut);
    const changed = parseNumstat(numstatOut);
    const dirtyPaths = new Set(dirty.map((entry) => entry.path));

    const files: VenueFileCounts = {
      // Changed against the base and clean in the tree right now. Subtracting
      // the dirty paths is what makes the four states a partition: a file that
      // is both committed and edited is counted once, as edited, because that
      // is the state the tree is actually in.
      committed: changed.paths.filter((path) => !dirtyPaths.has(path)).length,
      modified: dirty.filter((entry) => entry.state === "modified").length,
      added: dirty.filter((entry) => entry.state === "added").length,
      untracked: dirty.filter((entry) => entry.state === "untracked").length,
    };

    return ok({
      kind: input.kind,
      path: input.path,
      branch: branch.length > 0 ? branch : null,
      files,
      diff:
        input.baseBranch === null || baseRevision === null
          ? null
          : { added: changed.insertions, removed: changed.deletions, base: input.baseBranch },
    });
  } catch (caught) {
    return err(stderrOf(caught));
  }
}

/**
 * Every path `git status --porcelain=v2 -z -uall` reports as dirty, with the
 * loose state it is in.
 *
 * Parsed sequentially rather than by scanning for line prefixes, because a
 * RENAME entry (`2 …`) is followed by a SECOND NUL-terminated token holding the
 * original path — and that token is arbitrary user data. A scan would read it
 * as an entry of its own the moment somebody had a file whose name began with
 * "? " or "u ".
 *
 * Ignored entries (`!`) never arrive: `--ignored` is not passed.
 */
function parseDirty(out: string): DirtyEntry[] {
  const tokens = splitNul(out);
  const entries: DirtyEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    index += 1;
    if (token.startsWith("? ")) {
      const path = token.slice(2);
      if (path.length > 0) entries.push({ path, state: "untracked" });
      continue;
    }
    if (token.startsWith("1 ") || token.startsWith("2 ") || token.startsWith("u ")) {
      // `1 <xy> <sub> <mH> <mI> <mW> <hH> <hI> <path>` — eight fixed fields
      // before the path, nine for `2`, and the path may contain spaces, so the
      // tail is rejoined. `u` carries more fields still and always means
      // conflicted, so it never needs its code read.
      const fixed = token.startsWith("u ") ? 10 : token.startsWith("2 ") ? 9 : 8;
      const parts = token.split(" ");
      const path = parts.slice(fixed).join(" ");
      // A rename's original path is its own token — consumed here so it can
      // never be mistaken for the next entry.
      if (token.startsWith("2 ")) index += 1;
      if (path.length === 0) continue;
      entries.push({ path, state: looseState(parts[1] ?? "", token.startsWith("u ")) });
      continue;
    }
  }
  return entries;
}

/**
 * Which loose state an `<XY>` status code means.
 *
 * `A` in either column is an addition — a file git did not have before, whether
 * it is staged or (with `AM`) staged and edited since. Everything else that is
 * dirty is `modified`: edited, deleted, renamed, type-changed, or conflicted.
 * The bar those counts feed says how much of the tree is in play, and each of
 * those is in play; splitting them further would add states the drawing has no
 * room to distinguish.
 */
function looseState(code: string, unmerged: boolean): "modified" | "added" {
  if (unmerged) return "modified";
  return code.includes("A") ? "added" : "modified";
}

/**
 * `git diff --numstat -z -M <base>` — the changed paths and the line totals.
 *
 * Base against the WORKING TREE, not against HEAD, so the lines include work
 * that is written but not yet committed. The hairline answers "how much work is
 * in this branch", and work an agent has just written is the most current
 * answer there is.
 *
 * Ordinary entries are `added\tdeleted\tpath\0`; a rename is
 * `added\tdeleted\t\0old\0new\0` (empty path field, then two path tokens).
 * Binary files print `-\t-`, which contributes a path and no lines — a `0`
 * would masquerade as an unchanged file.
 */
function parseNumstat(out: string): { paths: string[]; insertions: number; deletions: number } {
  const tokens = splitNul(out);
  const paths: string[] = [];
  let insertions = 0;
  let deletions = 0;
  let index = 0;
  while (index < tokens.length) {
    const field = tokens[index] ?? "";
    index += 1;
    if (field.length === 0) continue;
    const parts = field.split("\t");
    if (parts.length < 2) continue;
    insertions += parseCount(parts[0] ?? "");
    deletions += parseCount(parts[1] ?? "");
    const pathPart = parts[2] ?? "";
    if (pathPart.length > 0) {
      paths.push(pathPart);
      continue;
    }
    // Rename: the old path, then the new one. The new path is the file that
    // exists now, which is the one every other reading here is about.
    index += 1;
    const renamed = tokens[index] ?? "";
    index += 1;
    if (renamed.length > 0) paths.push(renamed);
  }
  return { paths, insertions, deletions };
}

/** `"-"` (binary) contributes nothing; anything unparseable contributes nothing either. */
function parseCount(field: string): number {
  const value = Number.parseInt(field, 10);
  return Number.isInteger(value) ? value : 0;
}

function splitNul(out: string): string[] {
  if (out.length === 0) return [];
  const parts = out.split("\0");
  // git's trailing NUL leaves a final empty token — drop it.
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}
