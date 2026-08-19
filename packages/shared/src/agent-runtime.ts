/**
 * Product-owned Session and model policy consumed by the Agent Runtime, and the
 * Agent Runtime contracts themselves.
 *
 * This is the boundary between Volli's Session Engine and the singular
 * Pi-backed executor. It speaks Volli vocabulary only: no Pi SDK types, no
 * Electron, no renderer concerns. Pi-native detail crosses this boundary in
 * exactly two bounded forms — the opaque {@link RuntimeRecoveryRef} stored on
 * the Session Attachment, and sanitized diagnostic strings. Nothing above the
 * runtime may dispatch on Pi tool or event names.
 *
 * {@link RuntimeObservation} is the only observation vocabulary. What a Session
 * writes down is derived from it in `@volli/session-engine`, which owns Session
 * facts; an executor states what happened and never what to record.
 */

import type { RuntimeImageInput } from "./blob";
import type { ActivityDescriptor } from "./session-activity";
import type { AuthorityDenialCause, AuthoritySnapshot, CodingToolId } from "./authority";
import type { ModelAccessSignInMethod } from "./model-access-sign-in";
import {
  SESSION_ESCALATION_OPTIONS,
  SESSION_ESCALATION_STOP_ID,
  SESSION_PERMISSION_OPTIONS,
  SESSION_REFUSAL_OPTION_IDS,
  type SessionInteraction,
  type SessionInteractionCancelReason,
  type SessionInteractionOption,
  type SessionInteractionResolution,
} from "./session-ledger";

export type SessionRole = "project" | "ticket" | "subagent";

/** Volli's reasoning policy, independent of any provider's type names. */
export const REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/** The selected model access for one Session attachment. */
export interface ModelSelection {
  providerId: string;
  modelId: string;
  reasoningLevel: ReasoningLevel;
}

/** Whether the singular Agent Runtime can truthfully use one account or model. */
export type ModelAccessState = "available" | "authentication-required" | "unavailable";

/** Sanitized hint about how use of one provider is billed. */
export type ModelAccessBillingSource =
  | "subscription"
  | "api-key"
  | "gateway"
  | "local"
  | "ambient"
  | "unknown";

/**
 * Product recovery vocabulary. Runtime-native login detail stays behind the host seam.
 *
 * `sign-in` was `external-sign-in` while signing in meant leaving for a
 * terminal running a bundled CLI. It happens in the app now, so the word came
 * off: the distinction that still earns its keep is sign-in versus retry — a
 * provider with no credential needs a person, a provider whose refresh failed
 * needs another attempt — and nothing here is external any more. The kind is
 * derived live on every inspect and never written down, so renaming it changes
 * no stored row.
 */
export interface ModelAccessRecovery {
  kind: "sign-in" | "retry";
}

/** One provider account as the renderer may see it. Never contains credentials. */
export interface ModelAccessProvider {
  id: string;
  label: string;
  state: ModelAccessState;
  accountLabel: string | null;
  billingSource: ModelAccessBillingSource;
  recovery: ModelAccessRecovery | null;
  /**
   * The ways this provider can be signed in to, in the provider's own words.
   *
   * Up to two, and which one a person wants is not derivable: Anthropic takes
   * an API key or a Claude Pro/Max subscription, and those are different
   * accounts with different bills. Empty means no interactive sign-in exists —
   * a provider configured only from ambient environment variables — and a row
   * with none offers no button rather than a button that cannot work.
   */
  signIn: readonly ModelAccessSignInMethod[];
  /**
   * Whether a credential for this provider is stored in the profile.
   *
   * Not the same question as {@link ModelAccessState}, and the gap is the
   * reason it is asked separately: a provider reading its key from an ambient
   * environment variable is `available` with nothing stored, and offering to
   * sign that one out would promise a change that removing no file can make.
   * Signing out acts on the stored credential and only ever on that.
   */
  hasStoredCredential: boolean;
}

/** One model the runtime knows, qualified by current account availability. */
export interface ModelAccessModel {
  providerId: string;
  modelId: string;
  label: string;
  state: ModelAccessState;
  reasoningLevels: readonly ReasoningLevel[];
  /**
   * The model's total context window, in tokens. Omitted when the catalog does
   * not report a usable size, so a reader never mistakes "unknown" for zero.
   */
  contextWindow?: number;
  /**
   * Whether this model takes image input (Pi's `Model.input` including
   * `"image"`), so the attach affordance can say a model cannot see pictures
   * instead of discovering it a turn later (VC-50).
   *
   * Not knowing reads as `true`. The asymmetry is deliberate: an attachment
   * always materializes into the workspace and is named in the brief, so a
   * wrong `true` degrades to a path reference the agent can still open, while a
   * wrong `false` removes an affordance the model actually supports.
   */
  acceptsImageInput: boolean;
}

