/**
 * The one Session-start module: how a structured Session begins, whatever its
 * Role. The Role is stated once, by the caller, as {@link SessionStartInput.role}
 * — the same field `session.create` records durably — instead of being
 * re-derived by parallel Ticket/project facades. Until VC-9 `ticketId !== null`
 * stood in for it; a Subagent Session inherits its parent's Ticket without
 * being a Ticket Session, which is what retired that reading.
 *
 * There is one executor, so there is one adapter id; keeping it here rather
 * than at each caller is what stops a second copy from quietly naming a
 * different runtime. The model rule is shared for the same reason: a Session
 * records the configured default as its own durable, observable event before
 * any attachment exists.
 *
 * Which is the whole of what "substitute" is allowed to mean here. A Session
 * born before the policy existed has its default written at attach — `attach`
 * below does exactly that — but it is written, as that Session's own
 * `model.select`, ahead of the attachment and visible in its history. What none
 * of this does is hand a model to a running attachment that the Session never
 * recorded: a model nobody wrote down is not a model this runtime will use.
 */

import type { SessionRuntime, SessionRuntimeCommandResult } from "@volli/session-engine";
import {
  AUTO_SELECT_TIERS,
  autoSelectCandidates,
  DECISION_PURPOSE_POLICY,
  DEFAULT_MODEL_REQUIRED,
  defaultModelRequiredForTier,
  isAgentModelTier,
  modelPurposeForRole,
} from "@volli/shared";
import type {
  AgentModelTier,
  AutoSelectCandidate,
  AutoSelectPick,
  ModelAccessSnapshot,
  ModelAutoPick,
  ModelSelection,
  McpToolDefinition,
  ModelTier,
  PromptResource,
  ReasoningLevel,
  SessionRole,
  SessionStartResult,
  SessionToolId,
  TicketEventActor,
} from "@volli/shared";

import type { SessionGrantPorts, TicketSessionDelegation } from "./delegation-policy";

/**
 * The Session Engine command id one start operation writes its `create` under.
 *
 * Exported because two callers need the same answer and neither owns it: `mint`
 * writes the command, and the tool door hands the id to the delegation ledger
 * as the durable evidence that a claimed fan-out slot really opened a Session.
 * Spelling it twice is how those two quietly stop agreeing.
 */
export function sessionCreateCommandId(operationId: string): string {
  return `${operationId}:create`;
}

/**
 * The one adapter id the structured product attaches under.
 *
 * The runtime supplies it to the command itself; this constant is what every
 * *other* reader of a durable attachment compares against — including the boot
 * sweep, which retires every local open attachment that does not match. It is
 * declared in this module, which carries no runtime dependency, so those
 * readers can name the id without importing Pi; `PI_ADAPTER_ID` aliases it so
 * the two cannot drift.
 */
export const STRUCTURED_ADAPTER_ID = "pi";

/**
 * The refusal, once, for both Roles. Two wordings of one rule would read as two
 * rules — a person meeting it on a Board chat and again on a Ticket has no way
 * to tell that the second is the same missing setting as the first. The wording
 * itself lives in `@volli/shared` because the renderer classifies this refusal
 * as a predictable configuration state rather than an error to toast (VC-53):
 * a copy declared here would drift out from under that classifier silently.
 */
export { DEFAULT_MODEL_REQUIRED };

export type StructuredSessionsErrorCode =
  | "DEFAULT_MODEL_REQUIRED"
  | "MODEL_SELECTION_REJECTED"
  // An invocation-time model override Model Access cannot honor: a model it
  // does not know, a provider that needs sign-in first, or a reasoning level
  // the chosen model cannot run. Refused before any Session exists.
  | "MODEL_UNAVAILABLE"
  | "SKILL_NOT_FOUND"
  | "TICKET_NOT_IN_PROJECT"
  // A Subagent Session with no parent, or a parent named for a Role that has
  // none (VC-9). A caller bug, refused before anything durable exists.
  | "PARENT_REQUIRED";

/** A refusal a caller can act on, never a bare string a surface has to parse. */
export class StructuredSessionsError extends Error {
  constructor(
    readonly code: StructuredSessionsErrorCode,
    message: string,
    readonly sessionId: string | null = null,
  ) {
    super(message);
    this.name = "StructuredSessionsError";
  }
}

/** The single Session Engine verb this module is allowed to reach. */
export type StructuredSessionCommands = Pick<SessionRuntime, "command">;

/**
 * How a start turns skills into the durable resources the runtime injects —
 * all halves implemented by the composition root, because only it holds the
 * project table and the Session Engine.
 *
 * `resolve` and `index` both run BEFORE `session.create`, and their failure
 * policies differ on purpose. A skill the user NAMED that is not on disk
 * refuses the start while there is still nothing durable to strand —
 * `resolve` throws {@link StructuredSessionsError} with `SKILL_NOT_FOUND`.
 * The `index` — the opt-in metadata disclosure nobody named — is best-effort:
 * an unreadable skills directory costs the index, never the chat, because a
 * broken opt-in must not brick every Session in the project. `injectedNames`
 * are the skills already resolved in full; the index skips them rather than
 * telling the model to go read what it was already handed.
 *
 * `record` runs after create and before attach, writing everything resolved
 * as the Session's own `prompt-resources` input: the attach composes the
 * system prompt from that record, never from a second disk read, so a
 * restart-recovery re-attach months later injects the same bytes this start
 * did — index included.
 */
export interface SessionSkillPorts {
  resolve(projectId: string, names: readonly string[]): Promise<readonly PromptResource[]>;
  index(projectId: string, injectedNames: readonly string[]): Promise<PromptResource | null>;
  record(sessionId: string, resources: readonly PromptResource[]): Promise<void>;
}

