/**
 * What every agent verb is handed: the service state a handler may reach, and
 * the request-scoped snapshot the dispatch resolved before calling it (VC-167).
 *
 * The dispatch used to be one `execute` closure, and this is the state it
 * closed over — the project list, the Session projections, the `VOLLI_SESSION`
 * identity, the per-Session harness watermarks and the terminal update locks.
 * Handlers now take it as an argument, so what a verb can reach is legible at
 * its signature instead of being whatever happened to be in scope.
 *
 * The Session snapshot half is deliberately not resolved here (VC-403):
 * {@link AgentCommandContext.loadProjections} and
 * {@link AgentCommandContext.loadSessions} fold every project's Sessions only
 * when a handler actually calls one of them, and share one memo when a
 * handler calls both (or calls one twice) — so a verb that never asks pays
 * nothing, automatically, rather than by a policy declared per verb. The
 * `VOLLI_SESSION` identity lookup is still declared per verb in `table.ts`
 * (`envSession`), because which of two lookups a verb wants — the identity or
 * its own terminal record — is a real per-verb choice the fold's laziness does
 * not make for it.
 */

import type Database from "better-sqlite3";
import type { SessionEngine, SessionTranscriptArtifact } from "@volli/session-engine";
import { makeAgentError } from "@volli/shared";
import type {
  AgentErrorCode,
  AgentRequest,
  AgentResponse,
  AuthorityPolicy,
  DoctorFacts,
  HarnessId,
  ModelAccessSnapshot,
  Project,
  PromptResource,
  SessionActivityState,
  SessionProjection,
  SessionRecord,
  SessionRole,
  SessionEnvRepair,
  SessionEnvReport,
  TicketEventActor,
  TranscriptReference,
} from "@volli/shared";
import type { DataChangedEvent, HarnessEventNotice, SessionHarnessNotice } from "@volli/shared";

import type { NotificationOutcome, NotificationRequest } from "@volli/shared";
import type { HandlerPolicy, HostHandlerMap } from "../handlers/handler-map";
import type { RunGitAsync } from "../worktree";
import type { WorktreeReadService } from "../worktree-reads";
import type { VerifyOperatorToken } from "./resolution";

