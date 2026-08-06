/**
 * The terminal-shaped view of a Session: the trace and resume seed for a
 * terminal, distinct from its live in-memory PTY state
 * (`TerminalEngine`/renderer `stores/sessions.ts`). `ticketId: null` means a
 * project-scoped scratch session (CONTEXT.md's "Scratch session") — main
 * checkout, no worktree, no board involvement, still recorded.
 * `harnessSessionId` is reserved for the harness's own resume UUID
 * (claude/codex `--resume` seed) — filled in later by hooks/the volli CLI,
 * starts `null`.
 *
 * This stopped being a table row at migration 018. Versions 003–017 stored a
 * Session *as* a terminal, so this shape and the `sessions` row were the same
 * thing; 018 reduced the row to identity alone (id, project, ticket, title,
 * createdAt) and made a terminal one attachment among possible others. What
 * fills the rest of these fields now is `terminalSessionRecord`, which calls
 * itself a temporary IPC/UI compatibility projection and means it.
 *
 * The consequence is load-bearing and easy to miss: every field below is a
 * terminal harness/process fact, so a Session with no terminal attachment — a
 * structured (chat) Session — has no honest record here at all, and
 * `terminalSessionRecord` returns `null` for one rather than fabricating a
 * `harnessId: "claude-code"` that read every structured Session out of a
 * listing as a never-ending terminal (see
 * `docs/plans/session-ui-migration-readiness.md`, blocker B4). Do not add a
 * field to this interface expecting the ledger to carry it; add it to the
 * attachment the projection reads.
 *
 * {@link ChatSessionRecord} is the honest record for the Session that null
 * drops: title/identity plus the latest structured attachment's adapter and
 * liveness, never terminal facts it does not have. {@link SessionListingRow}
 * is what the renderer's Session listings (`volli:session-list`,
 * `volli:session-list-for-ticket`) actually return — a discriminated union of
 * the two — so a project's or a ticket's listing is complete: a terminal
 * attachment renders as `"terminal"`, and everything else (no attachment yet,
 * or a structured-only Session) renders as `"chat"`. Consumers that are
 * genuinely terminal-only (the `volli` CLI socket, the terminal resume path)
 * keep reading `SessionRecord | null` straight off `terminalSessionRecord`;
 * they were never the surface that dropped chat Sessions.
 */

import { declaresInputNeeded, expectsHarnessEvents } from "./harness/types";
import type { HarnessAdapter, HarnessEvent } from "./harness/types";
import type { HarnessId } from "./ticket";

/**
 * What the initial PTY launch actually started. `unknown` is reserved for
 * records created before this metadata existed: showing a generic Terminal is
 * more honest than guessing that a historical bare shell was Claude Code.
 */
export const SESSION_LAUNCH_KINDS = ["agent", "shell", "unknown"] as const;

export type SessionLaunchKind = (typeof SESSION_LAUNCH_KINDS)[number];

/** Whether `value` is durable launch-kind metadata accepted across IPC/storage boundaries. */
export function isSessionLaunchKind(value: unknown): value is SessionLaunchKind {
  return typeof value === "string" && (SESSION_LAUNCH_KINDS as readonly string[]).includes(value);
}

/**
 * Where the PTY first landed in Volli's app-owned layout. `unknown` is the
 * migration value for historical records whose renderer layout was not stored.
 */
export const SESSION_PLACEMENTS = ["tab", "split", "unknown"] as const;

export type SessionPlacement = (typeof SESSION_PLACEMENTS)[number];

/** Whether `value` is durable session-placement metadata. */
export function isSessionPlacement(value: unknown): value is SessionPlacement {
  return typeof value === "string" && (SESSION_PLACEMENTS as readonly string[]).includes(value);
}

