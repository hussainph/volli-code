/**
 * Delegation to a Subagent Session (VC-9): the application half behind the
 * `session_delegate` tool, the way `start-session.ts` is the half behind
 * `session_start` and `supervise-session.ts` behind stop and send. The door
 * validates and words the answer; this module owns the semantics.
 *
 * ## What a delegation is
 *
 * Three acts, and only the first two happen inside the tool call:
 *
 * 1. A real child Session is minted through the one Sessions facade — Role
 *    `subagent`, the parent's project and Ticket, the parent as its ancestor —
 *    and attached. It shows in the session list, has its own transcript and
 *    its own model. It is never a hidden thread inside the parent.
 * 2. A watcher is parked on the child's durable stream — the same subscription
 *    every surface reads — and THEN the task is submitted as the child's
 *    kickoff turn, detached, marked as the parent's delegation so the child
 *    reads it as its instruction rather than as a person's message. Detached
 *    because the runtime answers a `message.submit` when the TURN it started
 *    ends, and this call is due as the child opens, not when it finishes.
 * 3. The tool call RETURNS. When the child's first turn completes, a
 *    NOTICE carrying its answer is submitted into the parent as a marked
 *    message: `steer` delivery, so a parent mid-turn reads it now and an idle
 *    parent opens a turn on it. The parent is never parked on its helper, and
 *    there is no await tool to park it with (VC-457).
 *
 * ## The child's model is its parent's anchor (VC-431)
 *
 * A delegation that names neither a `model` nor a `tier` runs on what its
 * PARENT is anchored to, rather than on a rung of the Subagent Role's own.
 * This module does not decide that: it passes the caller's override through
 * untouched, and the facade resolves it in `mint`, beside the tool surface and
 * MCP a child already inherits there (`sessions.ts`, `anchoredOnParent`). One
 * place answers "what does a subagent inherit from its parent", so a future
 * start path cannot get half of it.
 *
 * ## The answer rides the notice, quoted as another author's prose
 *
 * The child's final message reaches the parent without a second call, avoiding
 * a turn spent fetching the answer. The notice carries Volli's facts — the
 * child's handle, its state, the title the
 * parent gave it — AND the child's last message, inside the same quoted
 * untrusted-prose envelope `volli session answer` prints (VC-457). The
 * envelope is the trust boundary: the notice rides the `user` channel because
 * that is the channel a model is guaranteed to read, and a child reads
 * untrusted repository content on the parent's behalf, so its words arrive
 * `|`-quoted and labelled as the subagent's, never as the person's. Long
 * answers are cut at {@link SUBAGENT_ANSWER_NOTICE_LIMIT} characters with a
 * pointer to `volli session answer <handle>` for the whole text.
 *
 * ## What "done" is
 *
 * The child's first `turn.completed` with no pending interaction — and a
 * subagent cannot open one, since it holds no `ask_user`. `turn.interrupted`,
 * `session.stopped`, and a failed or closed attachment end the watch too, and
 * every one of them still notifies unless the parent itself stopped the child:
 * that stop is already the parent's own decision, not news to echo back.
 * There is no wall clock (VC-457): a long research child runs
 * until it answers, and a person or the
 * parent stops it when it is wrong, not a timer when it is slow.
 *
 * ## A child whose first attach failed keeps its task
 *
 * The attach can fail before anything runs — a worktree that cannot be made,
 * an executor that will not start. The task is then held in the child's own
 * durable follow-up queue under the kickoff's ids (VC-799) and released at its
 * next ready attach, which is a person's Retry; the turn that opens is
 * watched by {@link Delegations.rearm}, and its end is the delegation's one
 * notice. The tool call returns `needs-recovery` meanwhile, and boot recovery
 * leaves a child whose queue still holds the task alone: its failed attach
 * is not an outcome to report.
 *
 * ## A child resumed later reports again
 *
 * A person can open a stopped or finished child and send it more work. Its
 * delegation was already settled, so nothing would tell the parent — and a
 * parent that never hears about the work it started is the failure this module
 * exists to prevent. {@link Delegations.rearm} watches such a child again from
 * the turn that resumed it, and its end is one more notice under an id keyed
 * on that turn.
 *
 * ## Delivery waits for a reader
 *
 * A notice is submitted only while the parent holds a live executor; a
 * `message.submit` into a Session with none is refused durably under the
 * command id it was sent with, and that id is the delegation's one durable
 * mark of "the parent was told" — so a refused notice would read as delivered
 * forever. A parent between attachments (a relaunch retired every one) has
 * its notice parked on its own stream instead, delivered at its next
 * `attachment.opened`: the same wake the Runtime Brief rides, from the ledger
 * rather than from process memory. A stopped parent is told nothing; there is
 * no one to tell, and the log says so.
 *
 * ## Bounds
 *
 * - No cap on live children: a shared worktree is the parent's
 *   own coordination problem, and the tool description says so.
 * - Depth is structural: a subagent's bundle holds no `session.delegate`, so
 *   there is no grandchild to count and no counter here.
 * - No time bound (VC-457). The 20-minute wall clock this module once armed
 *   stopped research children mid-work with nothing written, and recorded
 *   the parent as the actor of a stop nobody chose.
 * - Stopping the parent stops its live children, with the parent as the
 *   actor, so a person who ended one line of work does not leave its helpers
 *   editing the tree behind it.
 *
 * ## Replay and restart
 *
 * Every durable write is keyed on the operation id (the parent plus the
 * runtime's own tool call id), so a replayed call lands one child, one
 * kickoff and one notice. The watchers are process memory, and a relaunch
 * loses them — but not the facts they waited on. Boot recovery retires every
 * open attachment, so a child mid-turn at the relaunch reads as interrupted;
 * a child that finished before it has its `turn.completed` in its own ledger.
 * {@link Delegations.recover} folds exactly those facts for every delegation
 * whose notice never reached its parent and parks each notice the way a live
 * settle would have. Nothing is re-watched; recovery reports and lets go.
 */

