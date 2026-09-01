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
 * The snapshot half is deliberately not resolved here. Several verbs skip work
 * they do not need — the hook hot path takes no projection snapshot and no
 * identity lookup — and that laziness is declared per verb in `table.ts`,
 * beside the handler it belongs to, rather than hidden in a condition here.
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
  ModelAccessSnapshot,
  Project,
  PromptResource,
  SessionActivityState,
  SessionProjection,
  SessionRecord,
  SessionEnvRepair,
  SessionEnvReport,
  TicketEventActor,
  TranscriptReference,
} from "@volli/shared";
import type {
  DataChangedEvent,
  HarnessEventNotice,
  SessionHarnessNotice,
  SessionStartedNotice,
  TicketMovedNotice,
} from "../../ipc/contract";

import type { AutoTitleRequest } from "../session-runtime/auto-title";
import type { Sessions } from "../session-runtime/sessions";
import type { RunGit, RunGitAsync } from "../worktree";

export interface AgentCommandServiceOptions {
  db: Database.Database;
  /** The app composition root's one durable Session Engine. */
  sessionEngine: SessionEngine;
  appVersion: string;
  now?: () => number;
  newId?: () => string;
  /**
   * The git runner the read-only worktree commands execute through. All git
   * calls stay inside the worktree module (CONCEPT #42); this seam only lets
   * tests substitute a scripted runner. Defaults to {@link runGitCapturing}.
   */
  git?: RunGit;
  /**
   * The non-blocking git runner for verbs that can execute user-configured
   * hooks or scan complete Change Sets. Defaults to {@link runGitCapturingAsync}
   * and is separate from {@link git} so a caller cannot accidentally put a
   * long-running child back onto Electron main.
   */
  gitAsync?: RunGitAsync;
  /**
   * Whether a ticket's stamped worktree directory still exists on disk (C3):
   * threaded into the worktree read verbs' disk-existence seam so a stamped-
   * but-deleted directory refuses with INVALID_REQUEST rather than letting
   * status.ts's errs-dirty fallback report `uncommitted: true` for a tree that's
   * gone. Same seam shape as {@link git} — defaults to {@link existsSync}; tests
   * substitute a scripted predicate.
   */
  worktreeExists?: (path: string) => boolean;
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
  notify?: (title: string, message: string) => void;
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
   * subset this project implies, and whether its dependencies are installed. Injected because
   * main is the only process that knows HOW the PATH came to be — it ran the
   * boot probe and owns the adoption outcome — and absent (tests) means
   * identify answers without an env block rather than inventing one.
   */
  sessionEnv?: (cwd: string) => Promise<SessionEnvReport>;
  /**
   * The product Session start route (VC-13) — the same facade the renderer's
   * `sessions.create` RPC rides, threaded in the way {@link sessionEngine} is
   * so no parallel creation path can grow here. Raw `session.create` over
   * this door stays FORBIDDEN. Absent means the Session runtime never came up
   * this launch, which the verb reports as retryable.
   */
  sessions?: Pick<Sessions, "start">;
  /**
   * Submits one user message to a structured Session — the kickoff turn. The
   * runtime answers a `message.submit` only when the TURN it started ends, so
   * the door fires this detached and replies as the session opens; a refusal
   * lands in the log and in the Session's own durable state, never in the
   * caller's exit code.
   */
  submitSessionMessage?: (input: {
    sessionId: string;
    text: string;
    /**
     * The turn's durable ids, derived by the caller from its own operation id
     * rather than minted here (VC-162).
     *
     * `message.submit` is deduplicated by command id in the Session Engine, so
     * whether a replayed start sends one kickoff or two is decided entirely by
     * whether this id is stable. Minting it here — which is what this port used
     * to do — made every replay a second turn, which no caller could fix from
     * outside.
     */
    commandId: string;
    messageId: string;
  }) => Promise<void>;
  /**
   * Fires one model-call title refinement (VC-81) behind a kickoff-derived
   * heuristic title, on the owner's ladder — utility default, then the
   * Session's own model, then the Role's default. Never fires for an
   * explicit `--title` (that is already a person's choice), and never
   * rejects: the heuristic is the fallback the titler keeps on failure.
   * Absent means no model refinement this launch — heuristic only.
   */
  refineAutoTitle?: (input: AutoTitleRequest) => void;
  /**
   * Called after `session.start` opens a Session, with everything the
   * renderer's toast says and targets. A notice, not a navigation: the app
   * must never move or steal focus because a start landed — the toast's
   * action is the only door into the new session's tab.
   */
  onSessionStarted?: (notice: SessionStartedNotice) => void;
  /**
   * Interrupts every live agent attachment of a ticket after a committed
   * backward move. Its command and receipt are Session evidence; Esc leaves
   * the terminal attachment alive. Absent (tests) means a no-op.
   */
  interruptTicketSessions?: (ticketId: string) => string[] | Promise<string[]>;
  /**
   * Called after a socket command COMMITS a planning mutation, with the exact
   * ticket it resolved and touched — the scope index.ts broadcasts as
   * `volli:data-changed` so the renderer refreshes the right surfaces promptly.
   * Never called for a read-only command or a no-op (e.g. a same-column
   * `ticket.move`). A ticketless Session mutation is project-scoped rather than
   * targeted, so every reader refreshes conservatively.
   * Absent (tests) means the broadcast is a no-op.
   */
  onMutation?: (change: Omit<DataChangedEvent, "entity">) => void;
  /**
   * Called after `ticket.move` COMMITS a real column change, carrying the
   * before/after fact main's pending-arrival coordinator cannot reconstruct
   * afterward (VC-226).
   *
   * Separate from {@link AgentCommandOptions.onMutation}, which only tells
   * renderers to re-read planning data. CONTEXT.md makes an explicit `volli
   * ticket move` a Deliberate move with the same semantics as a drag, so this
   * seam creates the same one durable countdown even when no renderer exists.
   * Never called for a same-column no-op. Absent in tests means no observer.
   */
  onDeliberateMove?: (notice: TicketMovedNotice) => void;
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
}