/** The complete sanitized Model Access view at one observation time. */
export interface ModelAccessSnapshot {
  observedAt: number;
  providers: readonly ModelAccessProvider[];
  models: readonly ModelAccessModel[];
}

/** The Roles that attach a runtime. Subagent Sessions have no attachment of their own. */
export type RuntimeSessionRole = Extract<SessionRole, "ticket" | "project">;

/** Volli identities every runtime attachment carries, whatever its Role. All opaque. */
interface RuntimeIdentityFields {
  sessionId: string;
  rootThreadId: string;
  attachmentId: string;
  projectId: string;
}

/** A Ticket Session's identity: the Role is what guarantees the Ticket is there. */
export interface TicketRuntimeIdentity extends RuntimeIdentityFields {
  role: Extract<RuntimeSessionRole, "ticket">;
  ticketId: string;
}

/** A project-scoped Session's identity: ticketless by construction, never by omission. */
export interface ProjectRuntimeIdentity extends RuntimeIdentityFields {
  role: Extract<RuntimeSessionRole, "project">;
  ticketId: null;
}

/**
 * Role and identity are one value, not two agreeing fields.
 *
 * The Role decides what the runtime may assume about the Session — a Ticket to
 * work, or a project root and nothing else — so a spec that named the Role
 * separately from the identity could state a Ticket Session with no Ticket. Here
 * that shape does not typecheck.
 */
export type RuntimeSessionIdentity = TicketRuntimeIdentity | ProjectRuntimeIdentity;

/** Where execution happens. Local is the only venue built today. */
export type ExecutionVenue = "local";

export interface RuntimeToolBundle {
  tools: readonly CodingToolId[];
}

/** Generated Runtime Brief, delivered as persisted Session input. */
export interface RuntimeBrief {
  text: string;
}

/** A controlled prompt resource supplied by the product, never discovered. */
export interface PromptResource {
  name: string;
  text: string;
}

/**
 * Bounded runtime-native recovery reference stored on the Session Attachment.
 * Opaque to every layer above the runtime; used to reopen the Pi sidecar and
 * deduplicate completed entries after restart.
 */
export interface RuntimeRecoveryRef {
  runtime: "pi";
  sessionId: string;
  sessionFilePath: string;
}

/**
 * Which half of {@link AuthorityFallback} sent the runtime to ask.
 *
 * Worth naming rather than collapsing, because the two mean different things to
 * the person answering: a run of refusals back to back means the policy is in
 * the way of one line of work, while a total across the Session means it is in
 * the way of the Session.
 */
export type RuntimeAskTrip = "consecutive" | "session";

/**
 * One escalation: a question the runtime blocks on because its own policy keeps
 * refusing.
 *
 * Deliberately a port and not an observation. An observation states what
 * happened and expects no reply; this needs an answer before the tool call it
 * belongs to can proceed either way. Keeping it a typed port is also what keeps
 * `@volli/agent-runtime` free of ledger types — the host owns the interaction
 * record, and the runtime owns only the question.
 */
export interface RuntimeAskRequest {
  /** The rule that refused, or `call.unreadable` when the gate refused before any ran. */
  cause: AuthorityDenialCause;
  /** The runtime tool name as requested, which may not be a tool Volli offers. */
  tool: string;
  /**
   * The runtime's own id for the call being judged.
   *
   * Carried so a producer can correlate the question to the activity row it is
   * about. Without it an ask can only ever be shown at the foot of the
   * transcript, never against the call that raised it.
   */
  toolCallId: string;
  /** The turn the blocked call belongs to. Null before the first turn opens. */
  turnId: string | null;
  /** The refusing rule's own words, as the model would otherwise have received them. */
  reason: string;
  trip: RuntimeAskTrip;
  /**
   * Whether a person may overrule this refusal.
   *
   * Not "could the call run if this layer stood aside" — for the hard-deny rules
   * that is true and is exactly why they are not overridable. See
   * {@link OVERRIDABLE_AUTHORITY_RULES}, which keeps the two reasons apart: some
   * refusals an override could not honour anyway, because the tool is not
   * loaded; the rest are perfectly grantable and must not be granted, because a
   * login item or a disabled certificate check outlives the Session that asked
   * for it.
   *
   * The runtime enforces this rather than trusting it: a host that answers
   * `allow` to a refusal that is not overridable is not obeyed.
   */
  overridable: boolean;
}