import type { SessionStopDetail } from "@volli/shared";

import {
  composeSubagentNotice,
  noticeProse,
  readSessionOrigin,
  sessionHostNoticeMetadata,
  shortSessionId,
  SUBAGENT_ANSWER_NOTICE_LIMIT,
  SUBAGENT_NOTICE_COMMAND_ID_SUFFIX,
  SUBAGENT_NOTICE_MESSAGE_ID_SUFFIX,
  type NoticeAnswer,
} from "@volli/shared";
import type {
  ModelSelection,
  RuntimeSessionIdentity,
  SessionEvent,
  SessionOrigin,
  SessionStopActor,
  SubagentNoticeReason,
  SubagentOutcomeState,
  TicketEventActor,
  TranscriptReference,
} from "@volli/shared";
import type {
  SessionAnswer,
  SessionEngine,
  SessionRuntime,
  SessionTranscriptArtifact,
} from "@volli/session-engine";
import {
  foldSessionAnswerState,
  isSessionStreamFrame,
  readSessionAnswer,
} from "@volli/session-engine";

import type { DelegationRef } from "./delegation-policy";
import { deliverHostNotice, errorText } from "./host-notice-delivery";
import type { NoticeDelivery } from "./host-notice-delivery";
import { KickoffRefusedError, type StartSessionPorts } from "./start-session";
import type { SessionModelOverride, Sessions } from "./sessions";
import { stopSessionOperation } from "./supervise-session";
import { hostLogger } from "../log/root";

const log = hostLogger("delegation");

/** The inline answer bound now lives with the notice words in `@volli/shared`. */
export { SUBAGENT_ANSWER_NOTICE_LIMIT };

/** What the operations need. Narrow on purpose; everything is per-call. */
export interface DelegateSessionPorts {
  /** The one facade verb a delegation needs: mint and attach. */
  sessions: Pick<Sessions, "start">;
  /** Delivers the kickoff turn, with the ids this module derives. */
  submitSessionMessage: NonNullable<StartSessionPorts["submitSessionMessage"]>;
  /** The child's and parent's durable streams, and the parent's ledger to notify into. */
  runtime: Pick<SessionRuntime, "command" | "subscribe" | "projection">;
  /**
   * What a stop needs (VC-86's operation, reused with the parent as actor),
   * plus the ledger read recovery makes.
   */
  sessionEngine: Pick<SessionEngine, "listSessions" | "submit" | "listEvents">;
  now: () => number;
  /**
   * Reads the child's final message for the notice. Absent in a composition
   * with no artifact store: the notice then carries the state alone and names
   * `volli session answer`, which is what it always did.
   */
  readTranscriptArtifact?: (reference: TranscriptReference) => Promise<SessionTranscriptArtifact>;
  /**
   * Where a failure nobody is waiting on is written down (AGENTS.md: never
   * silently swallow). Defaults to the process log.
   */
  report?: (message: string) => void;
  /** Renderer fan-out after the child is durable. Absent in tests. */
  onMutation?: (input: { projectId: string; ticketId?: string; kind: "session" }) => void;
}

/** A refusal the door words for the model. `message` is a complete sentence. */
export class DelegateSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegateSessionError";
  }
}

export interface DelegateSessionInput {
  /** Idempotency key: the parent plus the runtime's tool call id. */
  operationId: string;
  /** The calling Session, as the attachment bound it. Never named in the call. */
  parent: RuntimeSessionIdentity;
  task: string;
  title?: string;
  modelOverride?: SessionModelOverride;
  actor: TicketEventActor;
}

