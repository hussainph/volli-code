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
 * This layer was written as defence in depth beneath a boundary, and neither
 * one ships today. `SessionRuntimeSpec.authority` is optional and no product
 * caller supplies one, so Pi is handed no `beforeToolCall` and nothing below is
 * ever consulted; the Seatbelt sandbox that used to sit under it is no longer
 * installed either, so a Session's tools carry the authority of whoever is
 * running Volli. That is a deliberate decision to run Pi at its own defaults,
 * not an erosion — and `docs/plans/authority-two-axis-rearchitecture.md` is
 * where both axes come back. It changes the policy this mechanism carries
 * rather than the mechanism, which is why everything below is kept whole.
 *
 * Read the reasoning below with that in mind. Several rules were deliberately
 * scoped against a kernel boundary they could assume beneath them; those
 * arguments describe the layering this pack was designed for, not what a
 * Session runs under now.
 *
 * What a policy decision would add, once there is something to add it to, is a
 * *countable, nameable* refusal for the risk a kernel cannot see the intent of.
 * A `git reset --hard` over a person's uncommitted work is permitted by every
 * boundary ever proposed here and is still the wrong thing to do. Nothing
 * refuses it today.
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
 * never load, so an unlisted tool is not merely absent — it is a tool the Agent
 * Tool Surface never carried, and Pi refuses the name before any policy runs.
 */
export type CodingToolId = "read" | "edit" | "write" | "execute";

/**
 * The tools a Session can be offered that are not coding tools.
 *
 * Neither one is a bundle member and neither should become one: a name added to
 * {@link CodingToolId} is a name every rule, every durable Snapshot and every
 * bundle then has an opinion about, and these have no file, no command and no
 * environment for a rule to read. They are wired as ports on the Session spec
 * instead — a Session that was given nowhere to send a question, or no web
 * boundary, is never offered the tool.
 *
 * They reach the rule pack the same way a coding tool does and no rule objects,
 * because none of them carries what a rule reads. That is the whole of how an
 * interaction tool is judged, and it is deliberate rather than an omission:
 * these tools are governed by whether the Session was handed the port at all.
 *
 * The order is registration order and it is load-bearing twice over — it is the
 * order `sessionToolIds` returns and therefore the order the Agent Tool Surface
 * is built in, which the provider's Cache Prefix is computed over. It is
 * not hashed: {@link AUTHORITY_RULE_IDS} is the pack's identity, and naming a
 * tool is not a rule. Anything registered beside the bundle belongs in this list.
 */
export const NON_CODING_TOOL_IDS = [
  /** Asking the person driving the Session a question, and blocking on the answer. */
  "ask_user",
  /** Reading one public web document through Volli's own fetch boundary. */
  "web_fetch",
  /** Asking the configured search provider for references, through Volli's own search boundary. */
  "web_search",
] as const;

export type NonCodingToolId = (typeof NON_CODING_TOOL_IDS)[number];

/**
 * Every name the Agent Tool Surface can carry, whatever kind of tool it is.
 *
 * One vocabulary rather than two, because the things that must name a tool —
 * a durable Snapshot, a Role bundle, a rule pack, a denial in the ledger — have
 * no reason to care which half a name came from. The split above records how a
 * tool is *wired*; this union records what a Session may be *offered*.
 *
 * The Verb Registry (VC-92, built in VC-161) becomes the source of these names:
 * a verb's registry key is its name here, on every surface that projects it, so
 * a tool promoted from the Agent CLI arrives already spelled the way a rule pack
 * and a Role bundle would spell it. Until the registry exists, the two lists
 * above are that source, and `sessionToolIds` is the one place they are read
 * together.
 */
