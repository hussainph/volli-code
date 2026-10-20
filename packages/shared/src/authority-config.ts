/** App-owned per-actor host-API policy and delegation budget posture.
 * Retired per-call review fields are ignored when reading old project overrides.
 */
import { SESSION_AWAIT_KINDS, type SessionAwaitKind } from "./session-await";
import { TICKET_AWAIT_KINDS, type TicketAwaitKind } from "./ticket-await";

export type BudgetPosture = "ask" | "refuse";

export const BUDGET_POSTURES = ["ask", "refuse"] as const;

/**
 * The budget half of a project's authority policy: what each allowance does
 * when it runs out. One field per budget cause, so a project that softens one
 * cap has said nothing about the next cap this family grows.
 */
export interface AuthorityBudgetPolicy {
  /** `budget.delegation-children`: a Ticket Session's in-ticket fan-out allowance. */
  delegationExceeded: BudgetPosture;
}

/**
 * The kinds of caller a per-project policy can speak about.
 *
 * VC-92 ruled that "no environment variable means the user" is dead. Absence of
 * evidence had been attributing an anonymous socket caller as the *highest*
 * trust actor in the system, so an unauthenticated caller becomes its own kind
 * here rather than borrowing one.
 *
 * These are not {@link Actor} — that is who a ticket event is attributed to, and
 * it is written after the fact. This is who a caller *is* at the door, which is
 * the question a policy has to answer before it can decide anything.
 */
export const AUTHORITY_ACTOR_KINDS = ["user", "session", "unauthenticated"] as const;

export type AuthorityActorKind = (typeof AUTHORITY_ACTOR_KINDS)[number];

/**
 * Whose transcript one Session may read through `session.peek`.
 *
 * VC-92 ruled the verb stays read tier — reading a transcript is a read, and
 * inventing a tier for it would make tier mean two things. Who may read *whose*
 * transcript is policy, and this is where that policy lives.
 *
 * `own` is the default rather than `project` because cross-Session transcript
 * disclosure is the one read that carries another agent's whole context, and an
 * orchestrator that needs it can be granted it per project.
 */
export const PEEK_DISCLOSURES = ["none", "own", "project"] as const;

export type PeekDisclosure = (typeof PEEK_DISCLOSURES)[number];

/**
 * What one kind of caller may do, once the door knows who it is.
 *
 * Read by VC-163 at the socket door and by VC-85's watch/wake tools; nothing in
 * this ticket enforces any of it. That split is deliberate and is the reason
 * this ticket exists as its own step: VC-163 is blocked on a durable per-actor
 * policy to read, and a policy store is a smaller, safer thing to land than an
 * authentication seam. The data lands first so the seam has something to consult.
 */
export interface AuthorityActorPolicy {
  /**
   * Coordination-tier verbs this kind of caller may run.
   *
   * Coordination tier is VC-92's middle class: visible, attributable, reversible
   * writes — `ticket.create/update/move/comment`, `notify`,
   * `session.done/blocked/link`. They stay CLI-reachable and are judged here
   * per actor. Read-tier verbs are not listed because no policy withholds them;
   * control-tier verbs are not listed because they never exist on the socket at
   * all, which is a stronger statement than any list could make.
   *
   * The tier itself is never stored. VC-92 pinned it as derived from a verb's
   * access modes and actor requirements, so a stored tier could disagree with
   * the registry and one of them would be wrong.
   */
  coordinationVerbs: readonly string[];
  /** Whose transcripts this caller may read. */
  peek: PeekDisclosure;
  /**
   * What this caller may block on through the watch/wake tools (VC-85).
   *
   * VC-92's ruling: blocking is a runtime property, not a privilege. The tool
   * ships in both bundles and waiting is not itself an act of authority — so
   * what may be *awaited* is policy data, and the tool's presence is not.
   */
  awaitable: readonly TicketAwaitKind[];
  /**
   * What this caller may block on through `session_await` (VC-324 item 3).
   *
   * A second list rather than a widened first one. {@link TicketAwaitKind}
   * names planner facts and {@link SessionAwaitKind} names Session Events:
   * two ledgers, two vocabularies, two cursors. Merged, a project could not
   * say "wait on your children, not on my board" — and a stored word would
   * have two meanings, which is the one thing a policy list may not have.
   *
   * Tolerant on read: a document written before this field existed resolves to
   * the defaults, exactly as an absent `awaitable` does.
   */
  awaitableSessions: readonly SessionAwaitKind[];
}