export interface AgentCommandServiceOptions {
  /** Runner for host-issued Session facts; desktop keeps local. */
  venue?: import("@volli/shared").RunnerIdentity;
  db: Database.Database;
  /** The app composition root's one durable Session Engine. */
  sessionEngine: SessionEngine;
  appVersion: string;
  now?: () => number;
  newId?: () => string;
  /**
   * The git runner the worktree verbs this service runs itself (`worktree
   * sync`, the collision scan) execute through — the non-blocking one. All git
   * calls stay inside the worktree module (CONCEPT #42); this seam only lets
   * tests substitute a scripted runner. Defaults to {@link runGitCapturingAsync}.
   * There is no synchronous runner here, so a verb cannot put a git child back
   * onto Electron main's thread (VC-786). `worktree status` and `worktree diff`
   * read through {@link worktreeReads} and its own runner; this one reaches them
   * only through the default service built when that is omitted.
   */
  gitAsync?: RunGitAsync;
  /**
   * Whether a ticket's stamped worktree directory still exists on disk (C3):
   * threaded into the worktree read verbs' disk-existence seam so a stamped-
   * but-deleted directory refuses with INVALID_REQUEST rather than letting
   * status.ts's errs-dirty fallback report `uncommitted: true` for a tree that's
   * gone. The same kind of seam as {@link gitAsync} — defaults to {@link existsSync}; tests
   * substitute a scripted predicate. Like {@link gitAsync}, it reaches `worktree
   * status` / `worktree diff` only through the default {@link worktreeReads}.
   */
  worktreeExists?: (path: string) => boolean;
  /**
   * The host's worktree read service (VC-788): `worktree status` and
   * `worktree diff` read through the same snapshot and coalescers every other
   * door does. The host compositions pass their own (`HostAgentCommandOptions`
   * requires it); absent, the service builds a private one over
   * {@link gitAsync} and {@link worktreeExists} — a suite's isolated host.
   */
  worktreeReads?: WorktreeReadService;
  observeSession?: (
    sessionId: string,
    lines: number,
  ) => { status: SessionActivityState; output: string } | undefined;
  /**
   * Reads one durable transcript artifact — what `session peek` renders a chat
   * Session's tail from (VC-79). The store is a content-addressed directory and
   * needs neither the db nor a live runtime, so production always has one;
   * absent (tests) means the peek answers with its activity counts and no
   * transcript rather than failing.
   */
  readTranscriptArtifact?: (reference: TranscriptReference) => Promise<SessionTranscriptArtifact>;
  /**
   * The one delivery path (VC-295). Three verbs reach it and each names its own
   * producer: a verified harness `input.needed` hook (`needs-you`, and it opens
   * the Session), an unattended move into Doing (operational — a guardrail a
   * preference must not be able to hide, opening the ticket), and `volli notify`
   * (operational and free-form, so it opens nothing).
   */
  notify?: (request: NotificationRequest) => NotificationOutcome;
  /**
   * The Model Access snapshot read `model.list` serves (VC-78) — the same
   * `inspectPiModelAccess` seam every app surface reads, threaded in the way
   * {@link sessions} is so no parallel provider probe can grow here. Absent
   * means the Pi runtime never came up this launch, which the verb reports as
   * retryable APP_UNREACHABLE. The snapshot is structurally secret-free
   * (`ModelAccessSnapshot` has no credential field), so passing it through is
   * what keeps this verb's output credential-free.
   */
  inspectModelAccess?: (input: { signal: AbortSignal }) => Promise<ModelAccessSnapshot>;
  /**
   * How long `model.list` waits on the snapshot before answering TIMEOUT.
   * Bounded below the CLI's own 10s socket deadline so a hung provider probe
   * (VC-61's live pain — the sequential inspect loop has no per-probe bound
   * yet) surfaces as this verb's legible TIMEOUT rather than the socket's.
   * A seam only so tests need not wait out the real bound.
   */
  modelAccessTimeoutMs?: number;
  /**
   * The `env` block `volli identify` reports (VC-94): the session's resolved
   * PATH, its provenance, the measured tools resolved against it and the
   * subset this project implies, and whether its dependencies are installed.
   * The cwd and its project root keep workspace walks inside the resolved
   * checkout. Injected because main is the only process that knows HOW the PATH
   * came to be — it ran the boot probe and owns the adoption outcome — and
   * absent (tests) means identify answers without an env block rather than
   * inventing one.
   */
  sessionEnv?: (cwd: string, projectRoot: string) => Promise<SessionEnvReport>;
  /**
   * This machine as a Volli Cloud runner (VC-895), as `volli identify`
   * reports it: its name and state, never its id or credential. Absent, or
   * `null` (not a runner this launch), means identify prints no runner line.
   */
  cloudRunner?: () => { readonly name: string | null; readonly state: string } | null;
  /**
   * The host's handler map (VC-668), which this door projects: every verb is
   * bound in `table.ts` as a projection of `handlers[key]`, never as a
   * handler of its own — a catalog command's under its key, the ticket
   * create, update and comment under the board's (VC-794), and every other
   * verb under its own key, whose entry this service serves into the map on
   * construction (VC-923, `agent-dispatch/verbs.ts`). A Done move's trim, its
   * interrupts and its armed arrival, and every projected board write's
   * receipt, feed rows and `data-changed`, therefore belong to the handler,
   * which the composition root built once for every door. The projection
   * invokes it only under {@link AgentCommandContext.handlerPolicy}. The
   * four Session reads are entries this service serves too (VC-894), which a
   * router also reaches, Workspace-scoped.
   */
  handlers: HostHandlerMap;
  /**
   * Called after a socket command with no map entry COMMITS a planning
   * mutation (a projected write announces through the map's own bus), with
   * the exact ticket it resolved and touched — the scope index.ts broadcasts as
   * `volli:data-changed` so the renderer refreshes the right surfaces promptly.
   * Never called for a read-only command or a no-op (e.g. a same-column
   * `ticket.move`). A ticketless Session mutation is project-scoped rather than
   * targeted, so every reader refreshes conservatively.
   * Absent (tests) means the broadcast is a no-op.
   */
  onMutation?: (change: Omit<DataChangedEvent, "entity">) => void;
  /**
   * Called for every canonical harness event this door ingests (harness-events),
   * after any session-record write it implies has committed — the notice
   * index.ts pushes to every window as `volli:harness-event`. Absent (tests)
   * means the fan-out is a no-op.
   */
  onHarnessEvent?: (notice: HarnessEventNotice) => void;
  /**
   * Called when a wrapper announce actually CHANGES which harness a session is
   * running — the notice index.ts pushes to every window as
   * `volli:session-harness`, so the sidebar's label and the session's harness
   * state move without waiting for a refetch. Never called for the ordinary
   * announce that agrees with what Volli already believes. Absent (tests) means
   * the fan-out is a no-op.
   */
  onSessionHarness?: (notice: SessionHarnessNotice) => void;
  /**
   * What only main can answer about the harness runtime — which wrappers it
   * wrote, where the shim is, what the shell integration looks like. Injected
   * rather than read here, because every one of these lives in the boot-time
   * runtime state and none of it belongs in this door. Absent (tests) makes
   * `doctor` report that it could not look.
   */
  doctorFacts?: () => Promise<DoctorFacts>;
  /**
   * Rebuilds the generated runtime and re-runs Session PATH adoption. Its
   * report gives `doctor --fix` evidence for the PATH new Sessions will get;
   * the calling Session's own observation remains intentionally unchanged.
   */
  doctorRepair?: () => Promise<SessionEnvRepair>;
  /**
   * Verifies a caller's `VOLLI_SESSION_TOKEN`, answering the Session id it
   * authenticates or `null` (VC-163).
   *
   * The composition root's `SessionTokenRegistry.verify`. A seam rather than a
   * direct import because the minting half belongs to the attachments — the
   * PTY manager and the Pi adapter — and only main's startup sees both sides.
   *
   * Absent means nothing can authenticate, so every socket caller resolves to
   * the unauthenticated actor: reads yes, coordination writes no. Fail-closed
   * by construction, which is what makes an unwired test a safe default rather
   * than an accidental grant.
   */
  verifySessionToken?: (token: string | undefined) => string | null;
  /**
   * Verifies a hostd-issued operator token (VC-623), answering who it was
   * issued for or `null`.
   *
   * Absent means this host accepts none — desktop, which issues none — so a
   * request carrying one is the unauthenticated actor, exactly as it would be
   * without it. Reached only by a request with no Session evidence at all
   * (`presentedOperatorToken`), so it can never change how a Session's request
   * is judged.
   */
  verifyOperatorToken?: VerifyOperatorToken;
  /**
   * How `project.add` detects a new project's base branch (VC-623). Defaults
   * to the same async detector the app's Add Project uses; tests script it.
   */
  detectBaseBranch?: (path: string) => Promise<string | null>;
  /**
   * Called once for every write an operator token was presented for, after it
   * was answered: who, which verb, and how it ended (VC-623). The host's audit
   * line. Never handed the token itself.
   */
  onOperatorWrite?: (record: OperatorWriteRecord) => void;
  /**
   * Reads one project's resolved authority policy for the admission gate
   * (VC-163).
   *
   * Defaults to this service's own database. Overridable so the gate can be
   * driven from a policy store that is not this SQLite file — which is what a
   * host serving the External Agent Surface will have — and so a test can state
   * a policy without writing a row.
   */
  readAuthorityPolicy?: (projectId: string) => AuthorityPolicy;
  /**
   * The board in Volli Cloud (VC-894): in a cloud launch, every verb whose
   * route is `cloud-board` (`cloud-agent/routes.ts`) is answered by the
   * backend through these instead of this host's SQLite board, after the
   * same identity and admission as today, with the token-verified Session as
   * the agent the backend acts for. Absent (every local launch), the
   * dispatch is exactly as before.
   *
   * Production: desktop main spreads the cloud product store's `agentCommands`
   * into `createHostAgentCommands`. The store composes `createCloudBoardVerbs`
   * over its Agent backend and forgets cached grants on attachment close/failure.
   */
  cloudBoardVerbs?: import("../cloud-agent/board-verbs").CloudBoardVerbs;
  /**
   * A cloud launch's Session verbs (VC-894 S6-3): after the same identity and
   * admission as today, a Session read or `notify` whose target is not
   * claimed here is answered by the backend for the token-verified Session;
   * `null` from its `socket` continues to this host's local answer, so a
   * target claimed here stays on this runner's ledger. Its presence also
   * hands a recorded `session done`/`blocked` todo comment to the backend's
   * accept fold, which derives it from the signal fact, rather than writing
   * it to this host's board. Absent (every local launch), the dispatch is
   * exactly as before.
   *
   * Production: desktop main passes the store's `agentCommands` to this socket
   * service; `createRunnerComposition` also passes its Session overlay to the
   * runtime's tool door. Session listing is always a backend read.
   */
  cloudSessionVerbs?: import("../cloud-agent/session-verbs").CloudSessionVerbs;
  /**
   * The projects this door's roster folds and resolves against, as machine
   * identity only (never board authority). Absent (every local launch): this
   * host's SQLite projects (`listProjects`). A cloud launch's store passes its
   * current owner's projects, whose shadow identities `listProjects` leaves
   * out.
   *
   * Production: the cloud product store's `agentCommands.projects` maps the
   * owner's `projectIds` through `getProjectById`; desktop main passes it here.
   */
  projects?: () => readonly Project[];
  /**
   * The skills index a fresh Session with no explicit skills would carry — the
   * SAME port `session start` composes through (`SessionSkillPorts.index` with
   * nothing injected), threaded in so `prompt baseline` prices the index a real
   * start would record rather than a reconstruction that could drift. `null`
   * means no index (no skills, unreadable tier): a real, smaller baseline.
   * Absent (tests, runtime never up) makes the command refuse rather than
   * report a baseline it knows is missing a section.
   */
  skillsIndex?: (projectId: string) => Promise<PromptResource | null>;
}

