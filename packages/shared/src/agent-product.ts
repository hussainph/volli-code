import type { SessionRole } from "./agent-runtime";
import { AGENT_ERROR_CODES } from "./agent-surface";
import type { AgentError, AgentErrorCode } from "./agent-surface";

/** The source revision owner-approved as the beginning of the agent capability record. */
export const AGENT_CAPABILITY_BASELINE = "8e8a17c0";

/** Identity embedded in one built CLI bundle. Release versions remain promotion markers. */
export interface AgentBuildIdentity {
  /** The private package version of the CLI bundle. */
  cliVersion: string;
  /** The promoted desktop release marker from the source tree that built this CLI. */
  releaseVersion: string;
  /** Git source revision, including an explicit dirty suffix when applicable. */
  sourceRevision: string;
  /** Per-build identity. Two local builds of one revision must not rely on semver to differ. */
  buildId: string;
}

/** Optional live app facts used by local help without making the app a help dependency. */
export interface AgentHelpRuntime {
  appVersion: string | null;
  surface: AgentHelpSurface | null;
  /** Why no resolved surface could be read. Null when the caller is outside a Session. */
  surfaceUnknownReason: string | null;
}

/** The Role and ordered Agent Tool Surface frozen on one durable Session. */
export interface AgentHelpSurface {
  sessionId: string;
  role: SessionRole;
  tools: readonly string[];
}

export interface AgentConceptSection {
  heading: string;
  paragraphs: readonly string[];
  bullets?: readonly string[];
}

/**
 * The canonical five-minute operating-model primer. CLI help, the managed skill
 * pack, and the docs site project this data rather than maintaining prose copies.
 */