/**
 * The per-project authority document, fully resolved.
 *
 * Host-API access and budget posture, independent of any executor attachment.
 */
export interface AuthorityPolicy {
  budgets: AuthorityBudgetPolicy;
  actors: Readonly<Record<AuthorityActorKind, AuthorityActorPolicy>>;
}

/**
 * The coordination-tier verbs an authenticated Session may run with no grant.
 *
 * The verbs an in-Session agent already uses to do its job: report on a ticket,
 * signal it is done or blocked, get someone's attention. Spelled as the Verb
 * Registry spells them, because VC-92 pinned the dot-name as the verb's identity
 * on every surface that projects it.
 *
 * The last two are INVOLUNTARY and were missing from this list until VC-163
 * wired it to the door — a gap that was invisible while nothing read the
 * policy. Neither is a verb an agent chooses: `session.harness` is fired by a
 * harness's own launch wrapper one step before it execs, and `hook` by a
 * harness hook reporting what the agent is doing. VC-92 §3 assigns both to the
 * coordination tier, and omitting them here would have refused every Session
 * the two channels its own harness reports through — silently, since `hook`
 * discards its answer by design so as never to wedge the agent it fired from.
 */
const DEFAULT_SESSION_COORDINATION_VERBS = [
  "ticket.comment",
  "ticket.create",
  "ticket.move",
  // The verdict channel (VC-85). A default rather than a grant, for the same
  // reason `session.done` is one: reporting how your own stage went is the job,
  // not a privilege on top of it. What makes a signal worth reading is that its
  // signer is authenticated, which is VC-163's door to close — not a shorter
  // list here, which would only push the report back into a comment nobody can
  // query.
  "ticket.signal",
  "ticket.update",
  "session.blocked",
  "session.done",
  "session.link",
  // Worktree sync (VC-185). A default rather than a grant, by VC-92's audit
  // principle: it merges the base into a worktree the Session's own `execute`
  // tool already reaches with two git commands, so withholding it here would
  // withhold nothing — it would only push the same merge back into hand-rolled
  // shell, which is the uneven staleness handling this verb replaces.
  "worktree.sync",
  // Label merge (VC-310). A default on `worktree.sync`'s reasoning: a Session
  // already holds `ticket.update`, whose `--add-label`/`--remove-label` reach
  // every association this verb touches, so withholding it would not withhold
  // the outcome — it would push the same rewrite into a hand-rolled loop that
  // previews nothing and reports no blast radius. The verb's own preview-first
  // shape is the guard here, not the policy list.
  "label.merge",
  "notify",
  "session.harness",
  "hook",
] as const;

/** Authenticated Sessions keep coordination and await access; anonymous callers get reads only. */
export const DEFAULT_AUTHORITY_POLICY: AuthorityPolicy = Object.freeze({
  // `ask` is VC-204's ruling: the in-ticket delegation allowance was always a
  // soft cap in intent, and its end is a question for the person driving
  // rather than a refusal. The allowance itself stays 3 and stays hard-coded —
  // what this field softens is only what the end of it does.
  budgets: Object.freeze({ delegationExceeded: "ask" }),
  actors: Object.freeze({
    user: Object.freeze({
      coordinationVerbs: Object.freeze([...DEFAULT_SESSION_COORDINATION_VERBS]),
      peek: "project",
      awaitable: Object.freeze([...TICKET_AWAIT_KINDS]),
      awaitableSessions: Object.freeze([...SESSION_AWAIT_KINDS]),
    }),
    session: Object.freeze({
      coordinationVerbs: Object.freeze([...DEFAULT_SESSION_COORDINATION_VERBS]),
      peek: "own",
      awaitable: Object.freeze([...TICKET_AWAIT_KINDS]),
      awaitableSessions: Object.freeze([...SESSION_AWAIT_KINDS]),
    }),
    unauthenticated: Object.freeze({
      coordinationVerbs: Object.freeze([]),
      peek: "none",
      awaitable: Object.freeze([]),
      awaitableSessions: Object.freeze([]),
    }),
  }),
}) as AuthorityPolicy;

/**
 * Whether one kind of caller may run one coordination-tier verb (VC-163).
 *
 * The read VC-44 built this store for, and the whole of the socket door's
 * write-side judgement. Deliberately a plain membership test rather than a
 * cascade of special cases:
 *
 * - **An unlisted verb is refused.** Not "unknown, so allow" — a caller
 *   holding no list holds nothing, which is what makes the default posture
 *   (`unauthenticated: { coordinationVerbs: [] }`) mean reads-only with no
 *   further code.
 * - **Read-tier verbs never reach here.** Callers gate on the verb's registry
 *   actor requirement first, so absence from a list is never mistaken for
 *   withholding a read that no policy withholds.
 * - **The tier is not consulted, because it is not stored.** VC-92 pinned tier
 *   as derived from access modes plus actor requirement; a policy that also
 *   recorded one could disagree with the registry, and one of them would be
 *   wrong.
 */