/** One operator write, as {@link AgentCommandServiceOptions.onOperatorWrite} reports it. */
export interface OperatorWriteRecord {
  /** The login the token was issued for. */
  readonly login: string;
  readonly cmd: string;
  readonly ok: boolean;
  /** The refusal's code when `ok` is false. */
  readonly code: AgentErrorCode | null;
}

export interface AgentCommandService {
  execute(request: AgentRequest): Promise<AgentResponse>;
}

/**
 * The identity `VOLLI_SESSION` names — enough to attribute a write and resolve
 * a project or ticket, and deliberately nothing about how the Session runs.
 * Resolved against the Session Engine itself, so a structured (chat) Session
 * answers exactly like a PTY one (VC-51); `terminalSessionRecord` stays the
 * door to terminal facts (cwd, harness, exit), which identity never carries.
 */
export interface EnvSessionIdentity {
  id: string;
  projectId: string;
  ticketId: string | null;
  /** The Session's own stated Role (VC-9), never read off `ticketId`. */
  role: SessionRole;
}

/**
 * A launch a wrapper minted a harness session id for, held until the harness
 * proves the launch happened (VC-807). Until then it is a promise, not a fact:
 * `claude --version` mints too, and never starts a session.
 */
export interface PendingHarnessLaunch {
  readonly harnessId: HarnessId;
  readonly harnessSessionId: string;
}

