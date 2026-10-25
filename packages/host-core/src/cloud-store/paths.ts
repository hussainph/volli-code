import { isAbsolute } from "node:path";
import type Database from "better-sqlite3";

import { prepared } from "../db/prepared";
import { withTransaction } from "../db/transaction-gate";
import { canonicalize, isInside } from "../worktree/paths";

export interface CheckoutPath {
  projectRepoId: string;
  projectId: string;
  runnerId: string;
  absPath: string;
  kind: "main" | "managed_clone";
  adoptedFromFrozen: boolean;
}

export interface WorkingCopyPath {
  workingCopyId: string | null;
  kind: "worktree" | "main_checkout";
  /** Machine-observed git identity survives reclamation and title edits. */
  branch: string | null;
  baseBranch: string | null;
  headSha: string | null;
  ticketId: string;
  projectRepoId: string;
  runnerId: string;
  absPath: string;
  adoptedFromFrozen: boolean;
}

export class RunnerPathCollision extends Error {
  readonly code = "runner_path_collision";
  constructor() {
    super(
      "This folder is already registered to another working copy or runner. Choose another folder.",
    );
    this.name = "RunnerPathCollision";
  }
}

interface CheckoutRow {
  project_repo_id: string;
  project_id: string;
  runner_id: string;
  abs_path: string;
  kind: CheckoutPath["kind"];
  adopted_from_frozen: number;
}
interface WorkingCopyRow {
  working_copy_id: string | null;
  kind: WorkingCopyPath["kind"];
  branch: string | null;
  base_branch: string | null;
  head_sha: string | null;
  ticket_id: string;
  project_repo_id: string;
  runner_id: string;
  abs_path: string;
  adopted_from_frozen: number;
}
const checkoutFromRow = (row: CheckoutRow): CheckoutPath => ({
  projectRepoId: row.project_repo_id,
  projectId: row.project_id,
  runnerId: row.runner_id,
  absPath: row.abs_path,
  kind: row.kind,
  adoptedFromFrozen: row.adopted_from_frozen !== 0,
});
const copyFromRow = (row: WorkingCopyRow): WorkingCopyPath => ({
  workingCopyId: row.working_copy_id,
  kind: row.kind,
  branch: row.branch,
  baseBranch: row.base_branch,
  headSha: row.head_sha,
  ticketId: row.ticket_id,
  projectRepoId: row.project_repo_id,
  runnerId: row.runner_id,
  absPath: row.abs_path,
  adoptedFromFrozen: row.adopted_from_frozen !== 0,
});

/**
 * A registry belongs to one runner identity, not the current account globally.
 * Adoption copies frozen pointers verbatim and never updates a board row.
 * Missing/nonabsolute shadow pointers are not folders a runner may adopt.
 */