/** A durable session record: trace + resume seed for a terminal session. */
export interface SessionRecord {
  id: string;
  projectId: string;
  /** `null` means a project-scoped scratch session — no ticket, no board involvement. */
  ticketId: string | null;
  /**
   * What the session was LAUNCHED with — durable history, never overwritten.
   * A terminal outlives the agent that opened it: quit opencode, run claude in
   * the same pane, and the launch is still a true statement about how this
   * session began (it is the immutable launch record, and the
   * only harness a session that never announced anything can be judged by).
   * What is RUNNING is {@link SessionRecord.activeHarnessId}; read the two
   * together through {@link effectiveHarnessId} rather than either alone.
   */
  harnessId: HarnessId;
  /**
   * What is actually running in the terminal right now, as announced by the
   * harness's own PATH-shim wrapper on every invocation. `null` means nothing
   * has announced itself — a session that predates the announce, a bare shell,
   * or a harness launched around the wrapper — and falls back to the launch
   * harness, which is the best available answer rather than a claim.
   */
  activeHarnessId: HarnessId | null;
  /** The harness's own resume/session UUID; filled in later by hooks/the volli CLI. */
  harnessSessionId: string | null;
  /** Whether this PTY launched an agent, a bare shell, or predates launch metadata. */
  launchKind: SessionLaunchKind;
  /** Whether the PTY first landed as a top-level tab, a split pane, or predates placement metadata. */
  placement: SessionPlacement;
  title: string;
  /** Absolute working directory the session's PTY was booted in. */
  cwd: string;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds; `null` while the session is live. */
  endedAt: number | null;
  /**
   * The shell's exit code, stamped by the PTY exit path alongside `endedAt`.
   * `null` while live, for boot-sweep ends (the process outcome was never
   * observed), and for rows predating the column — outcome labels never guess.
   */
  exitCode: number | null;
}

/**
 * The honest record for a Session that {@link SessionRecord} cannot describe:
 * one with no terminal attachment, because it either hasn't attached anything
 * yet or has only ever attached a structured (chat) adapter. Identity plus the
 * minimum a listing needs to name and to know is-this-still-going-on — nothing
 * terminal-shaped, and nothing about the transcript itself (that is the
 * structured adapter's own domain, read through the Session Engine directly).
 */
export interface ChatSessionRecord {
  sessionId: string;
  title: string;
  projectId: string;
  /** `null` means a project-scoped scratch session — no ticket, no board involvement. */
  ticketId: string | null;
  /** Epoch milliseconds. */
  createdAt: number;
  /** The latest structured attachment's adapter id; `null` before one has ever attached. */
  adapterId: string | null;
  /** Whether a structured attachment is currently open. */
  live: boolean;
}

/**
 * One row of a Session listing (`volli:session-list`,
 * `volli:session-list-for-ticket`): a terminal attachment renders as
 * `"terminal"`, everything else as `"chat"` — see the module doc comment for
 * the precedence between them. Replaces the flat `SessionRecord[]` those
 * endpoints used to return, which is where a structured-only Session used to
 * disappear.
 */
export type SessionListingRow =
  | { kind: "terminal"; record: SessionRecord }
  | { kind: "chat"; record: ChatSessionRecord };

/**
 * Which harness a session is to be JUDGED by: what announced itself, falling
 * back to what the session launched with.
 *
 * Written once, and every consumer routed through it, because the fallback is
 * the whole rule and a second hand-copy of it is how one surface comes to name
 * a harness the next one has already stopped believing in. Everything that
 * decides something about the running agent asks this — the resume command line,
 * the notification's subject, the sidebar's label — while the launch harness
 * stays available, unrewritten, for the things that are genuinely about how the
 * session began.
 */
export function effectiveHarnessId(
  record: Pick<SessionRecord, "harnessId" | "activeHarnessId">,
): HarnessId {
  return record.activeHarnessId ?? record.harnessId;
}

/** Stable human-facing identifier used by the CLI instead of exposing the stored UUID. */
export function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/**
 * Session activity vocabulary (ticket-detail-mvp decision #5): "working"
 * (output within ~10s) / "waiting" (a human is blocking the agent) / "idle"
 * (running, quiet) / "parked" (idle and SIGSTOP'd for the warm tier, issue #51
 * — CONT'd back to "idle"/"working" on wake) / "exited".
 *
 * Every state but "waiting" is derived from the PTY. "waiting" cannot be: an
 * agent sitting at a permission prompt emits no output, so recency alone reads
 * it as "idle", which is exactly backwards. It is only ever *declared*, by a
 * harness hook event (`input.needed`), and so exists only for the sessions
 * whose harness reports one.
 */
export const SESSION_ACTIVITY_STATES = ["working", "waiting", "idle", "parked", "exited"] as const;

export type SessionActivityState = (typeof SESSION_ACTIVITY_STATES)[number];

/** Whether `value` is one of the {@link SESSION_ACTIVITY_STATES} — IPC-boundary vocabulary guard. */
export function isSessionActivityState(value: unknown): value is SessionActivityState {
  return (
    typeof value === "string" && (SESSION_ACTIVITY_STATES as readonly string[]).includes(value)
  );
}

export interface CreateSessionInput {
  /** Opaque UUID supplied by the caller — kept out of this function so it stays pure/deterministic. */
  id: string;
  projectId: string;
  /** Defaults to `null` (project-scoped scratch session). */
  ticketId?: string | null;
  harnessId: HarnessId;
  launchKind: SessionLaunchKind;
  placement: SessionPlacement;
  title: string;
  /** Absolute working directory the session's PTY was booted in. */
  cwd: string;
  /** Epoch milliseconds, stamped onto `createdAt`. */
  now: number;
}

