/**
 * The durable authority policy a project is governed by, as data rather than code.
 *
 * `./authority.ts` holds the Authority Snapshot — the policy one Session
 * executes under, pinned for the life of one attachment. This module holds the
 * thing a Snapshot is *made from*: a per-project document with built-in
 * defaults, resolved at attach. Slice 7 of
 * `docs/plans/authority-two-axis-rearchitecture.md` calls this "policy as data",
 * and the point is that changing what a Session may do stops requiring a build.
 *
 * **Where this may be stored is a security property, not a convenience.** The
 * override is app-owned state — a column on `projects` in the SQLite database
 * under Electron's `userData`. It is never a file in the worktree and never a
 * repo-committed settings file. Claude Code's classifier refuses to read
 * `autoMode` out of repo-local settings for exactly this reason: a checked-in
 * file, or a build step that writes one, would let the thing being governed
 * write its own permissions. A policy store the agent can edit is not a policy
 * store.
 *
 * Say the limit of that honestly, because today it is a limit and not a
 * guarantee. The database is outside every Session workspace, so no file tool
 * reaches it — `path.outside-workspace` refuses reads and writes there. But the
 * pack does not judge command *operands*, and the capability axis is off, so a
 * Session's `execute` tool can still reach the database through an ordinary
 * shell command. What closes that is `writableRoots` in VC-45, not anything
 * here. What this module does buy today is that policy is never sourced from
 * the tree the agent is editing, which is the mistake that costs nothing to
 * avoid and everything to make.
 *
 * Nothing here is a rule. The rule pack stays compiled (`./authority-policy.ts`)
 * and its identity stays {@link AUTHORITY_RULE_IDS}; what became data is which
 * posture a project runs the pack under, who judges what the pack cannot, and
 * the per-actor policy VC-163 and VC-85 read. Rules-as-data is a later slice,
 * and it needs a rule language before it needs a store.
 */

import type { AuthorityFallback } from "./authority";

/**
 * What the deterministic rule pack does to a Session, as a per-project posture.
 *
 * Three states and not two, because "no gate at all" is a real answer a person
 * must be able to give. Codex ships it as a bypass mode and Claude Code as
 * `--dangerously-skip-permissions`; Volli has shipped it since the sandbox came
 * out, as the absence of a Snapshot. Naming it makes it a decision rather than
 * the status quo nobody chose.
 *
 * The three map onto the runtime seam exactly, which is why there is no fourth:
 *
 * - `off` — no Snapshot is constructed, so `SessionRuntimeSpec.authority` is
 *   absent, so Pi installs no `beforeToolCall`. The rule pack, the fallback
 *   thresholds and the escalation port are all unreachable rather than quietly
 *   permissive. This is what every Session ran under before this ticket.
 * - `observe` — the Snapshot is built, pinned and durably recorded against the
 *   attachment, and the gate does not install. Nothing is refused. The pack's
 *   identity is on the record, so a later reader can say what a Session *would*
 *   have been governed by, which is the whole of what the Snapshot is for.
 * - `enforce` — the Snapshot is also handed to the runtime, the gate installs,
 *   and a refusal is a refusal: recorded as `authority.denied`, escalated to a
 *   person once {@link AuthorityFallback} trips, and overridable exactly where
 *   `OVERRIDABLE_AUTHORITY_RULES` says a person's "yes" could be carried out.
 *
 * `observe` is not `off` with extra steps: it is the posture that makes the
 * Snapshot durable without changing what any Session can do, which is what lets
 * this slice ship without silently re-activating a dormant rule pack. VC-28 v0
 * gives `observe` its second half — a gate that records what it would have
 * refused — and it attaches to this name rather than inventing another.
 */
export type AuthorityEnforcement = "off" | "observe" | "enforce";

export const AUTHORITY_ENFORCEMENTS = ["off", "observe", "enforce"] as const;

