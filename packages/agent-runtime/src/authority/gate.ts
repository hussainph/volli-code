/**
 * The Authority Snapshot, enforced at the one place Pi asks before acting.
 *
 * Pi validates a tool's arguments and then offers the call for inspection; this
 * is the whole of what Volli does with that offer. Normalize, decide, refuse or
 * stand aside. No observation, no ledger entry, no Session fact: making a
 * denial durable touches six layers and is deliberately a later phase, so this
 * stays a function with no reach.
 *
 * It fails closed. A call that cannot be normalized — an unresolvable path, an
 * argument that is not the shape the tool's schema promised — is refused rather
 * than passed through, because a policy layer that fails open is worse than no
 * policy layer: it reads as protection while providing none.
 */

import { errorMessage, evaluate, type AuthoritySnapshot, type PolicyToolCall } from "@volli/shared";
import { normalizeToolCall, resolveWorkspaceRoot } from "./normalize";

/** The reason this call is refused, or undefined when the Session's authority permits it. */
export function authorityRefusal(input: {
  tool: string;
  args: unknown;
  authority: AuthoritySnapshot;
  workspacePath: string;
}): string | undefined {
  let workspacePath: string;
  let call: PolicyToolCall;
  try {
    workspacePath = resolveWorkspaceRoot(input.workspacePath);
    call = normalizeToolCall({ tool: input.tool, args: input.args, workspacePath });
  } catch (error) {
    return `This call could not be checked against the Session's authority, so it was refused: ${errorMessage(error)}`;
  }
  const decision = evaluate(call, input.authority, { workspacePath });
  return decision.outcome === "deny" ? decision.reason : undefined;
}
