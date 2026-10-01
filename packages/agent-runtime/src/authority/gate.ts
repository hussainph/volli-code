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
 *
 * Every caller that judges a call goes through here — Pi's `beforeToolCall`
 * for a direct call, and anything that dispatches a nested one — so the path
 * rules see the same {@link CapabilityPolicy} the Session's walls were compiled
 * from (VC-45). A decision kept per tool would be a second policy.
 */

import { lstatSync } from "node:fs";
import {
  capabilityWrite,
  errorMessage,
  evaluate,
  isOverridableAuthorityRule,
  linkedAlias,
  operandDenial,
  type AuthorityDenialCause,
  type AuthoritySnapshot,
  type CapabilityPolicy,
  type PolicyToolCall,
} from "@volli/shared";
import { resolveCapabilityPolicy } from "./capability";
import { normalizeToolCall, resolveWorkspaceRoot } from "./normalize";

/** Allow, or a refusal named well enough to count and to record. */
export type AuthorityVerdict =
  | { outcome: "allow" }
  | {
      outcome: "deny";
      cause: AuthorityDenialCause;
      reason: string;
      /**
       * Set when the Session's own walls refuse this call too, so a person's
       * "yes" to an otherwise overridable rule could not be carried out: the
       * tool would be refused at the file guard or the kernel a moment later.
       * The escalation does not put a question nobody can answer.
       */
      walled?: true;
    };

const ALLOW: AuthorityVerdict = { outcome: "allow" };

/**
 * Whether a Scoped Session's walls would refuse what this call reads or writes.
 *
 * Asked only after an overridable rule has refused, and only of a contained
 * Session — without walls nothing stands behind the gate, so consent is never
 * moot. Reads count the file tools' and every literal operand's; a recursive
 * reader handed a directory ABOVE a denied entry is not walled, because the
 * kernel refuses only the denied files and the rest of the read goes ahead —
 * so a person's "yes" would still do something.
 */
function wallsRefuse(call: PolicyToolCall, capability: CapabilityPolicy): boolean {
  const segments = call.command?.segments ?? [];
  const writes = [...call.writes, ...segments.flatMap((segment) => segment.writes)];
  const reads = [...call.reads, ...segments.flatMap((segment) => segment.paths)];
  return (
    writes.some((path) => capabilityWrite(capability, path).outcome === "deny") ||
    reads.some((path) => operandDenial(capability, path, false) !== undefined)
  );
}

/**
 * A multiply-linked regular file named by the denied path it shares an inode
 * with, when the resolver indexed one: a second name for a credential is the
 * credential. The resolver also protects its names in every granted root in
 * Seatbelt; this check covers indexed identities under names elsewhere.
 */
export function throughLinks(capability: CapabilityPolicy, path: string): string {
  let entry;
  try {
    entry = lstatSync(path);
  } catch {
    return path;
  }
  if (!entry.isFile() || entry.nlink < 2) return path;
  return linkedAlias(capability, path, `${entry.dev}:${entry.ino}`);
}

/** The call with every path it names translated through {@link throughLinks}. */
function withLinksNamed(call: PolicyToolCall, capability: CapabilityPolicy): PolicyToolCall {
  const name = (path: string) => throughLinks(capability, path);
  return {
    ...call,
    reads: call.reads.map(name),
    writes: call.writes.map(name),
    command:
      call.command === null
        ? null
        : {
            ...call.command,
            segments: call.command.segments.map((segment) => ({
              ...segment,
              paths: segment.paths.map(name),
              writes: segment.writes.map(name),
            })),
          },
  };
}

/** What the Session's authority makes of one call, before it runs. */
export function authorityVerdict(input: {
  tool: string;
  args: unknown;
  authority: AuthoritySnapshot;
  workspacePath: string;
  /**
   * The capability policy this attachment resolved (VC-45). The runtime always
   * passes one; a caller that has none gets the built-in denylist for the
   * process's own home, with {@link readableRoots} as its only grants and the
   * workspace as its only writable root — never "no secrets known".
   */
  capability?: CapabilityPolicy;
  /**
   * Directories holding output this Session's own tools saved (VC-469), read
   * only when no {@link capability} was passed. Inside a resolved policy they
   * are its grants already.
   */
  readableRoots?: readonly string[];
  /** Whether the Session runs behind walls compiled from {@link capability}. */
  contained?: boolean;
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
  const capability =
    input.capability ??
    resolveCapabilityPolicy({
      workspacePath,
      grants: input.readableRoots ?? [],
      sandboxCarveOuts: false,
    });
  call = withLinksNamed(call, capability);
  const decision = evaluate(call, input.authority, { workspacePath, capability });
  if (decision.outcome === "allow") return ALLOW;
  const walled =
    input.contained === true &&
    isOverridableAuthorityRule(decision.rule) &&
    wallsRefuse(call, capability);
  return {
    outcome: "deny",
    cause: decision.rule,
    reason: decision.reason,
    ...(walled ? { walled: true } : {}),
  };
}
