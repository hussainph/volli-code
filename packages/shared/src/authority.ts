/**
 * The durable policy a Session executes under, and the pure decision it yields.
 *
 * Everything here is data plus a total function over it. Path resolution, shell
 * lexing, and the filesystem live in `@volli/agent-runtime`, which normalizes one
 * runtime tool call into a {@link PolicyToolCall} before asking for a decision.
 * That split is the point: the policy table is a unit test with no runtime, no
 * process, and no model, while the parts that must touch a disk stay in the one
 * package allowed to.
 *
 * This layer is defence in depth, not the boundary. The boundary is the Seatbelt
 * sandbox in `@volli/agent-runtime`, which denies the network outright, hands
 * children a credential-free environment, and scopes reads and writes to the
 * Session workspace. What a policy decision adds is a *countable, nameable*
 * refusal for the residual risk inside that scope — the things a kernel cannot
 * see the intent of, like rewriting `.git/hooks` on the way to a commit.
 */

/**
 * Which working tree a Session executes in.
 *
 * Not derivable from the Session Role: a Ticket that never took a worktree runs
 * in the project's Main checkout, so the location is recorded rather than
 * inferred. Policy keys off this, because the risk is a property of the tree —
 * a disposable branch-isolated worktree versus a human's uncommitted work.
 */
export type WorkLocationKind = "worktree" | "main-checkout";

/**
 * Explicit coding tools a Session may load. Ambient user and project extensions
 * never load, so an unlisted tool is not merely absent — reaching for one is a
 * policy denial.
 */
export type CodingToolId = "read" | "edit" | "write" | "execute";

/**
 * When silent denial stops being the right answer and the user should be asked.
 *
 * Counting is the caller's job, not the rule's: a single call is allowed or
 * denied on its own merits, and only a run of denials means the policy is in the
 * agent's way. Both thresholds are Anthropic's published defaults for the same
 * mechanism, adopted with no knowledge of how they were tuned.
 */
export interface AuthorityFallback {
  /** Consecutive denials before escalating. */
  consecutiveDenials: number;
  /** Total denials within one Session before escalating. */
  sessionDenials: number;
}

/**
 * The policy one Session executes under, in the shape its durable record will
 * take.
 *
 * Nothing persists it yet. It is constructed per attach and lives as long as the
 * attachment does, so {@link rulePackId} and {@link rulePackHash} are presently
 * ceremony: both ends compute them from the same compile-time constant inside
 * one process, and no reader compares them against anything older. They are here
 * because the denial ledger is the next phase and a record is easier to write
 * than to retrofit — but until that lands, the hash pins nothing and would
 * detect nothing.
 *
 * What the pinning is *for*, once there is something to pin against: a Session
 * must not have its authority changed under it by an unrelated Settings edit,
 * while the facts the rules read — resolved paths, the current branch, how many
 * denials have accrued — stay live, because they are machine state rather than
 * policy and freezing them would record a lie within seconds.
 */
export interface AuthoritySnapshot {
  mode: "auto";
  location: WorkLocationKind;
  tools: readonly CodingToolId[];
  rulePackId: string;
  rulePackHash: string;
  /**
   * The model allowed to judge calls the deterministic rules cannot. Null, and
   * deliberately so: with the network denied, no credentials in the child
   * environment, and the filesystem scoped and symlink-proof, a per-call model
   * invocation would mostly re-derive what the kernel already guarantees. The
   * field exists so the seam predates the need.
   */
  classifierModel: string | null;
  fallback: AuthorityFallback;
}

/**
 * One lexed command in a pipeline or operator chain.
 *
 * Rules need the program separated from its arguments because the dangerous
 * cases are argument-shaped — `rm -rf /` differs from `rm -rf ./build` only in
 * an operand, and no honest pattern match over a raw string tells them apart.
 */
export interface PolicyCommandSegment {
  program: string;
  args: readonly string[];
  /** Absolute, resolved paths this segment's operands denote. */
  paths: readonly string[];
  /** Absolute, resolved paths this segment redirects output into. */
  writes: readonly string[];
  /** `NAME=value` prefixes set for this segment alone. */
  env: readonly string[];
}

