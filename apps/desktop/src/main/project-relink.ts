/**
 * Reconnecting a project to the folder it moved to (VC-430).
 *
 * A tracked project's `path` is an absolute location, and nothing on the
 * machine tells Volli when that location is renamed or moved. The row goes on
 * naming a folder that is no longer there: the project is still in the rail
 * with all of its tickets, and every root-based operation — browsing files,
 * starting a Session, any git command — fails. Registering the new folder is
 * not a fix, it is a SECOND project with none of the first one's history.
 *
 * So this module owns the one operation that is a fix: same row, new `path`.
 * It is the only caller of `updateProjectPath`, and it exists as a module
 * rather than as a handler body because three things have to happen in order
 * and each of them is a seam a test has to drive — judge the folder, commit
 * the write, then repair what the move broke underneath.
 *
 * The RULES live in `@volli/shared`'s `project-relink.ts`, not here: the
 * renderer explains the refusals this raises, and one rule described in two
 * processes is two rules. What lives here is everything the rules cannot know
 * without touching the machine — what is on disk, what git says, and what is
 * still running in the folder the project is leaving.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { validateProjectRelink } from "@volli/shared";
import type {
  Project,
  ProjectFolderState,
  ProjectRelinkAftermath,
  ProjectRelinkRefusal,
} from "@volli/shared";

import { getProjectById, listProjects, updateProjectPath } from "./db/projects-repo";
import { runGitCapturingAsync } from "./worktree/git";
import { listWorktreePathsByProject } from "./db/tickets-repo";
import { busySiteWithin } from "./worktree/activity";
import type { BusyWorktreeSites } from "./worktree/activity";
import { projectContainerName } from "./worktree/containers";
import type { RunGitAsync } from "./worktree/types";

/**
 * What a look at `path` finds. Exported because the renderer's recovery path
 * asks the same question of a project's REGISTERED folder — "is it still
 * there?" — and both answers have to use one vocabulary.
 */
export function inspectFolderOnDisk(path: string): ProjectFolderState {
  try {
    return statSync(path).isDirectory() ? "present" : "not-a-directory";
  } catch {
    return "missing";
  }
}

export type ProjectFolderReport =
  | { ok: true; path: string; state: ProjectFolderState }
  | { ok: false; error: string };

/**
 * Whether one project's REGISTERED folder is still where the row says.
 *
 * The question the recovery path is built on: nothing on the machine tells
 * Volli that a folder was renamed, so the app has to look. It answers with the
 * path as well as the verdict, because the surface that offers a relink has to
 * be able to show the person which folder went missing — that is usually the
 * only clue to where they moved it.
 */
export function inspectProjectFolder(
  db: Database.Database,
  projectId: string,
  inspectFolder: (path: string) => ProjectFolderState = inspectFolderOnDisk,
): ProjectFolderReport {
  const project = getProjectById(db, projectId);
  if (project === undefined) return { ok: false, error: "Unknown project" };
  return { ok: true, path: project.path, state: inspectFolder(project.path) };
}

export interface ProjectRelinkDeps {
  db: Database.Database;
  /**
   * What a look at a folder finds. A seam for the same reason every other one
   * here is: a relink is judged against the disk, and a suite that has to
   * create and move real checkouts to state a rule is not a suite.
   */
  inspectFolder?: (path: string) => ProjectFolderState;
  /**
   * The runner `git worktree repair` goes through. ASYNC on purpose — this
   * runs on Electron main, and repairing a repository with many linked
   * worktrees is not a thing to block a frame on.
   */
  gitAsync?: RunGitAsync;
  /**
   * Every directory a live terminal or agent is working in. Asked about the
   * folder the project is LEAVING: a Session there keeps the cwd it was
   * spawned with, and no row update can move a running process. Absent means
   * "assume none", which reports no warning rather than a false one.
   */
  busyWorktreeSites?: BusyWorktreeSites;
  /** Whether a worktree directory still exists. Defaults to {@link existsSync}. */
  worktreeExists?: (path: string) => boolean;
  now?: () => number;
}

export interface ProjectRelinkRequest {
  projectId: string;
  /** The replacement folder, as chosen. Resolved to an absolute path here. */
  path: string;
}

export type ProjectRelinkOutcome =
  | { ok: true; project: Project; aftermath: ProjectRelinkAftermath }
  | { ok: false; error: string; refusal?: ProjectRelinkRefusal };