/**
 * Freeze the sanitized Agent Tool Surface before the first attachment.
 *
 * Only names and order cross this port. Implementations may inspect live
 * capability settings to resolve them, but credentials and callable ports stay
 * with their owners and never enter Session history. A reattach reads this
 * record and either rebinds it honestly or fails without sending a changed tool
 * array.
 */
export interface SessionToolSurfacePorts {
  /**
   * The whole surface for one Role: `capability tools ∪ bundle(Role) ∪
   * grants(session)` (VC-162).
   *
   * Takes the Role because the Role decides the base verb half — a Project
   * Session carries the agent-control family and a Ticket Role carries none.
   * The separate `grants` argument is the durable birth exception, which keeps
   * availability-as-enforcement without turning it into a bundle edit. Before
   * this argument existed every Session resolved the same list, and "Role
   * determines the tool bundle" was true only in `CONTEXT.md`.
   *
   * `within` is a Subagent Session's bound (VC-9): its parent's own frozen
   * surface. A child cannot get a port its parent lacked, and the parent's
   * record — not today's Settings — is what says what it had. Absent for the
   * two root Roles, which are bounded by nothing but the profile.
   */
  resolve(
    role: SessionRole,
    grants: readonly string[],
    within?: readonly SessionToolId[],
    mcpTools?: readonly McpToolDefinition[],
    classify?: boolean,
  ): readonly SessionToolId[];
  /** Selected sanitized definitions for a newly born root Session. */
  resolveMcp?(projectId: string): readonly McpToolDefinition[];
  /**
   * Whether a Session born now in this project is offered `classify` (VC-478):
   * a decision model is configured for the tool and, if it is in the cloud,
   * opted into (`offersClassifyTool`). Asked once, at birth, and frozen with the rest of
   * the surface; a Subagent is still bounded by its parent's record (`within`).
   * Absent reads as no.
   */
  resolveClassify?(projectId: string): Promise<boolean>;
  /** Exact definitions a parent froze, used verbatim by a new child. */
  recordedMcp?(sessionId: string): Promise<readonly McpToolDefinition[]>;
  /**
   * The surface one existing Session was frozen with, or `null` when it has
   * none recorded (a legacy Session that has not attached since VC-164). Read
   * for a parent, to bound its child.
   */
  recorded(sessionId: string): Promise<readonly SessionToolId[] | null>;
  record(
    sessionId: string,
    tools: readonly SessionToolId[],
    mcpTools?: readonly McpToolDefinition[],
    /**
     * A Subagent Session's parent, so what the child freezes beside its names
     * — Code Mode's routes (VC-471) — is bounded by the parent's record the
     * way the names are. Absent for a root Session.
     */
    parentSessionId?: string,
  ): Promise<void>;
}

/**
 * The backfill's command id, derived from the Session rather than the attach.
 *
 * The read that decides whether to backfill and the write that performs it are
 * not one atomic step, so two attaches racing the same legacy Session — a Retry
 * pressed while the first is still in flight, two surfaces mounting it at once —
 * can both see nothing recorded and both write. An operation-scoped id would
 * make those two writes look like two different intents and leave the Session
 * with a duplicate `model.select` in its durable history. Keyed on the Session,
 * they are one intent stated twice, which is precisely what command dedup exists
 * to collapse.
 */
function modelBackfillCommandId(sessionId: string): string {
  return `${sessionId}:model-backfill`;
}

export interface SessionStartInput {
  operationId: string;
  projectId: string;
  /**
   * The Ticket this Session works, or none. A Ticket Session's own; a Subagent
   * Session's inherited from its parent; a Board Session's null.
   */
  ticketId: string | null;
  /**
   * The Role, stated by the door (VC-9). A person's doors have two to choose
   * from and say which through `roleImpliedByTicket`; only the delegate tool
   * door mints a `subagent`, and it says so.
   */
  role: SessionRole;
  /**
   * The Session that delegated this one — required for a `subagent`, refused
   * for every other Role. Trusted in-process ancestry from the bound tool
   * door; no renderer or socket schema can name it.
   */
  parentSessionId?: string;
  title: string | null;
  /**
   * The Session id a client already minted (VC-358), honored when present so a
   * provisional chat can be promoted under the id it carried all along. There
   * is no swap to manage because there is no second id: the ledger takes this
   * one as the Session's.
   *
   * Rides the `session.create` CLIENT COMMAND only — never the model record,
   * never an attach — and is deliberately absent from the durable intent the
   * engine writes: the id IS the Session's id, so recording that it was
   * proposed would be a second copy of one fact. The command id stays derived
   * from {@link operationId}, so a replayed promotion restates the same id
   * under the same key, which is what lets the engine's dedup collapse it (its
   * replay guard refuses a replay naming a different id than the create was
   * accepted under).
   *
   * Absent — every existing caller, whose doors name no such field — keeps the
   * ledger's own id derivation, untouched.
   *
   * THIS FACADE DOES NOT VALIDATE. Format is the RPC door's contract
   * (`z.uuidv4()` there, per `docs/BOUNDARIES.md` rule 1), and uniqueness is
   * the ledger's (`assertGloballyUnusedId`). A caller reaching this facade by
   * another door — the agent socket, an Automation — therefore carries the
   * same obligation the RPC door discharges for the renderer.
   */
  requestedSessionId?: string;
  /** Skill slugs to inject at attach time. Absent means none — never ambient. */
  skills?: readonly string[];
  /**
   * Door-derived provenance for the `session_started` planner event: the
   * renderer's RPC door passes nothing (the human clicked), the agent socket
   * passes its `requestActor` result. Never self-declared by a caller.
   */
  actor?: TicketEventActor;
  modelOverride?: SessionModelOverride;
  /**
   * The request this Session is being born to carry, offered to the decision
   * model that may choose its model (VC-432). Honoured only when the start
   * names NO model, tier or reasoning level — a caller that said what it wants
   * is never second-guessed — and only when a decision model is configured and
   * permitted, so an absent or ignored hint changes nothing. The text is the
   * first message, a delegated task or an Automation's Instructions.
   */
  autoSelect?: { request: string };
  /**
   * Trusted in-process ancestry from a Ticket caller's claimed `session.start`.
   * The renderer's create schema cannot name it; only the bound tool door may
   * pass this birth context through the shared facade.
   */
  delegation?: TicketSessionDelegation;
}

