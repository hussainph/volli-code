/**
 * Who holds which tools, and the one place the whole vocabulary is known
 * (VC-162).
 *
 * `CONTEXT.md` has always said Role determines the tool bundle. Until this
 * module there was no mapping to determine it with: every Session was handed
 * the same four coding tools plus whatever ports the profile could wire, and
 * `RuntimeToolBundle` could not spell a product verb at all. VC-92's second
 * earned property — *no injection can call a tool that is not in the room* — is
 * worthless while every room holds the same things.
 *
 * ## The formula
 *
 * VC-92 wrote it as `bundle(Role) ∪ grants(session)`, which under-describes it.
 * Coding tools, `ask_user` and Web Access are not Verb Registry verbs and have
 * no key a bundle could name, so a literal reading of that formula would hand a
 * Session a product verb and no way to read a file. What is actually resolved:
 *
 * ```
 * Agent Tool Surface = capability tools ∪ Role verb bundle ∪ Session verb grants
 * ```
 *
 * - **capability tools** — the coding tools this venue loads, plus the
 *   port-gated `ask_user` / `web_fetch` / `web_search`. A port *is* the
 *   capability: a Session handed nowhere to send a question is offered no
 *   question tool, rather than one that fails when called.
 * - **Role verb bundle** — {@link roleVerbBundle}, registry data.
 * - **Session verb grants** — durable policy naming registry keys, and nothing
 *   else.
 *
 * Keeping the three sets apart is load-bearing rather than tidy. Collapsed into
 * one list, a grant could name `web_fetch` and be handed a tool with no
 * boundary behind it, or name `ticket.list` and be handed a tool nothing can
 * build. Separated, both are rejected by construction: a grant is checked
 * against the verb half only, and capability membership is decided by whether
 * the port exists.
 *
 * ## When it resolves, which is the invariant everything else rests on
 *
 * Once, at Session creation, and never again. Not once per attachment — VC-164
 * froze the `tool-surface` record before the first attachment exists, and
 * `CONTEXT.md`'s Cache Prefix entry states the consequence: *"reattachment
 * rebinds that exact surface or fails without sending a different one."*
 *
 * So a grant recorded after a Session exists is inert for that Session, at
 * every later attachment, forever. It reaches the next Session created. This
 * amends VC-92's "takes effect at the next attachment", which was written
 * before the record moved to birth, and it is deliberate on two independent
 * grounds: availability is enforcement, so it must settle once; and the
 * provider computes its Cache Prefix over the serialized tool array, so a
 * Session that gained a tool mid-life would throw away its whole prefix —
 * including the system prompt, where the provider orders tools first.
 */

import { CAPABILITY_TOOL_IDS, CODING_TOOL_IDS, NON_CODING_TOOL_IDS } from "./authority";
import type { CodingToolId, NonCodingToolId, SessionToolId } from "./authority";
import type { SessionRole } from "./agent-runtime";
import { VERB_TOOL_KEYS, isVerbToolKey } from "./verb-registry";
import type { VerbToolKey } from "./verb-registry";