export function coordinationVerbAllowed(
  policy: AuthorityPolicy,
  kind: AuthorityActorKind,
  verbKey: string,
): boolean {
  return policy.actors[kind].coordinationVerbs.includes(verbKey);
}

/**
 * The token a project's list splices its own defaults in at.
 *
 * Claude Code's `"$defaults"` pattern, adopted for its shape rather than its
 * spelling. Extending a default list is the ordinary act and must be the cheap
 * one; replacing a list wholesale is rare, is occasionally right, and must be
 * visible as a choice when someone reads the stored document back. A list that
 * omits the token replaces — deliberately, and legibly, because the absence of
 * a token somebody else's list has is the thing a reviewer notices.
 *
 * It is not a wildcard and expands in place, so position is preserved: a project
 * can put its own entries before or after the defaults.
 */
export const AUTHORITY_DEFAULTS_TOKEN = "$defaults";

/** One coordination-verb list, as a project may state it. */
export type AuthorityListOverride = readonly string[];

/** An await list can name only the fixed await vocabulary or splice defaults. */
export type AuthorityAwaitableOverride = readonly (
  | TicketAwaitKind
  | typeof AUTHORITY_DEFAULTS_TOKEN
)[];

/** A Session-await list can name only the Session vocabulary or splice defaults. */
export type AuthorityAwaitableSessionsOverride = readonly (
  | SessionAwaitKind
  | typeof AUTHORITY_DEFAULTS_TOKEN
)[];

/** The per-actor half of an override; every field optional. */
export interface AuthorityActorPolicyOverride {
  coordinationVerbs?: AuthorityListOverride;
  peek?: PeekDisclosure;
  awaitable?: AuthorityAwaitableOverride;
  awaitableSessions?: AuthorityAwaitableSessionsOverride;
}

/** The budget half of an override; every field optional, absent inherits. */
export interface AuthorityBudgetPolicyOverride {
  delegationExceeded?: BudgetPosture;
}

/**
 * What a project may say about its own authority. Every field is optional and an
 * absent field inherits — a stored override records departures, never a
 * re-statement of the defaults, so a default that changes reaches every project
 * that never disagreed with it.
 */
export interface AuthorityPolicyOverride {
  budgets?: AuthorityBudgetPolicyOverride;
  actors?: Partial<Record<AuthorityActorKind, AuthorityActorPolicyOverride>>;
}

/**
 * Splice a project's list against the defaults it inherits.
 *
 * De-duplicated, first occurrence winning, so a project that names an entry the
 * defaults already carry does not get it twice — the list is a set with an order
 * and a reader should not have to know whether a duplicate meant anything.
 */
function spliceList<T extends string>(
  override: readonly (T | typeof AUTHORITY_DEFAULTS_TOKEN)[] | undefined,
  defaults: readonly T[],
): readonly T[] {
  if (override === undefined) return defaults;
  const spliced: T[] = [];
  for (const entry of override) {
    if (entry === AUTHORITY_DEFAULTS_TOKEN) spliced.push(...defaults);
    else spliced.push(entry as T);
  }
  return Object.freeze([...new Set(spliced)]);
}

function resolveActor(
  override: AuthorityActorPolicyOverride | undefined,
  defaults: AuthorityActorPolicy,
): AuthorityActorPolicy {
  return {
    coordinationVerbs: spliceList(override?.coordinationVerbs, defaults.coordinationVerbs),
    peek: override?.peek ?? defaults.peek,
    awaitable: spliceList(override?.awaitable, defaults.awaitable),
    awaitableSessions: spliceList(override?.awaitableSessions, defaults.awaitableSessions),
  };
}

/**
 * The policy a project is actually governed by: the built-in defaults, with the
 * project's recorded departures applied.
 *
 * Total over its input, and deliberately so. This runs on the attach path, where
 * a throw costs a Session its attachment; a stored document that has gone bad —
 * hand-edited, written by an older build, corrupted — must degrade to the
 * defaults rather than refuse to start an agent. Validation belongs at the write,
 * which is where someone is present to be told.
 */
