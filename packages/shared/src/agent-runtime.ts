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
import type { WorkspaceDependenciesStatus } from "./session-env";
import type {
  AuthorityDenialCause,
  AuthoritySnapshot,
  CodingToolId,
  NonCodingToolId,
  SessionToolId,
} from "./authority";
import { NON_CODING_TOOL_IDS } from "./authority";
import type { ModelAccessSignInMethod } from "./model-access-sign-in";
import type { UsageLimits } from "./usage-limits";
// Type-only: `verb-registry.ts` reads this module's own vocabulary, so a value
// import here would close a cycle. Nothing below needs one.
import type { VerbToolKey } from "./verb-registry";
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
import type { SessionUsage } from "./session-usage";

/** The Roles a Session may be created under, as a runtime list a stored string is checked against. */
export const SESSION_ROLES = ["project", "ticket", "subagent"] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];

/**
 * The glossary word for each Role (CONTEXT.md "Session Role"), for prose a
 * person or an agent reads. The enum value is a frozen durable field written
 * into Session history and stays `project`; the word for it is Board.
 */
export const SESSION_ROLE_NAMES: Record<SessionRole, string> = {
  project: "Board Session",
  ticket: "Ticket Session",
  subagent: "Subagent Session",
};

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
  /**
   * The account's subscription windows, when this provider has a way to read
   * them (VC-263). Absent for the many providers that report no such thing;
   * present-but-`unavailable` for an account the runtime knows how to ask
   * about and could not, or must not, read — see {@link UsageLimits}.
   */
  usageLimits?: UsageLimits;
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

/** What one explicit model-catalog refresh changed or could not safely apply. */
export interface ModelCatalogRefreshReport {
  added: number;
  removed: number;
  /** Source models withheld because no unambiguous executable protocol existed. */
  rejected: number;
  /** Providers whose complete current list was applied, including unchanged lists. */
  refreshedProviderIds: readonly string[];
  /** Providers that retained their last usable list after an isolated failure. */
  failedProviderIds: readonly string[];
}

/** The complete sanitized Model Access view at one observation time. */
export interface ModelAccessSnapshot {
  observedAt: number;
  providers: readonly ModelAccessProvider[];
  models: readonly ModelAccessModel[];
  /** Present only when this inspection explicitly refreshed catalogs. */
  refresh?: ModelCatalogRefreshReport;
}

/**
 * The Roles that attach a runtime: every Role there is.
 *
 * Since VC-9 a Subagent Session is a real Session with an attachment, a
 * transcript and a model of its own — never a hidden thread inside its
 * parent — so this is the whole of {@link SessionRole} rather than a subset.
 * It stays a separate name because it answers a different question (which
 * Roles the prompt and identity vocabularies are total over), and because a
 * future Role that does NOT attach would leave this one narrower again.
 */
export type RuntimeSessionRole = SessionRole;

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
 * A Subagent Session's identity (VC-9): the Session that delegated it, and the
 * Ticket it inherited from that Session — or none, when the parent had none.
 *
 * The parent is part of the identity because it is what the Role MEANS: a
 * subagent is a bounded helper for one other Session, and the host binds
 * that Session here so the answer can be delivered to it without the child
 * ever naming it. The Ticket is nullable here and nowhere else in this union,
 * because a subagent is the one Role whose Ticket is not its own.
 */
export interface SubagentRuntimeIdentity extends RuntimeIdentityFields {
  role: Extract<RuntimeSessionRole, "subagent">;
  ticketId: string | null;
  parentSessionId: string;
}

/**
 * Role and identity are one value, not two agreeing fields.
 *
 * The Role decides what the runtime may assume about the Session — a Ticket to
 * work, a project root and nothing else, or a parent to answer — so a spec that
 * named the Role separately from the identity could state a Ticket Session with
 * no Ticket, or a subagent with no parent. Here those shapes do not typecheck.
 */
export type RuntimeSessionIdentity =
  | TicketRuntimeIdentity
  | ProjectRuntimeIdentity
  | SubagentRuntimeIdentity;

/** Where execution happens. Local is the only venue built today. */
export type ExecutionVenue = "local";

/**
 * The named half of a Session's Agent Tool Surface: what its Role handed it,
 * as opposed to what a wired port gave it.
 *
 * Two fields rather than one widened list, and the reason is a sentence in the
 * system prompt. `prompt.ts` renders {@link tools} as *"The available coding
 * tools are: …"*, which is true of `read`/`edit`/`write`/`execute` and would
 * become false the moment a product verb joined them. Widening the field would
 * have made the prompt lie; adding a field beside it leaves those bytes exactly
 * as they were (VC-162).
 *
 * They are also wired differently, which is the deeper reason they are not one
 * list. A coding tool is answered by the execution environment the runtime
 * holds; a verb tool is answered by a host port. Keeping them apart is what
 * lets {@link SessionToolBinding} carry the right thing for each.
 */