/**
 * The verbs each Role holds with no grant (VC-162).
 *
 * `project` carries the agent-control family — start, stop, send (VC-86) —
 * because orchestrating work is what a Board Session is for. `ticket`
 * carries execution verbs and none of that family: merge submission is
 * VC-89's, credential-adjacent git is VC-45's, and a ticket executor that
 * needs stop over its own children is a VC-44 grant, never a bundle edit.
 *
 * `subagent` holds NO verb (VC-9), and each absence is a decision:
 *
 * - No agent-control verb — `session.start`, `session.stop`, `session.send`,
 *   `automation.run` — and no `session.delegate`. A child cannot spawn, steer
 *   or stop anything, whatever its context tells it, which makes "helpers do
 *   not spawn" structural rather than kickoff prose. It also makes delegation
 *   depth a bundle fact: with no `session.delegate` in the room there is no
 *   grandchild to count, so no depth counter exists anywhere.
 * - No `ticket.await`. A subagent is a bounded helper whose answer is its
 *   last message; a helper parked on a Ticket gate is a helper that never
 *   answers.
 *
 * What it does hold is decided by {@link ROLE_CAPABILITY_POLICY}, which is the
 * capability half of the same decision.
 *
 * A `ticket` bundle without agent-control verbs is not a gap in this ticket;
 * it is the default property this map exists to make true. A Ticket Session can
 * receive an explicit durable grant at birth (VC-183), but that exception feeds
 * the `grants` parameter below and never edits this bundle map — a Ticket with
 * no such record still has nothing an injected instruction can call.
 *
 * `ticket.await` sits in BOTH working bundles, by VC-92's ruling on VC-85:
 * blocking is a runtime property, not a privilege, so an executor waiting on
 * its own gate is as legitimate as an orchestrator waiting on a fleet. What a
 * given Session may await is per-actor policy data
 * (`AuthorityActorPolicy.awaitable`), judged at call time — bundle membership
 * is deliberately not the control.
 *
 * `automation.run` sits in the `project` bundle ALONE (VC-134, filed by
 * VC-112). Starting an Automation Run is agent control — it spends model budget
 * and opens work on a Ticket — so it travels with `session.start` under VC-92's
 * pairing rule. And its absence from the `ticket` bundle is the whole of what
 * keeps orchestrator authority out of a Ticket Session: VC-112 declines
 * OpenClaw's "cap a created job to the creating turn's tools" rule on the
 * grounds that it patches a hole `bundle(Role) ∪ grants(session)` never opens.
 * A Session that never held the verb has nothing to inherit or to be capped
 * from, so there is deliberately no capping rule anywhere beside this map.
 *
 * Declared as a total map over {@link SessionRole} so adding a Role is a bundle
 * decision made at the compiler rather than a silent empty default — the same
 * discipline the registry's tier table holds for adding a verb.
 */
const ROLE_VERB_BUNDLES: Readonly<Record<SessionRole, readonly VerbToolKey[]>> = Object.freeze({
  // The whole agent-control family travels together (VC-92's pairing rule,
  // completed by VC-86): a build that shipped stop/send as tools while start
  // stayed elsewhere — or the reverse — would make the bundle no boundary.
  // `automation.run` (VC-134) travels with them by the same rule.
  //
  // Literal order here is cosmetic: `resolveAgentToolSurface` reorders the
  // union through `VERB_TOOL_KEYS`, so registry declaration order — not this
  // array — is what a frozen Cache Prefix records.
  project: Object.freeze([
    "session.start",
    "session.stop",
    "session.send",
    "ticket.await",
    "automation.run",
    "session.delegate",
  ]) as readonly VerbToolKey[],
  // `session.delegate` in the Ticket bundle is deliberate (VC-9): an executor
  // needs "go look at this and tell me" as much as an orchestrator does, and
  // what makes it safe is the CHILD's bundle, not the parent's Role. It is
  // not the agent-control family — a subagent answers back here and cannot
  // act on anything else — so VC-92's pairing rule does not pull the rest of
  // that family in with it.
  ticket: Object.freeze(["ticket.await", "session.delegate"]) as readonly VerbToolKey[],
  subagent: Object.freeze([]) as readonly VerbToolKey[],
});