export function resolveAuthorityPolicy(
  override: AuthorityPolicyOverride | null | undefined,
): AuthorityPolicy {
  const defaults = DEFAULT_AUTHORITY_POLICY;
  if (override === null || override === undefined) return defaults;
  return {
    budgets: {
      delegationExceeded:
        override.budgets?.delegationExceeded ?? defaults.budgets.delegationExceeded,
    },
    actors: {
      user: resolveActor(override.actors?.user, defaults.actors.user),
      session: resolveActor(override.actors?.session, defaults.actors.session),
      unauthenticated: resolveActor(
        override.actors?.unauthenticated,
        defaults.actors.unauthenticated,
      ),
    },
  };
}

/**
 * Read one stored override document, keeping only what it says legibly.
 *
 * The parse half of the same bargain {@link resolveAuthorityPolicy} makes: this
 * is fed a JSON blob off a database column, so every field is checked and an
 * unreadable one is dropped rather than thrown over. A `null` answer means "this
 * project states nothing", which is also what an absent column means — the two
 * are the same situation and must resolve the same way.
 *
 * Dropping a bad field rather than the whole document is the choice worth
 * naming: a project that misspells one enforcement value should lose that
 * setting, not the per-actor policy stored beside it.
 */
export function parseAuthorityPolicyOverride(value: unknown): AuthorityPolicyOverride | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const override: AuthorityPolicyOverride = {};
  const budgets = parseBudgets(row.budgets);
  if (budgets !== undefined) override.budgets = budgets;
  const actors = parseActors(row.actors);
  if (actors !== undefined) override.actors = actors;
  return override;
}

function enumOrUndefined<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** The read-path half of `budgets`, dropping what it cannot read like every field here. */
function parseBudgets(value: unknown): AuthorityBudgetPolicyOverride | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const budgets: AuthorityBudgetPolicyOverride = {};
  const posture = enumOrUndefined(row.delegationExceeded, BUDGET_POSTURES);
  if (posture !== undefined) budgets.delegationExceeded = posture;
  return Object.keys(budgets).length === 0 ? undefined : budgets;
}

function parseActors(
  value: unknown,
): Partial<Record<AuthorityActorKind, AuthorityActorPolicyOverride>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const actors: Partial<Record<AuthorityActorKind, AuthorityActorPolicyOverride>> = {};
  for (const kind of AUTHORITY_ACTOR_KINDS) {
    const parsed = parseActor(row[kind]);
    if (parsed !== undefined) actors[kind] = parsed;
  }
  return Object.keys(actors).length === 0 ? undefined : actors;
}

function parseActor(value: unknown): AuthorityActorPolicyOverride | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const actor: AuthorityActorPolicyOverride = {};
  const coordinationVerbs = parseStringList(row.coordinationVerbs);
  if (coordinationVerbs !== undefined) actor.coordinationVerbs = coordinationVerbs;
  const peek = enumOrUndefined(row.peek, PEEK_DISCLOSURES);
  if (peek !== undefined) actor.peek = peek;
  const awaitable = parseAwaitableList(row.awaitable, TICKET_AWAIT_KINDS);
  if (awaitable !== undefined) actor.awaitable = awaitable;
  const awaitableSessions = parseAwaitableList(row.awaitableSessions, SESSION_AWAIT_KINDS);
  if (awaitableSessions !== undefined) actor.awaitableSessions = awaitableSessions;
  return Object.keys(actor).length === 0 ? undefined : actor;
}

/**
 * One await list's read path, parameterized over its vocabulary.
 *
 * Shared by the two lists because they were byte-identical apart from the
 * vocabulary — while the vocabularies themselves stay apart, which is what
 * stops a Ticket kind being accepted into the Session list. All-or-nothing
 * like every list here: a list that lost an unreadable entry would grant
 * strictly less than the document says, with nothing to show it happened.
 */
function parseAwaitableList<V extends readonly string[]>(
  value: unknown,
  vocabulary: V,
): readonly V[number][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed = [...vocabulary, AUTHORITY_DEFAULTS_TOKEN] as const;
  return value.every(
    (entry) => typeof entry === "string" && (allowed as readonly string[]).includes(entry),
  )
    ? (value as readonly V[number][])
    : undefined;
}

/**
 * A coordination-verb list is kept only when every entry is a string.
 *
 * All-or-nothing rather than filtering the bad entries out, because a list is
 * the one place a silent drop changes meaning: a `coordinationVerbs` that lost
 * an unreadable entry would grant strictly less than the document says, with
 * nothing on the surface to show it happened.
 */