/**
 * An invocation-time model override, within the user's configured policy — the
 * Automation Runtime contract's parameter shape, arriving from the
 * `session_start` tool and an Automation Run. Every half is optional and
 * merges onto a base: a bare reasoning override keeps the base model, a bare
 * model override keeps the base level when the chosen model supports it.
 *
 * The base is the Role's default unless a `tier` names another rung (VC-259).
 * A tier and an exact model are ALTERNATIVES, and the type says so: `model`
 * replaces the base, `tier` chooses which base, and an override carrying both
 * would be asking two questions with one answer slot — so it does not type.
 * The door renders that same rule as a refusal in words.
 */
export type SessionModelOverride = {
  reasoningLevel?: ReasoningLevel;
  /**
   * What to do when Model Access cannot run this override right now.
   *
   * `"refuse"` (the default, and every human door) throws `MODEL_UNAVAILABLE`
   * before anything durable exists. A person who just chose a model in a
   * picker is standing there, and the honest answer is immediate: nothing was
   * started, and nothing has to be cleaned up.
   *
   * `"record"` writes the selection as asked and lets the ATTACH refuse it.
   * This is VC-112 for Automation Runs: "a pinned model that has since become
   * unavailable does not silently fall back — let the Session fail through the
   * existing error path rather than building a second failure surface." The
   * Run therefore opens its Session, records the Runtime it was actually told
   * to use, and the runtime's own
   * `configuration_invalid` Attention (`pi-adapter.ts`) puts it in `error`,
   * where VC-133's notification rule and the Session's own dot both find it.
   *
   * Neither arm falls back to another model; they differ only in WHERE the
   * refusal is recorded. A door with nobody behind it needs the durable one,
   * because a refusal returned to a timer is a refusal nobody reads.
   */
  whenUnavailable?: "refuse" | "record";
} & (
  | { model?: { providerId: string; modelId: string }; tier?: undefined }
  | {
      /**
       * The kind of work, resolved through the user's tier table at start:
       * the tier's model AND its stored reasoning level, unless
       * `reasoningLevel` says otherwise. What the Session records is the
       * selection it resolved to, never the tier name, so a later Settings
       * change does not move a running Session.
       */
      tier?: ModelTier;
      model?: undefined;
    }
);

/**
 * The model policy a Session durably recorded: what it runs, and the rung that
 * model came from.
 *
 * `tier` is `null` when an exact id was named rather than a rung, and
 * `selection` is `null` only on a Session born before the policy existed —
 * every mint records one. The pair travels together because a child reads both
 * to inherit ({@link anchoredOnParent}), and reading one without the other is
 * what made the tier look like decoration rather than a policy a child can
 * stand on.
 */
export interface SessionModelAnchor {
  readonly selection: ModelSelection | null;
  readonly tier: ModelTier | null;
}

/**
 * What a Subagent Session runs on when its delegation NAMED nothing (VC-431):
 * its parent's own anchor, never a rung of the Role's own.
 *
 * The rung this replaced was `utility` — the slot for work nobody asked for,
 * such as chat names and summaries — so a profile that filled it with a cheap
 * background model ran every un-named delegation there. A delegation is work
 * the parent asked for, and "whatever the parent is anchored to" is the only
 * default that needs no explanation.
 *
 * In order:
 *
 * 1. The caller's own `model` or `tier` wins outright. A delegation that names
 *    one is answering this question itself.
 * 2. The parent's `tier`, passed on AS A TIER. The child therefore reads the
 *    user's current Settings row the way its parent did, which is the ruling
 *    this carries out: a rung is a standing preference for a kind of work, not
 *    a snapshot of one model. A child can outlive a Settings change and run a
 *    different model than its parent is running; that is the rung doing its
 *    job, not drift.
 * 3. The parent's exact model AND its level — what a parent pinned by id, or
 *    one that simply resolved its Role's default, recorded. Here the child
 *    runs precisely what the parent runs.
 * 4. Nothing. A parent that recorded no anchor at all leaves the Role's rung
 *    standing, which since VC-431 is the ladder root rather than `utility`.
 *
 * `utility` is never inherited AS A TIER: no door may name that row
 * (`AGENT_MODEL_TIERS`), so a parent carrying it from an older build hands
 * down the model it is actually running instead. Nothing here can put a child
 * on the Utility row.
 *
 * Pure, and it answers ONLY the model/tier alternative. What the caller said
 * besides that rides on top of whichever anchor was found: `reasoning` alone
 * means "what my parent runs, at this level", and `whenUnavailable` still says
 * where a refusal lands. Those are carried across rather than spread, because
 * the alternative is precisely what this function is choosing between and
 * {@link SessionModelOverride} states that in its own union.
 */
export function anchoredOnParent(
  override: SessionModelOverride | undefined,
  parent: SessionModelAnchor,
): SessionModelOverride | undefined {
  if (override?.model !== undefined || override?.tier !== undefined) return override;
  const carried =
    override?.whenUnavailable === undefined ? {} : { whenUnavailable: override.whenUnavailable };
  const level = override?.reasoningLevel;
  if (parent.tier !== null && isAgentModelTier(parent.tier)) {
    return {
      ...carried,
      ...(level === undefined ? {} : { reasoningLevel: level }),
      tier: parent.tier,
    };
  }
  if (parent.selection === null) return override;
  return {
    ...carried,
    model: { providerId: parent.selection.providerId, modelId: parent.selection.modelId },
    reasoningLevel: level ?? parent.selection.reasoningLevel,
  };
}

