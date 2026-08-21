/**
 * Where a file path named by a chat actually opens (VC-120 §5.1).
 *
 * Activity rows and file mentions carry the RAW tool-input path — absolute or
 * relative, pointing at whichever checkout the agent was standing in. The old
 * behavior handed that string straight to a file API that speaks
 * project-relative paths only, so an absolute path failed as "Invalid file
 * path" and a worktree-only file resolved against the main checkout and
 * rendered raw ENOENT text. This module is the missing translation: one pure
 * decision, taken before any store or IPC is touched.
 *
 * The rules, in order:
 *
 *  1. A RELATIVE path means "in my venue". A ticket chat's venue is its
 *     worktree; a project chat's is the main checkout. The scope answers it —
 *     deliberately no cross-checkout guessing: a bare `src/x.ts` from a project
 *     session that happened to `cd` into a worktree is ambiguous, and a
 *     deterministic wrong-checkout read that fails with honest copy beats a
 *     heuristic that silently opens a different file than the transcript meant.
 *  2. An ABSOLUTE path is resolved by containment: a known ticket worktree
 *     wins first (most specific root), then the project's main checkout.
 *     Worktree hits carry their ticket, so the caller can land the tab in that
 *     ticket's workspace — the transcript pointed there by name.
 *  3. Anything else is `outside`: a path this project cannot open. The caller
 *     says so and navigates nowhere, instead of opening a pane whose only
 *     content is an error.
 *
 * Containment reuses {@link toProjectRelPath} — the same normalize-and-prefix
 * test the sidebar tree trusts, including its sibling-root guard (`/repo` must
 * not claim `/repo-old`). String-only and macOS-shaped like that module; main
 * still re-validates every relPath it is handed.
 */
import { toProjectRelPath } from "./project-rel-path";

/** One ticket whose worktree exists, per the board's current knowledge. */
export interface ChatWorktreeRef {
  ticketId: string;
  /** Absolute path of the ticket's live worktree (`Ticket.worktreePath`). */
  worktreePath: string;
}

/** Which venue the chat that named the path runs in. */
export type ChatOpenScope = { kind: "project" } | { kind: "ticket"; ticketId: string };

export type ChatOpenTarget =
  /** Open in the Project Files workbench (main checkout). */
  | { kind: "project-file"; relPath: string }
  /** Open as `ticketId`'s file tab (resolves through its worktree seam). */
  | { kind: "ticket-file"; ticketId: string; relPath: string }
  /** Not openable by this project — tell the user, navigate nowhere. */
  | { kind: "outside"; path: string };

/** A single leading `./` stripped — tool inputs spell venue-relative paths both ways. */
function stripDotSlash(path: string): string {
  return path.startsWith("./") ? path.slice(2) : path;
}

/**
 * Decides the open target for a chat-named `path`. Pure; see the module doc
 * for the rules. `worktrees` entries whose root contains the path win over the
 * project root, first match in array order — callers pass the board's ticket
 * list, and two live worktrees never nest inside one another.
 */
export function resolveChatOpenTarget(input: {
  path: string;
  projectPath: string;
  worktrees: readonly ChatWorktreeRef[];
  scope: ChatOpenScope;
}): ChatOpenTarget {
  const { path, projectPath, worktrees, scope } = input;

  if (!path.startsWith("/")) {
    const relPath = stripDotSlash(path);
    // A relative path that strips to nothing ("." / "./") names a directory,
    // not a file — nothing a file tab can show.
    if (relPath.length === 0 || relPath === ".") return { kind: "outside", path };
    return scope.kind === "ticket"
      ? { kind: "ticket-file", ticketId: scope.ticketId, relPath }
      : { kind: "project-file", relPath };
  }

  for (const worktree of worktrees) {
    const relPath = toProjectRelPath(worktree.worktreePath, path);
    // The empty relPath is the worktree root itself — a directory.
    if (relPath !== null && relPath.length > 0) {
      return { kind: "ticket-file", ticketId: worktree.ticketId, relPath };
    }
  }

  const relPath = toProjectRelPath(projectPath, path);
  if (relPath !== null && relPath.length > 0) {
    // In a ticket workspace the honest copy of a repo path is the worktree's —
    // exactly how the same relPath already behaves when spelled relatively.
    return scope.kind === "ticket"
      ? { kind: "ticket-file", ticketId: scope.ticketId, relPath }
      : { kind: "project-file", relPath };
  }

  return { kind: "outside", path };
}