/**
 * Which capability tools a Role may be offered at all (VC-9).
 *
 * The bundle map above decides the verb half; this decides the other half, and
 * it exists for one Role. A Board Session and a Ticket Session are bounded
 * by nothing but their profile — every coding tool the venue loads and every
 * port the host wired. A Subagent Session is bounded twice more: by this
 * policy, and by its parent's own frozen surface (`within`, below).
 *
 * The first capability a subagent is never offered is `ask_user`. The person
 * driving did not start that Session and is not in front of it; a question
 * from it would arrive inside work they had handed to someone else, and its
 * answer would be read by a model they never spoke to. Withholding the NAME
 * here is what keeps the port from being wired: `sessionToolBindings` offers
 * `ask_user` only where the frozen surface names it, so absence in the record
 * is absence of the door. Everything else a subagent keeps — a helper that
 * can read but not edit the tree it was asked to fix is a helper that reports
 * a diff nobody applies.
 *
 * The second is `todo_write` (VC-6), withheld on `ask_user`'s own ground. A
 * todo list has exactly two readers: a person watching the Session live, and
 * the Ticket comment its lifecycle signal leaves behind. A Subagent Session
 * has neither — nobody is in front of it, and its parent's Ticket is commented
 * by the parent — so a list a child kept would be written for no one, while
 * still costing every child's Cache Prefix the tool's schema and description.
 * Reopen this the moment a child's plan gains a reader: the peek overlay
 * (VC-269) is that reader, and deleting the name below is the whole change.
 *
 * Total over {@link SessionRole} for the reason the bundle map is.
 */
const ROLE_CAPABILITY_POLICY: Readonly<
  Record<SessionRole, { readonly withheld: readonly NonCodingToolId[] }>
> = Object.freeze({
  project: Object.freeze({ withheld: Object.freeze([]) as readonly NonCodingToolId[] }),
  ticket: Object.freeze({ withheld: Object.freeze([]) as readonly NonCodingToolId[] }),
  subagent: Object.freeze({
    withheld: Object.freeze(["ask_user", "todo_write"]) as readonly NonCodingToolId[],
  }),
});

/** The verbs one Role holds before any grant. Registry data, never a live read. */
export function roleVerbBundle(role: SessionRole): readonly VerbToolKey[] {
  return ROLE_VERB_BUNDLES[role];
}

/**
 * Whether a string is a name the Agent Tool Surface can carry, either half.
 *
 * The runtime guard over the durable vocabulary. A decoded `tool-surface`
 * record and a stored grant both arrive as strings, and this build is the only
 * thing that knows which of them it can still bind — a record naming a verb a
 * later version withdrew must fail loudly rather than reach a tool array as a
 * name with nothing behind it.
 */
export function isSessionToolId(value: unknown): value is SessionToolId {
  if (typeof value !== "string") return false;
  // The two halves through the two constants that ARE those halves, rather than
  // through a restatement of either: `CAPABILITY_TOOL_IDS` is the whole
  // capability vocabulary and `isVerbToolKey` the whole registry one, so a tool
  // added to either is admitted here without this line being touched.
  return (CAPABILITY_TOOL_IDS as readonly string[]).includes(value) || isVerbToolKey(value);
}

/** What a venue can actually answer, as membership rather than as ports. */
export interface AgentToolCapabilities {
  /** The coding tools this venue loads, in the order it offers them. */
  coding: readonly CodingToolId[];
  /**
   * The non-coding tools whose port this Session was given. Membership only:
   * the ports themselves stay with their owners and never enter this module,
   * a Session record, or anything durable.
   */
  interaction: readonly NonCodingToolId[];
}

export interface AgentToolSurfaceInput {
  role: SessionRole;
  capabilities: AgentToolCapabilities;
  /**
   * Verb keys granted to this one Session by durable policy, beyond its Role's
   * bundle.
   *
   * A parameter and not a store read, because this function is pure and the
   * store is not built (VC-162 ships the seam; a later slice adds the durable
   * per-Session grant). Every rule over a grant is enforced here regardless, so
   * the slice that adds the store inherits a resolver that already fails
   * closed rather than one that learns to.
   */
  grants?: readonly string[];
  /**
   * The surface this Session may not exceed: its parent's own frozen record,
   * for a Subagent Session (VC-9).
   *
   * A child cannot get a port its parent lacked, and the parent's record — not
   * the profile as it stands today — is what says what the parent had. Only
   * the capability half is bounded by it; the verb half is the child's own
   * bundle, which for a subagent is empty regardless. Absent for a root Role.
   */
  within?: readonly SessionToolId[];
}

