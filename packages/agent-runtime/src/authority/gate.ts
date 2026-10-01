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
  violations as allViolations,
  type PolicyViolation,
  type AuthorityDenialCause,
  type AuthoritySnapshot,
  type PolicyToolCall,
} from "@volli/shared";
import { normalizeToolCall, resolveReadableRoot, resolveWorkspaceRoot } from "./normalize";

/** Allow, or a refusal named well enough to count and to record. */
export type AuthorityVerdict =
  | { outcome: "allow" }
  | { outcome: "deny"; cause: AuthorityDenialCause; reason: string; violations?: readonly PolicyViolation[]; stages?: readonly string[] };

const ALLOW: AuthorityVerdict = { outcome: "allow" };

/** What the Session's authority makes of one call, before it runs. */
export function authorityVerdict(input: {
  tool: string;
  args: unknown;
  authority: AuthoritySnapshot;
  workspacePath: string;
  /**
   * Directories outside the workspace holding output this Session's own tools
   * saved, which it may read (VC-469). Resolved per call, so one that does not
   * exist yet, or that is not a real directory, grants nothing.
   */
  readableRoots?: readonly string[];
  protection?: boolean;
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
  const readableRoots = (input.readableRoots ?? []).flatMap(
    (root) => resolveReadableRoot(root) ?? [],
  );
  const decision = evaluate(call, input.authority, {
    workspacePath,
    ...(readableRoots.length === 0 ? {} : { readableRoots }),
  });
  if (decision.outcome === "allow") return ALLOW;
  return { outcome: "deny", cause: decision.rule, reason: decision.reason,
    ...(input.protection === true ? {
      violations: allViolations(call, input.authority, { workspacePath, readableRoots }),
      ...((call.command?.segments.length ?? 0) > 1 ? { stages: call.command!.segments.map((segment) => [segment.program, ...segment.args].join(" ")) } : {}),
    } : {}),
  };
}

/**
 * The call as an approval card shows it: the command itself, or the tool and
 * the path it names. Best effort and display-only; nothing is decided from it.
 */
export function describeCall(tool: string, args: unknown): string {
  if (typeof args === "object" && args !== null) {
    const record = args as Record<string, unknown>;
    if (typeof record.command === "string") return record.command;
    const path = record.path ?? record.file_path ?? record.filePath;
    if (typeof path === "string") return `${tool}  ${path}`;
  }
  return tool;
}