/**
 * What a person chose when the runtime stopped and asked.
 *
 * `allow` grants exactly this call: there is no durable policy store to write a
 * standing answer into, so nothing here can mean "always". `stop` ends the turn,
 * not the Session.
 *
 * Named a choice rather than an outcome or an answer deliberately — `CONTEXT.md`
 * reserves both of those for the durable Session Interaction vocabulary, and
 * this is the runtime's private reading of a decision that is recorded there.
 */
export type RuntimeAskChoice = "allow" | "refuse" | "stop";

/** What one escalation puts in front of a person. */
export interface RuntimeAskOffer {
  kind: SessionInteraction["kind"];
  options: readonly SessionInteractionOption[];
}

const PERMISSION_OPTION_IDS = { once: "once", reject: "reject" } as const;

/**
 * The choices one escalation offers, in Volli's own interaction vocabulary.
 *
 * Both pairs are minted from the ledger's own lists rather than written out
 * here, because the surface that offers a choice and the runtime that reads the
 * answer are one decision made twice, and the option ids are the wire between
 * them. A literal restated on either side compiles cleanly and fails silently.
 * Two things about the pairs are deliberate.
 *
 * `always` is absent from the overridable pair even though
 * {@link SESSION_PERMISSION_OPTIONS} declares it: there is no durable policy
 * store to write a standing grant into, and an option that silently meant
 * `once` would be a lie told in the one place a person is being asked to trust
 * us. It is filtered from that list rather than restated as literals, so the
 * labels stay defined in the one place the ledger defines them.
 *
 * A refusal that cannot be overridden still asks, because it is still a real
 * question — not "may it run", which is settled, but "is this policy in your
 * way badly enough to stop". That is why it is an interaction and not an
 * Attention: it has a consequence either way.
 */
export function askOffer(request: RuntimeAskRequest): RuntimeAskOffer {
  if (!request.overridable) return { kind: "question", options: SESSION_ESCALATION_OPTIONS };
  const offered = new Set<string>([PERMISSION_OPTION_IDS.once, PERMISSION_OPTION_IDS.reject]);
  return {
    kind: "permission",
    options: SESSION_PERMISSION_OPTIONS.filter((option) => offered.has(option.id)),
  };
}

/**
 * Read a person's chosen option ids back as an outcome.
 *
 * Fails to a refusal. Every id this does not recognise — an empty answer, a
 * stale option from a build that offered something else, free text where a
 * choice was expected — leaves the call refused, which is the state it was
 * already in. The only answers that change anything are the two this
 * deliberately spells out.
 */
export function askChoice(
  request: RuntimeAskRequest,
  optionIds: readonly string[],
): RuntimeAskChoice {
  // Refusal is read first, so an answer carrying both a grant and a refusal
  // resolves toward the state the call was already in. A multi-select that
  // accumulated `once` and `reject` together is incoherent, and resolving an
  // incoherent permission toward execution is the wrong direction to be wrong in.
  const chosen = optionIds.map((id) => id.toLowerCase());
  if (chosen.some((id) => SESSION_REFUSAL_OPTION_IDS.includes(id))) return "refuse";
  if (request.overridable) {
    return chosen.includes(PERMISSION_OPTION_IDS.once) ? "allow" : "refuse";
  }
  return chosen.includes(SESSION_ESCALATION_STOP_ID) ? "stop" : "refuse";
}

/** One answer the model thought worth offering. */
export interface RuntimeAskUserOption {
  /** The model's own id, returned verbatim in the answer it reads back. */
  id: string;
  label: string;
  description?: string;
}

/**
 * One question the model decided to put to the person driving the Session.
 *
 * A separate port from {@link RuntimeAskRequest}, and separate for a reason that
 * survives their similar shapes: an escalation is the runtime's own policy
 * stopping a call and asking whether to stand aside, so its options are Volli's
 * fixed vocabulary and its answer is a verdict — `allow`, `refuse`, `stop` —
 * that the runtime then enforces. This question is the model's own, its options
 * are whatever the model thought worth offering, and its answer is simply the
 * tool's result. One port serving both would have to decide which of the two
 * readings an answer takes, and the two readings disagree about every id: an
 * option a model happened to label `reject` is not a refusal of anything.
 */