function parseStringList(value: unknown): AuthorityListOverride | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined;
}

/**
 * What {@link validateAuthorityPolicyOverride} answers: the document as it will
 * be stored, or every reason it will not be.
 *
 * Every reason and not the first, because this reports to a person editing a
 * form: fixing one field only to be told about the next is the interaction a
 * batch of errors exists to avoid.
 */
export type AuthorityPolicyValidation =
  | { readonly ok: true; readonly override: AuthorityPolicyOverride }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Validate one override document on its way IN, refusing what
 * {@link parseAuthorityPolicyOverride} would have quietly dropped.
 *
 * The write half of the bargain the read half makes, and deliberately the
 * opposite bargain. {@link resolveAuthorityPolicy} runs on the attach path where
 * a throw costs a Session its attachment, so it degrades; its doc names the
 * trade and says where the other side lives — "validation belongs at the write,
 * which is where someone is present to be told". This is that place.
 *
 * So the two differ on purpose and must not be collapsed into one pass:
 *
 * - An **unknown key** is an error here and invisible there. A misspelled
 *   `enforcment` silently means "state nothing" on the read path, which is
 *   indistinguishable from a project that chose the default — the exact failure
 *   a person editing policy must never hit in silence.
 * - A **bad value** is an error here and a dropped field there. `enforcement:
 *   "enforced"` must not store as "inherit observe" and read back as though the
 *   project never disagreed.
 * - An **absent** field is inherit in both. That is the one agreement, and it is
 *   the whole additive-inheritance design: a stored document records departures,
 *   never a re-statement of the defaults.
 *
 * Errors are path-qualified (`actors.session.peek`) because a document nested
 * three deep gives "invalid policy" nothing to point at.
 */
export function validateAuthorityPolicyOverride(value: unknown): AuthorityPolicyValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, errors: ["A policy override must be an object."] };
  }
  const row = value as Record<string, unknown>;
  const errors: string[] = [];
  const override: AuthorityPolicyOverride = {};

  rejectUnknownKeys(
    row,
    ["enforcement", "judgmentMode", "classifierModel", "fallback", "budgets", "actors"],
    "",
    errors,
  );

  // VC-504: old stored review settings are accepted but never retained.
  if (row.budgets !== undefined) {
    const budgets = validateBudgets(row.budgets, errors);
    if (budgets !== undefined) override.budgets = budgets;
  }

  if (row.actors !== undefined) {
    const actors = validateActors(row.actors, errors);
    if (actors !== undefined) override.actors = actors;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, override };
}

/**
 * Whether a validated override says nothing at all.
 *
 * The store's NULL rule, as a question the caller can ask before writing —
 * `updateProjectSkillModes`'s bargain for this column. A project that reverted
 * its last departure must be byte-identical in the database to one that never
 * stated anything, or the two are distinguishable in the column and identical
 * everywhere above it, which is a difference something will eventually depend on
 * by accident.
 */
export function isEmptyAuthorityPolicyOverride(override: AuthorityPolicyOverride): boolean {
  return Object.keys(override).length === 0;
}

function badEnum(path: string, allowed: readonly string[]): string {
  return `${path} must be one of: ${allowed.join(", ")}.`;
}

/**
 * An unrecognised key is refused rather than ignored.
 *
 * The single most valuable thing this validator does that the read path cannot.
 * A typo'd field name is the one mistake that produces a document which stores
 * cleanly, reads back cleanly, and governs nothing.
 */
function rejectUnknownKeys(
  row: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
  errors: string[],
): void {
  for (const key of Object.keys(row)) {
    if (!allowed.includes(key)) errors.push(`Unknown field: ${prefix}${key}.`);
  }
}

function validateBudgets(
  value: unknown,
  errors: string[],
): AuthorityBudgetPolicyOverride | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push("budgets must be an object.");
    return undefined;
  }
  const row = value as Record<string, unknown>;
  rejectUnknownKeys(row, ["delegationExceeded"], "budgets.", errors);
  const budgets: AuthorityBudgetPolicyOverride = {};
  if (row.delegationExceeded !== undefined) {
    const posture = enumOrUndefined(row.delegationExceeded, BUDGET_POSTURES);
    if (posture === undefined) errors.push(badEnum("budgets.delegationExceeded", BUDGET_POSTURES));
    else budgets.delegationExceeded = posture;
  }
  return Object.keys(budgets).length === 0 ? undefined : budgets;
}