export type DelegateSessionOutcome = {
  childSessionId: string;
  handle: string;
  title: string;
  model: ModelSelection;
} & (
  | {
      /** After a ready attach: the task was sent and its watch armed. */
      state: "running";
    }
  | {
      /** The attach failed, so no task was sent. */
      state: "needs-recovery";
      /**
       * Whether the task waits in the child's queue for its next ready attach
       * (VC-799); its notice then arrives under the delegation's own ids once
       * the task has run.
       */
      taskHeld: boolean;
    }
);

/** How a watched delegation ended (shared with the cloud subagent notice). */
export type { SubagentOutcomeState };

/** The child's answer as its ledger reads it, as the shared composer takes it. */
function noticeAnswer(answer: Pick<SessionAnswer, "text" | "unreadable"> | null): NoticeAnswer {
  if (answer === null) return { state: "unread" };
  if (answer.text === null) {
    return answer.unreadable ? { state: "unreadable", error: null } : { state: "none" };
  }
  return { state: "text", message: noticeProse(answer.text, SUBAGENT_ANSWER_NOTICE_LIMIT) };
}

/**
 * The notice the parent reads when its helper is done: Volli's facts, then
 * the child's final message quoted as the child's prose (VC-457). The words
 * are `composeSubagentNotice` in `@volli/shared`, the one composer the cloud
 * subagent notice (VC-696) uses too; this adapts the local ledger's reads.
 */
export function subagentNotice(input: {
  childSessionId: string;
  stopDetail?: SessionStopDetail;
  parentSessionId?: string;
  title: string;
  state: SubagentOutcomeState;
  reason: SubagentNoticeReason | null;
  /** Who stopped it, for a `stopped` outcome; null when unknown. */
  stoppedBy?: SessionStopActor | null;
  /** The child's answer as its ledger reads; absent when none was read. */
  answer?: Pick<SessionAnswer, "text" | "unreadable"> | null;
}): string {
  return composeSubagentNotice({
    parentSessionId: input.parentSessionId ?? "",
    childSessionId: input.childSessionId,
    title: input.title,
    state: input.state,
    reason: input.reason,
    stoppedBy: input.stoppedBy ?? null,
    stopDetail: input.stopDetail ?? null,
    answer: noticeAnswer(input.answer ?? null),
  }).text;
}

/** The marker the child reads its task under, so it is an instruction and not a person. */
export function delegatedTaskMarker(parentSessionId: string): string {
  return `[Delegated task from your parent Session ${shortSessionId(parentSessionId)} — carry it out; your last message is your answer]`;
}

const DELEGATED_KICKOFF_TITLE_LIMIT = 80;

/**
 * The three durable ids one delegation spends, derived from its operation id.
 * DURABLE, not live: the suffixes are what `listUnansweredSubagents` reads back
 * out of two ledgers, so they are frozen the way any durable id derivation is.
 */
export const DELEGATION_ID_SUFFIXES = Object.freeze({
  kickoff: ":kickoff",
  kickoffMessage: ":kickoff-message",
  notice: SUBAGENT_NOTICE_COMMAND_ID_SUFFIX,
  noticeMessage: SUBAGENT_NOTICE_MESSAGE_ID_SUFFIX,
  stop: ":stop",
});

/** The kickoff turn's ids, derived so a replayed delegation submits one message. */
function kickoffIds(operationId: string): { commandId: string; messageId: string } {
  return {
    commandId: `${operationId}${DELEGATION_ID_SUFFIXES.kickoff}`,
    messageId: `${operationId}${DELEGATION_ID_SUFFIXES.kickoffMessage}`,
  };
}

/** The notice's ids, derived so a replayed watcher delivers one message. */
function noticeIds(operationId: string): { commandId: string; messageId: string } {
  return {
    commandId: `${operationId}${DELEGATION_ID_SUFFIXES.notice}`,
    messageId: `${operationId}${DELEGATION_ID_SUFFIXES.noticeMessage}`,
  };
}

/** A durable title from the task's first line, when the parent named none. */
function titleFromTask(task: string): string {
  const line = task.trim().split("\n")[0]?.trim() ?? "";
  const collapsed = line.replaceAll(/\s+/gu, " ");
  return collapsed.length > DELEGATED_KICKOFF_TITLE_LIMIT
    ? `${collapsed.slice(0, DELEGATED_KICKOFF_TITLE_LIMIT - 1)}…`
    : collapsed || "Delegated task";
}

interface LiveDelegation extends DelegationRef {
  unsubscribe: () => void;
  settled: boolean;
  /** The notice ids this watch settles under: the kickoff's, or a resumed turn's. */
  notice: { commandId: string; messageId: string };
  /**
   * A child a person resumed after its delegation settled (VC-457). Its end
   * still notifies the parent, but a parent stop does not cascade onto it:
   * the person who resumed it chose to, and a parent already stopped would
   * otherwise stop it the moment it began.
   */
  resumed: boolean;
}

