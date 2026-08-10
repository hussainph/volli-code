/**
 * The Authority Snapshot, enforced at the one place Pi asks before acting.
 *
 * Pi validates a tool's arguments and then offers the call for inspection; this
 * is the whole of what Volli does with that offer. Normalize, decide, refuse or
 * stand aside. The verdict is returned rather than acted on: recording it and
 * telling Pi are the caller's jobs, and keeping them out of here is what lets
 * the decision stay a synchronous function over its inputs.
 *
 * It fails closed. A call that cannot be normalized — an unresolvable path, an
 * argument that is not the shape the tool's schema promised — is refused rather
 * than passed through, because a policy layer that fails open is worse than no
 * policy layer: it reads as protection while providing none. That refusal cites
 * `call.unreadable` rather than borrowing a rule's name: no rule ran, and a
 * denial ledger that said otherwise would misattribute it.
 */

import {
  errorMessage,
  evaluate,
  type AuthorityDenialCause,
  type AuthoritySnapshot,
  type PolicyToolCall,
} from "@volli/shared";
import { normalizeToolCall, resolveWorkspaceRoot } from "./normalize";

/** Allow, or a refusal named well enough to count and to record. */
export type AuthorityVerdict =
  | { outcome: "allow" }
  | { outcome: "deny"; cause: AuthorityDenialCause; reason: string };

const ALLOW: AuthorityVerdict = { outcome: "allow" };

/** What the Session's authority makes of one call, before it runs. */
export function authorityVerdict(input: {
  tool: string;
  args: unknown;
  authority: AuthoritySnapshot;
  workspacePath: string;
}): AuthorityVerdict {
  let workspacePath: string;
  let call: PolicyToolCall;
  try {
    workspacePath = resolveWorkspaceRoot(input.workspacePath);
    call = normalizeToolCall({ tool: input.tool, args: input.args, workspacePath });
  } catch (error) {
    return {
      outcome: "deny",
      cause: "call.unreadable",
      reason: `This call could not be checked against the Session's authority, so it was refused: ${errorMessage(error)}`,
    };
  }
  const decision = evaluate(call, input.authority, { workspacePath });
  if (decision.outcome === "allow") return ALLOW;
  return { outcome: "deny", cause: decision.rule, reason: decision.reason };
}