/**
 * What a start reaches to let a decision model choose its model (VC-432).
 * Both halves are the composition root's: the desktop answers them from the
 * decision service and its settings.
 */
export interface SessionAutoSelectPort {
  /**
   * Whether a decision for this project could run at all: a model is
   * configured and, in the cloud, opted into for `model.select`. One database
   * read, so a start with no decision model pays for nothing else.
   */
  available(projectId: string): boolean;
  /**
   * The pick among `candidates` for this request, or null for every way a
   * decision is not made or not trusted: unset, slow, wrong, or below the
   * confidence threshold. Never rejects; null is "keep the default".
   */
  decide(input: {
    sessionId: string;
    projectId: string;
    request: string;
    tierHint: AgentModelTier | null;
    candidates: readonly AutoSelectCandidate[];
    /** The birth's whole deadline, preparation included. */
    signal?: AbortSignal;
  }): Promise<AutoSelectPick | null>;
}

/** The durable identity a create-only call resolves — nothing about an executor. */
export interface SessionCreateResult {
  sessionId: string;
}

/** The start result plus the model policy the Session durably recorded. */
export type SessionStartOutcome = SessionStartResult & { model: ModelSelection };

export interface Sessions {
  /**
   * Mint the durable Session and record its model policy — and STOP there.
   *
   * The optimistic-open half of a chat start (VC-16): both commands are local
   * DB writes, so the renderer gets an addressable Session id in milliseconds
   * and lands its tab, while `attach` — which materializes the Ticket worktree
   * and boots the Agent Runtime — follows as its own call off that critical
   * path. Same refusals as `start`: an unknown ticket or a missing default
   * model refuses before anything durable exists.
   *
   * The answer carries the model policy the mint durably recorded — the
   * RESOLVED selection, which an Automation Run stores as its own record
   * (VC-126) — widening {@link SessionCreateResult} structurally, so the
   * renderer's create RPC (typed to the narrower shape) is untouched.
   */
  create(input: SessionStartInput): Promise<SessionCreateResult & { model: ModelSelection }>;
  /** Mint and attach in one call — the agent socket's door (VC-13). */
  start(input: SessionStartInput): Promise<SessionStartOutcome>;
  /**
   * Another attachment attempt on the Session that already exists — any
   * Session, whichever Role it was born under. The Role guard the old
   * per-Role facades ran here is gone, not moved: with one attach door there
   * is no wrong namespace left to catch.
   */
  attach(input: SessionAttachInput): Promise<SessionStartResult>;
  /** Also guards runtime-context backfill when attachment bypasses this facade. */
  waitForBirth?(sessionId: string): Promise<void>;
}

export interface SessionAttachInput {
  operationId: string;
  sessionId: string;
}

/**
 * Which Role's default a resolution wants.
 *
 * The Role is this module's own vocabulary. Since VC-9 it is the whole
 * {@link SessionRole}. The map from a Role to the tier it reads is shared
 * (`modelPurposeForRole`), stated once for every process — and since VC-431 a
 * Subagent Session's row is the ladder root rather than `utility`, the rung no
 * Session may run on: a Subagent Session normally runs on its parent's own
 * anchor ({@link anchoredOnParent}), and this row is what stands when the
 * parent recorded none.
 *
 * The PORT, though, speaks tiers rather than Roles: since VC-259 an override
 * can name any rung, and the Role's tier is just the rung nobody named. So the
 * Role is mapped here, at the one moment both facts are in hand, rather than
 * in the composition root, which no longer knows whether a tier was asked for.
 */
export type SessionDefaultModelRole = SessionRole;

export interface SessionsOptions {
  runtime: StructuredSessionCommands;
  /**
   * The configured default for one tier, resolved through the inheritance
   * chain the app documents (VC-112, VC-259): the project's own runtime
   * preference first (`projects.session_model`, NULL = inherit), then the
   * app-wide tier ladder from the named rung down. Separate answers, asked at
   * the one moment the rung is known — never a substitution, since a rung
   * with no explicit choice of its own inherits the next by stated policy
   * rather than by silent fallback, and a ladder with nothing on it answers
   * null so the caller can refuse.
   *
   * Async because one rung needs the catalog: `visual`'s fallback holds only
   * when the model it lands on can read images, and only Model Access knows.
   *
   * `projectId` is `null` where the project rung must not be walked: no
   * project is known (the legacy model-backfill on `attach`, which holds a
   * bare Session id), or the caller NAMED a tier and the project's pin is
   * not an answer to that question — see {@link resolveModelSelection}. It
   * reads as "the tier ladder only".
   */
  readDefaultModel(tier: ModelTier, projectId: string | null): Promise<ModelSelection | null>;
  ticketBelongsToProject(projectId: string, ticketId: string): boolean;
  /**
   * This Session's durable model policy — the anchor it recorded at birth.
   *
   * Both halves, because both are read here: `selection` is the legacy
   * backfill's question ("has this Session ever recorded one?"), and `tier` is
   * what a child inherits when its parent resolved through a rung (VC-431).
   * One port rather than two, so the two readers cannot disagree about what a
   * Session's policy IS.
   */
  readModelAnchor(sessionId: string): Promise<SessionModelAnchor>;
  /**
   * The model record a start already wrote for this Session under this command
   * id, exactly as written, or null when it wrote none (VC-432). A replayed
   * start restates it: the engine refuses a replay whose intent differs, and
   * the Session's CURRENT model is not what its birth recorded once a person
   * has picked another.
   */
  readBirthModel?(
    sessionId: string,
    commandId: string,
  ): Promise<{ selection: ModelSelection; tier: ModelTier | null; auto?: ModelAutoPick } | null>;
  /** Canonical command history, independent of the current projection. */
  readBirthModelFromLedger?: SessionsOptions["readBirthModel"];
  skills: SessionSkillPorts;
  toolSurface: SessionToolSurfacePorts;
  /** Durable per-Session grants and ancestry, resolved and recorded at birth (VC-183, VC-9). */
  grants: SessionGrantPorts;
  /**
   * What Model Access can actually run, consulted only when an override
   * arrives: the configured default was validated when it was saved
   * (`assertDefaultModelAvailable`), so the no-override path never pays for a
   * runtime inspection.
   */
  inspectModelAccess?(): Promise<ModelAccessSnapshot>;
  /**
   * The decision model's say over a start that named no model (VC-432). Absent
   * means nothing is ever auto-picked.
   */
  autoSelect?: SessionAutoSelectPort;
  /**
   * Records the `session_started` ticket event. Living in `mint` — the one
   * shared creation path under BOTH `create` (the renderer's optimistic open)
   * and `start` (the agent socket) — is what makes every door's start land in
   * planner history identically, with the actor each door derived (VC-13
   * decision 3). A Ticket concern: a ticketless mint records nothing, because
   * planner history is Ticket history. Absent in tests means no planner write.
   */
  recordSessionStarted?(event: {
    ticketId: string;
    sessionId: string;
    actor: TicketEventActor;
  }): void;
}