/**
 * The service state and request-scoped snapshot one verb handler runs against.
 *
 * `options` is the composition root verbatim, because most of what a handler
 * reaches for is an injected seam (`notify`, `onMutation`, `sessions`) that has
 * no default and reads best at its own name. The fields beside it are the ones
 * the service RESOLVED once at construction — a default applied, or a map it
 * owns — so a handler cannot accidentally use an unresolved `options.now`.
 */
export interface AgentCommandContext {
  /** Everything the composition root injected. */
  readonly options: AgentCommandServiceOptions;
  /** {@link AgentCommandServiceOptions.now}, defaulted to `Date.now`. */
  readonly now: () => number;
  /** {@link AgentCommandServiceOptions.newId}, defaulted to `randomUUID`. */
  readonly newId: () => string;
  /** {@link AgentCommandServiceOptions.git}, defaulted to `runGitCapturing`. */
  readonly git: RunGit;
  /** {@link AgentCommandServiceOptions.gitAsync}, defaulted to `runGitCapturingAsync`. */
  readonly gitAsync: RunGitAsync;
  /** {@link AgentCommandServiceOptions.worktreeExists}, defaulted to `existsSync`. */
  readonly worktreeExists: (path: string) => boolean;
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
  /** Every registered project, listed once per request. */
  readonly projects: readonly Project[];
  /**
   * Every Session of every project, folded once — or empty, for a verb whose
   * table entry declares it takes no snapshot. `sessions` below narrows it to
   * the terminal rows.
   */
  readonly projections: readonly SessionProjection[];
  /**
   * The terminal half of {@link projections}: the verbs that need a PTY have
   * nothing a structured-only Session can answer, and dropping it there is
   * correct, not a compatibility gap.
   */
  readonly sessions: readonly SessionRecord[];
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
   * Either the authenticated session actor its token proves, or
   * `unauthenticated`. Never `user`: a socket call cannot establish that a
   * person made it, and attributing one anyway is the grant-by-absence VC-92
   * §6.3 ruled dead.
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
 * One verb's handler: the named function that replaced its branch of the
 * chain. Uniformly async, so the table holds one shape rather than two.
 */
export type AgentVerbHandler = (
  context: AgentCommandContext,
  request: AgentRequest,
) => Promise<AgentResponse>;

export function failure(code: AgentErrorCode, reason: string, next?: string | null): AgentResponse {
  return { v: 1, ok: false, error: makeAgentError(code, reason, next) };
}
