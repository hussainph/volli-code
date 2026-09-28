/**
 * Relinking a project to the folder it moved to (VC-430) — the rules, shared.
 *
 * A tracked project is a row whose `path` is an absolute location on disk.
 * Rename or move that folder and the row keeps pointing at where it used to
 * be: the project is still in the rail, still has its tickets, and every
 * root-based operation — browsing files, starting a Session, anything git —
 * fails against a path that is no longer there. Adding the new folder is not
 * the fix; that mints a SECOND project and strands the first one's history.
 *
 * So the fix is a relink: the same row, a new `path`. What this module owns is
 * the judgement either side of that write — which replacement folders may be
 * saved, and what a person has to be told afterwards — and it lives in the
 * shared package for `worktree-preservation.ts`'s reason: main refuses the bad
 * folder and the renderer explains the refusal, and a rule enforced in one
 * process and described in another must have exactly one definition. No
 * transport and no `node:fs` here (docs/BOUNDARIES.md) — the caller looks at
 * the disk and reports what it saw as a {@link ProjectFolderState}.
 */

/**
 * What a look at a registered or candidate project folder found.
 *
 * `"missing"` covers every reason a `stat` could not answer — gone, renamed,
 * on an unmounted volume, unreadable — because from here they are one fact
 * with one recovery, and a surface that split them would be asking a person to
 * diagnose their own filesystem.
 */
export type ProjectFolderState = "present" | "missing" | "not-a-directory";

/** The little of a project this module needs: who it is, and where it points. */
export interface ProjectRelinkSubject {
  id: string;
  name: string;
  path: string;
}

export interface ProjectRelinkInput {
  /** The project being relinked. */
  project: ProjectRelinkSubject;
  /** The chosen replacement folder, already resolved to an absolute path. */
  candidatePath: string;
  /** What the caller's look at {@link candidatePath} found. */
  candidateState: ProjectFolderState;
  /** Every tracked project, INCLUDING {@link project} — filtered by id here. */
  projects: readonly ProjectRelinkSubject[];
}

/** Why a relink was refused. Stable ids; the sentences are derived from them. */
export type ProjectRelinkRefusal = "missing" | "not-a-directory" | "unchanged" | "claimed";

export type ProjectRelinkValidation =
  | { ok: true; path: string }
  | { ok: false; refusal: ProjectRelinkRefusal; error: string };

/**
 * What a completed relink could not make follow the project by itself.
 *
 * Ids, with the sentences derived from them ({@link projectRelinkNoticeText}),
 * for `worktree-preservation.ts`'s reason: main decides which of these are
 * true and the renderer says them out loud, and two independent lists of
 * English would drift. The relink itself always succeeds — none of these is a
 * failure, and none of them is a reason to refuse the move.
 */
export const PROJECT_RELINK_NOTICES = [
  /** Live Sessions are still working in the folder the project just left. */
  "sessions-keep-old-cwd",
  /** Git's links between the moved repository and its ticket worktrees were fixed. */
  "worktrees-repaired",
  /** They could not be, and git commands in those worktrees will fail until they are. */
  "worktrees-unrepaired",
  /** New worktrees will land in a container named after the new folder. */
  "worktree-container-renamed",
] as const;

/** One thing the move left behind, by its durable id. */
export type ProjectRelinkNotice = (typeof PROJECT_RELINK_NOTICES)[number];

/** What the caller observed around a relink it has just committed. */
export interface ProjectRelinkAftermath {
  /** Sessions still live in the folder the project pointed at before the move. */
  liveSessions: number;
  /** Ticket worktrees git-linked to this project's repository. */
  worktrees: number;
  /** Whether repairing git's administrative links in the new root succeeded. */
  worktreesRepaired: boolean;
  /** Whether the move changed the folder name new worktrees are grouped under. */
  containerRenamed: boolean;
}

/** Everything {@link aftermath} says did not follow the project, in reading order. */
export function projectRelinkNotices(
  aftermath: ProjectRelinkAftermath,
): readonly ProjectRelinkNotice[] {
  const notices: ProjectRelinkNotice[] = [];
  if (aftermath.liveSessions > 0) notices.push("sessions-keep-old-cwd");
  if (aftermath.worktrees > 0) {
    notices.push(aftermath.worktreesRepaired ? "worktrees-repaired" : "worktrees-unrepaired");
  }
  if (aftermath.containerRenamed) notices.push("worktree-container-renamed");
  return notices;
}

const NOTICE_TEXT: Record<ProjectRelinkNotice, (aftermath: ProjectRelinkAftermath) => string> = {
  "sessions-keep-old-cwd": ({ liveSessions }) =>
    liveSessions === 1
      ? "1 running session is still working in the old folder. Restart it to pick up the new path."
      : `${liveSessions} running sessions are still working in the old folder. Restart them to pick up the new path.`,
  "worktrees-repaired": ({ worktrees }) =>
    `Reconnected ${worktrees} ticket ${plural(worktrees, "worktree")} to the repository at its new path.`,
  "worktrees-unrepaired": ({ worktrees }) =>
    `${worktrees} ticket ${plural(worktrees, "worktree")} could not be reconnected. Run \`git worktree repair\` in the project folder.`,
  "worktree-container-renamed": () =>
    "New worktrees will be grouped under the new folder name; existing ones stay put.",
};

/** `"worktree"` / `"worktrees"`, so a count of one never reads like a typo. */
function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

/** What one notice says, given the move it describes. */
export function projectRelinkNoticeText(
  notice: ProjectRelinkNotice,
  aftermath: ProjectRelinkAftermath,
): string {
  return NOTICE_TEXT[notice](aftermath);
}

/**
 * A folder path with one trailing slash removed — `"/"` itself untouched, so
 * normalising can never turn a path into the empty string. Every comparison
 * below runs on normalised values: a folder chosen from a picker and the same
 * folder typed with a trailing slash are one place, and a rule that read them
 * as two would refuse nothing and duplicate happily.
 */
function normalizeFolderPath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * Whether this replacement folder may be saved onto this project's row.
 *
 * Four refusals, and the last is the one the ticket exists for: a folder
 * another project already tracks is never relinked onto this one, because the
 * two rows would then name the same checkout and every path-keyed lookup in
 * the app would answer with whichever it found first.
 */
export function validateProjectRelink(input: ProjectRelinkInput): ProjectRelinkValidation {
  if (input.candidateState === "missing") {
    return { ok: false, refusal: "missing", error: "That folder doesn't exist." };
  }
  if (input.candidateState === "not-a-directory") {
    return { ok: false, refusal: "not-a-directory", error: "That's a file, not a folder." };
  }
  const candidatePath = normalizeFolderPath(input.candidatePath);
  if (candidatePath === normalizeFolderPath(input.project.path)) {
    return {
      ok: false,
      refusal: "unchanged",
      error: `${input.project.name} already points at that folder.`,
    };
  }
  const claimant = input.projects.find(
    (project) =>
      project.id !== input.project.id && normalizeFolderPath(project.path) === candidatePath,
  );
  if (claimant !== undefined) {
    return {
      ok: false,
      refusal: "claimed",
      error: `${claimant.name} already tracks that folder.`,
    };
  }
  return { ok: true, path: candidatePath };
}
