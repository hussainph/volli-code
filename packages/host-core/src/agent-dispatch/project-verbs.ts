/**
 * `volli project add` — the operator's bootstrap write on a headless host
 * (VC-623).
 *
 * A fresh `volli-hostd` has an empty board and no window to add a folder from.
 * This is the app's Add Project, reached over the socket: the same
 * `planProjectCreate` desktop's `volli:project-create` runs, so the folder must
 * exist and be a directory, the base branch is detected, and the prefix its
 * name derives must be unique. Only the default name is this door's own, and
 * it is the one the app's folder picker suggests: the folder's basename.
 *
 * Its registry actor is `user`, so the admission gate has already refused every
 * caller but a verified operator before this runs; nothing here re-checks it.
 */
import { basename, resolve } from "node:path";

import type { AgentRequest, AgentResponse, Project } from "@volli/shared";

import { planProjectCreate } from "../project-create";
import type { AgentCommandContext } from "./context";
import { failure } from "./context";
import { dryRunResponse } from "./preview";

function projectSummary(project: Project): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    prefix: project.ticketPrefix,
    path: project.path,
    baseBranch: project.baseBranch,
  };
}

export async function projectAddVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const typed = request.args["id"];
  if (typeof typed !== "string" || typed.trim().length === 0) {
    return failure("INVALID_REQUEST", "project add needs the folder's path.");
  }
  // Relative to where the operator typed it, as every shell command reads one.
  const path = resolve(request.ctx.cwd, typed);
  const named = request.args["name"];
  if (named !== undefined && (typeof named !== "string" || named.trim().length === 0)) {
    return failure("INVALID_REQUEST", "--name needs a non-empty name.");
  }
  const name = typeof named === "string" ? named.trim() : basename(path);
  const dryRun = request.args["dryRun"] === true;
  const plan = await planProjectCreate(
    {
      db: context.options.db,
      detectBaseBranch: context.options.detectBaseBranch,
      now: context.now,
      newId: context.newId,
      onCreated: (project) => context.options.onMutation?.({ projectId: project.id }),
    },
    { path, name },
    { write: !dryRun },
  );
  if (plan.kind === "refused") return failure("INVALID_REQUEST", plan.error);
  if (dryRun) {
    const target = { kind: "project" as const, id: plan.project.id, label: plan.project.name };
    // A folder already tracked is answered, not written: say so in the preview.
    const preview =
      plan.kind === "existing"
        ? dryRunResponse(request, target, {
            durableWrites: [],
            humanVisibleEffects: [
              `${plan.project.path} is already the project ${plan.project.name}; nothing changes.`,
            ],
          })
        : dryRunResponse(request, { ...target, id: null });
    return preview!;
  }
  return {
    v: 1,
    ok: true,
    data: { created: plan.kind === "new", project: projectSummary(plan.project) },
  };
}