/** Creates a {@link SessionRecord}. Pure and deterministic — the caller supplies `id` and `now`. */
export function createSessionRecord(input: CreateSessionInput): SessionRecord {
  return {
    id: input.id,
    projectId: input.projectId,
    ticketId: input.ticketId ?? null,
    harnessId: input.harnessId,
    // Nothing has announced itself at the instant a session is created — not
    // even the harness the launch line is about to start, which announces from
    // inside its own wrapper a moment later.
    activeHarnessId: null,
    harnessSessionId: null,
    launchKind: input.launchKind,
    placement: input.placement,
    title: input.title,
    cwd: input.cwd,
    createdAt: input.now,
    endedAt: null,
    exitCode: null,
  };
}

/**
 * When a delivery was FIRED, in epoch milliseconds off the clock of whatever
 * fired it — `null` when it carries no such stamp.
 *
 * Every canonical event reaches Volli through its own short-lived `volli hook`
 * process, over its own socket connection, and nothing in that arrangement
 * preserves the order the harness emitted them in. Two hooks that fire a
 * millisecond apart race through a process boot, a stdin read and a connect,
 * any of which can reorder them by tens of milliseconds. Main's arrival stamp
 * therefore orders the DELIVERIES and not the events, and last-arrival-wins on
 * a `waiting` is how a session comes to show Idle while its agent sits at a
 * permission prompt — the one failure this channel exists to prevent, because
 * nobody ever comes back to a session that looks finished.
 *
 * The stamp is taken at the hook process's first instruction, ahead of all the
 * variable latency it exists to see past. Three things it is NOT, each of which
 * the name invites a reader to assume:
 *
 * It is not a sequence number. It is a wall clock, and wall clocks step — an
 * NTP correction or a hand-set clock between two hook launches inverts two
 * events that really were ordered. Both hooks run on the same machine, so there
 * is no skew BETWEEN the processes to worry about; that is not the same as the
 * clock being monotonic underneath them.
 *
 * It is not the moment of emission. The harness decides to fire, then spawns a
 * process, and this is the second of those. That is much closer to the truth
 * than arrival, which is the whole reason it is worth carrying, but it remains
 * a proxy for something nothing on the wire can observe directly.
 *
 * It is not fine-grained. Two hooks that fire inside the same millisecond are
 * genuinely unordered, and no amount of care here can invent an order for them.
 *
 * Which is why `null` is a value here and not a failure. An event carrying no
 * ordering information is not unorderable-and-therefore-droppable — a `volli`
 * older than the field, or a hook that could not read a clock, still reports
 * something true — so {@link supersededHarnessEvent} refuses only what it can
 * PROVE is stale and lets everything else through in arrival order, exactly as
 * before.
 */
export type HarnessEventOrder = number | null;

/**
 * Reads an ordering key off an untrusted edge. Anything that is not a finite
 * number reads as `null` rather than as grounds to refuse the delivery: a stamp
 * this cannot use is exactly as much ordering information as no stamp at all,
 * and the event around it is still true.
 */