/**
 * Who judges a call the deterministic rules cannot settle.
 *
 * Defined here and given behaviour by VC-28. `ask` is today's path: a refusal
 * the rules produced goes to a person through the escalation port. `auto` is
 * Anthropic's auto-mode shape — a classifier judges first and only a flag
 * reaches the person. The field rides the Snapshot so that a Session's judge is
 * pinned at attach like everything else about its authority; a Settings change
 * mid-Session must not silently change who is deciding.
 *
 * It is deliberately not a third enforcement value. Enforcement asks whether the
 * pack binds; judgment asks who rules on what the pack cannot answer. Collapsing
 * them is the same one-dial-two-jobs mistake the re-architecture exists to undo.
 */
export type JudgmentMode = "ask" | "auto";

export const JUDGMENT_MODES = ["ask", "auto"] as const;

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
  awaitable: readonly string[];
}

/**
 * The per-project authority document, fully resolved.
 *
 * Everything a Snapshot needs and nothing a Snapshot has. The Snapshot adds what
 * only an attachment knows — the tree it runs in, the Agent Tool Surface it was
 * handed, the pack it pinned — and this supplies what a project decided in
 * advance.
 */
export interface AuthorityPolicy {
  enforcement: AuthorityEnforcement;
  judgmentMode: JudgmentMode;
  /** The model allowed to judge what the rules cannot. Null until VC-28. */
  classifierModel: string | null;
  fallback: AuthorityFallback;
  actors: Readonly<Record<AuthorityActorKind, AuthorityActorPolicy>>;
}

/**
 * The coordination-tier verbs an authenticated Session may run with no grant.
 *
 * The verbs an in-Session agent already uses to do its job: report on a ticket,
 * signal it is done or blocked, get someone's attention. Spelled as the Verb
 * Registry spells them, because VC-92 pinned the dot-name as the verb's identity
 * on every surface that projects it.
 */
const DEFAULT_SESSION_COORDINATION_VERBS = [
  "ticket.comment",
  "ticket.create",
  "ticket.move",
  "ticket.update",
  "session.blocked",
  "session.done",
  "session.link",
  "notify",
] as const;

/**
 * The built-in policy, and the reasoning for each departure from "off".
 *
 * `enforcement: "observe"` is this ticket's day-one posture and it was taken
 * deliberately, against the nine-rule pack as VC-3 left it rather than the ten
 * it used to be. Enforcing on day one refuses two things the product itself
 * asks a Session to do: the skills index tells the model to activate a skill by
 * reading its `SKILL.md`, and a personal-tier skill lives at
 * `<home>/.agents/skills/<slug>/SKILL.md` — outside every Session workspace, so
 * `path.outside-workspace` refuses the read. The Main checkout a ticket brief
 * offers as reference reads the same way. Worse, the same file is readable
 * through `execute`, because no rule judges command operands: the model would
 * learn to reach for `cat` where `read` was refused, which is the workaround
 * coaching the plan's denial-semantics slice exists to stop. `observe` pins and
 * records the Snapshot, changes nothing a Session can do, and leaves the flip to
 * `enforce` a per-project decision that needs no build. Slice 1 of the plan —
 * one read policy for both layers — is what makes `enforce` the right default,
 * and it is VC-45's to ship.
 *
 * `judgmentMode: "ask"` because no classifier exists yet; `auto` without VC-28
 * would name a judge that cannot judge.
 *
 * The actor defaults carry VC-92's rulings. An authenticated Session gets the
 * coordination verbs it already uses and may read its own transcript. The
 * unauthenticated caller gets **reads only** — no coordination verb, no
 * transcript, nothing to await — which VC-92 justified as costing almost
 * nothing: the app drives ~99% of human interaction, in-Session agents
 * authenticate, and an external client will authenticate through the host API.
 * The user is the person driving Volli and is bounded by the app's own surfaces
 * rather than by this table, so their entry is permissive and is here to be
 * a complete table rather than a live restriction.
 *
 * `awaitable` is empty everywhere because VC-85 has not landed: there is nothing
 * to wait on yet, and a default naming await kinds that do not exist would be a
 * guess written down as policy.
 */
