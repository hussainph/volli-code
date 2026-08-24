/*
 * Side-effect preview helpers shared by every mutation handler.
 *
 * Validation remains with the verb that owns it; these helpers only turn a
 * validated request into the registry-declared mutation plan, and keep an
 * undeclared dryRun from falling through to the real write.
 */

import { buildMutationPlan, cliVerbName, MUTATION_PLAN_CONTRACT, verbEntry } from "@volli/shared";
import type {
  AgentRequest,
  AgentResponse,
  MutationPlanOverrides,
  MutationPlanTarget,
} from "@volli/shared";

import { failure } from "./context";

/** Returns the shared side-effect plan after a handler has finished read-only validation. */
export function dryRunResponse(
  request: AgentRequest,
  target: MutationPlanTarget,
  overrides?: MutationPlanOverrides,
): AgentResponse | null {
  if (request.args["dryRun"] !== true) return null;
  const entry = verbEntry(request.cmd);
  if (entry === undefined) {
    return failure("UNSUPPORTED_COMMAND", `No Verb Registry entry matches ${request.cmd}.`);
  }
  return {
    v: 1,
    ok: true,
    data: buildMutationPlan(entry, target, overrides),
  };
}

/**
 * What this build can do, answered without resolving Project, Ticket or
 * Session. The `--dry-run` preflight asks this and nothing else: an ordinary
 * `identify` can fail with PROJECT_REQUIRED or SESSION_NOT_FOUND, and refusing
 * a preview for either would be the same confident-but-irrelevant refusal the
 * teaching-error work exists to remove. An app that predates the marker simply
 * ignores the unknown argument and answers a context-shaped identify, which
 * carries no `previewContract` — so the preflight stays fail-closed.
 */
function capabilityReport(appVersion: string): AgentResponse {
  return { v: 1, ok: true, data: { appVersion, previewContract: MUTATION_PLAN_CONTRACT } };
}

/**
 * Why an undeclared `dryRun` may not proceed, or null when the verb declares a
 * preview. The bundled CLI's parser already refuses this, but the socket is a
 * public door and a registry-projected tool builds its own arguments — so the
 * only place the promise "a preview never executes the real write" can actually
 * be kept is here, where the write would otherwise happen. Registry-generic on
 * purpose: a verb becomes previewable by declaring the option, never by being
 * named in a second list.
 */
function undeclaredPreviewRefusal(request: AgentRequest): AgentResponse | null {
  if (request.args["dryRun"] !== true) return null;
  const entry = verbEntry(request.cmd);
  if (entry?.options.some((option) => option.name === "--dry-run") === true) return null;
  return failure(
    "INVALID_REQUEST",
    `${request.cmd} declares no side-effect preview, so dryRun was refused rather than ignored on the way to a real write.`,
    `Run \`volli help ${cliVerbName(request.cmd)}\` to see whether this verb offers --dry-run, or drop dryRun to perform the real operation.`,
  );
}

/** Answers request variants that must complete before any project or Session read. */
export function agentCommandPreflight(
  appVersion: string,
  request: AgentRequest,
): AgentResponse | null {
  const undeclaredPreview = undeclaredPreviewRefusal(request);
  if (undeclaredPreview !== null) return undeclaredPreview;
  return request.cmd === "identify" && request.args["capabilities"] === true
    ? capabilityReport(appVersion)
    : null;
}