export interface RuntimeAskUserRequest {
  /** The runtime's own id for the asking call, so the question can be shown against it. */
  toolCallId: string;
  /** What the model wants to know, in its own words. */
  question: string;
  /** Absent or empty means the model wants prose rather than a choice. */
  options?: readonly RuntimeAskUserOption[];
  /** Whether more than one option may be chosen. Absent reads as one. */
  multiple?: boolean;
  /**
   * Whether a person may answer in their own words instead of choosing.
   *
   * Absent reads as true, and the default is the point: the model wrote the
   * options, so a person must be able to say the thing it did not think of. Only
   * an explicit `false` closes that door, and only a question that already
   * offers something to choose between can close it — a question with no options
   * and no free text asks for an answer that cannot be given.
   */
  allowOther?: boolean;
}

/**
 * One bounded web document, as the boundary that read it describes it.
 *
 * Declared here rather than beside the sockets because {@link SessionRuntimeSpec}
 * is where the port is offered, and this package may not import the one that
 * owns DNS and TLS. `@volli/agent-runtime` names the same type
 * `SafeWebFetchResult`; there is one declaration so the two cannot drift.
 *
 * Everything here is a fact the fetcher established, and none of it is the
 * page's to state: {@link origin} and {@link finalUrl} are read off the request
 * Volli made, not off the bytes that came back, which is what makes them usable
 * as provenance in front of text that may be trying to claim otherwise.
 */
export interface RuntimeWebDocument {
  /** The URL that was asked for, canonical as admission normalized it. */
  requestedUrl: string;
  /** The URL the bytes came from. Equal to {@link requestedUrl} while no redirect is followed. */
  finalUrl: string;
  /** Scheme, host and port of the final URL. */
  origin: string;
  /**
   * The kind of text in {@link text}: `markdown` when the page was served as
   * Markdown or its article was extracted from HTML and converted, `text` for
   * the other media types Volli reads. Raw markup is never handed back — it is
   * spent inside the boundary, and only what a reader can use leaves it.
   */
  contentType: "text" | "markdown";
  /** The document's text, already inside the boundary's own character bound. */
  text: string;
  /** Whether the boundary cut the text short of the document's end. */
  truncated: boolean;
}

/**
 * One reference a search returned: somewhere to read, not something read.
 *
 * Every field is third-party text. Unlike {@link RuntimeWebDocument}, where the
 * provenance around the content is Volli's, *all three* of these come from the
 * provider and through it from whoever wrote the page — the URL included. A URL
 * here carries no authority and is not a trust label: reading one is a fresh
 * decision, judged from scratch by the same policy every other URL faces.
 *
 * Bounded before it gets here. The boundary that produced it has already cut
 * each field to one line inside its own character bounds, because these are
 * one-line fields by contract and a newline in them is a third party writing
 * the shape of Volli's own list.
 */
export interface RuntimeWebSearchReference {
  title: string;
  url: string;
  snippet: string;
}

/**
 * What one search returns.
 *
 * {@link provider} and {@link query} are Volli's own facts — the id of the
 * provider a person configured, and the query Volli sent — so they can be
 * stated as provenance in front of references that may claim otherwise.
 */
export interface RuntimeWebSearchResults {
  /** The configured provider's id, as Volli names it. Never the provider's own words. */
  provider: string;
  /** The query Volli sent, which is the model's own text. */
  query: string;
  references: readonly RuntimeWebSearchReference[];
  /** Whether the provider offered more references than the boundary passed on. */
  truncated: boolean;
}

