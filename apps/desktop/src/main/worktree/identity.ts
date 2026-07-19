/**
 * Worktree path + branch resolution (worktree-support §3.1). Both are stamped
 * ONCE at first creation and thereafter win verbatim from the persisted ticket
 * row — a title edit never renames a live worktree's directory or branch
 * (CONTEXT: "named once at creation"). The branch uses the shared, tested
 * `ticketBranchName`; the path is app-owned, outside both the repo and
 * Electron's `userData`:
 *
 *   <home>/.volli/worktrees/<project-dirname>-<short-id>/<DISPLAY-ID>-<slug>/
 *
 * where `project-dirname` is the basename of the main checkout, `short-id` the
 * first 8 chars of the project UUID (disambiguating same-named repos), and
 * `slug` the same `slugify` the branch name uses.
 */
import { basename, join } from "node:path";

import { slugify, ticketBranchName } from "@volli/shared";

export interface WorktreeIdentityInput {
  /** `~` (or its test override). */
  home: string;
  /** The MAIN checkout's absolute path. */
  projectPath: string;
  /** The project's opaque UUID (first 8 chars become the dir short-id). */
  projectId: string;
  /** The ticket's display id, e.g. `"VC-12"`. */
  displayId: string;
  /** The ticket title (slugified into path + branch). */
  title: string;
  /** Persisted `ticket.worktree_path`, or `null` — wins verbatim when set. */
  persistedPath: string | null;
  /** Persisted `ticket.branch`, or `null` — wins verbatim when set. */
  persistedBranch: string | null;
}

export interface ResolvedWorktreeIdentity {
  path: string;
  branch: string;
}

/** Strips a single trailing slash so `basename` never returns `""`. */
function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/** The leaf dir name for a ticket: `<DISPLAY-ID>-<slug>`, or just `<DISPLAY-ID>` when the slug is empty. */
function worktreeLeaf(displayId: string, title: string): string {
  const slug = slugify(title);
  return slug ? `${displayId}-${slug}` : displayId;
}

/** The per-project container dir name: `<project-dirname>-<short-id>`. */
function projectContainer(projectPath: string, projectId: string): string {
  const dirname = basename(stripTrailingSlash(projectPath));
  const shortId = projectId.slice(0, 8);
  return `${dirname}-${shortId}`;
}

/**
 * Resolves the worktree's identity. Persisted values (already stamped on the
 * ticket row) always win — computation only happens for a ticket that has
 * never had a worktree, so the directory/branch are frozen at first creation.
 */
export function resolveWorktreeIdentity(input: WorktreeIdentityInput): ResolvedWorktreeIdentity {
  const branch = input.persistedBranch ?? ticketBranchName(input.displayId, input.title);
  const path =
    input.persistedPath ??
    join(
      input.home,
      ".volli",
      "worktrees",
      projectContainer(input.projectPath, input.projectId),
      worktreeLeaf(input.displayId, input.title),
    );
  return { path, branch };
}