/** What one boot recovery did, in counts a log line can print. */
export interface DelegationRecovery {
  /** Finished children whose notice was parked or delivered. */
  answered: number;
  /** Children cut short by the relaunch, reported as interrupted. */
  reported: number;
  /** Children that never began a turn; nothing to say until a person retries. */
  skipped: number;
}

/** The outcomes of this delegation's watch, not of unrelated commands or a prior kickoff. */
function outcomeOf(
  payload: SessionEvent["payload"],
  operationId: string,
  resumed = false,
): SubagentOutcomeState | null {
  switch (payload.kind) {
    case "command.receipt.recorded":
      return !resumed &&
        payload.receipt.status === "rejected" &&
        payload.receipt.commandId === kickoffIds(operationId).commandId
        ? "failed"
        : null;
    case "turn.completed":
      return "completed";
    case "turn.interrupted":
      return "interrupted";
    case "session.stopped":
      return "stopped";
    case "attachment.failed":
      return "failed";
    case "attachment.closed":
      return payload.outcome === "completed" ? null : payload.outcome;
    default:
      return null;
  }
}

export type { NoticeDelivery } from "./host-notice-delivery";

/**
 * Which of Volli's own origins are a host notice — Volli telling the Session
 * something, not anyone resuming it (VC-809). A Record, so a new reason fails
 * to compile here until someone decides which it is.
 */
const IS_HOST_NOTICE: Record<Extract<SessionOrigin, { kind: "volli" }>["reason"], boolean> = {
  "watch-notice": true,
  "subagent-notice": true,
  "browser-notice": true,
  "shell-notice": true,
  "worktree-notice": true,
  "relaunch-recovery": false,
  "scheduled-resume": false,
  supervision: false,
  "auto-title": false,
};

/** A turn Volli opened by telling the Session something, not by anyone resuming it. */
function isHostNoticeOrigin(origin: SessionOrigin | null): boolean {
  return origin?.kind === "volli" && IS_HOST_NOTICE[origin.reason];
}

/**
 * The origin a `command.recorded` event carries: the slim fold's field when
 * present, else the door's attribution in its provenance. Null when unknown.
 */
export function commandOriginOf(event: SessionEvent): SessionOrigin | null {
  if (event.commandOrigin !== undefined) return event.commandOrigin;
  const detail = event.provenance?.source.detail;
  return typeof detail === "object" && detail !== null && !Array.isArray(detail)
    ? readSessionOrigin((detail as Record<string, unknown>).sessionOrigin)
    : null;
}

/**
 * The ids a resumed child's notice spends, keyed on the turn that resumed it
 * so each resumption lands one notice. DURABLE, not live, like the kickoff's.
 */
export function resumedNoticeIds(
  operationId: string,
  turnId: string,
): { commandId: string; messageId: string } {
  return {
    commandId: `${operationId}:resume:${turnId}${DELEGATION_ID_SUFFIXES.notice}`,
    messageId: `${operationId}:resume:${turnId}${DELEGATION_ID_SUFFIXES.noticeMessage}`,
  };
}

/**
 * The delegation host for one process: what `session_delegate` calls, and the
 * in-memory registry of live children it keeps.
 */
export interface Delegations {
  delegate(input: DelegateSessionInput): Promise<DelegateSessionOutcome>;
  /** The children of one parent still being watched, in start order. */
  liveChildren(parentSessionId: string): readonly string[];
  /** Whether a child's current work is already being watched. */
  watching(childSessionId: string): boolean;
  /**
   * Watch a child whose delegation already settled, from the turn a person
   * resumed it with (VC-457), so that turn's end notifies the parent too.
   * A turn a host notice opened in an answered child is not a resumption and
   * arms nothing (VC-809). Idempotent per child while a watch is live.
   */
  rearm(
    entry: DelegationRef & { answered: boolean },
    resumed: { turnId: string; afterSequence: number },
  ): Promise<void>;
  /**
   * Watch an answered child that a person or another Session steered a
   * message into while a turn of it was already running (VC-809). That turn
   * was opened by something else — a host notice, typically, which
   * {@link rearm} leaves alone — so its start named no resumption; the joined
   * message is one, and the turn's end reports under that turn's resume ids.
   * A message whose origin is a host notice, or that arrived while the child
   * was idle (its own turn's start re-arms), arms nothing.
   */
  rearmJoined(
    entry: DelegationRef & { answered: boolean },
    joined: { origin: SessionOrigin | null; afterSequence: number },
  ): Promise<void>;
  /**
   * Notify every delegation a relaunch left unanswered, off the children's own
   * ledgers. Run once at boot, after stale attachments are retired; the notice
   * command id is durable, so running it twice delivers nothing twice.
   */
  recover(unanswered: readonly DelegationRef[]): Promise<DelegationRecovery>;
}