export const AGENT_CONCEPT_SECTIONS: readonly AgentConceptSection[] = [
  {
    heading: "Session identity and attachments",
    paragraphs: [
      "A Session is the durable identity and locally ordered history of one agentic conversation. Volli creates the Session before an executor attaches. The Session outlives a terminal pane, a structured-chat runtime, a model turn, and a restarted attachment. Reconnect and recovery can replace the live attachment without creating a different Session.",
      "Structured chat and terminal are venues or attachments, not separate Session types. A Session Role states the product scope: project, ticket, or subagent. Role controls context, the frozen Agent Tool Surface, and future authority policy; it is not the name of the UI or process attached to the Session.",
    ],
  },
  {
    heading: "Chats, kickoff doors, and first turns",
    paragraphs: [
      "A plain chat created in the app is durable immediately and attaches in the background. It sends no model turn until a person submits the first message. A kickoff door creates or resolves the Session and submits an opening turn immediately. The opening turn is the difference; neither door creates a second kind of Session.",
      "The app action Create & start is a composed human action. It creates a Ticket in Doing and starts a Session with a kickoff turn. The individual verbs stay independent so automation cannot acquire hidden consequences.",
    ],
    bullets: [
      "ticket.move changes the board and starts no Session.",
      "ticket.create --status doing creates a Ticket in Doing and starts no Session.",
      "session.start starts a Session and does not move or create a Ticket.",
      "session.done and session.blocked record Session signals and do not move the board.",
    ],
  },
  {
    heading: "Tickets, worktrees, and Project Sessions",
    paragraphs: [
      "A worktree-scoped Ticket records the intent to use isolation before a checkout exists. Volli materializes or reuses the Ticket worktree when work starts. Ending a Session does not remove the checkout. Archiving a Ticket preserves its worktree; later retention or an explicit app action can remove disposable checkout state while the retained branch remains the source for recreation.",
      "A Project Session runs on the Main checkout, the project folder the person added to Volli. It has no Ticket worktree and no board effect. A Ticket configured without worktree isolation also runs on the Main checkout, but it remains a Ticket Session because Role and work location answer different questions.",
    ],
  },
  {
    heading: "Board state, Session signals, and human effects",
    paragraphs: [
      "Ticket state and Session state are separate ledgers. A Ticket comment appears in the Ticket activity feed. A Ticket move changes the board. A Session signal appears on that Session and can raise attention. Each write documents where a person sees the result and the important actions it does not imply.",
      "notify calls Electron's native Notification API. It raises a native macOS notification, not an in-app Sonner toast. A Session start received through the agent path raises an actionable in-app toast with Open session. It does not steal focus or navigate until the person uses that action.",
    ],
  },
  {
    heading: "Actors and the socket boundary",
    paragraphs: [
      "An Actor is user, session, automation, or unauthenticated. The app derives attribution from the door a mutation arrived through; callers never declare themselves. Ticket events keep that attribution and may cite the originating Session.",
      "The local socket authenticates a Session by a per-attachment token, exported into that Session's environment beside VOLLI_SESSION. A caller with no valid token is the unauthenticated Actor: never the user, and never the Session it names. Its default posture is reads only, and what it may write beyond that is per-project policy a person sets in the app.",
      "Scope that claim honestly. The token defeats an injected string and cross-session confusion; it does not defeat a hostile process running as the signed-in macOS user, which can read the token out of any environment it can see. That is precisely why the control tier is absent from the socket rather than gated on the token: a named tool call is bound to the attachment that made it and never crosses a socket, so there is no credential to steal.",
    ],
  },
  {
    heading: "The three product surfaces",
    paragraphs: [
      "The Agent CLI is the shell-composable discovery and coordination surface. It carries reads and low-risk writes that are visible, attributable, and reversible. The Agent Tool Surface is the ordered set of named tools frozen into one Session's Role bundle. Tool availability is enforcement: a tool-only verb is absent from shell execution because the Role was or was not handed that capability, not because the operation does not exist. The app is the attended human surface for navigation, decisions, curation, and visible outcomes.",
      "Every agent-facing operation has one Verb Registry key everywhere, and that key is its identity: help, authority, a Role bundle, and a Session's durable frozen tool list all spell it. Only the surface spelling changes. For example, session.start renders as volli session start in shell syntax, and reaches a model as the named tool session_start, because no model provider accepts a dot in a tool name. The two are one verb with one handler, not two capabilities. Help names the right door. A wrong-door refusal redirects to that door; a no-door refusal means this build declares no such verb.",
    ],
  },
  {
    heading: "Derived Verb Tiers",
    paragraphs: [
      "A Verb Tier is derived from a registry entry's access modes and actor requirement. It is not a risk label stored beside the verb. Read tier means Agent CLI access for any local caller. Coordination tier means an Agent CLI write attributed to a Session actor. Control tier means a Role-gated named tool that is absent from the agent socket. A verb on no agent surface has no tier.",
      "Inside a resolved Session, help reports the Role and the exact frozen Agent Tool Surface the app recorded. If the app is stopped, the Session is stale, or this build cannot supply that read, static help still works and says availability is unknown. It never rebuilds bundle membership from current Settings or prompt prose.",
    ],
  },
  {
    heading: "Attended runtime",
    paragraphs: [
      "Volli's structured Agent Runtime is attended. The desktop app owns its local model loop, durable Session writes, notifications, and actionable UI. Closing or failing to start that runtime does not create a headless fallback. A command that requires it returns APP_UNREACHABLE; the safe recovery is to launch the app and retry once.",
      "Web Access is optional and may be absent from a Session's frozen tools. The managed Volli skill pack carries this operating model locally, so an agent never needs web access to discover how Volli works. The bundled volli help output remains the live authority if a managed file was user-edited and became stale.",
    ],
  },
];

export interface AgentCapabilityChange {
  /** The prior source identity this capability entry follows. */
  baseline: string;
  /** Identity of the first source bundle that serves the entry. */
  build: string;
  added: readonly string[];
  changed: readonly string[];
  fixed: readonly string[];
  removed: readonly string[];
}