/**
 * Points an existing project at `path`, or refuses with a sentence a person
 * can act on.
 *
 * Returns the committed row and an {@link ProjectRelinkAftermath} — what the
 * move left behind — which the caller turns into notices through the shared
 * `projectRelinkNotices`. Nothing in the aftermath is a failure: the relink
 * either happened or was refused, and these are the parts of the move that
 * could not follow the row.
 */
export async function relinkProject(
  deps: ProjectRelinkDeps,
  request: ProjectRelinkRequest,
): Promise<ProjectRelinkOutcome> {
  const inspectFolder = deps.inspectFolder ?? inspectFolderOnDisk;
  const now = deps.now ?? Date.now;

  const project = getProjectById(deps.db, request.projectId);
  if (project === undefined) return { ok: false, error: "Unknown project" };

  const candidatePath = resolve(request.path);
  const validation = validateProjectRelink({
    project,
    candidatePath,
    candidateState: inspectFolder(candidatePath),
    projects: listProjects(deps.db),
  });
  if (!validation.ok) {
    return { ok: false, error: validation.error, refusal: validation.refusal };
  }

  // Asked BEFORE the write, and about the folder being left behind: that is
  // where a live terminal or agent actually is, and the row is about to stop
  // naming it.
  const liveSessions = await countLiveSessionsIn(deps, project.path);

  const relinked = updateProjectPath(deps.db, project.id, validation.path, now());
  // `getProjectById` answered a moment ago inside the same synchronous call,
  // so the row is there; this is the type narrowing, not a real branch.
  /* v8 ignore next */
  if (relinked === undefined) return { ok: false, error: "Unknown project" };

  const worktreeExists = deps.worktreeExists ?? existsSync;
  const worktrees = listWorktreePathsByProject(deps.db, project.id).filter(worktreeExists).length;

  return {
    ok: true,
    project: relinked,
    aftermath: {
      liveSessions,
      worktrees,
      worktreesRepaired: await repairWorktreeLinks(deps, validation.path, worktrees),
      // Where the NEXT worktree lands. `resolveWorktreeIdentity` stamps a
      // ticket's directory once and reads it back verbatim forever after, so
      // the worktrees that already exist do not move — but the container name
      // is derived from the project folder's basename, so a rename splits
      // future worktrees off from the ones already there. Nothing breaks; it
      // is simply not what a person would assume, which is what makes it a
      // notice rather than a repair.
      containerRenamed:
        projectContainerName(project.path, project.id) !==
        projectContainerName(validation.path, project.id),
    },
  };
}

/**
 * How many live execution surfaces are working at or under `directory`.
 *
 * Filtered through {@link busySiteWithin} rather than trusted as scoped, for
 * the reason that helper documents: terminals are reported unscoped, because a
 * live PTY holds whatever cwd it holds. Absent supplier means none — a warning
 * nobody can substantiate is worse than no warning.
 */
async function countLiveSessionsIn(deps: ProjectRelinkDeps, directory: string): Promise<number> {
  if (deps.busyWorktreeSites === undefined) return 0;
  const sites = await deps.busyWorktreeSites(directory);
  return sites.filter((site) => busySiteWithin(directory, [site]) !== null).length;
}

/**
 * Runs git's own repair for linked worktrees from the checkout's new location,
 * answering whether it succeeded.
 *
 * Moving a main checkout breaks the link in BOTH directions: each linked
 * worktree's `.git` file names an administrative directory that has moved, and
 * the repository's record of each worktree names a `.git` file it can still
 * find but no longer reach back from. `git worktree repair`, run from the main
 * checkout, is git's documented fix for exactly this, which is why this runs
 * from the path just committed rather than the one the row used to hold.
 *
 * A project with no worktrees on disk is not asked: there is nothing to
 * repair, and a repository that is not a git checkout at all (a project can be
 * any folder) would fail the command for a reason nobody needs telling about.
 * A failure is reported, never thrown — the relink itself has already
 * committed, and the notice tells the person the one command that finishes it.
 */
async function repairWorktreeLinks(
  deps: ProjectRelinkDeps,
  projectPath: string,
  worktrees: number,
): Promise<boolean> {
  if (worktrees === 0) return true;
  const gitAsync = deps.gitAsync ?? runGitCapturingAsync;
  try {
    await gitAsync(["worktree", "repair"], projectPath);
    return true;
  } catch {
    return false;
  }
}