/** Everything the Agent Runtime needs to start one Session, whatever its Role. */
export interface SessionRuntimeSpec {
  identity: RuntimeSessionIdentity;
  /**
   * Immutable execution root — a Ticket's isolated worktree, or a project root
   * for a ticketless Session. Work lands inside it: the prompt's workspace
   * layer instructs writes and destructive commands to stay in the workspace,
   * while allowing task-anchored reads elsewhere on the machine.
   */
  workspacePath: string;
  venue: ExecutionVenue;
  model: ModelSelection;
  /**
   * The policy every tool call is checked against — when the Session was given
   * one at all.
   *
   * Optional, and absent throughout the product: Volli runs Pi ungated, and the
   * desktop adapter supplies no Snapshot. Absence is not a Snapshot that allows
   * everything. With no Snapshot the runtime installs no `beforeToolCall`, so
   * the rule pack, the fallback thresholds and {@link ask} are structurally
   * unreachable rather than merely permissive — which is why this is an absent
   * field and not an `ungated` member on {@link AuthoritySnapshot}. A Snapshot
   * that meant "do not consult me" would still have to carry a pack id, a pack
   * hash and two thresholds describing rules nobody will ever run, and the one
   * path that must not reach the gate would depend on every caller remembering
   * to check.
   *
   * The machinery is kept whole for
   * `docs/plans/authority-two-axis-rearchitecture.md`, which changes the policy
   * the mechanism carries rather than the mechanism.
   */
  authority?: AuthoritySnapshot;
  brief: RuntimeBrief;
  promptResources?: readonly PromptResource[];
  tools: RuntimeToolBundle;
  /** Opaque Pi sidecar locator from the durable Session Attachment. */
  recovery?: RuntimeRecoveryRef;
  signal?: AbortSignal;
  /**
   * Refusals this Session already accrued, before this attachment existed.
   *
   * Carried beside {@link AuthoritySnapshot} rather than inside it because a
   * count is live machine state and not policy — the snapshot's own rule is that
   * the facts its rules read stay live while the policy is pinned. The per-
   * Session half of {@link AuthorityFallback} is a fact about the Session, so a
   * counter starting from zero on every attach would never reach its threshold;
   * the consecutive half has no equivalent, since an allowed call is not an
   * event and only a live runtime sees both answers.
   */
  priorAuthorityDenials?: number;
  /**
   * Ask a person, and block until they answer.
   *
   * Optional, and its absence is a working configuration rather than a
   * degradation: with no host to ask, the fallback thresholds have nothing to
   * escalate to and every refusal stays silent, which is exactly what shipped
   * before this port existed.
   *
   * There is no timeout, invented or otherwise — an unanswered question parks
   * the turn for as long as it takes. `signal` is how the wait ends without an
   * answer, and a host must listen to it: it fires when the turn is interrupted
   * or the attachment is released, and it is the host's only notice that the
   * question it is showing has been abandoned and must be withdrawn. A host that
   * ignores it strands whatever it opened, because the runtime stops waiting
   * either way.
   *
   * Rejecting the promise is a different statement, and the runtime treats it as
   * one: it means the host cannot obtain an answer at all, so the refusal stands
   * and *is recorded*. Aborting means nobody was asked; rejecting means nobody
   * could be.
   *
   * A host that opens a durable record for the question should commit it before
   * parking, and commit the answer before resolving — otherwise a relaunch
   * mid-wait loses the question while the runtime is still blocked on it.
   */
  ask?: (request: RuntimeAskRequest, signal: AbortSignal) => Promise<RuntimeAskChoice>;
  /**
   * Let the model ask a person, and block its call until they answer.
   *
   * Beside {@link ask} rather than inside it, because the two are different acts
   * that happen to wait the same way — see {@link RuntimeAskUserRequest}. Its
   * absence is what decides whether the model is offered the tool at all: a
   * Session with no host to ask is not given a way to ask, rather than given one
   * that fails on use.
   *
   * Every word of {@link ask}'s bargain holds here too. There is no timeout;
   * `signal` is the only notice the host gets that the question it is showing
   * has been abandoned and must be withdrawn; a rejection means the host could
   * not obtain an answer at all, and reaches the model as a failed tool call
   * rather than as an answer nobody gave.
   *
   * What comes back is the person's decision as the ledger holds it — their own
   * option ids and their own words — and not a reading of it. Nothing between
   * here and the model is entitled to interpret an answer the model itself
   * phrased the question for.
   */
  askUser?: (
    request: RuntimeAskUserRequest,
    signal: AbortSignal,
  ) => Promise<SessionInteractionResolution>;
  /**
   * Read one public web document, through a boundary this Session does not own.
   *
   * Optional on the same terms as {@link askUser}, and for the same reason: its
   * absence is what decides whether the model is offered a web tool at all. A
   * Session given no boundary has no way to reach the network through the
   * runtime, rather than a tool that fails on use.
   *
   * One URL in and one bounded document out is the whole of the contract. There
   * is deliberately no header, host, port, method or redirect policy a caller
   * could state: every one of those is a decision the boundary makes for itself,
   * and a port that accepted them would be a port through which the model could
   * negotiate its own safety.
   *
   * `signal` withdraws the read, and a host must honour it — the runtime stops
   * waiting either way. A rejection means the read did not happen: a refusal
   * carries a rule the runtime turns into text the model can act on, and
   * anything else is a host that could not answer and fails the call.
   */
  webFetch?: (input: { url: string; signal: AbortSignal }) => Promise<RuntimeWebDocument>;
  /**
   * Ask the configured search provider for references, through a boundary this
   * Session does not own.
   *
   * Optional on the same terms as {@link webFetch}: a Session given no provider
   * is offered no search tool, rather than one that fails on use. The two are
   * independent — a Session can be given either, both or neither, because
   * searching and reading are different capabilities with different costs. A
   * search discloses the query to a third party; a fetch does not.
   *
   * One query in and bounded references out is the whole of the contract. The
   * endpoint, the credential and every bound are the boundary's, and there is
   * deliberately no URL, count, provider, locale or freshness a caller could
   * state: a port that carried them would be a port the model could aim.
   *
   * What comes back is references and never page contents. Nothing behind this
   * port may read a result page — that is what makes a search cheap to allow
   * and a fetch a separate decision.
   *
   * `signal` withdraws the search, and a host must honour it. A rejection means
   * the search did not happen: a refusal carries a rule the runtime turns into
   * text the model can act on, and anything else is a host that could not
   * answer and fails the call.
   */
  webSearch?: (input: { query: string; signal: AbortSignal }) => Promise<RuntimeWebSearchResults>;
  /** Resolves only after the observation reaches its required consumer boundary. */
  observer: (observation: RuntimeObservation) => Promise<void>;
}