export interface RuntimeToolBundle {
  /** Coding tools, in the order this venue offers them. */
  tools: readonly CodingToolId[];
  /**
   * Product verbs from `bundle(Role) ∪ grants(session)`, in canonical registry
   * order. Absent means none — the Ticket Role's default bundle has no
   * agent-control tool, while a durable birth grant may add one scoped verb.
   *
   * Membership comes from here; execution comes from
   * {@link SessionRuntimeSpec.callVerb}. A bundle naming a verb with no port
   * behind it fails where the surface is built, which is the cheapest place
   * for it to fail.
   */
  verbs?: readonly VerbToolKey[];
  /**
   * Whether this Session's surface names `todo_write` (VC-6).
   *
   * A boolean where its neighbours are lists, because the tool is one name and
   * there is nothing to order. It is HERE rather than beside the ports for the
   * reason this interface exists at all: `todo_write` is answered by neither an
   * execution environment nor a host port — a call replaces a list the durable
   * transcript already keeps — so the bundle is the only thing left that can
   * say whether the Session holds it.
   *
   * Absent means no, and absent is what every Session frozen before VC-6 says.
   * That is the whole point of gating it: the Pi adapter refuses an attachment
   * whose derived tool array disagrees with the durable record, so a name added
   * unconditionally would refuse every Session that predates it.
   */
  todoWrite?: boolean;
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
 * Which half of {@link AuthorityFallback} sent the runtime to ask — or, for
 * `budget`, the fact that no denial accrued at all.
 *
 * Worth naming rather than collapsing, because the three mean different things
 * to the person answering: a run of refusals back to back means the policy is
 * in the way of one line of work, a total across the Session means it is in
 * the way of the Session, and a budget means nothing was refused yet — an
 * allowance ran out and the call is waiting on "a little more" (VC-204).
 * `budget` asks are raised by a verb's own door rather than by the escalation
 * counter, so they never advance either {@link AuthorityFallback} threshold:
 * the person already answered, and counting that answer as friction would
 * escalate twice over one decision.
 */
export type RuntimeAskTrip = "consecutive" | "session" | "budget";

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
  /**
   * The URL the bytes came from: the last hop of the redirect chain, or
   * {@link requestedUrl} when the first request answered with the document.
   * Every hop passed the same admission, address and pinning policy.
   */
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

/**
 * Who holds a Browser Tab — whose turn it is to drive it (VC-239).
 *
 * At most one party at a time: one Session, or the person. `null` is a free
 * tab. Reads never need a hold; a write takes a free tab's hold, keeps its
 * own, and is refused on anyone else's. The holder is named in the tab list so
 * a Session can see contention before it fails on it.
 */
export type RuntimeBrowserHolder =
  | { kind: "session"; sessionId: string; self: boolean }
  | { kind: "person" }
  | null;

/** One Browser Tab as the runtime lists it: bounded metadata, never page content. */
export interface RuntimeBrowserTab {
  /** Product-owned opaque id — never a positional Chromium tab index. */
  tabId: string;
  url: string;
  title: string;
  /** Who opened it. A person's tab and an agent's tab render differently and are audited differently. */
  createdBy: "user" | "session";
  /**
   * Which Session opened it, or null for a person's tab (VC-238). The host
   * shows a Session only its own tabs by default, so this usually names the
   * caller; it is here so a parent that is shown a child's tabs can tell them
   * apart from its own.
   *
   * Separate from {@link heldBy}, and deliberately: ownership says whose tab
   * this IS — who may see it, whose attachment end closes it, whose cap it
   * counts against — while the hold says whose turn it is to write to it right
   * now. A Session owns its headless tabs permanently and holds one only while
   * it is driving it; the person owns none and may hold any.
   */
  ownerSessionId: string | null;
  /** Who holds it right now, or `null` for a free tab. */
  heldBy: RuntimeBrowserHolder;
}

/** The answer to taking a hold: yours now (or already), or somebody else's. */
export type RuntimeBrowserHoldOutcome =
  | { kind: "held"; tabId: string }
  | { kind: "refused"; tabId: string; holder: NonNullable<RuntimeBrowserHolder> };

/** Every Browser Tab the host let this Session see. */
export interface RuntimeBrowserTabList {
  tabs: readonly RuntimeBrowserTab[];
}

/**
 * The tab facts every Browser answer carries beside its own payload (VC-238):
 * enough for the person's transcript card to name the tab, mark who is driving
 * it, and show that its page did not load — none of which the model's text can
 * say, and none of which the renderer may infer from a tool name.
 */
export interface RuntimeBrowserPage {
  tabId: string;
  url: string;
  title: string;
  /** Which Session owns the tab, or null for the person's own. */
  ownerSessionId: string | null;
  /**
   * Volli's words for the tab's last load failure or renderer crash, or null
   * when the page is healthy. A navigation onto a page that fails to load
   * still answers with a snapshot, so without this the row would wear a
   * success glyph over a broken page (§9).
   */
  error: string | null;
}

/**
 * One Browser Tab read as structure: the accessibility tree the page's own
 * engine computed, printed one `role "name" [ref=eN]` node per line.
 *
 * The refs are the interaction contract. Each names an element of THIS
 * snapshot's {@link generation}; the host refuses a ref presented against a
 * later generation rather than acting on whatever now occupies the page — a
 * stale selector must fail, not click.
 *
 * Everything in {@link snapshotText} and {@link title} is page-derived and
 * therefore untrusted third-party content. The runtime wraps it in the same
 * provenance envelope a fetched web document gets; nothing below the envelope
 * may treat a line of it as an instruction.
 */
export interface RuntimeBrowserSnapshot extends RuntimeBrowserPage {
  /** The formatted accessibility snapshot, already bounded by the host. */
  snapshotText: string;
  /** Monotonic per-tab counter; refs are valid only against the generation that minted them. */
  generation: number;
  /** Whether the host cut the tree at its own bound before the page ended. */
  truncated: boolean;
  /**
   * An opaque id for the picture the host took of the page after this call
   * changed it, for the person's transcript card — never the bytes, which
   * stay with the host (VC-238). Null when nothing changed (a plain read) or
   * when the host declined to look because the person was using the tab.
   */
  picture: string | null;
}

/** The answer to one action: the fresh snapshot, plus what the action touched. */
export interface RuntimeBrowserActResult extends RuntimeBrowserSnapshot {
  /**
   * The element acted on, as the last snapshot named it (VC-238): the ref the
   * model passed and the page's accessible name for it, or null when the name
   * was empty. Null altogether for page-level actions (press, scroll, wait).
   */
  target: { ref: string; name: string | null } | null;
}

/**
 * How a Browser Tab is steered: somewhere new, or along its own history.
 * A discriminated shape rather than a URL-or-keyword string, so "back" can
 * never be misread as a relative address.
 */
export type RuntimeBrowserNavigation =
  | { kind: "url"; url: string }
  | { kind: "back" }
  | { kind: "forward" }
  | { kind: "reload" };

/**
 * One semantic action against a snapshot ref.
 *
 * `generation` travels with every action for {@link RuntimeBrowserSnapshot}'s
 * reason: the ref names what the model saw, and what the model saw is only
 * addressable while the page still is that generation. Optional fields belong
 * to particular kinds — the tool schemas constrain which; the port validates.
 */
export interface RuntimeBrowserActRequest {
  tabId: string;
  generation: number;
  kind: "click" | "type" | "press" | "select" | "hover" | "scroll" | "wait";
  /** The snapshot ref being acted on; absent for page-level kinds (press, scroll, wait). */
  ref?: string;
  /** Text for `type`, option value for `select`. */
  text?: string;
  /** Key spec for `press`, e.g. `Enter` or `Control+a`. */
  key?: string;
  /** Scroll direction, or the wait bound in milliseconds. */
  direction?: "up" | "down";
  waitMs?: number;
}

/** A captured Browser Tab image, bounded by the host before it reaches anyone. */
export interface RuntimeBrowserScreenshot extends RuntimeBrowserPage {
  /** PNG bytes, base64. The host owns scale and size bounds. */
  base64Png: string;
  /** The host's id for the same picture, kept for the person (VC-238). Null when the host keeps none. */
  picture: string | null;
  width: number;
  height: number;
}

/** One console message or page error, already cut to the host's bounds. */
export interface RuntimeBrowserConsoleMessage {
  level: "debug" | "info" | "log" | "warn" | "error";
  text: string;
}

/** A Browser Tab's recent console output and page errors, bounded. */
export interface RuntimeBrowserConsole extends RuntimeBrowserPage {
  messages: readonly RuntimeBrowserConsoleMessage[];
  truncated: boolean;
}

/**
 * The one Browser port: everything a Session can do to a Browser Tab, answered
 * by the host that owns the native surface.
 *
 * One port for six tools, deliberately. Looking and acting are one capability
 * with one answerer — the desktop's BrowserTabHost — and splitting the port
 * would invent a grant model this slice does not have; when per-tab grants
 * arrive they arrive as policy inside the host, not as port shape. Like
 * {@link SessionRuntimeSpec.webFetch}, every method takes what the model said
 * and a signal, and decides everything else itself: which tabs are visible,
 * every bound, every refusal. There is deliberately no raw JavaScript, no
 * cookie, no header and no CDP surface here — a port that carried them would
 * be a port the model could aim at the machine hosting it.
 */
export interface RuntimeBrowserPort {
  tabs(input: { signal: AbortSignal }): Promise<RuntimeBrowserTabList>;
  /** Steer a tab — or open one, when `tabId` is absent and the navigation names a URL. */
  navigate(input: {
    tabId?: string;
    navigation: RuntimeBrowserNavigation;
    signal: AbortSignal;
  }): Promise<RuntimeBrowserSnapshot>;
  snapshot(input: { tabId: string; signal: AbortSignal }): Promise<RuntimeBrowserSnapshot>;
  /** Act, then answer with the fresh snapshot the action produced. */
  act(input: RuntimeBrowserActRequest & { signal: AbortSignal }): Promise<RuntimeBrowserActResult>;
  screenshot(input: { tabId: string; signal: AbortSignal }): Promise<RuntimeBrowserScreenshot>;
  console(input: { tabId: string; signal: AbortSignal }): Promise<RuntimeBrowserConsole>;
  /**
   * Take a tab's hold, or learn who has it (VC-239). Optional as a PAIR with
   * {@link release}: a Session whose frozen surface predates the hold tools is
   * handed a port without them, and the surface offers `browser_acquire` and
   * `browser_release` exactly when the port carries both. The writes above
   * take the hold implicitly either way, so such a Session still works.
   */
  acquire?(input: { tabId: string; signal: AbortSignal }): Promise<RuntimeBrowserHoldOutcome>;
  /** Give a hold back early. Releasing a tab this Session does not hold is a no-op. */
  release?(input: { tabId: string; signal: AbortSignal }): Promise<{ tabId: string }>;
  /** Releases host-private debugger/controller resources when an attachment ends. */
  dispose?(): void;
}

/** A Browser port whose hold pair is present — what the two hold tools bind to. */
export type RuntimeBrowserHoldPort = RuntimeBrowserPort &
  Required<Pick<RuntimeBrowserPort, "acquire" | "release">>;

/**
 * The port narrowed to its hold pair, or `undefined` when it carries neither.
 * Carrying exactly one is refused loudly: a Session that could take a hold and
 * not give it back — or the reverse — would be a surface no rule describes.
 */
export function browserHoldPort(
  port: RuntimeBrowserPort | undefined,
): RuntimeBrowserHoldPort | undefined {
  if (port === undefined) return undefined;
  const hasAcquire = port.acquire !== undefined;
  const hasRelease = port.release !== undefined;
  if (!hasAcquire && !hasRelease) return undefined;
  if (!hasAcquire || !hasRelease) {
    throw new Error(
      "A Browser port must carry both browser_acquire and browser_release or neither; the hold tools are offered together.",
    );
  }
  // The same object, proven: both methods were just read as present, so the
  // narrowing is a fact about `port` rather than a copy that could lose a
  // `this`-bound method.
  return port as RuntimeBrowserHoldPort;
}

/** How a background shell stands: still running, or exited with what it exited with. */
export type RuntimeShellState = "running" | "exited";

/**
 * One background shell as the runtime lists it (VC-270): bounded metadata,
 * never its output. Every shell result restates the Session's live shells in
 * this shape, so the tool calls that started and read them are the record the
 * model re-reads for free — there is no per-turn prompt channel for them.
 */
export interface RuntimeShellRecord {
  /** Host-minted opaque id, never a pid: a pid is reused by the OS and a shell id is not. */
  shellId: string;
  /** The command as the model gave it. */
  command: string;
  /** The model's own label for the shell, or `null` when it gave none. */
  title: string | null;
  state: RuntimeShellState;
  /** Exit code once exited; `null` while running and when the shell died of a signal. */
  code: number | null;
  /** The signal that ended it, once exited that way. */
  signal: string | null;
  /** Host clock, milliseconds. */
  startedAt: number;
  exitedAt: number | null;
}

/**
 * How a shell stands, in the words every surface says it in: `running`,
 * `exited 0`, or `exited by SIGTERM`.
 *
 * Here rather than beside any one caller because three surfaces answer the
 * same question — the tool result the model reads, the output pane's header,
 * and any listing — and a Session must not be told its shell `exited 0` in
 * one place and `exited by SIGKILL` in another. Takes the three fields it
 * reads, so the desktop's renderer-facing shell state satisfies it as well as
 * a {@link RuntimeShellRecord}.
 */
export function shellStanding(
  shell: Pick<RuntimeShellRecord, "state" | "code" | "signal">,
): string {
  if (shell.state === "running") return "running";
  if (shell.signal !== null) return `exited by ${shell.signal}`;
  return `exited ${shell.code ?? "?"}`;
}

/**
 * The one line a shell is named by: the first non-blank line of its command,
 * trimmed. Deliberately NOT truncated — how short a name must be is the
 * caller's business (the model's listing bounds it to fit a result; the
 * Activity Island lets its own truncation chain do it), and a bound baked in
 * here would be applied twice.
 */
export function shellCommandLine(command: string): string {
  return (
    command
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ""
  );
}

/** What starting a shell comes to: its record, and what it printed in the settle window. */
export interface RuntimeShellStartOutcome {
  shell: RuntimeShellRecord;
  pid: number;
  /** Whatever the command printed before the host stopped waiting — a server's "listening on" line. */
  output: string;
  /** Every shell this Session holds after the start, the one just started included. */
  shells: readonly RuntimeShellRecord[];
}

/**
 * What a read comes to. `output` is only what is NEW since the last read of
 * this shell, unless the caller asked for a `tail`, in which case it is the
 * last N bytes of everything retained. `truncated` says the host's own bound
 * dropped bytes before the caller could read them — either the ring buffer's
 * or the tail cap's.
 */
export interface RuntimeShellOutputOutcome {
  shell: RuntimeShellRecord;
  output: string;
  truncated: boolean;
  shells: readonly RuntimeShellRecord[];
}

/** What a kill comes to: the shell's record once it has exited. */
export interface RuntimeShellKillOutcome {
  shell: RuntimeShellRecord;
  shells: readonly RuntimeShellRecord[];
}

/**
 * The one background shell port (VC-270): everything a Session can do to a
 * command that runs beside the turn, answered by the host that owns the
 * process.
 *
 * One port for three tools, on {@link RuntimeBrowserPort}'s terms: starting,
 * reading and killing are one capability with one answerer, so a spec cannot
 * offer a Session the ability to start a process without the ability to end
 * it. Every method takes what the model said and a signal, and decides
 * everything else itself: the per-Session cap, the output bound, whether the
 * `cwd` is inside the workspace. A refusal is a typed error the tools turn
 * into text; anything else thrown is a host that could not answer at all.
 *
 * Deliberately absent: stdin, a PTY, a restart verb, a filter on reads. A
 * shell a person types into is the terminal, not this.
 */
export interface RuntimeShellPort {
  start(input: {
    command: string;
    /** Defaults to the Session workspace, and must stay inside it. */
    cwd?: string;
    title?: string;
    signal: AbortSignal;
  }): Promise<RuntimeShellStartOutcome>;
  output(input: {
    shellId: string;
    /** The last N bytes of everything retained, instead of what is new. Bounded by the host. */
    tail?: number;
    signal: AbortSignal;
  }): Promise<RuntimeShellOutputOutcome>;
  kill(input: { shellId: string; signal: AbortSignal }): Promise<RuntimeShellKillOutcome>;
  /** Kills every shell this Session started and forgets them; the attachment's end. */
  dispose?(): void;
}

/**
 * What the workspace's own package state was when this attachment started —
 * the two {@link SessionEnvReport} facts an agent can act on.
 *
 * Measured, never inferred, and measured at attach rather than carried on the
 * durable Session: a checkout whose dependencies were absent yesterday may
 * have them today, and a stale fact is worse than none. The prompt states it
 * only when there is something to do about it, which is why {@link
 * installCommand} travels beside {@link dependencies} — telling an agent that
 * dependencies are missing without naming the workspace's own install command
 * invites it to guess, and guessing `pnpm install` at a yarn workspace is the
 * measured cost `workspaceInstallCommand` exists to remove.
 *
 * This is the fix for who was being told: the dependency fact used to reach a
 * human, as a red pre-flight banner over a perfectly normal fresh checkout,
 * while the one party that could run the install — the agent — could learn it
 * only by thinking to run `volli identify` (VC-156).
 */
export interface RuntimeWorkspaceEnvironment {
  /** Dependencies in the Session's workspace; `null` when it is no package workspace. */
  dependencies: WorkspaceDependenciesStatus;
  /** The lockfile-derived install command for that workspace, or `null` when there is none to name. */
  installCommand: string | null;
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
   * Optional, and the optionality carries meaning that a value could not.
   * Absence is not a Snapshot that allows everything: with no Snapshot the
   * runtime installs no `beforeToolCall`, so the rule pack, the fallback
   * thresholds and {@link ask} are structurally unreachable rather than merely
   * permissive. A Snapshot that meant "do not consult me" would still have to
   * carry a pack id, a pack hash and two thresholds describing rules nobody will
   * ever run, and the one path that must not reach the gate would depend on
   * every caller remembering to check.
   *
   * The desktop adapter fills it from the attaching project's `AuthorityPolicy`
   * (VC-44), and fills it only when that policy says `enforce`. The two other
   * postures both arrive here as absence, for different reasons: `off` builds no
   * Snapshot at all, and `observe` builds one, records it on the attachment, and
   * deliberately does not hand it over. So a Session whose policy is `observe`
   * has a durable Snapshot and an unreachable gate at the same time — which is
   * the state slice 7 wanted, and the reason this field is the seam rather than
   * a flag inside the Snapshot.
   */
  authority?: AuthoritySnapshot;
  brief: RuntimeBrief;
  /**
   * The workspace's measured package state, when whoever built this spec could
   * measure it. Absent means unmeasured — never "measured and fine" — so a
   * caller with no filesystem to ask (the prompt-baseline diagnostic, a test)
   * composes the same prompt a healthy workspace does rather than a wrong one.
   */
  workspaceEnvironment?: RuntimeWorkspaceEnvironment;
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
  /**
   * Reach the Browser Tabs the host owns, through the one {@link RuntimeBrowserPort}.
   *
   * Optional on the same terms as {@link webFetch}: absence is what decides
   * whether the model is offered any browser tool. One port carries every
   * browser name — a Session with somewhere to send a browser action has all
   * of them, and one with nowhere has none. The one qualification is the hold
   * pair (VC-239): a port without `acquire`/`release` offers the six that
   * shipped before them, which is how a Session frozen with six keeps six.
   */
  browser?: RuntimeBrowserPort;
  /**
   * Run commands beside the turn, through the one {@link RuntimeShellPort}
   * (VC-270). Optional on {@link browser}'s terms: absence is what decides
   * whether the model is offered any shell tool, and one port carries all
   * three names.
   */
  shell?: RuntimeShellPort;
  /**
   * Run one product verb the Session's frozen Agent Tool Surface names, in the
   * host's own process (VC-162).
   *
   * The door that makes Role- and grant-scoped availability real. A verb reached this way
   * never crosses the agent socket, so the caller is not *attributed* from an
   * environment variable it could have been handed — it is the Session this
   * spec belongs to, bound by the host at attach and not stated in the call.
   * That is the whole difference between the two doors, and it is why a verb
   * whose misuse cannot be tolerated from an arbitrary same-uid process can
   * live here and not on the socket.
   *
   * Unlike {@link askUser} and {@link webFetch}, this port does NOT decide
   * membership: the bundle does. A Session whose bundle names a verb and whose
   * spec omits this port is a host that promised a tool it cannot answer, and
   * {@link sessionToolBindings} throws rather than building a surface with a
   * hole in it. The asymmetry is deliberate — a web boundary is a capability a
   * profile may genuinely lack, while a host that can attach a Session can
   * always run its own verbs.
   *
   * `input` has already been checked against the registry's schema for that
   * verb. What it has NOT been checked for is meaning: whether the Ticket
   * exists, whether the model is available, whether the caller's project holds
   * it. Those are the host's, and their refusals come back as text the model
   * can act on rather than as thrown errors — the line {@link webFetch} draws
   * between a refusal and a host that could not answer at all.
   */
  callVerb?: (request: RuntimeVerbCall, signal: AbortSignal) => Promise<RuntimeVerbResult>;
  /** Resolves only after the observation reaches its required consumer boundary. */
  observer: (observation: RuntimeObservation) => Promise<void>;
}

/** One product verb call, as the runtime hands it to the host. */
export interface RuntimeVerbCall {
  /** The canonical dot-key, never the provider wire name. */
  verb: VerbToolKey;
  /** Schema-checked arguments; semantics are still the host's to judge. */
  input: Readonly<Record<string, unknown>>;
  /**
   * The runtime's own id for this call.
   *
   * Carried so the host can derive a durable operation id from trusted caller
   * identity plus this, rather than minting a fresh random one per execution.
   * That is what makes a replayed tool call land as one durable act instead of
   * two — the same reasoning the Session Engine's command dedup already runs on.
   */
  toolCallId: string;
}

/** What the model is told a verb did. Text, because that is all a model reads. */
export interface RuntimeVerbResult {
  text: string;
  /**
   * Structured facts for the transcript row, never for the model (VC-9).
   *
   * Rides the tool result's `details` slot, which the activity mapper reads
   * and the model does not see. Exists for one row today: a `delegate` row
   * links to the child Session by id and names it by title, and parsing
   * either out of {@link text} would tie the transcript to the door's prose.
   * Flat JSON scalars only, so the durable activity marker stays bounded.
   */
  details?: Readonly<Record<string, string | number | boolean | null>>;
}

/** Just enough of a spec to say what surface it describes. */
export type SessionToolSpec = Pick<
  SessionRuntimeSpec,
  "tools" | "askUser" | "webFetch" | "webSearch" | "browser" | "shell" | "callVerb"
>;

/**
 * One tool of a Session's surface, carrying whatever answers it.
 *
 * A coding tool is answered by the execution environment, which the runtime
 * holds and this package cannot see, so it carries a name and nothing else. A
 * non-coding tool is answered by a port on the spec, and it carries that port —
 * already proven present by the act of being in this list. That is the point of
 * the union: the runtime switches on the name and reaches a port it never has to
 * null-check, so "named but unwired" has no branch to be handled in, because the
 * type cannot express it.
 */
export type SessionToolBinding =
  | { tool: CodingToolId }
  | { tool: "ask_user"; port: NonNullable<SessionRuntimeSpec["askUser"]> }
  | { tool: "web_fetch"; port: NonNullable<SessionRuntimeSpec["webFetch"]> }
  | { tool: "web_search"; port: NonNullable<SessionRuntimeSpec["webSearch"]> }
  // Eight arms, one port: each browser tool carries the whole RuntimeBrowserPort,
  // because the port is the capability and the names are only the model-facing
  // grain — the runtime switches on the name and calls the method it stands for.
  // The two hold arms carry the port with its optional pair proven present.
  | { tool: "browser_tabs"; port: RuntimeBrowserPort }
  | { tool: "browser_navigate"; port: RuntimeBrowserPort }
  | { tool: "browser_snapshot"; port: RuntimeBrowserPort }
  | { tool: "browser_act"; port: RuntimeBrowserPort }
  | { tool: "browser_screenshot"; port: RuntimeBrowserPort }
  | { tool: "browser_console"; port: RuntimeBrowserPort }
  | { tool: "browser_acquire"; port: RuntimeBrowserHoldPort }
  | { tool: "browser_release"; port: RuntimeBrowserHoldPort }
  // A name and nothing else, like a coding tool — but for the opposite reason.
  // A coding tool carries nothing because the runtime holds the environment
  // this package cannot see; `todo_write` carries nothing because there is
  // nothing to hold (VC-6).
  | { tool: "todo_write" }
  // Three arms, one port (VC-270), on the browser arms' terms.
  | { tool: "shell_start"; port: RuntimeShellPort }
  | { tool: "shell_output"; port: RuntimeShellPort }
  | { tool: "shell_kill"; port: RuntimeShellPort }
  | { tool: VerbToolKey; verb: VerbToolKey; port: NonNullable<SessionRuntimeSpec["callVerb"]> };

/**
 * The Agent Tool Surface one spec describes, in the order it is offered.
 *
 * The one derivation, and the reason there is only one. Two lists used to state
 * the same fact — the array the runtime builds, and the tool list on the
 * {@link AuthoritySnapshot} — kept equal by a caller remembering to keep them
 * equal. A caller that forgot did not produce a misconfiguration; it produced a
 * Session whose own policy refused its own tools, which is the failure VC-3 was
 * filed for. Deriving both from here is what makes that unrepresentable, and it
 * is what lets the pack carry no rule about tool identity at all.
 *
 * Order is part of the answer, not a detail of it. The provider's Cache Prefix
 * is computed over the serialized tool array, so a Session that reordered its
 * tools between attachments would pay a full cache miss for a list that had not
 * changed: the bundle first in its declared order, then the port-wired tools in
 * {@link NON_CODING_TOOL_IDS} order.
 *
 * A port decides membership because a port *is* the capability: a Session handed
 * nowhere to send a question has no question to send, so it is offered no tool
 * rather than a tool that fails when used. VC-162 replaces the bundle half with
 * `bundle(Role) ∪ grants(session)` from the Verb Registry; that changes what
 * this reads and not what it guarantees.
 */
export function sessionToolBindings(spec: SessionToolSpec): SessionToolBinding[] {
  // Keyed by the whole vocabulary rather than written as three conditions, so a
  // name added to `NON_CODING_TOOL_IDS` with no port behind it fails to compile
  // here — which is the only place that failure is cheap. A Snapshot recording
  // a tool no Session can be offered would be the same landmine VC-3 defused,
  // re-laid one vocabulary entry at a time.
  const browser = spec.browser;
  // The hold pair is offered together or not at all (VC-239): a port carrying
  // one of `acquire`/`release` without the other is a build bug, not a
  // smaller surface, and it is caught here where the cost is a thrown error
  // rather than a Session that can take a hold it cannot give back.
  const hold = browserHoldPort(browser);
  const shell = spec.shell;
  const wired: Record<NonCodingToolId, SessionToolBinding | null> = {
    ask_user: spec.askUser === undefined ? null : { tool: "ask_user", port: spec.askUser },
    web_fetch: spec.webFetch === undefined ? null : { tool: "web_fetch", port: spec.webFetch },
    web_search: spec.webSearch === undefined ? null : { tool: "web_search", port: spec.webSearch },
    browser_tabs: browser === undefined ? null : { tool: "browser_tabs", port: browser },
    browser_navigate: browser === undefined ? null : { tool: "browser_navigate", port: browser },
    browser_snapshot: browser === undefined ? null : { tool: "browser_snapshot", port: browser },
    browser_act: browser === undefined ? null : { tool: "browser_act", port: browser },
    browser_screenshot:
      browser === undefined ? null : { tool: "browser_screenshot", port: browser },
    browser_console: browser === undefined ? null : { tool: "browser_console", port: browser },
    browser_acquire: hold === undefined ? null : { tool: "browser_acquire", port: hold },
    browser_release: hold === undefined ? null : { tool: "browser_release", port: hold },
    // The one arm that reads the bundle instead of a port, and the one binding
    // that carries nothing: see `RuntimeToolBundle.todoWrite` for why a todo
    // list has no port to be answered by.
    todo_write: spec.tools.todoWrite === true ? { tool: "todo_write" } : null,
    shell_start: shell === undefined ? null : { tool: "shell_start", port: shell },
    shell_output: shell === undefined ? null : { tool: "shell_output", port: shell },
    shell_kill: shell === undefined ? null : { tool: "shell_kill", port: shell },
  };
  const verbs = spec.tools.verbs ?? [];
  const callVerb = spec.callVerb;
  if (verbs.length > 0 && callVerb === undefined) {
    // Loudly, and at the boundary that builds the surface. A bundle naming a
    // verb the host cannot run is not a smaller surface — it is a Session whose
    // durable record says it holds a tool that was never offered, which is the
    // exact disagreement `sessionToolIds` exists to make unrepresentable.
    throw new Error(
      `This Session's bundle names ${verbs.join(", ")}, but no verb port is wired to answer it.`,
    );
  }
  return [
    ...spec.tools.tools.map((tool): SessionToolBinding => ({ tool })),
    ...NON_CODING_TOOL_IDS.flatMap((tool) => wired[tool] ?? []),
    ...verbs.map((verb): SessionToolBinding => ({
      tool: verb,
      verb,
      port: callVerb as NonNullable<typeof callVerb>,
    })),
  ];
}

/**
 * The same surface as names alone — what a durable {@link AuthoritySnapshot}
 * records, and what a Role bundle and a rule pack would spell.
 */
export function sessionToolIds(spec: SessionToolSpec): SessionToolId[] {
  return sessionToolBindings(spec).map((binding) => binding.tool);
}

/**
 * Sanitized failure surfaced through observations. Never contains secrets.
 *
 * `reasoning` is a provider refusing the conversation's own earlier reasoning:
 * a `thinking` block whose signature no longer matches what was sent before
 * it (Claude's preserved thinking), or one the provider says was modified. It
 * is its own reason because it has its own repair — drop the reasoning and
 * send the turn again — and because re-sending the same request never clears
 * it, so it must not be mistaken for a transport fault worth retrying as is.
 */
export interface RuntimeFailure {
  reason: "auth" | "configuration" | "context" | "reasoning" | "model" | "aborted" | "unknown";
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
  | CompactionProgressObservation
  | CompactionObservation
  | ProviderReasoningDroppedObservation
  | TranscriptDeltaObservation
  | SettledMessageObservation
  | UsageObservation
  | RuntimeActivityObservation
  | AuthorityObservation
  | AttentionObservation
  | InteractionObservation;

/**
 * Why a provider dropped reasoning this runtime had sent it.
 *
 * Volli's own words for Anthropic's `input_transformations` entries, spelled
 * out rather than passed through: the provider's vocabulary is not ours to
 * leak into durable history or telemetry, and a type it adds later must land
 * as `unknown` rather than as a new string nobody has read. The same rule
 * `ATTEMPT_STOP_REASONS` follows, for the same reason.
 *
 * - `prefix-mismatch` — the block was bound to a prefix that has since changed.
 *   This is the one that means Volli edited history: something before the block
 *   is not the bytes it was signed against.
 * - `model-mismatch` — the block was written by a model that cannot read it
 *   back. A server-side fallback does this with nobody touching the picker.
 * - `unknown` — a transformation type this build has no word for.
 */
export const REASONING_DROP_CAUSES = ["prefix-mismatch", "model-mismatch", "unknown"] as const;

export type ReasoningDropCause = (typeof REASONING_DROP_CAUSES)[number];

/**
 * The provider silently dropped reasoning from the request this turn sent.
 *
 * Under the thinking-binding beta a mismatched `thinking` block is no longer a
 * 400 — it is dropped, the request succeeds, and the only trace is a top-level
 * `input_transformations` array that pi-ai records as a diagnostic on the
 * assistant message. So this is the ONLY way a person can learn that the model
 * answered them without the reasoning it had built up (VC-254).
 *
 * Not an {@link AttentionObservation}: nothing is blocked, no action clears it,
 * and the turn it describes completed normally. It is a fact about the turn,
 * closer to a compaction than to a failure — which is also why it carries a
 * `turnId` and is reported at most once per turn however many blocks went.
 *
 * `paths` are the provider's structural pointers (`messages.1.content.0`), kept
 * because they are what makes a report actionable when someone diffs two
 * request bodies. They name positions, never content.
 */
export interface ProviderReasoningDroppedObservation {
  kind: "provider-reasoning-dropped";
  turnId: string;
  /** How many blocks the provider dropped across every request in this Turn. Always at least one. */
  count: number;
  /** Every distinct cause in this Turn's transformations, in Volli's words. */
  causes: readonly ReasoningDropCause[];
  /** Every distinct provider structural pointer to what it dropped. */
  paths: readonly string[];
  occurredAt?: number;
  recoveryCursor?: string;
}

/**
 * The Session's authority decided whether one tool call could run.
 *
 * A denial is durable Session history, so it keeps the model-visible tool and
 * reason for the normal translation path. An allowance is observability-only:
 * the runtime reduces it straight to the metadata side channel rather than
 * making a durable fact or waiting on the Session observer. `toolCallId` is an
 * opaque local join key for that reducer; it must never leave it.
 */
export type AuthorityObservation =
  | {
      kind: "authority";
      state: "allowed";
      /** Null before the first turn opens, which a decision need not wait for. */
      turnId: string | null;
      /** Pi's local tool-call id, used only to join a wait to its activity. */
      toolCallId?: string;
      /** Time waiting for a person, when the authority gate measured it. */
      waitDurationMs?: number;
      occurredAt?: number;
    }
  | {
      kind: "authority";
      state: "denied";
      /** Null before the first turn opens, which a refusal need not wait for. */
      turnId: string | null;
      /** Pi's local tool-call id, used only to join a wait to its activity. */
      toolCallId?: string;
      /** Time waiting for a person, when the authority gate measured it. */
      waitDurationMs?: number;
      tool: string;
      cause: AuthorityDenialCause;
      reason: string;
      occurredAt?: number;
    };

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
 * The executor is currently preparing a context summary.
 *
 * This is deliberately transient. A summary that lands or fails has its own
 * durable {@link CompactionObservation}; this only lets a live Session say why
 * it is briefly not producing a reply. Keeping it out of recovery prevents a
 * restarted attachment from reviving a spinner for work that was interrupted.
 */
export interface CompactionProgressObservation {
  kind: "compaction-progress";
  state: "started" | "finished";
  reason: CompactionReason;
  occurredAt?: number;
}

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

/**
 * One model operation was metered.
 *
 * Deliberately not folded into {@link SettledMessageObservation}, and the split
 * is the point. A settled message is a message worth showing; a metered
 * operation is money worth counting, and most agentic spend is the second
 * without being the first — a reply that only called tools, a reply that failed
 * after its prompt had been billed, a Context Compaction, a utility completion
 * with no transcript at all. Usage carried on the settled arm could only ever
 * report the fraction of a turn that happened to say something out loud.
 *
 * `entryId` is the executor's own durable identity for the operation, and it is
 * what the durable fact is named after. A counter would re-mint a different id
 * on every replay and give the ledger a second copy of a bill it already has.
 */
export interface UsageObservation {
  kind: "usage";
  /** The executor's durable entry identity for the operation that spent this. */
  entryId: string;
  /** Null for spend outside a turn: compaction, and utility work. */
  turnId: string | null;
  usage: SessionUsage;
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
    /**
     * Typed resources delivered beside this message. The runtime frames them
     * after the user's text and retains their identity so compaction can
     * restore exact instructions instead of trusting a generated summary.
     */
    resources?: readonly PromptResource[],
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
  /**
   * The caller's deadline. Background work has no one waiting on it, so a
   * provider that never answers must not leave a promise pending for the life
   * of the process.
   */
  signal?: AbortSignal;
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
   * Run one utility completion and resolve its text and what it consumed.
   * Throws when the model is not one this runtime holds or the call failed; a
   * caller that cannot afford the throw (a title that keeps its heuristic)
   * catches and logs.
   *
   * A failure that was nonetheless BILLED throws a
   * {@link UtilityCompletionError} carrying its usage, so the caller can record
   * the spend it owes even though it got nothing for it.
   */
  completeUtility(input: UtilityCompletion): Promise<UtilityCompletionResult>;
}

/**
 * What a utility completion produced, and what it cost.
 *
 * Usage rides back with the text rather than being dropped, because this is
 * real spend on a real Session and it produces no transcript to carry it. A
 * caller that keeps the answer and a caller that discards it owe the same
 * bill: the provider charged for the call, not for the decision made after it.
 *
 * `usage` is null when the executor metered nothing — never a zero.
 */
export interface UtilityCompletionResult {
  text: string;
  usage: SessionUsage | null;
}

/**
 * A utility completion that produced no usable answer, carrying what it cost
 * anyway.
 *
 * THE FAILURE IS THE CASE THAT MOST NEEDS THIS. A provider bills for the prompt
 * it accepted, not for the answer Volli could use: a reply that stopped on a
 * length limit, a refusal, a model that returned nothing but a reasoning span.
 * Every one of those is a real charge, and every one of them reaches the caller
 * as a thrown error. A runtime that threw before reading `message.usage` would
 * make failed background work the one kind of spend a Session could never
 * account for — and the auto-titler retries, so the same Session can be billed
 * repeatedly for calls that leave no trace at all.
 *
 * `usage` is null when the call failed BEFORE anything was metered (an unknown
 * model, a transport that never connected). Null is "nothing was billed as far
 * as we can tell", never "free".
 */
export class UtilityCompletionError extends Error {
  readonly usage: SessionUsage | null;

  constructor(message: string, usage: SessionUsage | null) {
    super(message);
    this.name = "UtilityCompletionError";
    this.usage = usage;
  }
}