/** Newest-first agent capability record. It intentionally has no pre-baseline backfill. */
export const AGENT_CAPABILITY_CHANGES: readonly AgentCapabilityChange[] = [
  {
    baseline: "VC-163",
    build: "VC-185",
    added: [
      "volli worktree sync [<id>] — merge a ticket's base branch into its worktree branch and report what happened. Coordination tier: an authenticated Session, on the Agent CLI. It never waits on a gate, a check, or CI; it merges, reports, and returns.",
      "A conflicted sync is an outcome rather than a refusal: status reads conflicted, every conflicted path is listed, and the worktree is left conflicted for the Session to resolve. Branch on status, not on the exit code.",
      "volli worktree sync <id> --abort — the documented way out of a conflicted sync, on the same verb so the exit is discoverable from the entrance. Nothing else cleans up after a conflict.",
      "volli conflicts — the file-collision radar: which active ticket worktrees touch the same paths, as a per-path list and a worst-first list of colliding ticket pairs. Read tier, any caller, --json like every other read.",
    ],
    changed: [
      "Sync contacts no remote. It merges the base ref this checkout already has — origin/<base> when a fetch has landed one, the local base branch otherwise — so no credential is used and nothing can block on one.",
      "Sync runs local Git asynchronously behind a hard deadline, so a hung hook, signing helper, or filter cannot freeze Electron main or wait forever. A hook failure that leaves a merge in flight names --abort recovery.",
      "conflicts now compares each worktree's complete Change Set (committed, staged, unstaged, and untracked paths versus its base) and keeps each project's matrix separate.",
      "An authenticated Session may run worktree.sync by default, on the same grounds as its other coordination verbs: the merge is already inside the ambient authority its own execute tool reaches.",
    ],
    fixed: [],
    removed: [],
  },
  {
    baseline: "VC-162",
    build: "VC-163",
    added: [
      "Per-attachment session tokens. Volli mints one when it spawns a Session's terminal or attachment and exports it as VOLLI_SESSION_TOKEN; the socket verifies it. A Session now authenticates itself instead of announcing itself.",
      "The unauthenticated Actor, for a socket caller Volli cannot identify. It may read the board and, by default, write nothing — a posture a person can widen per project, per verb.",
      "FORBIDDEN_ACTOR (exit class 1), the refusal for a caller the project's policy does not let run a verb. Distinct from WRONG_DOOR, which is about the surface rather than the caller.",
    ],
    changed: [
      "No environment variable is read as the user any more. An absent or forged VOLLI_SESSION resolves to the unauthenticated Actor rather than to the highest-trust Actor in the system.",
      "Coordination-tier verbs — ticket create/update/move/comment, notify, session done/blocked/link/harness, hook — require an authenticated Session unless a project grants them more widely.",
      "ticket.comment stamps its comment row from the authenticated Actor rather than from raw VOLLI_SESSION, so a comment can no longer cite a Session that did not write it.",
      "Command detail no longer prints shell usage, argv options, or a copyable example for a verb the shell does not execute. A tool-only verb shows its callable name and input fields instead; an app-only verb names the app.",
    ],
    fixed: [],
    removed: [
      "session.start left the Agent CLI. It is control tier now: the named session_start tool in the project Role's bundle is the agent path, and the app is the human one. Typing it in a shell answers WRONG_DOOR and starts nothing.",
      "ticket.archive left every agent surface. Archiving is app-only curation; no Role bundle carries it and no CLI access mode projects it. Help still names it, so a wrong door stays distinguishable from no door.",
    ],
  },
  {
    baseline: "VC-91",
    build: "VC-162",
    added: [
      "A Role-scoped Agent Tool Surface: the named tools a Session holds are now resolved from its Role at creation, not handed identically to every Session.",
      "session_start as a named tool in the project Role's bundle. A Project Session can start a Ticket Session without touching the agent socket; the calling Session and its project are bound by Volli from the attachment, so the tool takes a ticket and nothing about the caller.",
      "A SESSION TOOLS block in every Session's first message, naming the Volli verbs that Session holds under their callable names, and stating that what is absent will not become available mid-Session.",
    ],
    changed: [
      "session.start gained the named session_start tool on the Agent Tool Surface beside its Agent CLI door. One registry key, one handler, two doors — its verb tier stayed coordination while the CLI door remained open. VC-163 then closed that door; see the entry above.",
      "A Session's frozen tool surface can now name Verb Registry keys alongside coding and interaction tools. The durable record spells the dot-key; only the provider wire uses the underscored form.",
      "A Ticket Session's tool array contains no agent-control tool, and cannot acquire one while it runs. Availability is decided once, when the Session is created.",
    ],
    fixed: [],
    removed: [],
  },
  {
    baseline: AGENT_CAPABILITY_BASELINE,
    build: "VC-91",
    added: [
      "volli help concepts and volli help changes as app-independent local topics.",
      "Structured human-visible effects and explicit non-effects in command detail.",
      "--dry-run previews for ticket create/update/move/comment, Session done/blocked/link, notify, and doctor --fix. The shared dryRun tool contract is ready for session.start when VC-162 supplies its tool seam.",
      "A preview is refused up front unless the running app declares the preview contract on a context-free identify probe, so --dry-run can never execute as a real write on an older app build, and never inherits a Project or Session refusal the verb itself did not need.",
      "An app-side refusal when a verb declares no preview at all, so a dryRun argument built outside the bundled CLI cannot be ignored on the way to a real write.",
      "Structured JSON error reason and next fields while stable error codes remain unchanged.",
    ],
    changed: [
      "Help discovers all declared Verb Registry doors and can report a resolved Session's frozen Agent Tool Surface.",
      "Managed Volli skill files and the docs site project the same concepts, effects, recovery, and capability data.",
    ],
    fixed: [
      "Unknown help paths now fail with valid commands and topics instead of silently returning bare help.",
      "A declared tool-only verb reached through the shell is a wrong-door refusal, distinct from an undeclared no-door name.",
    ],
    removed: [],
  },
];