function validateActors(
  value: unknown,
  errors: string[],
): Partial<Record<AuthorityActorKind, AuthorityActorPolicyOverride>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push("actors must be an object.");
    return undefined;
  }
  const row = value as Record<string, unknown>;
  rejectUnknownKeys(row, AUTHORITY_ACTOR_KINDS, "actors.", errors);
  const actors: Partial<Record<AuthorityActorKind, AuthorityActorPolicyOverride>> = {};
  for (const kind of AUTHORITY_ACTOR_KINDS) {
    if (row[kind] === undefined) continue;
    const actor = validateActor(row[kind], `actors.${kind}`, errors);
    if (actor !== undefined) actors[kind] = actor;
  }
  return Object.keys(actors).length === 0 ? undefined : actors;
}

function validateActor(
  value: unknown,
  path: string,
  errors: string[],
): AuthorityActorPolicyOverride | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(`${path} must be an object.`);
    return undefined;
  }
  const row = value as Record<string, unknown>;
  rejectUnknownKeys(
    row,
    ["coordinationVerbs", "peek", "awaitable", "awaitableSessions"],
    `${path}.`,
    errors,
  );
  const actor: AuthorityActorPolicyOverride = {};
  if (row.coordinationVerbs !== undefined) {
    const list = validateStringList(row.coordinationVerbs, `${path}.coordinationVerbs`, errors);
    if (list !== undefined) actor.coordinationVerbs = list;
  }
  if (row.awaitable !== undefined) {
    const list = validateAwaitableList(row.awaitable, `${path}.awaitable`, errors);
    if (list !== undefined) actor.awaitable = list;
  }
  if (row.awaitableSessions !== undefined) {
    const list = validateAwaitableSessionsList(
      row.awaitableSessions,
      `${path}.awaitableSessions`,
      errors,
    );
    if (list !== undefined) actor.awaitableSessions = list;
  }
  if (row.peek !== undefined) {
    const peek = enumOrUndefined(row.peek, PEEK_DISCLOSURES);
    if (peek === undefined) errors.push(badEnum(`${path}.peek`, PEEK_DISCLOSURES));
    else actor.peek = peek;
  }
  return Object.keys(actor).length === 0 ? undefined : actor;
}

/**
 * A list is refused whole when any entry is not a string, matching
 * {@link parseStringList}'s all-or-nothing rule for the reason given there — a
 * list that lost one entry grants something different from what it says.
 *
 * {@link AUTHORITY_DEFAULTS_TOKEN} needs no special case: it is a string, and
 * whether it appears is the project's business. A list that omits it replaces
 * the defaults, which is a legal thing to mean and is the reason the token is a
 * token rather than an implicit prefix.
 */
function validateStringList(
  value: unknown,
  path: string,
  errors: string[],
): AuthorityListOverride | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array of strings.`);
    return undefined;
  }
  if (!value.every((entry) => typeof entry === "string")) {
    errors.push(`${path} must contain only strings.`);
    return undefined;
  }
  return value as string[];
}

function validateAwaitableList(
  value: unknown,
  path: string,
  errors: string[],
): AuthorityAwaitableOverride | undefined {
  return validateAwaitableVocabulary(value, path, errors, TICKET_AWAIT_KINDS) as
    | AuthorityAwaitableOverride
    | undefined;
}

function validateAwaitableSessionsList(
  value: unknown,
  path: string,
  errors: string[],
): AuthorityAwaitableSessionsOverride | undefined {
  return validateAwaitableVocabulary(value, path, errors, SESSION_AWAIT_KINDS) as
    | AuthorityAwaitableSessionsOverride
    | undefined;
}

/**
 * One await list against one vocabulary, reported per entry.
 *
 * Shared by the two lists because the RULE is shared — an array, of this
 * vocabulary or the defaults token — while the vocabularies themselves stay
 * apart, which is what stops a Ticket kind being accepted into the Session
 * list. Refused whole rather than filtered, on `validateStringList`'s ground.
 */
function validateAwaitableVocabulary(
  value: unknown,
  path: string,
  errors: string[],
  vocabulary: readonly string[],
): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array.`);
    return undefined;
  }
  const allowed = [...vocabulary, AUTHORITY_DEFAULTS_TOKEN];
  const invalid = value.filter((entry) => typeof entry !== "string" || !allowed.includes(entry));
  if (invalid.length > 0) {
    errors.push(`${path} entries must be one of: ${allowed.join(", ")}.`);
    return undefined;
  }
  return value as readonly string[];
}