export type SessionToolId = CodingToolId | NonCodingToolId;

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
 * Nothing persists it, and with the gate off nothing in the product constructs
 * one either — a Snapshot reaches the runtime only when a caller hands it one,
 * and then lives as long as that attachment. {@link rulePackId} and
 * {@link rulePackHash} are ceremony twice over: computed from a compile-time
 * constant inside one process, and compared by no reader against anything
 * older. The denial
 * ledger they were written ahead of has since shipped — `authority.denied` is a
 * durable Session Event and `SessionProjection.authorityDenials` folds it — and
 * the snapshot that produced those denials still is not recorded anywhere. That
 * is the real, slightly awkward state today: a denial can be read back long
 * after the pack that ruled on it has changed, with nothing durable to say
 * which pack that was. The hash pins nothing until the snapshot itself is.
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
  /**
   * The Agent Tool Surface this Session was given, recorded rather than judged.
   *
   * No rule reads it. Availability is the enforcement — a tool the Session was
   * not handed is not in Pi's tool array, and Pi refuses an unknown name before
   * `beforeToolCall` ever runs — so a rule that re-checked the name here could
   * only fire when this list and the array disagreed, which is a bug in the
   * caller rather than an act by the model. `sessionToolIds` exists so they
   * cannot disagree: it is the one derivation both are built from.
   *
   * It stays on the Snapshot because the Snapshot is the durable answer to what
   * a Session was allowed to do, and a denial read back months later is not
   * interpretable without it. VC-44 persists it; VC-162 makes it registry data
   * as `bundle(Role) ∪ grants(session)`.
   */
  tools: readonly SessionToolId[];
  rulePackId: string;
  rulePackHash: string;
  /**
   * The model allowed to judge calls the deterministic rules cannot. Null, and
   * no longer for the reason originally written here: that with the network
   * denied and the filesystem scoped, the categories a classifier is best at
   * were largely unreachable. Both premises are gone, and
   * `docs/plans/authority-two-axis-rearchitecture.md` names that argument as the
   * mistake the whole rework exists to undo — containment was one dial doing two
   * jobs.
   *
   * It is null today only because nothing constructs a Snapshot at all. What a
   * classifier would add is an intent check — whether the user actually asked
   * for this — which no boundary has ever answered: a branch sweep or an
   * over-broad `rm` wholly inside the workspace passes every rule here.
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
 * substitution and `xargs` all defeat it. It is sound only as a layer beneath a
 * boundary that does not depend on it, and unsound as one on its own — so it
 * must never become the thing a Session's safety rests on. Nothing runs it
 * today; the boundary it was written under is not installed.
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
 *
 * Nine rules, and the missing tenth is the reason to read this list carefully.
 * `tool.not-bundled` used to lead it: it refused any name outside
 * {@link AuthoritySnapshot.tools}. It was deleted in VC-3, on the ground the
 * Agent Tool Surface states — availability is enforcement, so a tool the Session
 * was not handed cannot be called and needs no rule to say so. Pi resolves a
 * tool by name and answers `Tool X not found` before `beforeToolCall` runs, and
 * `sessionToolIds` gives the array and the Snapshot one source, so the rule had
 * no call left that it could reach. It is not to be revived under its own name:
 * a later per-call refusal over a tool a Session *does* hold — a revoked grant,
 * a Role-scoped control verb — is a different question and takes a new id, so
 * that the two are countable apart in the ledger.
 */
export const AUTHORITY_RULE_IDS = [
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

/**
 * Why a call was refused, once a refusal is a durable fact rather than a string.
 *
 * Wider than {@link AuthorityRuleId} by exactly one member, because the gate can
 * refuse before any rule runs: an operand it cannot resolve, or a tool argument
 * it cannot read, is refused on the principle that a caller which cannot say
 * what a call does must not allow it. That is a real denial and it must be
 * countable, but no rule cited it, so it cannot borrow a rule's name.
 */
export type AuthorityDenialCause = AuthorityRuleId | "call.unreadable";

/**
 * The rules a person may overrule when Volli stops and asks.
 *
 * The test is not how alarming a rule sounds — it is whether an answer of "yes"
 * could do anything. A rule is overridable when the call would actually be
 * carried out if the policy stood aside, *and* a reasonable person could want
 * it: writing a `pre-commit` hook is ordinary work, and so is a `git reset
 * --hard` in a checkout the person owns.
 *
 * Everything else only reports. The hard-deny rules are the case where consent
 * could be honoured and must not be: a login item, a disabled certificate check
 * or a weakened SIP outlives the Session that asked for it, and a person
 * answering a question mid-task is not in a position to weigh that. The other
 * case — a refusal no "yes" could carry out — left this pack with
 * `tool.not-bundled`, whose example was the clearest of all: a tool that is not
 * loaded cannot be called into existence by consent. Any rule proposed for this
 * pack still has to answer that question before it is placed on either side.
 *
 * `path.outside-workspace` and `command.git-escapes-workspace` are here on a
 * reason that has since expired. Seatbelt denied them whatever this layer
 * decided, so consent was moot; with the sandbox no longer installed they are
 * grantable rather than moot. The list has not been re-derived for that — the
 * pack is dormant, and reopening the question belongs to
 * `docs/plans/authority-two-axis-rearchitecture.md` rather than to a quiet edit
 * here.
 */
export const OVERRIDABLE_AUTHORITY_RULES = [
  "path.git-internals",
  "path.volli-internals",
  "command.git-discards-work",
] as const satisfies readonly AuthorityRuleId[];

/** Whether a refusal is one a person can overrule, or one that only reports. */
export function isOverridableAuthorityRule(cause: AuthorityDenialCause): boolean {
  return (OVERRIDABLE_AUTHORITY_RULES as readonly string[]).includes(cause);
}

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