/** Sanitized failure surfaced through observations. Never contains secrets. */
export interface RuntimeFailure {
  reason: "auth" | "configuration" | "context" | "model" | "aborted" | "unknown";
  message: string;
}

export interface SanitizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Prompt tokens served from the provider's cache. Reported separately from
   * `inputTokens` because providers price and count them apart — and because
   * context occupancy is their sum: on a cached turn `inputTokens` alone is
   * only the uncached sliver of what the model is actually holding.
   */
  cacheReadTokens?: number;
  /** Prompt tokens written into the provider's cache this turn. */
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface SettledAssistantMessage {
  /** Stable runtime entry identity; deduplicates replay after restart. */
  entryId: string;
  role: "assistant";
  text: string;
  reasoning?: string;
  model?: { providerId: string; modelId: string };
  usage?: SanitizedUsage;
}

export type RuntimeObservation =
  | AttachmentObservation
  | TurnObservation
  | CompactionObservation
  | TranscriptDeltaObservation
  | SettledMessageObservation
  | RuntimeActivityObservation
  | AuthorityObservation
  | AttentionObservation
  | InteractionObservation;

/**
 * The Session's authority refused a call, before the tool ran.
 *
 * Not an activity that failed: no tool executed, and the runtime is reporting
 * Volli's own decision back to Volli. Emitted through the same observer as
 * everything else so the refusal reaches durable history before the model is
 * told — `observer` resolves only at the consumer boundary, which is what makes
 * "recorded, then refused" an ordering the runtime can actually keep.
 */
export interface AuthorityObservation {
  kind: "authority";
  state: "denied";
  /** Null before the first turn opens, which a refusal need not wait for. */
  turnId: string | null;
  tool: string;
  cause: AuthorityDenialCause;
  reason: string;
  occurredAt?: number;
}

export interface AttachmentObservation {
  kind: "attachment";
  state: "started" | "recovered" | "closed" | "failed";
  recovery?: RuntimeRecoveryRef;
  failure?: RuntimeFailure;
}

export interface TurnObservation {
  kind: "turn";
  state: "started" | "completed" | "interrupted";
  turnId: string;
  occurredAt?: number;
  recoveryCursor?: string;
}

/**
 * Why a context was compacted, in the executor's own three words.
 *
 * Spelled out rather than imported: this package depends on nothing, and Pi
 * names these same three reasons in its own `CompactionReason`. The two are
 * held in step by the one place that can see both — `pi/runtime.ts` checks this
 * list against Pi's type — rather than by an import this package may not have.
 *
 * All three have producers: the reserve threshold, the overflow a provider
 * refused, and the `/compact` verb a person typed.
 */
export const COMPACTION_REASONS = ["threshold", "overflow", "manual"] as const;

export type CompactionReason = (typeof COMPACTION_REASONS)[number];

/**
 * The Session's context was summarized — or an attempt to summarize it failed.
 *
 * Deliberately not a {@link TurnObservation}. Compaction is maintenance rather
 * than a unit of the conversation: it says nothing the model said, an
 * interrupted one must raise no partial-turn Attention on recovery, and the
 * threshold path already runs inside a turn the person is waiting on.
 *
 * The two arms carry different facts because they are different facts. A
 * compaction that happened has a durable entry behind it and a before and after
 * worth reading; one that failed wrote nothing at all, and an entry id or a
 * token count on that arm could only be invented. A failed summary is
 * deliberately **not** an Attention: nothing is blocked by it, the message that
 * paid for it is delivered anyway, and there is no action a person could take
 * to clear it. What it does risk — the next turn refused for context length —
 * has its own Attention, raised only once overflow recovery has been spent.
 */
