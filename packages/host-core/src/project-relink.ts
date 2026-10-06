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
 * rather than as a handler body because four things have to happen in order
 * and each of them is a seam a test has to drive — judge the folder, commit the
 * write, move the worktree container the project owns, then let git repair the
 * links the move broke.
 *
 * The RULES live in `@volli/shared`'s `project-relink.ts`, not here: the
 * renderer explains the refusals this raises, and one rule described in two
 * processes is two rules. What lives here is everything the rules cannot know
 * without touching the machine — what is on disk, which folder a path actually
 * names, what git says, and what is still running in the folder the project is
 * leaving.
 *
 * Nothing here reads the disk synchronously. This runs on Electron main, where
 * a blocking `stat` is a frozen window, and a project folder can sit on an
 * unmounted network volume where that block is measured in seconds.
 */
import { rename, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { validateProjectRelink } from "@volli/shared";
import type {
  FolderIdentity,
  Project,
  ProjectFolderState,
  ProjectRelinkAftermath,
  ProjectRelinkRefusal,
  ProjectRelinkSubject,
} from "@volli/shared";

import { getProjectById, listProjects, updateProjectPath } from "./db/projects-repo";
import { runGitCapturingAsync } from "./worktree/git";
import { listWorktreeSitesByProject, updateTicketFields } from "./db/tickets-repo";
import { busySiteWithin } from "./worktree/activity";
import type { BusyWorktreeSites } from "./worktree/activity";
import { projectContainerName } from "./worktree/containers";
import type { RunGitAsync } from "./worktree/types";

/** What a look at one folder found, and which folder it actually was. */
export interface FolderProbe {
  state: ProjectFolderState;
  /**
   * Device and inode, so every spelling of one directory answers alike. `null`
   * whenever the look failed — there is no identity to report for a folder
   * that could not be read.
   */
  folder: FolderIdentity;
}

/**
 * What a look at `path` finds. Exported because the renderer's recovery path
 * asks the same question of a project's REGISTERED folder — "is it still
 * there?" — and both answers have to use one vocabulary.
 */
export async function probeFolderOnDisk(path: string): Promise<FolderProbe> {
  try {
    const stats = await stat(path);
    if (!stats.isDirectory()) return { state: "not-a-directory", folder: null };
    return { state: "present", folder: `${stats.dev}:${stats.ino}` };
  } catch {
    return { state: "missing", folder: null };
  }
}

/** The seam every folder read in this module goes through. */
export type ProbeFolder = (path: string) => Promise<FolderProbe>;

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
export async function inspectProjectFolder(
  db: Database.Database,
  projectId: string,
  probeFolder: ProbeFolder = probeFolderOnDisk,
): Promise<ProjectFolderReport> {
  const project = getProjectById(db, projectId);
  if (project === undefined) return { ok: false, error: "Unknown project" };
  const probe = await probeFolder(project.path);
  return { ok: true, path: project.path, state: probe.state };
}

export interface ProjectRelinkDeps {
  db: Database.Database;
  /**
   * What a look at a folder finds. A seam for the same reason every other one
   * here is: a relink is judged against the disk, and a suite that has to
   * create and move real checkouts to state a rule is not a suite.
   */
  probeFolder?: ProbeFolder;
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
  /** Renames the worktree container. Defaults to {@link rename}. */
  moveDirectory?: (from: string, to: string) => Promise<void>;
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
 * could not follow the row by themselves.
 */
export async function relinkProject(
  deps: ProjectRelinkDeps,
  request: ProjectRelinkRequest,
): Promise<ProjectRelinkOutcome> {
  const probeFolder = deps.probeFolder ?? probeFolderOnDisk;
  const now = deps.now ?? Date.now;

  const project = getProjectById(deps.db, request.projectId);
  if (project === undefined) return { ok: false, error: "Unknown project" };

  const candidatePath = resolve(request.path);
  const candidate = await probeFolder(candidatePath);
  // Asked BEFORE the write, and about the folder being left behind: that is
  // where a live terminal or agent actually is, and the row is about to stop
  // naming it. Reading it here also closes the window the validation would
  // otherwise sit open across — nothing is awaited between the judgement and
  // the write.
  const liveSessions = await countLiveSessionsIn(deps, project.path);
  const subjects = await identifiedProjects(listProjects(deps.db), probeFolder);

  const validation = validateProjectRelink({
    project,
    candidatePath,
    candidateState: candidate.state,
    candidateFolder: candidate.folder,
    projects: subjects,
  });
  if (!validation.ok) {
    return { ok: false, error: validation.error, refusal: validation.refusal };
  }

  const relinked = updateProjectPath(deps.db, project.id, validation.path, now());
  // `getProjectById` answered for this id a moment ago and nothing deletes a
  // project between there and here; this is the type narrowing, not a branch.
  /* v8 ignore next */
  if (relinked === undefined) return { ok: false, error: "Unknown project" };

  const container = await moveWorktreeContainer(deps, project, validation.path, now());
  // Only the checkouts still on disk. A row whose directory was deleted is not
  // something git can repair, and counting it would promise a person a
  // reconnection that never happened.
  const worktrees = await presentFolders(container.worktrees, probeFolder);

  return {
    ok: true,
    project: relinked,
    aftermath: {
      liveSessions,
      worktrees: worktrees.length,
      worktreesRepaired: await repairWorktreeLinks(deps, validation.path, {
        worktrees,
        relocated: container.relocated.filter((path) => worktrees.includes(path)),
      }),
      containerMoveNeeded: container.needed,
      containerMoved: container.moved,
    },
  };
}

/** Those of `paths` a look at the disk still finds. */
async function presentFolders(
  paths: readonly string[],
  probeFolder: ProbeFolder,
): Promise<readonly string[]> {
  const probes = await Promise.all(paths.map(async (path) => (await probeFolder(path)).state));
  return paths.filter((_, index) => probes[index] !== "missing");
}

/**
 * Every tracked project with the folder its path actually names.
 *
 * The identities are what let the shared rule refuse a folder another project
 * already tracks under a DIFFERENT spelling — a case-only difference on a
 * case-insensitive volume, or a symlink. A project whose folder is missing
 * reports no identity and falls back to its path, which is right: a row
 * pointing at nothing cannot claim a folder by identity.
 */
async function identifiedProjects(
  projects: readonly Project[],
  probeFolder: ProbeFolder,
): Promise<readonly ProjectRelinkSubject[]> {
  return Promise.all(
    projects.map(async (project) => ({
      id: project.id,
      name: project.name,
      path: project.path,
      folder: (await probeFolder(project.path)).folder,
    })),
  );
}

/**
 * How many live execution surfaces are working at or under `directory`.
 *
 * Filtered through {@link busySiteWithin} rather than trusted as scoped, for
 * the reason that helper documents: terminals are reported unscoped, because a
 * live PTY holds whatever cwd it holds. Absent supplier means none — a warning
 * nobody can substantiate is worse than no warning.
 *
 * One site at a time because the helper answers WHICH site is in the way, not
 * how many: the destructive guards need the first one to name it in a refusal,
 * and this needs the count to put a number in a warning.
 */
async function countLiveSessionsIn(deps: ProjectRelinkDeps, directory: string): Promise<number> {
  if (deps.busyWorktreeSites === undefined) return 0;
  const sites = await deps.busyWorktreeSites(directory);
  return sites.filter((site) => busySiteWithin(directory, [site]) !== null).length;
}

/** What became of the container a project's ticket worktrees live in. */
interface ContainerMove {
  /** Whether the project's new folder name means the container has to move. */
  needed: boolean;
  /** Whether it did. `true` when no move was needed. */
  moved: boolean;
  /** Where this project's ticket worktrees are NOW, as the rows say. */
  worktrees: readonly string[];
  /**
   * Those of {@link worktrees} that are somewhere new. These are the only ones
   * git cannot find by itself, so they are the only ones it has to be told
   * about — see {@link repairWorktreeLinks}.
   */
  relocated: readonly string[];
}

/**
 * Moves the worktree container so it keeps matching the project it belongs to.
 *
 * A ticket worktree lives at
 * `~/.volli/worktrees/<project-dirname>-<short-id>/<TICKET>-<slug>`, and
 * OWNERSHIP is decided by recomputing that container name from the project row
 * (`worktree/containers.ts`, VC-113). Rename the project folder and the name
 * the app computes stops matching the directory the worktrees are actually in
 * — so every destructive worktree path stops recognising them as this
 * database's: `remove.ts` refuses to delete an untracked checkout, the
 * orphan-delete channel refuses, and the orphan scan cannot see the container
 * at all, which leaves those checkouts unreclaimable.
 *
 * Renaming the container is what keeps VC-113's rule intact rather than
 * widening it: after the move, the container the app computes IS the container
 * on disk, so ownership needs no special case for a project that was renamed
 * once. The short id in the middle never changes, so the move can never take
 * another install's container with it.
 *
 * A live Session inside a moved worktree keeps working — a POSIX cwd follows
 * the directory, not the path it was opened under — and the stale path it
 * reports is already covered by the `sessions-keep-old-cwd` notice. A failed
 * move is reported, never thrown: the relink has committed, and leaving the
 * worktrees where they are costs cleanup, not work.
 */
async function moveWorktreeContainer(
  deps: ProjectRelinkDeps,
  project: Project,
  newPath: string,
  now: number,
): Promise<ContainerMove> {
  const sites = listWorktreeSitesByProject(deps.db, project.id);
  const oldName = projectContainerName(project.path, project.id);
  const newName = projectContainerName(newPath, project.id);
  const paths = sites.map((site) => site.path);
  if (oldName === newName || sites.length === 0) {
    return { needed: oldName !== newName, moved: true, worktrees: paths, relocated: [] };
  }

  // Only the worktrees actually sitting in the container this project owns
  // move. A row stamped somewhere else entirely (a hand-made checkout, a path
  // from before a container convention changed) is not this move's business.
  const containers = new Set(sites.map((site) => dirname(site.path)));
  const source = [...containers].find((path) => basename(path) === oldName);
  if (source === undefined) return { needed: true, moved: false, worktrees: paths, relocated: [] };
  const target = join(dirname(source), newName);

  const moveDirectory = deps.moveDirectory ?? rename;
  try {
    await moveDirectory(source, target);
  } catch {
    return { needed: true, moved: false, worktrees: paths, relocated: [] };
  }

  // The rows are stamped with absolute paths and read back verbatim forever
  // after (`resolveWorktreeIdentity`), so the directories moving is only half
  // the move: without this the app would go on opening the path it just left.
  // A row outside the container keeps the path it had — nothing moved it.
  const relocated: string[] = [];
  const worktrees = sites.map((site) => {
    if (dirname(site.path) !== source) return site.path;
    const path = join(target, basename(site.path));
    updateTicketFields(deps.db, site.ticketId, { worktreePath: path }, now);
    relocated.push(path);
    return path;
  });
  return { needed: true, moved: true, worktrees, relocated };
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
 * Only the worktrees that MOVED are named. Git's documentation is explicit that
 * a worktree which has moved must be named for repair to find it, and equally
 * that the bare command is the fix when the repository is what moved — so
 * naming a path git can already reach adds nothing, and naming one that is not
 * a linked worktree at all (a row stamped by hand, or by an older convention)
 * would put a failure in front of a person about a directory the relink never
 * touched.
 *
 * A project with no worktrees is not asked: there is nothing to repair, and a
 * repository that is not a git checkout at all (a project can be any folder)
 * would fail the command for a reason nobody needs telling about. A failure is
 * reported, never thrown — the relink itself has already committed, and the
 * notice tells the person the one command that finishes it.
 */
async function repairWorktreeLinks(
  deps: ProjectRelinkDeps,
  projectPath: string,
  found: { worktrees: readonly string[]; relocated: readonly string[] },
): Promise<boolean> {
  if (found.worktrees.length === 0) return true;
  const gitAsync = deps.gitAsync ?? runGitCapturingAsync;
  try {
    await gitAsync(["worktree", "repair", ...found.relocated], projectPath);
    return true;
  } catch {
    return false;
  }
}