export function createRunnerPathRegistry(db: Database.Database, options: { runnerId: string }) {
  const { runnerId } = options;
  if (runnerId.length === 0) throw new Error("A runner identity is required for local paths.");

  function assertAvailable(
    absPath: string,
    identity: {
      projectRepoId: string;
      ticketId: string | null;
      kind: "checkout" | WorkingCopyPath["kind"];
    },
  ): void {
    if (!isAbsolute(absPath)) throw new Error("Choose an absolute folder path.");
    const path = canonicalize(absPath);
    const paths = prepared<
      [],
      {
        runner_id: string;
        project_repo_id: string;
        ticket_id: string | null;
        abs_path: string;
        kind: "checkout" | WorkingCopyPath["kind"];
      }
    >(
      db,
      `SELECT runner_id, project_repo_id, NULL AS ticket_id, abs_path, 'checkout' AS kind FROM project_checkout_paths
      UNION ALL SELECT runner_id, project_repo_id, ticket_id, abs_path, kind FROM working_copy_paths`,
    ).all();
    for (const row of paths) {
      const sameRepo = row.runner_id === runnerId && row.project_repo_id === identity.projectRepoId;
      if (sameRepo && row.ticket_id === identity.ticketId) continue;
      const other = canonicalize(row.abs_path);
      const samePath = path === other;
      if (!samePath && !isInside(path, other) && !isInside(other, path)) continue;
      if (sameRepo) {
        const checkout = identity.kind !== "worktree";
        const otherCheckout = row.kind !== "worktree";
        // Main-checkout copies share only their own registered checkout, which
        // assertMainCopyPath validates before reaching this collision check.
        if (samePath && checkout && otherCheckout) continue;
        // A checkout/main copy is never a housekeeping target. It may contain
        // its repo's worktree, but a worktree must not contain another copy or
        // a checkout: removing its ignored content could destroy their work.
        if (!samePath && checkout && !otherCheckout && isInside(path, other)) continue;
        if (!samePath && !checkout && otherCheckout && isInside(other, path)) continue;
      }
      // Cross-runner overlaps and distinct nested worktrees always refuse.
      throw new RunnerPathCollision();
    }
  }

  function assertMainCopyPath(projectRepoId: string, absPath: string): void {
    const checkout = prepared<[string, string], { abs_path: string }>(
      db,
      "SELECT abs_path FROM project_checkout_paths WHERE runner_id = ? AND project_repo_id = ?",
    ).get(runnerId, projectRepoId);
    if (!checkout)
      throw new Error("Register this repository's checkout before its main-checkout Working copy.");
    if (canonicalize(checkout.abs_path) !== canonicalize(absPath)) throw new RunnerPathCollision();
  }

  function assertMainCopiesAt(projectRepoId: string, absPath: string): void {
    const copies = prepared<[string, string], { abs_path: string }>(
      db,
      "SELECT abs_path FROM working_copy_paths WHERE runner_id = ? AND project_repo_id = ? AND kind = 'main_checkout'",
    ).all(runnerId, projectRepoId);
    if (copies.some((copy) => canonicalize(copy.abs_path) !== canonicalize(absPath)))
      throw new Error(
        "This checkout has main-checkout Working copies; its folder cannot be remapped.",
      );
  }

  function getCheckout(projectId: string, projectRepoId: string): CheckoutPath | null {
    const row = prepared<[string, string], CheckoutRow>(
      db,
      "SELECT * FROM project_checkout_paths WHERE runner_id = ? AND project_repo_id = ?",
    ).get(runnerId, projectRepoId);
    if (!row) return null;
    if (row.project_id !== projectId)
      throw new Error("This repository belongs to another project.");
    return checkoutFromRow(row);
  }
  function registerCheckout(input: {
    projectId: string;
    projectRepoId: string;
    absPath: string;
    kind?: CheckoutPath["kind"];
    adoptedFromFrozen?: boolean;
  }): CheckoutPath {
    return withTransaction(db, () => {
      const existing = getCheckout(input.projectId, input.projectRepoId);
      assertMainCopiesAt(input.projectRepoId, input.absPath);
      assertAvailable(input.absPath, {
        projectRepoId: input.projectRepoId,
        ticketId: null,
        kind: "checkout",
      });
      prepared(
        db,
        `INSERT INTO project_checkout_paths
      (project_repo_id, project_id, runner_id, abs_path, kind, adopted_from_frozen)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(runner_id, project_repo_id) DO UPDATE SET
      abs_path = excluded.abs_path, kind = excluded.kind,
      adopted_from_frozen = excluded.adopted_from_frozen`,
      ).run(
        input.projectRepoId,
        input.projectId,
        runnerId,
        input.absPath,
        input.kind ?? existing?.kind ?? "main",
        (input.adoptedFromFrozen ?? existing?.adoptedFromFrozen ?? false) ? 1 : 0,
      );
      return getCheckout(input.projectId, input.projectRepoId)!;
    });
  }
  function checkoutPathOf(projectId: string, projectRepoId: string): string | null {
    const found = getCheckout(projectId, projectRepoId);
    if (found) {
      assertMainCopiesAt(projectRepoId, found.absPath);
      assertAvailable(found.absPath, { projectRepoId, ticketId: null, kind: "checkout" });
      return found.absPath;
    }
    const frozen = prepared<[string], { path: string }>(
      db,
      "SELECT path FROM projects WHERE id = ? AND NOT EXISTS (SELECT 1 FROM cloud_shadow_rows WHERE kind = 'project' AND id = projects.id)",
    ).get(projectId);
    if (!frozen?.path || !isAbsolute(frozen.path)) return null;
    return registerCheckout({
      projectId,
      projectRepoId,
      absPath: frozen.path,
      adoptedFromFrozen: true,
    }).absPath;
  }
  /**
   * The folder this runner would start a project's Sessions from, named
   * without touching anything: its registered checkout (lowest repository id
   * first), else the absolute folder of a frozen local project with the same
   * id that {@link checkoutPathOf} would adopt. A shadow row is never one.
   * Read-only: adoption, collision and on-disk checks stay with
   * {@link checkoutPathOf} and the callers.
   */
  function checkoutOfProject(projectId: string): { absPath: string; adoptable: boolean } | null {
    const registered = prepared<[string, string], { abs_path: string }>(
      db,
      "SELECT abs_path FROM project_checkout_paths WHERE runner_id = ? AND project_id = ? ORDER BY project_repo_id LIMIT 1",
    ).get(runnerId, projectId);
    if (registered) return { absPath: registered.abs_path, adoptable: false };
    const frozen = prepared<[string], { path: string }>(
      db,
      "SELECT path FROM projects WHERE id = ? AND NOT EXISTS (SELECT 1 FROM cloud_shadow_rows WHERE kind = 'project' AND id = projects.id)",
    ).get(projectId);
    if (!frozen?.path || !isAbsolute(frozen.path)) return null;
    return { absPath: frozen.path, adoptable: true };
  }
  function getCopy(ticketId: string, projectRepoId: string): WorkingCopyPath | null {
    const row = prepared<[string, string, string], WorkingCopyRow>(
      db,
      "SELECT * FROM working_copy_paths WHERE runner_id = ? AND ticket_id = ? AND project_repo_id = ?",
    ).get(runnerId, ticketId, projectRepoId);
    return row ? copyFromRow(row) : null;
  }
  function registerCopy(input: {
    ticketId: string;
    projectRepoId: string;
    absPath: string;
    workingCopyId?: string | null;
    kind?: WorkingCopyPath["kind"];
    branch?: string | null;
    baseBranch?: string | null;
    headSha?: string | null;
    adoptedFromFrozen?: boolean;
  }): WorkingCopyPath {
    return withTransaction(db, () => {
      const existing = getCopy(input.ticketId, input.projectRepoId);
      const kind = input.kind ?? existing?.kind ?? "worktree";
      if (kind === "main_checkout") assertMainCopyPath(input.projectRepoId, input.absPath);
      assertAvailable(input.absPath, {
        projectRepoId: input.projectRepoId,
        ticketId: input.ticketId,
        kind,
      });
      if (
        existing?.workingCopyId &&
        input.workingCopyId &&
        existing.workingCopyId !== input.workingCopyId
      )
        throw new Error("This working copy is already registered with another identity.");
      prepared(
        db,
        `INSERT INTO working_copy_paths
      (working_copy_id, ticket_id, project_repo_id, runner_id, abs_path, adopted_from_frozen, branch, base_branch, head_sha, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(runner_id, ticket_id, project_repo_id) DO UPDATE SET
      working_copy_id = excluded.working_copy_id, abs_path = excluded.abs_path,
      adopted_from_frozen = excluded.adopted_from_frozen, branch = excluded.branch,
      base_branch = excluded.base_branch, head_sha = excluded.head_sha, kind = excluded.kind`,
      ).run(
        input.workingCopyId ?? existing?.workingCopyId ?? null,
        input.ticketId,
        input.projectRepoId,
        runnerId,
        input.absPath,
        (input.adoptedFromFrozen ?? existing?.adoptedFromFrozen ?? false) ? 1 : 0,
        input.branch === undefined ? (existing?.branch ?? null) : input.branch,
        input.baseBranch === undefined ? (existing?.baseBranch ?? null) : input.baseBranch,
        input.headSha === undefined ? (existing?.headSha ?? null) : input.headSha,
        kind,
      );
      return getCopy(input.ticketId, input.projectRepoId)!;
    });
  }
  function copyPathOf(ticketId: string, projectRepoId: string): string | null {
    const found = getCopy(ticketId, projectRepoId);
    if (found) {
      if (found.kind === "main_checkout") assertMainCopyPath(projectRepoId, found.absPath);
      assertAvailable(found.absPath, { projectRepoId, ticketId, kind: found.kind });
      return found.absPath;
    }
    const frozen = prepared<
      [string],
      {
        project_id: string;
        uses_worktree: number;
        worktree_path: string | null;
        branch: string | null;
        base_branch: string | null;
      }
    >(
      db,
      "SELECT project_id, uses_worktree, worktree_path, branch, base_branch FROM tickets WHERE id = ? AND NOT EXISTS (SELECT 1 FROM cloud_shadow_rows WHERE kind = 'ticket' AND id = tickets.id)",
    ).get(ticketId);
    if (!frozen) return null;
    if (frozen.uses_worktree === 0) {
      const checkoutPath = checkoutPathOf(frozen.project_id, projectRepoId);
      if (!checkoutPath) return null;
      return registerCopy({
        ticketId,
        projectRepoId,
        absPath: checkoutPath,
        kind: "main_checkout",
        baseBranch: frozen.base_branch,
        adoptedFromFrozen: true,
      }).absPath;
    }
    if (!frozen.worktree_path || !isAbsolute(frozen.worktree_path)) return null;
    return registerCopy({
      ticketId,
      projectRepoId,
      absPath: frozen.worktree_path,
      branch: frozen.branch,
      baseBranch: frozen.base_branch,
      adoptedFromFrozen: true,
    }).absPath;
  }
  return {
    runnerId,
    checkouts: {
      pathOf: checkoutPathOf,
      get: getCheckout,
      register: registerCheckout,
      ofProject: checkoutOfProject,
    },
    workingCopies: {
      pathOf: copyPathOf,
      get: getCopy,
      register: registerCopy,
      list: (): WorkingCopyPath[] =>
        prepared<[string], WorkingCopyRow>(
          db,
          "SELECT * FROM working_copy_paths WHERE runner_id = ? ORDER BY ticket_id, project_repo_id",
        )
          .all(runnerId)
          .map(copyFromRow),
    },
  };
}

export type RunnerPathRegistry = ReturnType<typeof createRunnerPathRegistry>;