export function harnessEventOrder(value: unknown): HarnessEventOrder {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Whether a delivery has been overtaken by one already folded in. THE ordering
 * rule, written once: main applies it before it writes, the renderer applies it
 * before it renders, and two hand-copies of a rule this easy to get subtly
 * wrong would diverge on the first edit to either.
 *
 * Superseded means strictly older with both keys present, and nothing else. An
 * absent key on either side is an absence of evidence rather than evidence of
 * staleness, and an equal key is a tie the clock genuinely cannot break — both
 * are applied. That asymmetry is deliberate: this exists to stop Volli
 * believing an event it can prove is stale, not to start disbelieving every
 * event it cannot prove is fresh.
 */
export function supersededHarnessEvent(
  newest: HarnessEventOrder,
  firedAt: HarnessEventOrder,
): boolean {
  return newest !== null && firedAt !== null && firedAt < newest;
}

/**
 * What a harness has actually told us about one live session, as opposed to
 * what its adapter claims it can tell us. Declared capability and delivered
 * evidence are separate fields on purpose: the plan's honesty rule is that a
 * harness which declares an event but has never delivered one is not reporting
 * it, and that distinction is unrepresentable if the two are collapsed.
 *
 * How the activity actually reaches Volli is deliberately NOT stored — it is
 * derived from these fields plus the clock ({@link sessionActivitySource}), so
 * a launch that bypassed the wrapper decays into inference on its own instead
 * of needing a timer to fire and a write to land.
 */
export interface SessionHarnessState {
  /**
   * The harness this state is ABOUT — seeded from the launch, and rebuilt
   * against the announcing harness's own adapter when another one starts in the
   * same terminal (the renderer store's `announceHarness`). It follows the
   * effective harness rather than the launch one for the same reason
   * {@link effectiveHarnessId} exists: a session reporting for a harness that
   * quit an hour ago is the defect, not a historical record. What the previous
   * harness declared goes with it — a `waiting` it raised cannot outlive the
   * process that raised it.
   */
  harnessId: HarnessId;
  /**
   * Whether this launch may be held to a reporting promise at all
   * ({@link expectsHarnessEvents}) — an upper bound, never a claim. A harness
   * that fires nothing at boot is `false` here and can therefore never be
   * accused of silence, whatever its hooks declare.
   */
  expectsEvents: boolean;
  /**
   * Whether the adapter declares `input.needed`. Collapsed to a bit at
   * construction because it is the only per-event capability the renderer acts
   * on; cursor is the harness this exists for (its own source maps both
   * `Notification` and `PermissionRequest` to null, so it ships unable to say a
   * human is blocking it).
   */
  declaresInputNeeded: boolean;
  /**
   * Epoch ms of the `session harness` announce — the moment the wrapper
   * demonstrably ran — and the anchor the grace window for the first event is
   * measured from.
   *
   * `null` until one arrives, and the window does not run while it is. Anchored
   * here rather than at the PTY spawn because the PTY is the user's login
   * shell: at that instant nothing has been launched, the harness may not have
   * been typed yet, and a window started there is a stopwatch on the user. The
   * announce is fired by the harness's own process, so N seconds of silence
   * after one is a statement about the channel — the config we injected did not
   * take — which is a diagnosis rather than a guess.
   *
   * A launch that never announces therefore never turns silent. That is the
   * safe direction: it means the wrapper was bypassed entirely, which is a
   * missing call rather than a dead channel, and accusing a harness of not
   * reporting on evidence we never asked it for is the failure worth avoiding.
   */
  startedAt: number | null;
  /** Whether ANY canonical event has ever arrived. Declared is not delivered. */
  delivered: boolean;
  /** The newest hook-declared activity state; `null` means PTY derivation owns it. */
  declared: SessionActivityState | null;
  /**
   * The newest {@link HarnessEventOrder} folded in so far — the watermark a
   * later delivery is judged against. `null` until a stamped delivery arrives,
   * and `null` forever on a channel where none ever does: a key that cannot
   * order itself must not begin ordering everything behind it.
   */
  newestFiredAt: HarnessEventOrder;
}

export interface CreateSessionHarnessStateInput {
  harnessId: HarnessId;
  /**
   * The adapter behind that id, or `undefined` when nothing can describe it —
   * an id trusted since the renderer last read the catalog, a harness this
   * build does not ship. Both expectations below are read off it rather than
   * passed in beside it, so the one place that turns a harness into an
   * expectation is this function and there is nowhere for a caller's idea of
   * what a harness promised to drift from the adapter's.
   */
  adapter: Pick<HarnessAdapter, "injection" | "startupEvent" | "events"> | undefined;
  /** Epoch ms of the announce that proved this launch, or `null` if none has. */
  startedAt: number | null;
}

/** The zero state for a session that has just launched and reported nothing yet. */
export function createSessionHarnessState(
  input: CreateSessionHarnessStateInput,
): SessionHarnessState {
  const { adapter } = input;
  return {
    harnessId: input.harnessId,
    expectsEvents: expectsHarnessEvents(adapter),
    declaresInputNeeded: declaresInputNeeded(adapter),
    startedAt: input.startedAt,
    delivered: false,
    declared: null,
    newestFiredAt: null,
  };
}

/** Events meaning a human is now blocking the agent's progress. */
const BLOCKING_EVENTS: ReadonlySet<HarnessEvent> = new Set([
  "input.needed",
  "permission.requested",
]);

/**
 * Events that prove the channel is alive but say nothing about the parent
 * agent. A subagent finishing while its parent sits at a permission prompt is
 * not the parent moving again — the plan's rule that `SubagentStop` must never
 * notify, applied to state instead of notifications.
 */
const TELEMETRY_EVENTS: ReadonlySet<HarnessEvent> = new Set(["subagent.completed"]);

/**
 * Folds one canonical event into a session's harness state.
 *
 * **How a stale `waiting` clears: the newest event wins.** There is no TTL and
 * no explicit acknowledgement, because both would lie. A permission prompt can
 * legitimately sit unanswered for an hour, so expiring `waiting` on a timer
 * would drop a genuinely blocked session out of "Needs you" while the human is
 * still the blocker; and no harness in the table emits a
 * `permission.replied`-shaped signal to acknowledge against — answering
 * permissions is explicitly out of scope for this landing. What every harness
 * DOES emit is proof of the agent moving again (`turn.started` on the next
 * prompt, `tool.started` on the next tool, `turn.completed` on the next stop),
 * and that proof is what returns the session to PTY derivation. A `waiting`
 * therefore cannot outlive the agent's next observable action.
 *
 * **Which event is newest is not the order they arrived in.** `firedAt` is what
 * decides that, for the reasons {@link HarnessEventOrder} lays out, and it is
 * required rather than defaulted for the same reason `declared` is required at
 * the store: a caller who has a key and forgets to pass it would silently get
 * arrival order back, which is the bug. Pass `null` where there genuinely is
 * none.
 */
export function receiveHarnessEvent(
  state: SessionHarnessState,
  event: HarnessEvent,
  firedAt: HarnessEventOrder,
): SessionHarnessState {
  // A superseded delivery still proves the channel is alive. That proof is
  // order-free — a fact about what the harness can do, which no later fact
  // replaces — so it is kept while everything a newer event has already
  // answered is withheld. Main draws the same line on its own side of the wire:
  // one rule, and the two ends cannot drift into disagreeing about a session.
  if (supersededHarnessEvent(state.newestFiredAt, firedAt)) return { ...state, delivered: true };
  const newestFiredAt = firedAt ?? state.newestFiredAt;
  if (TELEMETRY_EVENTS.has(event)) return { ...state, delivered: true, newestFiredAt };
  // A blocking event from a harness whose own source maps that signal to null
  // (cursor) is not evidence, it is noise from something in the pipe that
  // shouldn't be there. Record the delivery — the channel is demonstrably alive
  // — but never let it raise a needs-you state the harness cannot vouch for.
  const blocking = BLOCKING_EVENTS.has(event) && state.declaresInputNeeded;
  return { ...state, delivered: true, newestFiredAt, declared: blocking ? "waiting" : null };
}

/**
 * How a session's activity reaches Volli. `reported` — the harness is
 * delivering hook events. `inferred` — nothing is reporting, and the PTY
 * heuristic is doing the work, which is the normal state of a harness that
 * promised no events and of one still inside its grace window. `silent` —
 * events were expected and never came, which is the one case worth a word in
 * the UI: the user was promised reporting and isn't getting it.
 */
export type SessionActivitySource = "reported" | "inferred" | "silent";

/**
 * How long a hooked launch has to deliver its first event, counted from the
 * announce that proved the launch, before we stop believing it will. The
 * adapter's `startupEvent` fires at harness boot, so this only has to cover the
 * announce plus one hook round-trip; anything longer leaves the session hanging
 * in a "waiting for events" state that will never resolve.
 */
export const HARNESS_EVENT_GRACE_MS = 20_000;

/**
 * What a session's harness is actually doing for us, right now. Derived rather
 * than stored: the expectation is revoked by the passage of time since the
 * launch announced itself and said nothing further — the hooks we injected did
 * not take — and deriving it against an injected clock means that revocation
 * needs no timer, no write, and no way to be missed.
 *
 * The tests run in the same order as {@link harnessChannelState}'s, and the
 * ordering is the same load-bearing thing there and here: a delivery is a FACT,
 * and the expectation and the window defer only an ACCUSATION. An event that has
 * already landed proves the channel works whether or not anything expected it
 * to speak, so it is read first and nothing below can withhold it.
 */
export function sessionActivitySource(
  state: SessionHarnessState,
  now: number,
): SessionActivitySource {
  if (state.delivered) return "reported";
  // Only a launch that could be held to a reporting promise can be silent. A
  // harness with no injection never claimed to report, and one with no
  // startup event says nothing until the agent acts — so for both, PTY-derived
  // activity is the expected outcome rather than a degradation worth telling
  // the user about. Codex is the second case, and this is the line that stops
  // the app accusing a perfectly healthy Codex session nobody has typed into.
  if (!state.expectsEvents) return "inferred";
  // No announce, no window. Nothing has proved a harness is running in this
  // terminal yet, so there is no launch to hold to a promise — see
  // {@link SessionHarnessState.startedAt}.
  if (state.startedAt === null || now - state.startedAt <= HARNESS_EVENT_GRACE_MS) {
    return "inferred";
  }
  return "silent";
}