export type CompactionObservation =
  | {
      kind: "compaction";
      state: "compacted";
      reason: CompactionReason;
      /** The durable compaction entry in the executor's own history. */
      entryId: string;
      /**
       * What the context held before, as the executor measured it: the model's
       * own last reported usage, not a guess.
       */
      tokensBefore: number;
      /**
       * What the compacted context is expected to hold, as the executor
       * estimates it.
       *
       * An estimate on purpose, and the asymmetry with `tokensBefore` is the
       * honest one: nothing has measured the new context yet, and nothing can
       * until the model next answers on it.
       */
      tokensAfter: number;
      occurredAt?: number;
      recoveryCursor?: string;
    }
  | {
      kind: "compaction";
      state: "failed";
      reason: CompactionReason;
      /** Sanitized; the same diagnostic discipline as {@link RuntimeFailure}. */
      message: string;
      occurredAt?: number;
      recoveryCursor?: string;
    };

/** Transient stream delta. Never advances the durable recovery cursor. */
export interface TranscriptDeltaObservation {
  kind: "delta";
  turnId: string;
  channel: "text" | "reasoning";
  text: string;
}

/** A completed runtime message settling exactly once into durable history. */
export interface SettledMessageObservation {
  kind: "message-settled";
  turnId: string;
  message: SettledAssistantMessage;
  occurredAt?: number;
  recoveryCursor?: string;
}

/** JSON-safe, runtime-normalized tool input and output. */
export type RuntimeActivityValue =
  | string
  | number
  | boolean
  | null
  | readonly RuntimeActivityValue[]
  | { readonly [key: string]: RuntimeActivityValue };

interface RuntimeActivityObservationBase {
  kind: "activity";
  /** The Volli turn that owns this activity lifecycle. */
  turnId: string;
  activityId: string;
  descriptor: ActivityDescriptor;
  input: RuntimeActivityValue;
  output: RuntimeActivityValue;
  occurredAt?: number;
  recoveryCursor?: string;
}

export type RuntimeActivityObservation =
  | (RuntimeActivityObservationBase & {
      state: "started" | "progress" | "completed";
      error?: never;
    })
  | (RuntimeActivityObservationBase & {
      state: "failed";
      error?: string;
    });

/**
 * Attention's `reason` is frozen, unlike the arms of this union.
 *
 * Pi's recovery sidecar validates a persisted marker by switching on `kind` and
 * then whitelisting this exact set — and it throws rather than skipping what it
 * does not recognise. Adding a whole new observation kind is therefore safe: the
 * sidecar holds none of them, so no marker already on disk changes how it
 * validates — {@link CompactionObservation} was added exactly that way.
 * Adding a `reason` is not: every attention marker written by an older build is
 * re-validated against the new list on the next recovery, and a Session whose
 * marker no longer matches fails to attach outright.
 */
export interface AttentionObservation {
  kind: "attention";
  state: "raised" | "cleared";
  reason: "auth" | "configuration" | "context" | "runtime-failure" | "partial-turn";
  message: string;
  occurredAt?: number;
  recoveryCursor?: string;
}

/**
 * The executor is waiting on a person, until it is answered or stops being asked.
 *
 * The runtime owns everything about the ask except which attachment is doing the
 * asking: the Session Engine injects `attachmentId` when it records the fact, so
 * the runtime cannot name an attachment other than its own. The Pi adapter
 * raises all three arms around its {@link SessionRuntimeSpec.ask} host: an
 * escalation opens one, an answer resolves it, and an abort cancels it.
 *
 * `cancelled` carries a reason where `resolved` carries a resolution, and
 * deliberately cannot carry both — see {@link SessionInteractionCancelReason}
 * for why an ask that ended undecided must leave nothing a reader could take for
 * a decision.
 */
export type InteractionObservation =
  | {
      kind: "interaction";
      state: "opened";
      interaction: Omit<SessionInteraction, "attachmentId">;
      occurredAt?: number;
    }
  | {
      kind: "interaction";
      state: "resolved";
      interactionId: string;
      resolution: SessionInteractionResolution;
      occurredAt?: number;
    }
  | {
      kind: "interaction";
      state: "cancelled";
      interactionId: string;
      reason: SessionInteractionCancelReason;
      occurredAt?: number;
    };

export type RuntimeMessageDelivery = "queue" | "steer" | "replace";

/** Observable outcome of one delivery attempt. Never silently reinterpreted. */
export type DeliveryOutcome =
  | { kind: "delivered"; delivery: "prompt" | "queue" | "steer" | "retry" }
  | {
      kind: "rejected";
      reason: "busy-unsupported" | "closed" | "replace-unsupported" | "retry-unavailable";
      message: string;
    };