/**
 * A lexed shell command line.
 *
 * Porting a lexer copies its bypass surface: `eval`, `base64`, command
 * substitution and `xargs` all defeat it. Sound as a layer beneath Seatbelt,
 * unsound as a standalone boundary, and it is only ever used as the former.
 */
export interface PolicyCommand {
  raw: string;
  segments: readonly PolicyCommandSegment[];
}

/**
 * One runtime tool call, normalized so no runtime-native type crosses into policy.
 *
 * Reads and writes are separate because most rules only care about one of them:
 * reading `.git/config` tells the agent something, while writing it changes what
 * every later command does. Collapsing the two would force every path rule to
 * choose between missing the write and refusing the harmless read.
 */
export interface PolicyToolCall {
  /** The runtime tool name as requested, which may not be a tool Volli offers. */
  tool: string;
  /** Absolute, resolved paths the call would read. */
  reads: readonly string[];
  /** Absolute, resolved paths the call would create, modify, or delete. */
  writes: readonly string[];
  /** Present only for process execution. */
  command: PolicyCommand | null;
}

/** Live machine state the rules read. Never persisted; recomputed per call. */
export interface PolicyContext {
  /** Absolute, resolved Session workspace root. */
  workspacePath: string;
}

/**
 * The verdict on one call.
 *
 * Allow or deny only. Asking is not a per-call verdict — it is what the caller
 * does once denials accumulate past {@link AuthorityFallback}, which keeps this
 * function total over its inputs and keeps escalation out of the rule table.
 */
export type PolicyDecision =
  | { outcome: "allow" }
  | {
      /** Names the rule that refused, so a denial is countable and nameable, not just failed. */
      outcome: "deny";
      rule: AuthorityRuleId;
      reason: string;
    };

/**
 * Every rule the built-in pack can cite, in pack order.
 *
 * The list is the pack's identity: {@link BUILTIN_RULE_PACK_HASH} is computed
 * from it, so adding, removing, or reordering a rule changes the hash. Renaming
 * a rule's behaviour without renaming the rule does not, which is the honest
 * limit of pinning by id — it tightens when per-project packs arrive and the
 * pack becomes data rather than code. Note that no Session persists the hash it
 * ran under yet, so today a changed pack is undetectable in either direction.
 */
export const AUTHORITY_RULE_IDS = [
  /** A tool outside the Session's bundle, including one Volli does not offer at all. */
  "tool.not-bundled",
  /** Any path resolving outside the Session workspace root. */
  "path.outside-workspace",
  /** Repository plumbing that rewrites what later commands will do. */
  "path.git-internals",
  /** Volli's own state inside the tree. */
  "path.volli-internals",
  /** Disabling certificate verification, in flags or in the environment. */
  "command.tls-weakening",
  /** Login items and cron: scheduling execution that survives the Session. */
  "command.persistence",
  /** SIP, Gatekeeper, and the other macOS platform guarantees. */
  "command.platform-weakening",
  /** Recursive removal aimed at a system root or a home directory. */
  "command.destructive-removal",
  /** Git subcommands that operate on a tree other than this Session's. */
  "command.git-escapes-workspace",
  /** Git subcommands that discard uncommitted work, denied only in a Main checkout. */
  "command.git-discards-work",
] as const;

export type AuthorityRuleId = (typeof AUTHORITY_RULE_IDS)[number];

export const BUILTIN_RULE_PACK_ID = "volli.builtin";

/**
 * FNV-1a over the pack's rule ids, as eight lowercase hex digits.
 *
 * A content hash and not a version counter, so the pack cannot change without
 * the hash changing. Chosen for being pure and dependency-free —
 * `@volli/shared` may not import `node:crypto` — and it guards against drift,
 * not against an adversary.
 */
export function hashRulePack(ruleIds: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const id of ruleIds) {
    for (let index = 0; index < id.length; index += 1) {
      hash ^= id.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x1f;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export const BUILTIN_RULE_PACK_HASH = hashRulePack(AUTHORITY_RULE_IDS);
