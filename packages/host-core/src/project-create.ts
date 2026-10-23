/**
 * Registering a folder as a project: the one validation every door applies.
 *
 * Lifted out of desktop's `volli:project-create` handler (VC-623) so the
 * operator's `volli project add` on a headless host registers a project by
 * exactly the rules the app's Add Project does, rather than by a second copy of
 * them: a folder already tracked answers with its project, the path must be an
 * existing directory, the base branch is detected, and the ticket prefix the
 * name derives must be unique across the workspace.
 *
 * A folder whose project was removed is re-attached rather than registered
 * again (VC-822): removal only detaches a project, so its tickets, Sessions,
 * ticket counter and Automations come back with it. A removed project keeps
 * its prefix for that return: a new project may not take it.
 *
 * The `stat` and the branch detection are awaited, never blocking: desktop
 * runs this on Electron main, and a folder on an unmounted volume is where a
 * synchronous read freezes the window.
 */
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";

import type Database from "better-sqlite3";
import { derivePrefix, PROJECT_COLORS, validateUniquePrefix } from "@volli/shared";
import type { Project } from "@volli/shared";

import {
  countProjects,
  findProjectByPath,
  findRemovedProjectByPrefix,
  getProjectById,
  insertProject,
  isProjectAttached,
  listProjects,
  nextSortOrder,
  reattachProject,
} from "./db/projects-repo";
import { detectProjectBaseBranchAsync } from "./project-base-branch";

export interface ProjectCreateRequest {
  /** The folder, exactly as the door received it; desktop's picker hands an absolute path. */
  readonly path: string;
  readonly name: string;
}

/** The project, and whether this call created it or found it already tracked at `path`. */
export type ProjectCreateOutcome =
  | { readonly ok: true; readonly project: Project; readonly created: boolean }
  | { readonly ok: false; readonly error: string };

export interface ProjectCreatePorts {
  readonly db: Database.Database;
  /** Defaults to {@link detectProjectBaseBranchAsync}; tests script it. */
  readonly detectBaseBranch?: (path: string) => Promise<string | null>;
  readonly now?: () => number;
  readonly newId?: () => string;
  /**
   * Announces a committed registration once: a new row, or a removed project
   * re-attached. Never a project already on the rail, and never a preview.
   */
  readonly onCreated?: (project: Project) => void;
}

/**
 * What a registration decided: the project already tracked at the path, a
 * refusal, the removed project at the path put back on the rail, or the new
 * row. A preview writes neither of the last two.
 */
export type ProjectCreatePlan =
  | { readonly kind: "existing"; readonly project: Project }
  | { readonly kind: "refused"; readonly error: string }
  | { readonly kind: "reattached"; readonly project: Project }
  | { readonly kind: "new"; readonly project: Project };

/**
 * Judges a registration and, when `write` is set, commits it.
 *
 * One function for both because a preview (`volli project add --dry-run`) must
 * run the same validation as the write, and because the insert has to follow
 * the last read with no `await` between them: branch detection yields, and a
 * second registration of the same folder could otherwise land in that gap.
 */
export async function planProjectCreate(
  ports: ProjectCreatePorts,
  input: ProjectCreateRequest,
  options: { readonly write: boolean },
): Promise<ProjectCreatePlan> {
  const { db } = ports;
  const existing = findProjectByPath(db, input.path);
  if (existing && isProjectAttached(db, existing.id))
    return { kind: "existing", project: existing };
  let stats;
  try {
    stats = await stat(input.path);
  } catch {
    return { kind: "refused", error: "Project path does not exist" };
  }
  if (!stats.isDirectory()) return { kind: "refused", error: "Project path is not a directory" };
  if (existing) return reattach(ports, existing.id, options);
  const baseBranch = await (ports.detectBaseBranch ?? detectProjectBaseBranchAsync)(input.path);
  // Detection yields to other requests. Re-read mutable project state only
  // after it returns, then validate and insert without another await.
  const createdWhileDetecting = findProjectByPath(db, input.path);
  if (createdWhileDetecting) return { kind: "existing", project: createdWhileDetecting };
  const ticketPrefix = derivePrefix(input.name);
  const prefixValidation = validateUniquePrefix(ticketPrefix, listProjects(db));
  if (!prefixValidation.ok) return { kind: "refused", error: prefixValidation.error };
  // A removed project keeps its prefix (VC-822): taking it here would leave
  // that project's folder impossible to add again.
  const removedHolder = findRemovedProjectByPrefix(db, ticketPrefix);
  if (removedHolder !== undefined) {
    return {
      kind: "refused",
      error: `Ticket prefix "${ticketPrefix}" is used by ${removedHolder.name}, which was removed. Add its folder again first.`,
    };
  }
  const now = (ports.now ?? Date.now)();
  const project: Project = {
    id: (ports.newId ?? randomUUID)(),
    name: input.name,
    path: input.path,
    ticketPrefix,
    baseBranch,
    colorIndex: countProjects(db) % PROJECT_COLORS.length,
    sortOrder: nextSortOrder(db),
    createdAt: now,
    updatedAt: now,
  };
  if (options.write) {
    insertProject(db, project);
    ports.onCreated?.(project);
  }
  return { kind: "new", project };
}

/**
 * The removed project at the folder, put back on the rail with its own id,
 * base branch and ticket counter. Asked again after the `stat` yielded, with
 * no await from here to the write: a concurrent add may have re-attached it
 * already. Its ticket prefix has to still be its own on the rail. A new
 * project cannot take a removed one's, but an older build, which does not see
 * the removal, can; two projects on the rail with one prefix would make every
 * display id ambiguous.
 */
function reattach(
  ports: ProjectCreatePorts,
  removedId: string,
  options: { readonly write: boolean },
): ProjectCreatePlan {
  const { db } = ports;
  const current = getProjectById(db, removedId)!;
  if (isProjectAttached(db, removedId)) return { kind: "existing", project: current };
  const prefixValidation = validateUniquePrefix(current.ticketPrefix, listProjects(db), removedId);
  if (!prefixValidation.ok) return { kind: "refused", error: prefixValidation.error };
  if (!options.write) return { kind: "reattached", project: current };
  reattachProject(db, removedId, (ports.now ?? Date.now)());
  const project = getProjectById(db, removedId)!;
  ports.onCreated?.(project);
  return { kind: "reattached", project };
}

/** Creates the project at `path`, or answers with the one already tracked there. */
export async function createProject(
  ports: ProjectCreatePorts,
  input: ProjectCreateRequest,
): Promise<ProjectCreateOutcome> {
  const plan = await planProjectCreate(ports, input, { write: true });
  if (plan.kind === "refused") return { ok: false, error: plan.error };
  return { ok: true, project: plan.project, created: plan.kind === "new" };
}