/**
 * Resolves the model policy this start records: the app default, or the
 * default with an invocation-time override merged on. An override is validated
 * against Model Access — availability and the model's reasoning levels, the
 * `assertDefaultModelAvailable` rule — and refused before any Session exists;
 * the plain default path stays exactly the policy `requireDefaultModel` was.
 *
 * {@link SessionModelOverride.whenUnavailable} is the one exception, and it
 * changes only WHERE the refusal lands. `"record"` keeps the merge above and
 * skips the inspection below, so the Session is minted carrying the selection
 * it was told to carry and the attach refuses it with the Attention every
 * other broken configuration raises. Note that the plain default path has
 * always behaved this way — a stale configured default is never inspected
 * here either — so this is the pin catching up with the inheritance it was
 * supposed to be interchangeable with, not a new kind of leniency.
 *
 * A `tier` (VC-259) changes only WHICH base is read: the named rung instead of
 * the Role's. Everything after is the same merge — a bare tier is a default
 * path (the row was validated when it was saved, so nothing is inspected), a
 * tier with a level is the reasoning-only path against that base. A tier that
 * resolves to nothing is the same refusal, naming the tier, and never a walk
 * past it to a model the user chose for something else.
 *
 * A named tier also OUTRANKS the project's pinned Session model, exactly as an
 * exact `model` override already does. VC-112's pin answers "what does this
 * project run by default"; `tier: "fast"` is a caller answering "what should
 * THIS Session run", and a pin quietly winning would start a Session on a
 * model nobody asked for while the door's reply and the Session header still
 * read `fast` — the silent swap this ticket exists to forbid. The pin still
 * governs every start that names no tier, which is every start there was
 * before tiers existed.
 */
async function resolveModelSelection(
  options: SessionsOptions,
  override: SessionModelOverride | undefined,
  role: SessionDefaultModelRole,
  projectId: string,
): Promise<ModelSelection> {
  const tier = override?.tier;
  const base = await options.readDefaultModel(
    tier ?? modelPurposeForRole(role),
    tier === undefined ? projectId : null,
  );
  const required = tier === undefined ? DEFAULT_MODEL_REQUIRED : defaultModelRequiredForTier(tier);
  if (
    override === undefined ||
    (override.model === undefined && override.reasoningLevel === undefined)
  ) {
    return requireDefaultModel(base, required);
  }
  const model = override.model ?? (base === null ? undefined : base);
  if (model === undefined) {
    // A reasoning level alone cannot conjure a model to run at it.
    throw new StructuredSessionsError("DEFAULT_MODEL_REQUIRED", required);
  }
  // The level is merged the same way whichever arm follows: no explicit level
  // falls back to the default's, then to Volli's central "medium" (the
  // no-default + --model case). Only the validation below differs.
  const reasoningLevel = override.reasoningLevel ?? base?.reasoningLevel ?? "medium";
  if (override.whenUnavailable === "record") {
    return { providerId: model.providerId, modelId: model.modelId, reasoningLevel };
  }
  if (options.inspectModelAccess === undefined) {
    throw new StructuredSessionsError(
      "MODEL_UNAVAILABLE",
      "Model Access is unavailable, so a model override cannot be validated.",
    );
  }
  const access = await options.inspectModelAccess();
  const available = access.models.find(
    (candidate) => candidate.providerId === model.providerId && candidate.modelId === model.modelId,
  );
  if (available === undefined || available.state !== "available") {
    throw new StructuredSessionsError(
      "MODEL_UNAVAILABLE",
      available?.state === "authentication-required"
        ? `Sign in to ${model.providerId} before starting a session on ${model.providerId}/${model.modelId}.`
        : `Model ${model.providerId}/${model.modelId} is not currently available.`,
    );
  }
  // The chosen model has to actually run the level it was given, and the
  // refusal names what it can run instead.
  if (!available.reasoningLevels.includes(reasoningLevel)) {
    throw new StructuredSessionsError(
      "MODEL_UNAVAILABLE",
      `Model ${model.providerId}/${model.modelId} does not support reasoning level "${reasoningLevel}" (valid: ${available.reasoningLevels.join(", ")}).`,
    );
  }
  return { providerId: model.providerId, modelId: model.modelId, reasoningLevel };
}

function sameSelection(a: ModelSelection, b: ModelSelection): boolean {
  return (
    a.providerId === b.providerId &&
    a.modelId === b.modelId &&
    a.reasoningLevel === b.reasoningLevel
  );
}