/** Observable outcome of applying one idle-time Session model policy. */
export type ModelSelectionOutcome =
  | { kind: "selected" }
  | {
      kind: "rejected";
      reason: "busy-unsupported" | "closed" | "model-unavailable" | "reasoning-unsupported";
      message: string;
    };

/**
 * Observable outcome of one EXPLICIT compaction request.
 *
 * The threshold and overflow paths need no such answer: nobody asked them, so
 * a compaction that found nothing to do is nothing to report, and only the
 * durable {@link CompactionObservation} records what happened. A person who
 * typed `/compact` did ask, and every way of not compacting has to reach them
 * — which is why `nothing-to-compact` and `summary-failed` are refusals here
 * rather than a quiet `false`.
 *
 * `summary-failed` overlaps a `CompactionObservation` deliberately. The
 * observation is the durable fact and the refusal is the answer to the
 * request; the same failure is both, exactly as a refused message is both a
 * receipt and a transcript row.
 */
export type CompactionRequestOutcome =
  | { kind: "compacted" }
  | {
      kind: "rejected";
      reason: "busy-unsupported" | "closed" | "nothing-to-compact" | "summary-failed";
      message: string;
    };

/** One live runtime attachment. Closing it never ends Session identity. */
export interface RuntimeAttachmentHandle {
  submitUserMessage(
    text: string,
    delivery?: RuntimeMessageDelivery,
    commandId?: string,
    /**
     * Images to send as content alongside `text`, for this turn (VC-50).
     *
     * Trailing and optional so every existing caller is untouched, and
     * separate from `text` because they are not interchangeable: a runtime
     * that cannot take images can ignore this and still deliver the message.
     * The bytes live only as long as the call — what persists is the
     * `volli-blob:` reference in the message parts.
     */
    images?: readonly RuntimeImageInput[],
  ): Promise<DeliveryOutcome>;
  /** Apply a validated model policy only while this attachment is idle. */
  selectModel(selection: ModelSelection): Promise<ModelSelectionOutcome>;
  /** Retry the last failed run without duplicating its user message. */
  retry(commandId?: string): Promise<DeliveryOutcome>;
  /**
   * Compact this Session's context now, because someone asked.
   *
   * The third producer of a {@link CompactionObservation} and the only one
   * with a caller waiting on it. `instructions` is free text handed to the
   * summarizer — what to keep, what matters — and is prose, never arguments.
   */
  compact(instructions?: string): Promise<CompactionRequestOutcome>;
  /** Abort the current run and settle the resulting state honestly. */
  interrupt(): Promise<void>;
  /** Release local resources; the Session and its history remain. */
  close(): Promise<void>;
  /** Replays durable semantic markers after an optional sidecar checkpoint. */
  reconcile(cursor: string | null): Promise<{
    cursor: string | null;
    observations: readonly RuntimeObservation[];
    /** Commands Pi durably accepted into a turn, for post-crash receipt repair. */
    receipts?: readonly { commandId: string; acceptedAt: number }[];
  }>;
  /** Recovery metadata persisted by the Session owner for exact sidecar reopen. */
  readonly recovery: RuntimeRecoveryRef | undefined;
}

/**
 * One standalone utility completion: prompt in, text out, nothing else.
 *
 * The third door on the runtime, beside Session start and Model Access
 * inspection — what a background job like auto-titling runs through so it
 * stays structurally outside the chat: no Session is created, no attachment,
 * no transcript and no ledger entry. The caller owns which model this runs
 * on, resolved and validated against its own policy first; the runtime is the
 * executor, not the chooser, and refuses a model it does not hold rather than
 * substituting one (no silent fallback).
 */
export interface UtilityCompletion {
  /** The model the caller's policy resolved; its reasoning level is sent as-is. */
  model: ModelSelection;
  systemPrompt: string;
  /** The single user message. */
  user: string;
}

/** The singular runtime port. Not a registry; there is exactly one executor. */
export interface AgentRuntime {
  /** Inspect provider accounts and models without exposing runtime credentials or native types. */
  inspectModelAccess(input?: {
    refresh?: boolean;
    signal?: AbortSignal;
  }): Promise<ModelAccessSnapshot>;
  startSession(spec: SessionRuntimeSpec): Promise<RuntimeAttachmentHandle>;
  /**
   * Run one utility completion and resolve its text. Throws when the model is
   * not one this runtime holds or the call failed; a caller that cannot afford
   * the throw (a title that keeps its heuristic) catches and logs.
   */
  completeUtility(input: UtilityCompletion): Promise<string>;
}