export const HELP_TOPIC_NAMES = [
  "concepts",
  "changes",
  "exit-codes",
  "addressing",
  "json",
  "orchestration",
] as const;

export type HelpTopicName = (typeof HELP_TOPIC_NAMES)[number];

export interface ErrorRecoveryGuidance {
  /** Why this stable class exists, suitable for local reference docs. */
  why: string;
  /** One safe action, or null when Volli lacks enough outcome evidence to name one. */
  next: string | null;
}

/** Shared recovery policy for CLI rendering, managed docs, and docs-site projection. */
export const ERROR_RECOVERY: Readonly<Record<AgentErrorCode, ErrorRecoveryGuidance>> = {
  USAGE: {
    why: "The typed arguments do not match this verb's declared syntax.",
    next: "Run `volli help <command>` and retry with the documented arguments.",
  },
  INVALID_REQUEST: {
    why: "The request reached its verb but one value or value combination is invalid.",
    next: "Read `volli help <command>`, correct the named value, and retry.",
  },
  UNSUPPORTED_COMMAND: {
    why: "This build declares no verb matching the typed name.",
    next: "Run `volli help` and choose one of the commands or topics it lists.",
  },
  WRONG_DOOR: {
    why: "The verb exists, but the shell is not the surface that executes it.",
    next: "Use the surface named in the refusal; if Role availability is unknown, inspect the Session Runtime Brief or `volli help <verb>` first.",
  },
  FORBIDDEN_ACTOR: {
    why: "The verb is on this surface, and this caller is not one the project's policy lets run it. Coordination-tier verbs want an authenticated Volli Session; a process that merely runs as your user is not one.",
    next: "Run the command from inside a Volli Session. If you already are, the project's per-actor policy withholds this verb and only a person can widen it in Settings — do not work around the refusal.",
  },
  APP_UNREACHABLE: {
    why: "The local desktop host or one of its required runtimes could not answer.",
    next: "Run `volli app launch`, wait for readiness, then retry the same command once.",
  },
  DB_UNAVAILABLE: {
    why: "The app could not open the durable local database.",
    next: "Open the Volli app and inspect its database error before retrying the command.",
  },
  PROJECT_REQUIRED: {
    why: "The verb needs a Project, but the context ladder resolved none.",
    next: "Pass `--project <name|prefix|path>` or run from a registered Project directory.",
  },
  PROJECT_NOT_FOUND: {
    why: "The selected Project no longer exists or does not match a registered Project.",
    next: "Run `volli project list`, then retry with a printed Project name, prefix, or path.",
  },
  AMBIGUOUS_PROJECT: {
    why: "More than one registered Project matches the selector.",
    next: "Retry with the exact Project path printed in the refusal.",
  },
  TICKET_NOT_FOUND: {
    why: "No live Ticket matches the supplied Display ID in the resolved Project context.",
    next: "Run `volli ticket list` in the intended Project and retry with a printed Display ID.",
  },
  AMBIGUOUS_TICKET: {
    why: "The Display ID matches Tickets in more than one Project.",
    next: "Resolve the intended Project explicitly, then retry the Ticket verb.",
  },
  SESSION_NOT_FOUND: {
    why: "The supplied or attributed Session identity is stale, missing, or unresolved.",
    next: "Run `volli session list` and use a current printed handle; for current-Session verbs, start from a live Volli Session.",
  },
  AMBIGUOUS_CONTEXT: {
    why: "The context ladder found more than one equally valid target.",
    next: "Pass the exact Project or Ticket selector requested by the refusal.",
  },
  CONTEXT_REQUIRED: {
    why: "The verb needs Project, Ticket, or Session context that no safe fallback can infer.",
    next: "Run `volli identify`, then supply the missing explicit selector or use a live Volli Session.",
  },
  CONTEXT_MISMATCH: {
    why: "Explicit context conflicts with the Session or directory context Volli resolved.",
    next: "Run `volli identify` and retry from the intended Session or with matching explicit context.",
  },
  BODY_MATCH_FAILED: {
    why: "An exact Ticket Body edit found zero or multiple matches, so applying it could clobber newer prose.",
    next: "Read the fresh Ticket Body, choose text that appears exactly once, and retry the edit.",
  },
  INVALID_COLUMN: {
    why: "The supplied board column is outside the accepted column vocabulary.",
    next: "Use a column named in the refusal or in `volli help ticket move`.",
  },
  INVALID_PRIORITY: {
    why: "The supplied priority is outside the accepted priority vocabulary.",
    next: "Use `low`, `medium`, or `high` and retry.",
  },
  ARCHIVED_TICKET: {
    why: "The target Ticket is archived, so ordinary Ticket mutations are closed.",
    next: "Open the Ticket in the app and restore it before retrying, or choose a live Ticket.",
  },
  SESSION_ENDED: {
    why: "The target Session attachment has ended and cannot accept this live mutation.",
    next: "Open or start a live Session, then repeat the action against that Session.",
  },
  MODEL_REQUIRED: {
    why: "No runnable default model or explicit model was available for Session start.",
    next: "Configure a default in Model Access or pass a model printed by `volli model list`.",
  },
  MODEL_UNAVAILABLE: {
    why: "The requested model, provider sign-in, or reasoning level is not runnable now.",
    next: "Run `volli model list`, then retry with an available printed model and reasoning level.",
  },
  PREFIX_CONFLICT: {
    why: "A Project ticket prefix conflicts with another registered Project.",
    next: "Resolve the duplicate prefix in Project Settings before retrying.",
  },
  FILE_READ_FAILED: {
    why: "A CLI file argument could not be read safely before the request was sent.",
    next: "Check the named path and permissions, or pass the content inline, then retry.",
  },
  MUTATION_FAILED: {
    why: "The operation failed without enough durable outcome evidence for an automatic retry.",
    next: null,
  },
  SOCKET_PROTOCOL: {
    why: "The CLI connected to the app but the versioned request or response exchange was invalid.",
    next: "Run `volli help changes` and confirm the CLI bundle and running app come from a compatible build before retrying.",
  },
  TIMEOUT: {
    why: "The app accepted the connection but did not produce an outcome within the command's bound.",
    next: "Inspect the current Ticket or Session state before deciding whether one retry is safe.",
  },
};

// Compile-time exhaustiveness beside the runtime test. A code added without
// recovery guidance fails here even before the test suite starts.
void (ERROR_RECOVERY satisfies Record<(typeof AGENT_ERROR_CODES)[number], ErrorRecoveryGuidance>);

const UNKNOWN_RECOVERY_EVIDENCE =
  "Volli lacks enough durable outcome evidence to name a safe retry.";

/** Creates the stable structured refusal used on both sides of the socket. */
export function makeAgentError(
  code: AgentErrorCode,
  message: string,
  next: string | null = ERROR_RECOVERY[code].next,
): AgentError {
  const reason = next === null ? `${message} ${UNKNOWN_RECOVERY_EVIDENCE}` : message;
  return { code, message, reason, next };
}
