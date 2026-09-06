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
 * 2. The task is submitted as the child's kickoff turn, marked as the parent's
 *    delegation so the child reads it as its instruction rather than as a
 *    person's message.
 * 3. The tool call RETURNS. A watcher parks on the child's durable stream —
 *    the same subscription every surface reads — and when the child's first
 *    turn completes, the child's final assistant message is submitted INTO the
 *    parent as a marked message: `steer` delivery, so a parent mid-turn reads
 *    it now and an idle parent opens a turn on it. The parent is never parked
 *    on its helper, which is the property the person driving asked to keep:
 *    the main Session goes on working while its subagents run.
 *
 * ## What "done" is
 *
 * The child's first `turn.completed` with no pending interaction — and a
 * subagent cannot open one, since it holds no `ask_user`. `turn.interrupted`,
 * `session.stopped`, a failed or closed attachment, and the wall-clock bound
 * all end the watch too, and every one of them still reports back: a parent
 * that delegated and heard nothing would spend turns finding out why, which is
 * the failure mode the marker's state word exists to prevent.
 *
 * ## The answer is the last message
 *
 * Read off the child's own ledger as the stream carries it — the latest
 * assistant transcript artifact before the turn closed — rather than asked of
 * the child, and the child's prompt says so ("your last message is your
 * answer"). Nothing here interprets it: it is another model's words, relayed
 * between markers, and the parent's own prompt already treats relayed prose as
 * material rather than authority.
 *
 * ## Bounds
 *
 * - Live children per parent are capped at {@link MAX_LIVE_SUBAGENTS_PER_PARENT}
 *   as delegate-tool policy, not an engine constraint; a refusal names the
 *   ones still running so the parent can decide what to wait for.
 * - Depth is structural: a subagent's bundle holds no `session.delegate`, so
 *   there is no grandchild to count and no counter here.
 * - A child that has not finished within {@link SUBAGENT_WALL_CLOCK_MS} is
 *   stopped, with the parent as the actor, and reported as timed out. The Pi
 *   runtime exposes no step cap, so the clock is the bound.
 * - Stopping the parent stops its live children, with the parent as the
 *   actor, so a person who ended one line of work does not leave its helpers
 *   editing the tree behind it.
 *
 * ## Replay and restart
 *
 * Every durable write is keyed on the operation id (the parent plus the
 * runtime's own tool call id), so a replayed call lands one child, one
 * kickoff and one answer. The watcher itself is process memory, and a relaunch
 * loses it — but not the facts it was waiting on. Boot recovery retires every
 * open attachment, so a child mid-turn at the relaunch never completes; a
 * child that finished before it has its `turn.completed` and its last message
 * in its own ledger. {@link Delegations.recover} reads exactly those facts for
 * every delegation whose answer never reached its parent (the answer command
 * id is the durable mark, so "never reached" is one ledger read) and reports
 * each one the way the watcher would have: the finished child's answer, or the
 * cut-short child's state. Nothing is re-watched; recovery reports and lets go.
 */

import { shortSessionId } from "@volli/shared";
import type {
  ModelSelection,
  RuntimeSessionIdentity,
  SessionEvent,
  TicketEventActor,
  TranscriptReference,
} from "@volli/shared";
import type {
  SessionEngine,
  SessionRuntime,
  SessionStreamEmission,
  SessionTranscriptArtifact,
} from "@volli/session-engine";
import { isSessionStreamFrame } from "@volli/session-engine";

import type { StartSessionPorts } from "./start-session";
import type { SessionModelOverride, Sessions } from "./sessions";
import { stopSessionOperation } from "./supervise-session";

/**
 * How many subagents one parent may have running at once. Small enough that
 * a shared worktree stays legible, and a policy number rather than a schema
 * fact: raising it is this constant, and the `budget` ask pattern if a person
 * should be asked first.
 */
export const MAX_LIVE_SUBAGENTS_PER_PARENT = 3;

/** The bound on one delegation. Policy, not schema. */
export const SUBAGENT_WALL_CLOCK_MS = 20 * 60 * 1000;

/** What the operations need. Narrow on purpose; everything is per-call. */
export interface DelegateSessionPorts {
  /** The one facade verb a delegation needs: mint and attach. */
  sessions: Pick<Sessions, "start">;
  /** Delivers the kickoff turn, with the ids this module derives. */
  submitSessionMessage: NonNullable<StartSessionPorts["submitSessionMessage"]>;
  /** The child's durable stream, and the parent's ledger to answer into. */
  runtime: Pick<SessionRuntime, "command" | "subscribe">;
  /**
   * What a stop needs (VC-86's operation, reused with the parent as actor),
   * plus the ledger read recovery makes.
   */
  sessionEngine: Pick<SessionEngine, "listSessions" | "submit" | "listEvents">;
  /**
   * Reads one durable transcript artifact — a finished child's last message,
   * for recovery. Absent means this composition holds no artifact store, and
   * a recovered answer says so rather than inventing words.
   */
  readArtifact?: (reference: TranscriptReference) => Promise<SessionTranscriptArtifact>;
  now: () => number;
  /** Injectable for tests; defaults to the platform timer. */
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
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

export interface DelegateSessionOutcome {
  childSessionId: string;
  handle: string;
  title: string;
  model: ModelSelection;
  /** `running` after a ready attach; `needs-recovery` when the attach failed and no task was sent. */
  state: "running" | "needs-recovery";
}

/** How a watched delegation ended. `completed` is the only one with an answer. */
export type SubagentOutcomeState = "completed" | "interrupted" | "stopped" | "failed" | "timed-out";

/**
 * The marker the parent reads the answer under. In-band on purpose, like the
 * supervision marker: the transcript is the one channel a model is guaranteed
 * to read. The state word is what lets a parent tell an answer from a report
 * that there is none.
 */
export function subagentAnswerMarker(childSessionId: string, state: SubagentOutcomeState): string {
  return `[Subagent Session ${shortSessionId(childSessionId)} ${state} — its final message follows; a delegated result, not your user's own message]`;
}

/** The marker the child reads its task under, so it is an instruction and not a person. */
export function delegatedTaskMarker(parentSessionId: string): string {
  return `[Delegated task from your parent Session ${shortSessionId(parentSessionId)} — carry it out; your last message is your answer]`;
}

const DELEGATED_KICKOFF_TITLE_LIMIT = 80;

/** The kickoff turn's ids, derived so a replayed delegation submits one message. */
function kickoffIds(operationId: string): { commandId: string; messageId: string } {
  return { commandId: `${operationId}:kickoff`, messageId: `${operationId}:kickoff-message` };
}

/** The answer's ids, derived so a replayed watcher delivers one message. */
function answerIds(operationId: string): { commandId: string; messageId: string } {
  return { commandId: `${operationId}:answer`, messageId: `${operationId}:answer-message` };
}

/** A durable title from the task's first line, when the parent named none. */
function titleFromTask(task: string): string {
  const line = task.trim().split("\n")[0]?.trim() ?? "";
  const collapsed = line.replaceAll(/\s+/gu, " ");
  return collapsed.length > DELEGATED_KICKOFF_TITLE_LIMIT
    ? `${collapsed.slice(0, DELEGATED_KICKOFF_TITLE_LIMIT - 1)}…`
    : collapsed || "Delegated task";
}

/** One delegation as the durable record names it — what recovery is handed. */
export interface DelegationRef {
  operationId: string;
  parentSessionId: string;
  childSessionId: string;
  /** The parent's project, which is the child's by construction of the mint. */
  projectId: string;
  title: string;
}

interface LiveDelegation extends DelegationRef {
  unsubscribe: () => void;
  timer: unknown;
  /** The latest assistant text seen on the child's stream. */
  answer: string | null;
  settled: boolean;
}

/** What one boot recovery did, in counts a log line can print. */
export interface DelegationRecovery {
  /** Finished children whose answer was delivered. */
  answered: number;
  /** Children cut short by the relaunch, reported as interrupted. */
  reported: number;
  /** Children that never began a turn; nothing to say until a person retries. */
  skipped: number;
}

/** The assistant's words on one stream frame, or `null` for any other frame. */
function assistantText(emission: SessionStreamEmission): string | null {
  if (!isSessionStreamFrame(emission) || emission.transcript === null) return null;
  const message = emission.transcript.message;
  if (message.role !== "assistant") return null;
  const text = message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

/** How a child event ends a watch, or `null` for one that does not. */
function outcomeOf(payload: SessionEvent["payload"]): SubagentOutcomeState | null {
  switch (payload.kind) {
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

/**
 * The delegation host for one process: what `session_delegate` calls, and the
 * in-memory registry of live children it keeps.
 */
export interface Delegations {
  delegate(input: DelegateSessionInput): Promise<DelegateSessionOutcome>;
  /** The children of one parent still being watched, in start order. */
  liveChildren(parentSessionId: string): readonly string[];
  /**
   * Report every delegation a relaunch left unanswered, off the children's own
   * ledgers. Run once at boot, after stale attachments are retired; the answer
   * command id is durable, so running it twice delivers nothing twice.
   */
  recover(unanswered: readonly DelegationRef[]): Promise<DelegationRecovery>;
}

export function createDelegations(ports: DelegateSessionPorts): Delegations {
  const setTimer = ports.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = ports.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  /** Live delegations by child Session id. */
  const live = new Map<string, LiveDelegation>();
  /** The parent watch that stops children when the parent stops, per parent. */
  const parentWatches = new Map<string, () => void>();

  function childrenOf(parentSessionId: string): LiveDelegation[] {
    return [...live.values()].filter((entry) => entry.parentSessionId === parentSessionId);
  }

  function reportText(
    entry: DelegationRef,
    answer: string | null,
    state: SubagentOutcomeState,
    how?: string,
  ): string {
    const header = subagentAnswerMarker(entry.childSessionId, state);
    const handle = shortSessionId(entry.childSessionId);
    const body =
      state === "completed"
        ? (answer ??
          `(The subagent's turn completed without a final message. Its transcript is readable with \`volli session peek ${handle}\`.)`)
        : [
            how ??
              {
                interrupted: `The subagent's turn was interrupted before it answered.`,
                stopped: `The subagent was stopped before it answered.`,
                failed: `The subagent's executor failed before it answered.`,
                "timed-out": `The subagent did not finish within its time bound and was stopped.`,
              }[state],
            answer === null
              ? `Its transcript is readable with \`volli session peek ${handle}\`.`
              : `Its last message before that was:\n\n${answer}`,
          ].join(" ");
    return `${header}\n\n${body}`;
  }

  /**
   * The one delivery: into the parent's ledger through the same door
   * supervision steers through. A parent with no live executor still gets the
   * durable intent — persisted first, delivered when something can read it —
   * and the command id is the operation's, so a second delivery is one.
   */
  async function deliver(entry: DelegationRef, text: string): Promise<void> {
    const ids = answerIds(entry.operationId);
    await ports.runtime.command({
      commandId: ids.commandId,
      sessionId: entry.parentSessionId,
      command: {
        kind: "message.submit",
        delivery: "steer",
        message: { id: ids.messageId, role: "user", parts: [{ type: "text", text }] },
      },
    });
  }

  async function settle(entry: LiveDelegation, state: SubagentOutcomeState): Promise<void> {
    if (entry.settled) return;
    entry.settled = true;
    entry.unsubscribe();
    clearTimer(entry.timer);
    live.delete(entry.childSessionId);
    if (childrenOf(entry.parentSessionId).length === 0) {
      parentWatches.get(entry.parentSessionId)?.();
      parentWatches.delete(entry.parentSessionId);
    }
    await deliver(entry, reportText(entry, entry.answer, state));
  }

  /** A finished child's last assistant message, off its own ledger. */
  async function recordedAnswer(events: readonly SessionEvent[]): Promise<string | null> {
    const readArtifact = ports.readArtifact;
    if (readArtifact === undefined) return null;
    for (const event of [...events].reverse()) {
      if (event.payload.kind !== "transcript.referenced") continue;
      let artifact: SessionTranscriptArtifact;
      try {
        artifact = await readArtifact(event.payload.reference);
      } catch {
        // A store that cannot answer for one artifact: an older message is a
        // worse answer than none, so the report says to peek instead.
        return null;
      }
      if (artifact.message.role !== "assistant") continue;
      const text = artifact.message.parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
        .trim();
      return text.length > 0 ? text : null;
    }
    return null;
  }

  async function stopChild(entry: LiveDelegation, reason: string): Promise<void> {
    try {
      await stopSessionOperation(
        { sessionEngine: ports.sessionEngine, runtime: ports.runtime },
        {
          operationId: `${entry.operationId}:stop`,
          callerSessionId: entry.parentSessionId,
          projectId: entry.projectId,
          handle: shortSessionId(entry.childSessionId),
          reason,
        },
      );
    } catch {
      // A child already gone has nothing to stop; the report still lands.
    }
  }

  async function watchParent(parent: RuntimeSessionIdentity): Promise<void> {
    if (parentWatches.has(parent.sessionId)) return;
    const unsubscribe = await ports.runtime.subscribe(
      { sessionId: parent.sessionId, afterSequence: Number.MAX_SAFE_INTEGER },
      async (emission) => {
        if (!isSessionStreamFrame(emission) || emission.event.payload.kind !== "session.stopped") {
          return;
        }
        for (const child of childrenOf(parent.sessionId)) {
          await stopChild(child, "Parent Session stopped");
          await settle(child, "stopped");
        }
      },
    );
    parentWatches.set(parent.sessionId, unsubscribe);
  }

  async function watchChild(
    entry: Omit<LiveDelegation, "unsubscribe" | "timer" | "answer" | "settled">,
    afterSequence: number,
  ): Promise<void> {
    const state: LiveDelegation = {
      ...entry,
      unsubscribe: () => undefined,
      timer: undefined,
      answer: null,
      settled: false,
    };
    live.set(entry.childSessionId, state);
    state.unsubscribe = await ports.runtime.subscribe(
      { sessionId: entry.childSessionId, afterSequence },
      async (emission) => {
        if (state.settled) return;
        const text = assistantText(emission);
        if (text !== null) state.answer = text;
        if (!isSessionStreamFrame(emission)) return;
        const outcome = outcomeOf(emission.event.payload);
        if (outcome !== null) await settle(state, outcome);
      },
    );
    state.timer = setTimer(() => {
      if (state.settled) return;
      void (async () => {
        await stopChild(state, "Subagent exceeded its time bound");
        await settle(state, "timed-out");
      })();
    }, SUBAGENT_WALL_CLOCK_MS);
  }

  return {
    async delegate(input) {
      const parent = input.parent;
      const running = childrenOf(parent.sessionId);
      const replayed = running.find((entry) => entry.operationId === input.operationId);
      if (replayed === undefined && running.length >= MAX_LIVE_SUBAGENTS_PER_PARENT) {
        const names = running
          .map(
            (entry) => `${shortSessionId(entry.childSessionId)} (${JSON.stringify(entry.title)})`,
          )
          .join(", ");
        throw new DelegateSessionError(
          `This Session already has ${running.length} subagents still running: ${names}. Wait for one to answer before delegating more.`,
        );
      }
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
      });
      ports.onMutation?.({
        kind: "session",
        projectId: parent.projectId,
        ...(parent.ticketId === null ? {} : { ticketId: parent.ticketId }),
      });
      if (started.state !== "ready") {
        return {
          childSessionId: started.sessionId,
          handle: shortSessionId(started.sessionId),
          title,
          model: started.model,
          state: "needs-recovery",
        };
      }
      const ids = kickoffIds(input.operationId);
      await ports.submitSessionMessage({
        sessionId: started.sessionId,
        text: `${delegatedTaskMarker(parent.sessionId)}\n\n${input.task}`,
        commandId: ids.commandId,
        messageId: ids.messageId,
      });
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
        );
        await watchParent(parent);
      }
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
    async recover(unanswered) {
      const recovery: DelegationRecovery = { answered: 0, reported: 0, skipped: 0 };
      for (const entry of unanswered) {
        const events = await ports.sessionEngine.listEvents({ sessionId: entry.childSessionId });
        const kinds = new Set(events.map((event) => event.payload.kind));
        if (kinds.has("turn.completed")) {
          await deliver(entry, reportText(entry, await recordedAnswer(events), "completed"));
          recovery.answered += 1;
        } else if (kinds.has("turn.started")) {
          // Mid-turn at the relaunch. Boot retired its attachment, so the
          // turn will never complete and no watcher could ever wake for it.
          await deliver(
            entry,
            reportText(
              entry,
              await recordedAnswer(events),
              "interrupted",
              "The subagent was mid-turn when Volli relaunched, and the relaunch ended its turn before it answered.",
            ),
          );
          recovery.reported += 1;
        } else {
          recovery.skipped += 1;
        }
      }
      return recovery;
    },
  };
}