export const DEFAULT_AUTHORITY_POLICY: AuthorityPolicy = Object.freeze({
  enforcement: "observe",
  judgmentMode: "ask",
  classifierModel: null,
  // Anthropic's published defaults for the same mechanism, adopted with no
  // knowledge of how they were tuned — see `AuthorityFallback`.
  fallback: Object.freeze({ consecutiveDenials: 3, sessionDenials: 20 }),
  actors: Object.freeze({
    user: Object.freeze({
      coordinationVerbs: Object.freeze([...DEFAULT_SESSION_COORDINATION_VERBS]),
      peek: "project",
      awaitable: Object.freeze([]),
    }),
    session: Object.freeze({
      coordinationVerbs: Object.freeze([...DEFAULT_SESSION_COORDINATION_VERBS]),
      peek: "own",
      awaitable: Object.freeze([]),
    }),
    unauthenticated: Object.freeze({
      coordinationVerbs: Object.freeze([]),
      peek: "none",
      awaitable: Object.freeze([]),
    }),
  }),
}) as AuthorityPolicy;

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

/** One list-valued field, as a project may state it. */
export type AuthorityListOverride = readonly string[];

/** The per-actor half of an override; every field optional. */
export interface AuthorityActorPolicyOverride {
  coordinationVerbs?: AuthorityListOverride;
  peek?: PeekDisclosure;
  awaitable?: AuthorityListOverride;
}

/**
 * What a project may say about its own authority. Every field is optional and an
 * absent field inherits — a stored override records departures, never a
 * re-statement of the defaults, so a default that changes reaches every project
 * that never disagreed with it.
 */
export interface AuthorityPolicyOverride {
  enforcement?: AuthorityEnforcement;
  judgmentMode?: JudgmentMode;
  classifierModel?: string | null;
  fallback?: Partial<AuthorityFallback>;
  actors?: Partial<Record<AuthorityActorKind, AuthorityActorPolicyOverride>>;
}

/**
 * Splice a project's list against the defaults it inherits.
 *
 * De-duplicated, first occurrence winning, so a project that names an entry the
 * defaults already carry does not get it twice — the list is a set with an order
 * and a reader should not have to know whether a duplicate meant anything.
 */
function spliceList(
  override: AuthorityListOverride | undefined,
  defaults: readonly string[],
): readonly string[] {
  if (override === undefined) return defaults;
  const spliced = override.flatMap((entry) =>
    entry === AUTHORITY_DEFAULTS_TOKEN ? defaults : [entry],
  );
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
    enforcement: override.enforcement ?? defaults.enforcement,
    judgmentMode: override.judgmentMode ?? defaults.judgmentMode,
    classifierModel:
      override.classifierModel === undefined ? defaults.classifierModel : override.classifierModel,
    fallback: {
      consecutiveDenials:
        override.fallback?.consecutiveDenials ?? defaults.fallback.consecutiveDenials,
      sessionDenials: override.fallback?.sessionDenials ?? defaults.fallback.sessionDenials,
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
  const enforcement = enumOrUndefined(row.enforcement, AUTHORITY_ENFORCEMENTS);
  if (enforcement !== undefined) override.enforcement = enforcement;
  const judgmentMode = enumOrUndefined(row.judgmentMode, JUDGMENT_MODES);
  if (judgmentMode !== undefined) override.judgmentMode = judgmentMode;
  if (typeof row.classifierModel === "string" || row.classifierModel === null) {
    override.classifierModel = row.classifierModel;
  }
  const fallback = parseFallback(row.fallback);
  if (fallback !== undefined) override.fallback = fallback;
  const actors = parseActors(row.actors);
  if (actors !== undefined) override.actors = actors;
  return override;
}

function enumOrUndefined<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/**
 * A threshold is kept only when it is a whole number of denials.
 *
 * `AuthorityEscalation` already defends itself against zero, negative and `NaN`
 * by reading them as "never escalate", but a stored document is written by a
 * person and a rejected value there is a value someone can be told about. This
 * drops it so the default stands, rather than persisting a number that silently
 * disables escalation while looking configured.
 */
function parseFallback(value: unknown): Partial<AuthorityFallback> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const fallback: Partial<AuthorityFallback> = {};
  if (isThreshold(row.consecutiveDenials)) fallback.consecutiveDenials = row.consecutiveDenials;
  if (isThreshold(row.sessionDenials)) fallback.sessionDenials = row.sessionDenials;
  return Object.keys(fallback).length === 0 ? undefined : fallback;
}