/**
 * The service state and request-scoped snapshot one verb handler runs against.
 *
 * `options` is the composition root verbatim, because most of what a handler
 * reaches for is an injected seam (`notify`, `onMutation`, `sessions`) that has
 * no default and reads best at its own name. The fields beside it are the ones
 * the service RESOLVED once at construction — a default applied, or a map it
 * owns — so a handler cannot accidentally use an unresolved `options.now`.
 *
 * A verb's handler is the map's entry for its key (VC-923,
 * `agent-dispatch/verbs.ts`), and this is the context that entry builds for
 * it, from the service's state and the request the door resolved
 * ({@link AgentVerbInput}). The door's own context adds its policy at the map
 * ({@link AgentCommandContext}).
 */
export interface AgentVerbContext {
  /** Everything the composition root injected. */
  readonly options: AgentCommandServiceOptions;
  /** {@link AgentCommandServiceOptions.now}, defaulted to `Date.now`. */
  readonly now: () => number;
  /** {@link AgentCommandServiceOptions.newId}, defaulted to `randomUUID`. */
  readonly newId: () => string;
  /** {@link AgentCommandServiceOptions.gitAsync}, defaulted to `runGitCapturingAsync`. */
  readonly gitAsync: RunGitAsync;
  /** {@link AgentCommandServiceOptions.worktreeExists}, defaulted to `existsSync`. */
  readonly worktreeExists: (path: string) => boolean;
  /** {@link AgentCommandServiceOptions.worktreeReads}, defaulted to a private service. */
  readonly worktreeReads: WorktreeReadService;
  /**
   * The app's one durable Session Engine. Lifted out of `options` because it
   * is a service rather than a seam: every verb that touches a Session reads
   * it, and none of them may substitute one.
   */
  readonly sessionEngine: SessionEngine;
  /**
   * The newest fire-time main has ingested per session — see
   * `createAgentCommandService`. Service-lived and mutable: the hook path reads
   * and writes it, and it must outlive the request that touched it.
   */
  readonly watermarks: Map<string, number>;
  /**
   * The per-Session read-modify-write locks the terminal native detail is
   * updated under. Service-lived for the same reason: two hooks racing on one
   * Session are exactly what it exists to serialize.
   */
  readonly terminalUpdateLocks: Map<string, Promise<void>>;
  /**
   * The launch each Session's wrapper last minted an id for and that has not
   * yet proved itself — see `sessionHarnessVerb`. Service-lived: the mint and
   * the startup hook that confirms it arrive on separate requests.
   */
  readonly pendingLaunches: Map<string, PendingHarnessLaunch>;
  /** Every registered project, listed once per request. */
  readonly projects: readonly Project[];
  /**
   * Every Session of every project — lazy and memoized (VC-403). Nothing is
   * folded until a handler actually calls this; a verb that never reads it
   * pays nothing, and a verb that calls it more than once (or calls
   * {@link loadSessions} too) still folds it exactly once. `loadSessions`
   * narrows the answer to the terminal rows.
   *
   * Previously an eager `projections` field the dispatch resolved for every
   * verb whose table entry did not opt out — that policy is gone; laziness now
   * makes the opt-out automatic for any verb that never calls this.
   */
  loadProjections(): Promise<readonly SessionProjection[]>;
  /**
   * The terminal half of {@link loadProjections}'s answer: the verbs that need
   * a PTY have nothing a structured-only Session can answer, and dropping it
   * there is correct, not a compatibility gap. Shares {@link loadProjections}'s
   * memo, so calling both costs one fold, not two.
   */
  loadSessions(): Promise<readonly SessionRecord[]>;
  /**
   * Who `VOLLI_SESSION` is, when the caller exported one and this verb's table
   * entry asks for it. `null` means no session env, an id that resolves to no
   * Session, or a verb that resolves its own.
   *
   * A CLAIM, resolved against the Session Engine. Whether the caller is
   * entitled to it is {@link actor}'s answer, not this one's — a forged
   * `VOLLI_SESSION` still resolves here, and still attributes as nobody.
   */
  readonly envSession: EnvSessionIdentity | null;
  /**
   * {@link envSession}'s own terminal record, resolved from the SAME
   * `getSession` call rather than the fleet fold (VC-403): `identify` is the
   * one caller, and it needs only this one Session's terminal facts (its
   * `cwd`), never the whole machine's. `null` when there is no `envSession`, or
   * its Session never opened a terminal (a structured Session's workspace is
   * its ticket's worktree instead — `identifyVerb` falls back to that).
   *
   * This is the SAME Session {@link envSession} names, and it cannot be any
   * other: `identify` used to find the terminal by searching the fleet for
   * `VOLLI_SESSION` while the rest of its answer described the DOOR's Session,
   * and the two agree by construction because `doorActor` refuses to reconcile
   * a token and a `VOLLI_SESSION` claim that disagree — it authenticates nobody
   * instead, so the fallback resolves the claim and both halves read the same
   * id. Dropping the fleet search is therefore purely the cost, never the
   * answer.
   */
  readonly envSessionTerminal: SessionRecord | null;
  /**
   * The Session this request's attachment token authenticated at the socket
   * door, or null when the caller presented no valid matching token. Kept
   * beside the raw env-session claim so diagnostics can report the same
   * liveness a coordination write would receive rather than treating a claim
   * as proof.
   */
  readonly authenticatedSessionId: string | null;
  /**
   * Who to ATTRIBUTE this caller's writes to, decided once by the dispatch
   * (VC-163).
   *
   * The authenticated session actor its token proves, `user` when a
   * hostd-issued operator token proves the person (VC-623, VC-92 §6.3's
   * amendment), or `unauthenticated`. Never `user` on absence: a socket call
   * without that proof cannot establish that a person made it, and attributing
   * one anyway is the grant-by-absence VC-92 §6.3 ruled dead.
   *
   * Handlers read this rather than deriving their own, so the actor a write is
   * ATTRIBUTED to is by construction the same actor the admission gate
   * ADMITTED. Two derivations could disagree, and the disagreement would be
   * invisible in exactly the case that matters — which is what it did, in
   * `ticket.comment`, until this field replaced a second read of raw env.
   *
   * `null` for a verb whose table entry skips identity resolution (`hook`,
   * `session.link`, `session.harness`). Those three resolve their own terminal
   * record and write no ticket history, so there is nothing here for them to
   * attribute — and `null` says that, where a defaulted `unauthenticated`
   * would have been a wrong answer rather than an absent one. Admission still
   * judged them: that runs off the token alone.
   */
  readonly actor: TicketEventActor | null;
}