/** A grant, bundle or capability that cannot become a tool. Fails a Session start. */
export class AgentToolSurfaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentToolSurfaceError";
  }
}

/**
 * The complete Agent Tool Surface for one Session, in canonical order.
 *
 * Order is part of the answer rather than a detail of it, because the Cache
 * Prefix is computed over the serialized tool array: capability tools first in
 * the order they have always had, then verb tools in registry declaration
 * order. Appending the verb half keeps a verb added in a later product version
 * from shifting the position of anything already in a frozen record.
 *
 * Deduplicated, because a Role bundle and a grant may name the same verb and
 * that is an ordinary overlap rather than a conflict — a surface is a set, and
 * offering one provider two tools of the same name is a request no provider
 * accepts.
 *
 * Fails closed, loudly, on every way the inputs can be wrong: a grant this
 * build does not know, a grant on a verb with no `tool` access mode, and a
 * capability naming a tool outside its own vocabulary. Each is a caller bug or
 * stale durable data, and neither should reach a model as a silently smaller
 * surface — a Session quietly missing a tool it was granted looks to its user
 * like a model that will not use it.
 */
export function resolveAgentToolSurface(input: AgentToolSurfaceInput): readonly SessionToolId[] {
  for (const tool of input.capabilities.coding) {
    if (!(CODING_TOOL_IDS as readonly string[]).includes(tool)) {
      throw new AgentToolSurfaceError(`${tool} is not a coding tool this build can load`);
    }
  }
  for (const tool of input.capabilities.interaction) {
    if (!(NON_CODING_TOOL_IDS as readonly string[]).includes(tool)) {
      throw new AgentToolSurfaceError(`${tool} is not an interaction tool this build can wire`);
    }
  }
  const granted = new Set<VerbToolKey>();
  if (input.role === "subagent" && (input.grants ?? []).length > 0) {
    // A subagent's bundle is the whole of its authority. A grant reaching it
    // is a caller that has confused the two kinds of child — the peer executor
    // VC-183 grants a scoped start to, and this bounded helper.
    throw new AgentToolSurfaceError("A Subagent Session takes no verb grant");
  }
  for (const grant of input.grants ?? []) {
    if (!isVerbToolKey(grant)) {
      // Both failures are one message on purpose: to the party holding a bad
      // grant, "no such verb" and "that verb is not a tool" are the same
      // mistake — a name that cannot become a tool in this build.
      throw new AgentToolSurfaceError(
        `${grant} is not a verb this build can offer as a tool, so it cannot be granted`,
      );
    }
    granted.add(grant);
  }
  const verbs = new Set<VerbToolKey>([...roleVerbBundle(input.role), ...granted]);
  const withheld = ROLE_CAPABILITY_POLICY[input.role].withheld;
  const within = input.within;
  const offered = (tool: SessionToolId): boolean =>
    !(withheld as readonly string[]).includes(tool) &&
    (within === undefined || within.includes(tool));
  return [
    ...input.capabilities.coding.filter(offered),
    // Canonical interaction order, taken from the vocabulary rather than from
    // the caller's array, so two Sessions that wired the same ports in
    // different orders resolve to the same surface and share a prefix.
    ...NON_CODING_TOOL_IDS.filter(
      (tool) => input.capabilities.interaction.includes(tool) && offered(tool),
    ),
    ...VERB_TOOL_KEYS.filter((key) => verbs.has(key)),
  ];
}

/**
 * The verb half of an already-resolved surface, in canonical order.
 *
 * What the runtime spec's bundle carries, and what the first-message block
 * names. Reading it back off the resolved list rather than re-deriving it from
 * Role and grants is deliberate: a reattachment months later has the durable
 * record and no memory of what produced it, and re-deriving would be exactly
 * the recomposition the frozen record exists to prevent.
 */
export function verbToolsOf(surface: readonly SessionToolId[]): readonly VerbToolKey[] {
  return surface.filter((tool): tool is VerbToolKey => isVerbToolKey(tool));
}