function isThreshold(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
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
  const awaitable = parseStringList(row.awaitable);
  if (awaitable !== undefined) actor.awaitable = awaitable;
  return Object.keys(actor).length === 0 ? undefined : actor;
}

/**
 * A list is kept only when every entry is a string.
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
    ["enforcement", "judgmentMode", "classifierModel", "fallback", "actors"],
    "",
    errors,
  );

  if (row.enforcement !== undefined) {
    const enforcement = enumOrUndefined(row.enforcement, AUTHORITY_ENFORCEMENTS);
    if (enforcement === undefined) errors.push(badEnum("enforcement", AUTHORITY_ENFORCEMENTS));
    else override.enforcement = enforcement;
  }

  if (row.judgmentMode !== undefined) {
    const judgmentMode = enumOrUndefined(row.judgmentMode, JUDGMENT_MODES);
    if (judgmentMode === undefined) errors.push(badEnum("judgmentMode", JUDGMENT_MODES));
    else override.judgmentMode = judgmentMode;
  }

  // `null` is a MEANINGFUL value here, not an absence: it is how a project says
  // "no classifier" against a default that names one. `undefined` is the
  // absence, and only that inherits — which is why `resolveAuthorityPolicy`
  // tests this field with `=== undefined` rather than `??`.
  if (row.classifierModel !== undefined) {
    if (row.classifierModel === null || typeof row.classifierModel === "string") {
      override.classifierModel = row.classifierModel;
    } else {
      errors.push("classifierModel must be a string or null.");
    }
  }

  if (row.fallback !== undefined) {
    const fallback = validateFallback(row.fallback, errors);
    if (fallback !== undefined) override.fallback = fallback;
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

function validateFallback(
  value: unknown,
  errors: string[],
): Partial<AuthorityFallback> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push("fallback must be an object.");
    return undefined;
  }
  const row = value as Record<string, unknown>;
  rejectUnknownKeys(row, ["consecutiveDenials", "sessionDenials"], "fallback.", errors);
  const fallback: Partial<AuthorityFallback> = {};
  for (const key of ["consecutiveDenials", "sessionDenials"] as const) {
    if (row[key] === undefined) continue;
    // `isThreshold`'s floor of 1, surfaced as a refusal rather than a drop.
    // `AuthorityEscalation` reads 0 and negatives as "never escalate", so a
    // stored 0 would disable escalation while looking configured.
    if (isThreshold(row[key])) fallback[key] = row[key] as number;
    else errors.push(`fallback.${key} must be a whole number of denials, 1 or greater.`);
  }
  return Object.keys(fallback).length === 0 ? undefined : fallback;
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
  rejectUnknownKeys(row, ["coordinationVerbs", "peek", "awaitable"], `${path}.`, errors);
  const actor: AuthorityActorPolicyOverride = {};
  for (const key of ["coordinationVerbs", "awaitable"] as const) {
    if (row[key] === undefined) continue;
    const list = validateStringList(row[key], `${path}.${key}`, errors);
    if (list !== undefined) actor[key] = list;
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