/**
 * The request as the socket door resolved it, which is what a verb's map
 * entry is asked (VC-923): the wire request, and every request-scoped fact
 * of {@link AgentVerbContext} the door decided before admitting it — the
 * projects it listed, who `VOLLI_SESSION` names, who the token authenticated,
 * and the attribution. Plain data, no port: the entry builds the rest of its
 * context from the service's own state, so each door owes only these facts.
 *
 * The entry trusts these facts: identity reaches it here, as the door
 * resolved it, not through the call. That is safe because only the socket's
 * policy admits a socket verb's key (the catalog's refuse every agent key, the
 * tool door's admits only its own call's verb), and the socket resolved them
 * from a token it verified. The door's credentials themselves stay behind:
 * `request` reaches the entry without the attachment or operator token.
 */
export interface AgentVerbInput {
  readonly request: AgentRequest;
  readonly projects: readonly Project[];
  readonly envSession: EnvSessionIdentity | null;
  readonly envSessionTerminal: SessionRecord | null;
  readonly authenticatedSessionId: string | null;
  readonly actor: TicketEventActor | null;
}

/**
 * What the socket door holds for one request: the verb context its decodes
 * read, and its policy at the map.
 */
export interface AgentCommandContext extends AgentVerbContext {
  /**
   * Who the door authenticated, as host history attributes a caller: the
   * `HandlerCall` a served verb with no {@link AgentVerbContext.actor} of its
   * own (a read, or a verb that skips identity) is invoked under, so the map
   * is always told who called. Never a grant: admission ran off the token.
   */
  readonly doorActor: TicketEventActor;
  /**
   * This request's policy at the handler map (VC-668): a projected verb
   * reaches `handlers[key]` only through it. It judges the socket's own
   * coordination policy for this request again, at the map, for a key another
   * door also reaches (the socket's own verbs reuse the dispatch's verdict),
   * and admits only the key this request's verb projects.
   */
  readonly handlerPolicy: HandlerPolicy;
}

/**
 * One verb's handler: the named function that replaced its branch of the
 * chain. Uniformly async, so the handler table holds one shape rather than
 * two.
 */
export type AgentVerbHandler = (
  context: AgentVerbContext,
  request: AgentRequest,
) => Promise<AgentResponse>;

/** What the socket's table calls for one request: a projection of the map. */
export type SocketVerbHandle = (
  context: AgentCommandContext,
  request: AgentRequest,
) => Promise<AgentResponse>;

export function failure(code: AgentErrorCode, reason: string, next?: string | null): AgentResponse {
  return { v: 1, ok: false, error: makeAgentError(code, reason, next) };
}
