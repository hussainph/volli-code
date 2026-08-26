/**
 * `volli conflicts` — the file-collision radar (VC-185, split from VC-89).
 *
 * Read tier, any caller, and VC-92's amendment is explicit about why: this is
 * the verb that most rewards being a CLI string in a bash pipeline. It projects
 * worktree diffs Volli already holds, costs a caller no model context until it
 * chooses to run it, and answers a question that was previously carried in an
 * orchestrator's head until merge time.
 *
 * Scope resolution is this door's concern; the scan and the matrix are behind
 * {@link scanCollisions}. `--project` narrows to one project, and its absence
 * sweeps every registered project — a collision between two projects' worktrees
 * is not a thing (different repositories, different bases), so the sweep is a
 * convenience for a caller standing outside a project, never a join across
 * them.
 */

import type { AgentRequest, AgentResponse, Project } from "@volli/shared";

import { scanCollisions } from "../worktree/collisions";
import { failure } from "./context";
import type { AgentCommandContext } from "./context";

/** The projects this sweep covers: the one named, or all of them. */
function scopedProjects(
  projects: readonly Project[],
  selector: unknown,
): { ok: true; projects: readonly Project[] } | { ok: false; response: AgentResponse } {
  if (typeof selector !== "string") return { ok: true, projects };
  const matches = projects.filter(
    ({ name, path, ticketPrefix }) =>
      name === selector || path === selector || ticketPrefix === selector,
  );
  if (matches.length === 0) {
    return {
      ok: false,
      response: failure("PROJECT_NOT_FOUND", `No registered project matches ${selector}.`),
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      response: failure("AMBIGUOUS_PROJECT", `More than one project matches ${selector}.`),
    };
  }
  return { ok: true, projects: matches };
}

/** `volli conflicts` — which active ticket worktrees touch the same files. */
export async function conflictsVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, projects, git, gitAsync, worktreeExists } = context;
  const scope = scopedProjects(projects, request.args["project"]);
  if (!scope.ok) return scope.response;
  const scan = await scanCollisions(
    { db: options.db, git, gitAsync, worktreeExists },
    scope.projects,
  );
  return {
    v: 1,
    ok: true,
    data: {
      // `scanned` is the count the empty case is read against: "0 overlaps
      // across 12 worktrees" and "0 overlaps across 0 worktrees" are different
      // answers, and only one of them is reassuring.
      scanned: scan.worktrees.length,
      worktrees: scan.worktrees,
      overlaps: scan.overlaps,
      pairs: scan.pairs,
      skipped: scan.skipped,
    },
  };
}