export function createDelegations(ports: DelegateSessionPorts): Delegations {
  const report =
    ports.report ?? ((message) => log.error("subagent delegation issue", { detail: message }));
  const delivery = { runtime: ports.runtime, report };
  /** Live delegations by child Session id. */
  const live = new Map<string, LiveDelegation>();
  /** The parent watch that stops children when the parent stops, per parent. */
  const parentWatches = new Map<string, () => void>();

  function childrenOf(parentSessionId: string): LiveDelegation[] {
    return [...live.values()].filter((entry) => entry.parentSessionId === parentSessionId);
  }

  /**
   * Whether the child's queue still holds the delegated task, waiting for its
   * next ready attach. A read that fails answers no, so the parent is still
   * told rather than never told.
   */
  async function holdsTask(entry: DelegationRef): Promise<boolean> {
    const { messageId } = kickoffIds(entry.operationId);
    try {
      const { projection } = await ports.runtime.projection({ sessionId: entry.childSessionId });
      return (projection.queue ?? []).some(({ id }) => id === messageId);
    } catch (error) {
      report(
        `could not read subagent ${shortSessionId(entry.childSessionId)}'s queue during recovery: ${errorText(error)}`,
      );
      return false;
    }
  }

  /** The child's answer, read off its own ledger; null when nothing can read it. */
  async function answerOf(childSessionId: string): Promise<SessionAnswer | null> {
    if (ports.readTranscriptArtifact === undefined) return null;
    try {
      return await readSessionAnswer(
        {
          listEvents: (query) => ports.sessionEngine.listEvents(query),
          readArtifact: ports.readTranscriptArtifact,
        },
        { sessionId: childSessionId },
      );
    } catch (error) {
      report(
        `could not read subagent ${shortSessionId(childSessionId)}'s answer for its notice: ${errorText(error)}`,
      );
      return null;
    }
  }

  /**
   * Whether the child's turn `turnId` was opened by a host notice (VC-809):
   * true only when that turn is still the latest and its recorded origin is
   * one. A projection that cannot be read is reported and answers false.
   */
  async function openedByHostNotice(childSessionId: string, turnId: string): Promise<boolean> {
    try {
      const { projection } = await ports.runtime.projection({ sessionId: childSessionId });
      return projection.latestTurnId === turnId && isHostNoticeOrigin(projection.latestTurnOrigin);
    } catch (error) {
      report(
        `could not read what opened subagent ${shortSessionId(childSessionId)}'s turn: ${errorText(error)}`,
      );
      return false;
    }
  }

  /**
   * The one delivery. The outcome state rides along so the message can carry
   * it as metadata for the chat surface (VC-330), and the child's answer rides
   * in the text (VC-457).
   */
  async function deliver(
    entry: DelegationRef,
    ids: { commandId: string; messageId: string },
    state: SubagentOutcomeState,
    reason: SubagentNoticeReason | null = null,
    stoppedBy: SessionStopActor | null = null,
    stopDetail?: SessionStopDetail,
  ): Promise<NoticeDelivery | "suppressed"> {
    // A parent's own stop is already a durable fact in the child's ledger.
    // Recovery and the durable answered index derive settlement from that
    // fact, without recording a synthetic parent-side :answer message.
    if (state === "stopped" && isParentStop(stoppedBy, entry.parentSessionId)) {
      return "suppressed";
    }
    const answer = await answerOf(entry.childSessionId);
    return deliverHostNotice(delivery, {
      sessionId: entry.parentSessionId,
      commandId: ids.commandId,
      messageId: ids.messageId,
      metadata: sessionHostNoticeMetadata({
        kind: "subagent",
        childSessionId: entry.childSessionId,
        title: entry.title,
        state,
        reason,
      }),
      text: subagentNotice({
        childSessionId: entry.childSessionId,
        parentSessionId: entry.parentSessionId,
        title: entry.title,
        state,
        reason,
        stoppedBy,
        ...(stopDetail === undefined ? {} : { stopDetail }),
        answer,
      }),
      label: `subagent notice for ${shortSessionId(entry.childSessionId)} to parent ${shortSessionId(entry.parentSessionId)}`,
    });
  }

  async function settle(
    entry: LiveDelegation,
    state: SubagentOutcomeState,
    stoppedBy: SessionStopActor | null = null,
    stopDetail?: SessionStopDetail,
  ): Promise<void> {
    if (entry.settled) return;
    entry.settled = true;
    entry.unsubscribe();
    live.delete(entry.childSessionId);
    if (childrenOf(entry.parentSessionId).every((child) => child.resumed)) {
      parentWatches.get(entry.parentSessionId)?.();
      parentWatches.delete(entry.parentSessionId);
    }
    await deliver(entry, entry.notice, state, null, stoppedBy, stopDetail);
  }

  async function stopChild(entry: LiveDelegation, reason: string): Promise<void> {
    try {
      await stopSessionOperation(
        { sessionEngine: ports.sessionEngine, runtime: ports.runtime },
        {
          operationId: `${entry.operationId}${DELEGATION_ID_SUFFIXES.stop}`,
          callerSessionId: entry.parentSessionId,
          projectId: entry.projectId,
          handle: shortSessionId(entry.childSessionId),
          reason,
        },
      );
    } catch (error) {
      // A child already gone has nothing to stop and the notice still lands;
      // any other failure is a helper left running, and the log must say so.
      report(
        `could not stop subagent ${shortSessionId(entry.childSessionId)} (${reason}): ${errorText(error)}`,
      );
    }
  }

  /**
   * The one Volli-initiated stop left (VC-457 retired the wall clock). The
   * stop is recorded with the parent as its actor, and the settle names the
   * parent too — whichever of this and the child's own watcher settles first,
   * both read the same cause, so the notice cannot claim a different one.
   */
  async function stopChildrenOf(parentSessionId: string): Promise<void> {
    const parentStop: SessionStopActor = { kind: "session", sessionId: parentSessionId };
    for (const child of childrenOf(parentSessionId)) {
      if (child.resumed) continue;
      await stopChild(child, "Parent Session stopped");
      await settle(child, "stopped", parentStop);
    }
  }

  async function watchParent(parent: RuntimeSessionIdentity): Promise<void> {
    if (parentWatches.has(parent.sessionId)) return;
    // From the parent's CURRENT sequence: only a stop from here on matters,
    // and a cursor past the ledger's end would never be reached by anything.
    const { projection, throughSequence } = await ports.runtime.projection({
      sessionId: parent.sessionId,
    });
    if (projection.stopped !== null) {
      await stopChildrenOf(parent.sessionId);
      return;
    }
    const unsubscribe = await ports.runtime.subscribe(
      { sessionId: parent.sessionId, afterSequence: throughSequence },
      async (emission) => {
        if (!isSessionStreamFrame(emission) || emission.event.payload.kind !== "session.stopped") {
          return;
        }
        await stopChildrenOf(parent.sessionId);
      },
      (error) => {
        report(
          `parent watch for ${shortSessionId(parent.sessionId)} lost its stream; its subagents will not be stopped with it: ${errorText(error)}`,
        );
      },
    );
    parentWatches.set(parent.sessionId, unsubscribe);
  }

  async function watchChild(
    entry: DelegationRef,
    afterSequence: number,
    notice: { commandId: string; messageId: string },
    resumed: boolean,
  ): Promise<void> {
    const state: LiveDelegation = {
      ...entry,
      unsubscribe: () => undefined,
      settled: false,
      notice,
      resumed,
    };
    live.set(entry.childSessionId, state);
    state.unsubscribe = await ports.runtime.subscribe(
      { sessionId: entry.childSessionId, afterSequence },
      async (emission) => {
        if (state.settled || !isSessionStreamFrame(emission)) return;
        const payload = emission.event.payload;
        const outcome = outcomeOf(payload, entry.operationId, state.resumed);
        if (outcome === null) return;
        // Stream frames can lag each other. Settle on the earliest durable
        // outcome of this watch, not whichever frame happened to arrive first.
        // In particular, a later own stop cannot erase a rejected kickoff,
        // and a rejection after an own stop cannot manufacture a failure notice.
        const childEvents = await ports.sessionEngine.listEvents({
          sessionId: entry.childSessionId,
        });
        const firstOutcome = childEvents.find(
          (event) =>
            event.sequence > afterSequence &&
            event.sequence <= emission.event.sequence &&
            outcomeOf(event.payload, entry.operationId, state.resumed) !== null,
        );
        const firstPayload = firstOutcome?.payload ?? payload;
        await settle(
          state,
          outcomeOf(firstPayload, entry.operationId, state.resumed) ?? outcome,
          firstPayload.kind === "session.stopped" ? firstPayload.by : null,
          firstPayload.kind === "turn.interrupted" ? firstPayload.stopDetail : undefined,
        );
      },
      (error) => {
        report(
          `watch on subagent ${shortSessionId(entry.childSessionId)} lost its stream: ${errorText(error)}`,
        );
      },
    );
    // A watch settled by a frame the subscribe itself replayed has already
    // removed itself; leaving its stream open would be a leak.
    if (state.settled) state.unsubscribe();
  }

  return {
    async delegate(input) {
      const parent = input.parent;
      const title = input.title?.trim() || titleFromTask(input.task);
      const started = await ports.sessions.start({
        operationId: input.operationId,
        projectId: parent.projectId,
        ticketId: parent.ticketId,
        role: "subagent",
        parentSessionId: parent.sessionId,
        title,
        actor: input.actor,
        ...(input.modelOverride === undefined ? {} : { modelOverride: input.modelOverride }),
        // The task is the request an automatic model choice reads (VC-432); it
        // is ignored when the caller named a model, tier or level.
        autoSelect: { request: input.task },
      });
      ports.onMutation?.({
        kind: "session",
        projectId: parent.projectId,
        ...(parent.ticketId === null ? {} : { ticketId: parent.ticketId }),
      });
      const ids = kickoffIds(input.operationId);
      const kickoff = {
        sessionId: started.sessionId,
        text: `${delegatedTaskMarker(parent.sessionId)}\n\n${input.task}`,
        commandId: ids.commandId,
        messageId: ids.messageId,
        origin: { kind: "session" as const, sessionId: parent.sessionId },
      };
      if (started.state !== "ready") {
        // Nothing can run the task yet, so it is HELD in the child's own
        // durable queue under the kickoff's ids (VC-799), released at the
        // child's next ready attach — a person's Retry. Boot recovery leaves a
        // child holding it alone (`recover`).
        //
        // No watch is armed here. A held child is not work in progress: its
        // parent's own watchers would defer their turn-end notices on it, for
        // a child that may never be retried. When the held task's turn opens,
        // `rearm` (armed on that wake in `agents.ts`) watches it under this
        // delegation's own `:answer` ids, since its notice never landed.
        let taskHeld = false;
        try {
          await ports.submitSessionMessage({ ...kickoff, delivery: "queue" });
          taskHeld = true;
        } catch (error) {
          report(
            `delegated task for subagent ${shortSessionId(started.sessionId)} could not be held for its retry: ${errorText(error)}`,
          );
        }
        return {
          childSessionId: started.sessionId,
          handle: shortSessionId(started.sessionId),
          title,
          model: started.model,
          state: "needs-recovery",
          taskHeld,
        };
      }
      // Watch BEFORE the kickoff, from the sequence the start left the child
      // at, so the turn the kickoff opens cannot end between the two.
      if (!live.has(started.sessionId)) {
        await watchChild(
          {
            operationId: input.operationId,
            parentSessionId: parent.sessionId,
            childSessionId: started.sessionId,
            title,
            projectId: parent.projectId,
          },
          started.throughSequence,
          noticeIds(input.operationId),
          false,
        );
        await watchParent(parent);
      }
      // Detached, for the reason `start-session.ts` detaches its kickoff: the
      // runtime answers a `message.submit` when the turn it opened ends, and
      // this call is due now. A refusal lands in the child's own durable
      // state — the watcher reads it there — and in the log.
      void Promise.resolve()
        .then(() => ports.submitSessionMessage(kickoff))
        .catch(async (error: unknown) => {
          report(
            `delegated task for subagent ${shortSessionId(started.sessionId)} was not delivered: ${errorText(error)}`,
          );
          // A durable refusal is the watcher's to settle, at the earliest
          // outcome in the child's ledger: settling on it here could beat a
          // stop committed before it. Only a kickoff that never reached the
          // ledger is settled here.
          if (error instanceof KickoffRefusedError) return;
          const child = live.get(started.sessionId);
          if (child !== undefined && !child.resumed) await settle(child, "failed");
        })
        .catch((error: unknown) => {
          report(
            `could not notify parent of failed subagent ${shortSessionId(started.sessionId)}: ${errorText(error)}`,
          );
        });
      return {
        childSessionId: started.sessionId,
        handle: shortSessionId(started.sessionId),
        title,
        model: started.model,
        state: "running",
      };
    },
    liveChildren(parentSessionId) {
      return childrenOf(parentSessionId).map((entry) => entry.childSessionId);
    },
    watching(childSessionId) {
      return live.has(childSessionId);
    },
    async rearm({ answered, ...entry }, resumed) {
      if (live.has(entry.childSessionId)) return;
      // Only a turn someone OPENED reports again (VC-809). A host notice the
      // child is told — its own shell exiting, a Browser Tab event — opens a
      // turn too, but nobody resumed the child, and the parent already has
      // its answer. The origin is read only when this wake's turn is still
      // the latest; otherwise, or when it cannot be read, it stays unknown
      // and the child reports, as before.
      if (answered && (await openedByHostNotice(entry.childSessionId, resumed.turnId))) return;
      if (live.has(entry.childSessionId)) return;
      // A delegation whose own notice never landed — a child a person retried
      // after its first attach failed — answers under the delegation's ids, so
      // boot recovery does not tell the parent a second time.
      await watchChild(
        entry,
        resumed.afterSequence,
        answered
          ? resumedNoticeIds(entry.operationId, resumed.turnId)
          : noticeIds(entry.operationId),
        true,
      );
    },
    async rearmJoined({ answered, ...entry }, joined) {
      // An unanswered delegation re-arms on any turn's start already.
      if (!answered || isHostNoticeOrigin(joined.origin)) return;
      if (live.has(entry.childSessionId)) return;
      let turnId: string | null;
      try {
        const { projection } = await ports.runtime.projection({ sessionId: entry.childSessionId });
        turnId = projection.turnActive ? projection.latestTurnId : null;
      } catch (error) {
        report(
          `could not read subagent ${shortSessionId(entry.childSessionId)}'s running turn: ${errorText(error)}`,
        );
        return;
      }
      if (turnId === null || live.has(entry.childSessionId)) return;
      // Keyed on the joined turn, so a racing `rearm` for the same turn
      // spends the same ids and the parent is told once.
      await watchChild(
        entry,
        joined.afterSequence,
        resumedNoticeIds(entry.operationId, turnId),
        true,
      );
    },
    async recover(unanswered) {
      const recovery: DelegationRecovery = { answered: 0, reported: 0, skipped: 0 };
      for (const entry of unanswered) {
        const events = await ports.sessionEngine.listEvents({ sessionId: entry.childSessionId });
        let { state } = foldSessionAnswerState(events);
        let stoppedBy = lastStopActor(events);
        let reason: SubagentNoticeReason | null = state === "interrupted" ? "app-relaunched" : null;
        // Recovery settles the original watch at its earliest outcome, just
        // like live delivery. A later stop (or relaunch sweep) cannot erase a
        // rejected kickoff whose frame never reached the watcher.
        let firstOutcome = events.find(
          (event) => outcomeOf(event.payload, entry.operationId) !== null,
        );
        // A failed first attach is not the delegation's outcome when the task
        // was held for a Retry (VC-799). Not yet run, and still queued: the
        // Retry's turn is what reports, through `rearm`, and a notice now
        // would be a second one then. Already run: that turn's outcome is it.
        if (firstOutcome?.payload.kind === "attachment.failed") {
          const failedAt = firstOutcome.sequence;
          const heldRun = events.find(
            (event) => event.sequence > failedAt && event.payload.kind === "turn.started",
          );
          if (heldRun === undefined) {
            if (await holdsTask(entry)) {
              recovery.skipped += 1;
              continue;
            }
          } else {
            firstOutcome = events.find(
              (event) =>
                event.sequence > heldRun.sequence &&
                outcomeOf(event.payload, entry.operationId) !== null,
            );
          }
        }
        const firstState =
          firstOutcome === undefined ? null : outcomeOf(firstOutcome.payload, entry.operationId);
        if (firstOutcome !== undefined && firstState !== null) {
          state = firstState;
          reason =
            state === "interrupted" && !isParentStop(stoppedBy, entry.parentSessionId)
              ? "app-relaunched"
              : null;
          stoppedBy =
            firstOutcome.payload.kind === "session.stopped" ? firstOutcome.payload.by : null;
        }
        const ids = noticeIds(entry.operationId);
        switch (state) {
          case "completed":
            await deliver(entry, ids, state);
            recovery.answered += 1;
            break;
          case "interrupted":
          case "failed":
            await deliver(entry, ids, state, reason);
            recovery.reported += 1;
            break;
          case "stopped":
            if (isParentStop(stoppedBy, entry.parentSessionId)) {
              recovery.skipped += 1;
            } else {
              await deliver(entry, ids, state, null, stoppedBy);
              recovery.reported += 1;
            }
            break;
          case "running":
            // Unreachable after the boot sweep, which closes every open
            // attachment before this runs; counted rather than guessed at.
            report(
              `subagent ${shortSessionId(entry.childSessionId)} still reads as mid-turn after the relaunch sweep; not reported`,
            );
            recovery.skipped += 1;
            break;
          case "not-started":
            recovery.skipped += 1;
            break;
          default:
            state satisfies never;
        }
      }
      return recovery;
    },
  };
}

function isParentStop(by: SessionStopActor | null, parentSessionId: string): boolean {
  return by?.kind === "session" && by.sessionId === parentSessionId;
}

/** The last committed stop, including its sequence for delayed-frame ordering. */
function lastStopEvent(events: readonly SessionEvent[]): SessionEvent | null {
  return events.findLast((event) => event.payload.kind === "session.stopped") ?? null;
}

/** Who recorded the last stop in a ledger, or null when none did. */
function lastStopActor(events: readonly SessionEvent[]): SessionStopActor | null {
  const stop = lastStopEvent(events);
  return stop?.payload.kind === "session.stopped" ? stop.payload.by : null;
}