/**
 * Whether this start is the kind an automatic choice may apply to: it offered
 * a request and named no model, tier or reasoning level. Whether a decision
 * could actually run is the port's availability check.
 */
function autoSelectOffered(options: SessionsOptions, input: SessionStartInput): boolean {
  const named = input.modelOverride;
  return (
    options.autoSelect !== undefined &&
    (input.autoSelect?.request.trim() ?? "") !== "" &&
    named?.model === undefined &&
    named?.tier === undefined &&
    named?.reasoningLevel === undefined
  );
}

/**
 * The decision model's pick for a start that named no model (VC-432), or null
 * to keep `configuredDefault`.
 *
 * Quiet on every miss, by design: no port, nothing to carry, a caller that
 * named a model, tier or level, a decision model not configured or not
 * permitted, fewer than two approved pairs, a catalog that cannot be read, a
 * slow or unsure answer — each is the configured default, with nothing said
 * and nothing awaited beyond the decision's own short deadline. Only the
 * person's approved pairs are ever offered: the default and each agent tier's
 * configured model, held to what Model Access says can run right now.
 */
async function autoSelectModel(
  options: SessionsOptions,
  input: SessionStartInput,
  configuredDefault: ModelSelection,
  parentAnchor: SessionModelAnchor | null,
  sessionId: string,
): Promise<AutoSelectPick | null> {
  const port = options.autoSelect;
  if (port === undefined) return null;
  const withdraw = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The whole refinement is bounded, preparation included: the decision
  // service's own deadline starts only when it is asked, and the catalog read
  // before it has none of its own.
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      withdraw.abort();
      resolve(null);
    }, DECISION_PURPOSE_POLICY["model.select"].timeoutMs);
  });
  const refinement = (async (): Promise<AutoSelectPick | null> => {
    const request = input.autoSelect?.request.trim() ?? "";
    if (!autoSelectOffered(options, input) || !port.available(input.projectId)) return null;
    const tiers = Object.fromEntries(
      await Promise.all(
        AUTO_SELECT_TIERS.map(async (tier) => [tier, await options.readDefaultModel(tier, null)]),
      ),
    ) as Partial<Record<AgentModelTier, ModelSelection | null>>;
    const approved = autoSelectCandidates(configuredDefault, tiers);
    if (approved.length < 2) return null;
    const runnable = await runnableSelections(options);
    const candidates = approved.filter(
      (candidate) =>
        sameSelection(candidate.selection, configuredDefault) ||
        (runnable?.(candidate.selection) ?? false),
    );
    // Preparation may finish after birth already fell back. Do not start a
    // paid call after that deadline, and withdraw any call already in flight.
    if (withdraw.signal.aborted) return null;
    return port.decide({
      signal: withdraw.signal,
      sessionId,
      projectId: input.projectId,
      request,
      tierHint:
        parentAnchor?.tier !== null &&
        parentAnchor?.tier !== undefined &&
        isAgentModelTier(parentAnchor.tier)
          ? parentAnchor.tier
          : null,
      candidates,
    });
  })();
  try {
    return await Promise.race([refinement, deadline]);
  } catch {
    // The default stands. A person is not waiting on a refinement they did not
    // ask for, and the model they will see is the one the Session runs.
    return null;
  } finally {
    clearTimeout(timer);
    // A refinement that outlived its deadline settles unobserved.
    refinement.catch(() => undefined);
  }
}

/** Whether Model Access can run a selection right now, or null when it cannot be asked. */
async function runnableSelections(
  options: SessionsOptions,
): Promise<((selection: ModelSelection) => boolean) | null> {
  if (options.inspectModelAccess === undefined) return null;
  const access = await options.inspectModelAccess();
  return (selection) =>
    access.models.some(
      (model) =>
        model.providerId === selection.providerId &&
        model.modelId === selection.modelId &&
        model.state === "available" &&
        model.reasoningLevels.includes(selection.reasoningLevel),
    );
}

