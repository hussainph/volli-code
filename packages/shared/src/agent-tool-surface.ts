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
 * `project` carries the agent-control family, because orchestrating work is
 * what a Project Session is for. `ticket` carries execution verbs — of which
 * there are none yet, and the empty list is the honest statement rather than a
 * placeholder: `session.stop`/`session.send` are VC-86's, merge submission is
 * VC-89's, and credential-adjacent git is VC-45's. `subagent` stays empty until
 * VC-9 defines what a Subagent Session is.
 *
 * An empty `ticket` bundle is not a gap in this ticket; it is the property this
 * ticket exists to make true. A Ticket Session's tool array holds no
 * agent-control tool, so an injected instruction telling it to start ten
 * Sessions has nothing to call.
 *
 * Declared as a total map over {@link SessionRole} so adding a Role is a bundle
 * decision made at the compiler rather than a silent empty default — the same
 * discipline the registry's tier table holds for adding a verb.
 */
const ROLE_VERB_BUNDLES: Readonly<Record<SessionRole, readonly VerbToolKey[]>> = Object.freeze({
  project: Object.freeze(["session.start"]) as readonly VerbToolKey[],
  ticket: Object.freeze([]) as readonly VerbToolKey[],
  subagent: Object.freeze([]) as readonly VerbToolKey[],
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
  return [
    ...input.capabilities.coding,
    // Canonical interaction order, taken from the vocabulary rather than from
    // the caller's array, so two Sessions that wired the same ports in
    // different orders resolve to the same surface and share a prefix.
    ...NON_CODING_TOOL_IDS.filter((tool) => input.capabilities.interaction.includes(tool)),
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
