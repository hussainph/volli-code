/**
 * Worktree OWNERSHIP (VC-113). `~/.volli/worktrees` is a shared address, not a
 * possession: the leaf a ticket gets is
 *
 *   <home>/.volli/worktrees/<project-dirname>-<projectId[0..8]>/<TICKET>-<slug>
 *
 * and the short id in the middle comes from the project row of ONE database.
 * Two installs that track the same repo (a release build and a `pnpm dev`
 * build, each with its own userData) therefore hold two DIFFERENT containers
 * under the SAME root — and every destructive path here used to gate on the
 * root, asking only "is this under `~/.volli/worktrees`?" before deleting.
 *
 * That question cannot distinguish "mine" from "the other install's", so each
 * app deleted the other's checkouts on launch: the sweep saw a git-registered
 * worktree with no row in ITS database, called it an orphan, and removed it —
 * leaving the owning database still pointing at a path that no longer existed,
 * with no event and no trace (that is VC-113's 44 vanished worktrees).
 *
 * So ownership gets a name. A container is ours when it is the container OUR
 * project rows compute; anything else under the root belongs to somebody else's
 * database and is not ours to remove, report, or offer for deletion — exactly
 * the stance {@link import("./sweep").sweepOrphans} already took toward a
 * worktree outside the root entirely.
 */
import { basename, join } from "node:path";
import type Database from "better-sqlite3";

import { listProjects } from "../db/projects-repo";
import { isInside } from "./paths";

/** Strips a single trailing slash so `basename` never returns `""`. */
function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/**
 * The per-project container dir NAME: `<project-dirname>-<short-id>`. The short
 * id disambiguates same-named repos within one database — and, as VC-113 found,
 * the same repo across two databases.
 */
export function projectContainerName(projectPath: string, projectId: string): string {
  return `${basename(stripTrailingSlash(projectPath))}-${projectId.slice(0, 8)}`;
}

/** The app-owned worktree root: `<home>/.volli/worktrees`. */
export function worktreesRoot(home: string): string {
  return join(home, ".volli", "worktrees");
}

/** The absolute container dir a project's worktrees live in. */
export function projectContainerPath(home: string, projectPath: string, projectId: string): string {
  return join(worktreesRoot(home), projectContainerName(projectPath, projectId));
}

/** One tracked project's container, paired with the project id for reporting. */
export interface OwnedContainer {
  projectId: string;
  path: string;
}

/**
 * Every container THIS database owns — one per tracked project. The allow-list
 * every destructive worktree path gates on; a container missing from it is
 * another install's (or another project's) and stays untouched.
 */
export function ownedContainers(db: Database.Database, home: string): OwnedContainer[] {
  return listProjects(db).map((project) => ({
    projectId: project.id,
    path: projectContainerPath(home, project.path, project.id),
  }));
}

/**
 * Whether `target` is a leaf INSIDE `container` — strictly. A path equal to the
 * container itself is not a worktree and answers `false`: deleting a container
 * would take every ticket's checkout with it, which no route may do in one act.
 * Every destructive path (sweep, remove, orphan-delete) gates on THIS question,
 * so the two containment rules cannot drift apart.
 */
export function isOwnedWorktreeLeaf(container: OwnedContainer, target: string): boolean {
  return isInside(container.path, target) && !isInside(target, container.path);
}

/**
 * Whether `target` is a leaf INSIDE one of `containers` — a worktree directory
 * this database owns.
 */
export function isOwnedWorktreePath(
  containers: readonly OwnedContainer[],
  target: string,
): boolean {
  return containers.some((container) => isOwnedWorktreeLeaf(container, target));
}