/** Product-owned Session start commands over private adapter migration scaffolding. */
export function createSessions(options: SessionsOptions): Sessions {
  // Publish the id before any birth writes, and release only after ALL of
  // them. A failed birth stays latched: it is incomplete, not a legacy Session.
  const births = new Map<
    string,
    {
      sessionId: string | null;
      failed: boolean;
      published: ReturnType<typeof Promise.withResolvers<void>>;
      complete: Promise<SessionCreateResult & { model: ModelSelection }>;
    }
  >();
  const sessionBirths = new Map<string, Promise<SessionCreateResult & { model: ModelSelection }>>();
  async function waitForBirth(sessionId: string): Promise<void> {
    const known = sessionBirths.get(sessionId);
    if (known !== undefined) {
      await known;
      return;
    }
    // Snapshot: a different birth added while we wait must not hold this attach.
    const pending = [...births.values()];
    for (const birth of pending) {
      await birth.published.promise;
      if (birth.sessionId === sessionId) await birth.complete;
    }
  }
  /** The shared create+model half; `start` attaches after it, `create` returns it as-is. */
  async function mint(
    input: SessionStartInput,
  ): Promise<SessionCreateResult & { model: ModelSelection }> {
    if (
      input.ticketId !== null &&
      !options.ticketBelongsToProject(input.projectId, input.ticketId)
    ) {
      throw new StructuredSessionsError(
        "TICKET_NOT_IN_PROJECT",
        "The requested Ticket was not found in this project.",
      );
    }
    // The Role is the caller's statement, read once here by the model policy,
    // the grants and the tool surface alike. What is checked is only that the
    // statement is coherent: a subagent has a parent and nothing else does.
    const role = input.role;
    if (role === "subagent" && input.parentSessionId === undefined) {
      throw new StructuredSessionsError(
        "PARENT_REQUIRED",
        "A Subagent Session needs the Session that delegated it.",
      );
    }
    if (role !== "subagent" && input.parentSessionId !== undefined) {
      throw new StructuredSessionsError(
        "PARENT_REQUIRED",
        "Only a Subagent Session has a parent Session.",
      );
    }
    // What a subagent inherits from its parent is decided HERE, beside the
    // tool surface and MCP inheritance below (VC-9, VC-431), because this is
    // the one creation path under both `create` and `start`. A second start
    // path that minted a subagent would otherwise get its parent's ports and
    // silently miss its parent's model.
    const parentAnchor =
      input.parentSessionId === undefined
        ? null
        : await options.readModelAnchor(input.parentSessionId);
    const override =
      parentAnchor === null
        ? input.modelOverride
        : anchoredOnParent(input.modelOverride, parentAnchor);
    const model = await resolveModelSelection(options, override, role, input.projectId);
    // Resolved before anything durable exists: a missing skill refuses the
    // start outright instead of stranding a Session that never attaches.
    const explicit =
      input.skills !== undefined && input.skills.length > 0
        ? await options.skills.resolve(input.projectId, input.skills)
        : [];
    // The metadata index rides behind the named bodies — specific material
    // first, then what else is installed. Best-effort by the port's contract:
    // null costs the index, never the start.
    const index = await options.skills.index(
      input.projectId,
      explicit.map((resource) => resource.name),
    );
    const resources = index === null ? explicit : [...explicit, index];
    // Resolve grants before creation and freeze them before the surface they
    // authorize. The resolver still owns vocabulary validation; this port owns
    // the durable per-Session source and its scope/recursion data.
    const grants = options.grants.resolveBirth({
      role,
      ticketId: input.ticketId,
      ...(input.delegation === undefined ? {} : { delegation: input.delegation }),
      ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
    });
    // A child is bounded by what its parent was frozen with (VC-9): the
    // parent's own durable record, read now, because a child cannot get a port
    // its parent lacked and Settings may have changed since the parent began.
    // A parent with no record — a legacy Session that never attached under
    // VC-164 — bounds its child by nothing, which is what it holds itself.
    const within =
      input.parentSessionId === undefined
        ? null
        : await options.toolSurface.recorded(input.parentSessionId);
    // Resolved before creation for the same reason as named resources: the
    // Session's Cache Prefix starts at birth, not whenever an attachment later
    // happens to read Settings. The answer is sanitized names/order only.
    const mcpTools =
      input.parentSessionId === undefined
        ? (options.toolSurface.resolveMcp?.(input.projectId) ?? [])
        : ((await options.toolSurface.recordedMcp?.(input.parentSessionId)) ?? []);
    const classify = (await options.toolSurface.resolveClassify?.(input.projectId)) ?? false;
    const toolSurface = options.toolSurface.resolve(
      role,
      grants.grants,
      within === null ? undefined : within,
      mcpTools,
      classify,
    );
    const createIdentity = () =>
      options.runtime.command({
        commandId: sessionCreateCommandId(input.operationId),
        command: {
          kind: "session.create",
          projectId: input.projectId,
          ticketId: input.ticketId,
          role,
          parentSessionId: input.parentSessionId ?? null,
          title: input.title,
          // Keep legacy intent byte-identical when the caller names no id.
          ...(input.requestedSessionId === undefined
            ? {}
            : { requestedSessionId: input.requestedSessionId }),
        },
      });
    const existing = births.get(input.operationId);
    if (existing !== undefined && !existing.failed) {
      // Still validate create intent: coalescing cannot bless a reused command
      // id whose project, title or requested Session differs.
      await createIdentity();
      return existing.complete;
    }
    const published = Promise.withResolvers<void>();
    const birthLatch = {
      sessionId: null as string | null,
      failed: false,
      published,
      complete: Promise.resolve().then(finishBirth),
    };
    births.set(input.operationId, birthLatch);
    return birthLatch.complete;

    async function finishBirth(): Promise<SessionCreateResult & { model: ModelSelection }> {
      try {
        const created = await createIdentity();
        birthLatch.sessionId = created.sessionId;
        sessionBirths.set(created.sessionId, birthLatch.complete);
        published.resolve();
        // The Session now exists durably, so planner history says so — whatever
        // the model record or a later attach do next, the app carries the recovery.
        if (input.ticketId !== null) {
          options.recordSessionStarted?.({
            ticketId: input.ticketId,
            sessionId: created.sessionId,
            actor: input.actor ?? { kind: "user" },
          });
        }
        // The tier the override named rides beside the resolved model (VC-259):
        // provenance for the pin, so the Session header and `session list` can say
        // "Fast · <model>". It is the RESOLVED override's tier, not the caller's,
        // so a subagent that inherited a rung records the rung it inherited — both
        // for the header and because that is what its own children read next
        // (VC-431).
        //
        // VC-432: a start that named nothing may have its model chosen by the
        // decision model, once, here at birth. The configured default resolved
        // above IS the fallback, so every miss lands exactly where a start with no
        // decision model would have. A pick that is the default itself keeps the
        // default's tier provenance; any other pick is an exact model.
        //
        // A replayed start finds its Session already carrying a model, and states
        // that same record again: the engine refuses a replay whose intent
        // differs, and a second decision (or a miss) is exactly such a difference.
        // Unavailable history is NOT empty history. Recover the original command
        // from the canonical ledger; if both reads fail, do not ask again.
        const offered = autoSelectOffered(options, input);
        const recordBirthModel = async (): Promise<ModelSelection> => {
          const modelCommandId = `${input.operationId}:model`;
          let historyAvailable = true;
          const read = options.readBirthModel ?? options.readBirthModelFromLedger;
          const birth =
            offered && read !== undefined
              ? await read(created.sessionId, modelCommandId).catch(async () => {
                  if (options.readBirthModelFromLedger !== undefined) {
                    try {
                      return await options.readBirthModelFromLedger(
                        created.sessionId,
                        modelCommandId,
                      );
                    } catch {
                      /* No history means no second inference. */
                    }
                  }
                  historyAvailable = false;
                  return null;
                })
              : null;
          const picked =
            birth === null && historyAvailable
              ? await autoSelectModel(options, input, model, parentAnchor, created.sessionId)
              : null;
          const chosen = birth?.selection ?? picked?.selection ?? model;
          const auto = birth === null ? picked?.auto : birth.auto;
          const tier =
            birth !== null
              ? (birth.tier ?? undefined)
              : picked !== null && !sameSelection(picked.selection, model)
                ? undefined
                : override?.tier;
          await recordModelSelection(options.runtime, {
            commandId: modelCommandId,
            sessionId: created.sessionId,
            model: chosen,
            ...(tier === undefined ? {} : { tier }),
            ...(auto === undefined ? {} : { auto }),
          });
          return chosen;
        };
        const chosen = await recordBirthModel();
        // Durable inside MINT, not beside the attach: VC-16 split the start so a
        // chat can open optimistically — `create` lands the tab and `attach`
        // follows separately — and the record has to exist before whichever
        // attach eventually composes the system prompt from it. The grant reaches
        // the store first: a tool surface without its scope would be a capability
        // that the door could not honestly bound.
        if (resources.length > 0) await options.skills.record(created.sessionId, resources);
        options.grants.recordBirth(created.sessionId, grants);
        await options.toolSurface.record(
          created.sessionId,
          toolSurface,
          mcpTools,
          ...(input.parentSessionId === undefined ? [] : [input.parentSessionId]),
        );
        births.delete(input.operationId);
        sessionBirths.delete(created.sessionId);
        return { sessionId: created.sessionId, model: chosen };
      } catch (error) {
        birthLatch.failed = true;
        throw error;
      } finally {
        published.resolve();
      }
    }
  }

  return {
    waitForBirth,
    async create(input) {
      const created = await mint(input);
      return { sessionId: created.sessionId, model: created.model };
    },

    async start(input) {
      const created = await mint(input);
      const attached = await attachStructuredSession(
        options.runtime,
        input.operationId,
        created.sessionId,
      );
      return { ...attached, model: created.model };
    },

    async attach(input) {
      await waitForBirth(input.sessionId);
      // One rule for every Session: nothing recorded gets the default recorded
      // at attach. Only a Session born before the model policy existed can
      // reach the branch in real data — every mint above records at birth — so
      // this is the legacy migration duty, stated without a Role read.
      if ((await options.readModelAnchor(input.sessionId)).selection === null) {
        // The Board default, and deliberately so: this door knows a Session
        // id and no Role, and the Board default is the one every Role
        // inherits from anyway. It is still written as this Session's own
        // `model.select` before the attachment, so what it resolved to is
        // visible in its history rather than assumed.
        const model = requireDefaultModel(
          await options.readDefaultModel(modelPurposeForRole("project"), null),
          DEFAULT_MODEL_REQUIRED,
          input.sessionId,
        );
        await recordModelSelection(options.runtime, {
          commandId: modelBackfillCommandId(input.sessionId),
          sessionId: input.sessionId,
          model,
        });
      }
      // A reattach continues the conversation the Session already had
      // (VC-457). A stopped Session's attachment is closed, so this attach
      // mints a new executor binding — and without a replay, a new Pi
      // transcript that had never heard of the work. The runtime carries the
      // newest closed attachment's context forward, and records a plain fresh
      // attachment when there is none (a Session's first attach through here).
      return attachStructuredSession(
        options.runtime,
        input.operationId,
        input.sessionId,
        "context_replay",
      );
    },
  };
}

/** The app default, or the refusal that names what the user has to choose. */
function requireDefaultModel(
  model: ModelSelection | null,
  message: string,
  sessionId: string | null = null,
): ModelSelection {
  if (model === null) {
    throw new StructuredSessionsError("DEFAULT_MODEL_REQUIRED", message, sessionId);
  }
  return model;
}

/** Attach the singular runtime. A rejected attachment stays durable for explicit recovery. */
async function attachStructuredSession(
  runtime: StructuredSessionCommands,
  operationId: string,
  sessionId: string,
  continuity: "fresh" | "context_replay" = "fresh",
): Promise<SessionStartResult> {
  const attached = await runtime.command({
    commandId: `${operationId}:start`,
    sessionId,
    command: { kind: "adapter.attach", continuity },
  });
  return {
    sessionId,
    state: attachmentReady(attached) ? "ready" : "needs-recovery",
    receipt: attached.receipt,
    throughSequence: attached.throughSequence,
  };
}

function attachmentReady(result: SessionRuntimeCommandResult): boolean {
  return result.receipt?.status === "accepted" || result.receipt?.status === "completed";
}

/** Record the Session's model policy durably, or refuse before anything attaches. */
async function recordModelSelection(
  runtime: StructuredSessionCommands,
  input: {
    commandId: string;
    sessionId: string;
    model: ModelSelection;
    tier?: ModelTier;
    auto?: ModelAutoPick;
  },
): Promise<void> {
  const selected = await runtime.command({
    commandId: input.commandId,
    sessionId: input.sessionId,
    command: {
      kind: "model.select",
      selection: input.model,
      ...(input.tier === undefined ? {} : { tier: input.tier }),
      ...(input.auto === undefined ? {} : { auto: input.auto }),
    },
  });
  if (selected.receipt?.status !== "completed") {
    throw new StructuredSessionsError(
      "MODEL_SELECTION_REJECTED",
      "The selected model policy could not be recorded for this Session.",
      input.sessionId,
    );
  }
}
