/**
 * The bounded cloud fold of one Session (`CloudSessionState`): the Session's
 * current state, small enough to live in one backend document.
 *
 * The local fold (`SessionProjectionCheckpoint`) keeps every command, every
 * receipt, every attachment and every resolved interaction, so it grows with
 * the Session and cannot be one document. The cloud fold runs the SAME
 * reducer (`advanceSessionProjection`), so the two cannot disagree about what
 * a fact means, and then trims what the cloud keeps elsewhere: commands and
 * receipts are queried from the accepted events and the runner inbox, resolved
 * history from the events, and only the attachments current state can still
 * depend on are kept.
 *
 * What the trim drops is either unread by the reducer (commands, receipts,
 * resolved interactions, resumptions) or read only to answer a question the
 * kept rows still answer (whether any attachment ever opened, the attachment a
 * late exit or native reference names). Adapter-native detail (recovery
 * locators, diagnostics) is cleared too: every reader of the cloud fold scrubs
 * it, and it is the part whose size an adapter decides. Active attention and
 * interactions are capped, oldest first, with a counter, so a runaway executor
 * cannot grow the document; the fold is otherwise exactly the local one, which
 * the parity test holds (with native detail compared scrubbed).
 *
 * A state is valid only for the fold version and the event vocabulary that
 * wrote it. Another version (a reducer shape change) or vocabulary (a kind
 * added) is a refold from the accepted history, never a reinterpretation of
 * the old document.
 */

import {
  SESSION_PROJECTION_CHECKPOINT_COMPATIBILITY,
  SESSION_PROJECTION_CHECKPOINT_VERSION,
  advanceSessionProjection,
  createSessionProjectionCheckpoint,
  sessionAwaitsUser,
  type Session,
  type SessionAttachmentProjection,
  type SessionAttention,
  type SessionInteraction,
  type SessionProjection,
  type SessionProjectionCheckpoint,
  type SessionProjectionEvent,
  type SessionReplyLocation,
  type SessionTurnOutcome,
} from "../session-ledger";
import type { ModelSelection } from "../agent-runtime";
import type { ModelTier } from "../model-access-policy";
import type { ModelAutoPick } from "../model-auto-select";
import type { SessionOrigin } from "../session-origin";
import type { SessionStopDetail } from "../session-stop";
import type { SessionTodoList } from "../session-todo";
import type { SessionUsageSummary } from "../session-usage";

/**
 * The version of the cloud fold's stored shape. It moves with the local
 * checkpoint version it is built on, so a reducer shape change there is a
 * refold here without anyone remembering to bump two numbers.
 */
export const CLOUD_SESSION_FOLD_VERSION = SESSION_PROJECTION_CHECKPOINT_VERSION * 100 + 1;

/** The contract: one state document stays under this many UTF-8 bytes. */
export const CLOUD_SESSION_STATE_MAX_BYTES = 64 * 1024;

/** Active attention items and active interactions kept, each; older ones are dropped and counted. */
const ACTIVE_LIMIT = 32;

/** How the trim behaves at one level. A later level only runs when the one before is still too big. */
interface TrimLevel {
  /** Closed or failed attachments kept, newest first, beside every open one. */
  closedAttachments: number;
  active: number;
  /** Unresolved executor starts and attributed commands kept, newest first. */
  pending: number;
  /** Clamp for the free-text fields a person or agent wrote (title, signal and stop reasons). */
  textLimit: number | null;
  keepTodoList: boolean;
}

const LEVELS: readonly TrimLevel[] = [
  {
    closedAttachments: 3,
    active: ACTIVE_LIMIT,
    pending: 16,
    textLimit: null,
    keepTodoList: true,
  },
  { closedAttachments: 0, active: 1, pending: 1, textLimit: 1024, keepTodoList: false },
  // The last resort: no active items at all (counted as dropped), short text.
  { closedAttachments: 0, active: 0, pending: 1, textLimit: 256, keepTodoList: false },
];

/** The reducer state the cloud keeps: a local checkpoint, trimmed, without its build markers. */
export type CloudSessionFold = Omit<SessionProjectionCheckpoint, "version" | "compatibility">;

export interface CloudSessionState {
  foldVersion: typeof CLOUD_SESSION_FOLD_VERSION;
  /**
   * The event vocabulary the fold was written under. A build that knows more
   * kinds refolds, so facts stored unread under an older one are folded.
   */
  compatibility: typeof SESSION_PROJECTION_CHECKPOINT_COMPATIBILITY;
  /**
   * Every accepted fact through this sequence has been considered. Facts the
   * fold could not read (an unknown kind, a quarantined payload) are passed
   * over, so this can be ahead of `fold.throughSequence`, the last fact folded.
   */
  throughSequence: number;
  fold: CloudSessionFold;
  /** Active items the cap dropped, oldest first, over the Session's life. */
  dropped: { attention: number; interactions: number };
  /**
   * A tighter trim level ran at some point in the Session's life: the plan
   * was dropped, long free text clamped, and active items beyond the level's
   * cap dropped then. Sticky, because what it dropped stays dropped.
   */
  truncated: boolean;
}

/**
 * Thrown when even the tightest trim cannot bring the state under its bound:
 * only a fact whose own fixed fields (a model id, a turn id) are enormous. The
 * caller sets that fact aside rather than folding it.
 */
export class CloudSessionStateTooLargeError extends Error {
  readonly bytes: number;

  constructor(bytes: number) {
    super(
      `The Session's cloud state is ${bytes} bytes after trimming; the bound is ${CLOUD_SESSION_STATE_MAX_BYTES}.`,
    );
    this.name = "CloudSessionStateTooLargeError";
    this.bytes = bytes;
  }
}

/**
 * A stored state this build can advance, or `null` when it was written by
 * another fold version (or is not a state at all): the caller refolds.
 */
export function readCloudSessionState(value: unknown): CloudSessionState | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Partial<CloudSessionState>;
  return state.foldVersion === CLOUD_SESSION_FOLD_VERSION &&
    state.compatibility === SESSION_PROJECTION_CHECKPOINT_COMPATIBILITY
    ? (state as CloudSessionState)
    : null;
}

/**
 * Folds `events` onto `previous` (or onto `session`'s birth when there is no
 * previous state) and trims the result to its bound.
 *
 * `events` are the readable facts after `previous.throughSequence`, in any
 * order; `through` is the last accepted sequence they cover, which may be past
 * the last readable one. The fold is pure: the same inputs give the same state.
 */
export function foldCloudSessionState(
  previous: CloudSessionState | null,
  session: Session,
  events: readonly SessionProjectionEvent[],
  through: number,
): CloudSessionState {
  const after = previous?.throughSequence ?? 0;
  if (!Number.isInteger(through) || through < after) {
    throw new Error(`Cannot fold a Session's cloud state back to ${through} from ${after}`);
  }
  for (const event of events) {
    if (event.sessionId !== session.id || event.sequence <= after || event.sequence > through) {
      throw new Error(
        `Event ${event.sequence} of ${event.sessionId} is outside the fold window (${after}, ${through}]`,
      );
    }
  }
  const checkpoint =
    previous === null
      ? createSessionProjectionCheckpoint(session, events)
      : advanceSessionProjection(
          {
            ...previous.fold,
            version: SESSION_PROJECTION_CHECKPOINT_VERSION,
            compatibility: SESSION_PROJECTION_CHECKPOINT_COMPATIBILITY,
          },
          events,
        );
  const { version: _version, compatibility: _compatibility, ...fold } = checkpoint;
  return bound(
    fold,
    through,
    previous?.dropped ?? { attention: 0, interactions: 0 },
    previous?.truncated ?? false,
  );
}

/** UTF-8 bytes of the state as JSON: what the bound measures. */
function cloudSessionStateBytes(state: CloudSessionState): number {
  return new TextEncoder().encode(JSON.stringify(state)).length;
}

function bound(
  fold: CloudSessionFold,
  throughSequence: number,
  dropped: CloudSessionState["dropped"],
  truncated: boolean,
): CloudSessionState {
  let bytes = 0;
  for (const [index, level] of LEVELS.entries()) {
    const state = trim(fold, throughSequence, dropped, level, truncated || index > 0);
    bytes = cloudSessionStateBytes(state);
    if (bytes <= CLOUD_SESSION_STATE_MAX_BYTES) return state;
  }
  throw new CloudSessionStateTooLargeError(bytes);
}

function newest<T>(items: readonly T[], limit: number): { kept: T[]; dropped: number } {
  const dropped = Math.max(0, items.length - limit);
  return { kept: items.slice(dropped), dropped };
}

function clamp(text: string | null, limit: number | null): string | null {
  if (text === null || limit === null || text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function trim(
  fold: CloudSessionFold,
  throughSequence: number,
  dropped: CloudSessionState["dropped"],
  level: TrimLevel,
  truncated: boolean,
): CloudSessionState {
  const { projection } = fold;
  const attachments = keptAttachments(projection.attachments, level.closedAttachments).map(
    withoutNative,
  );
  const attention = newest(projection.attention.active, level.active);
  const interactions = newest(projection.interactions.active, level.active);
  const keptAttention = attention.kept.map((item) => ({ ...item, diagnostic: null }));
  const {
    todoList,
    commands: _commands,
    receipts: _receipts,
    resumptions: _resumptions,
    ...rest
  } = projection;
  const trimmed: SessionProjection = {
    ...rest,
    session: { ...projection.session, title: clamp(projection.session.title, level.textLimit) },
    commands: [],
    receipts: [],
    resumptions: [],
    attachments,
    liveExecutor: projection.liveExecutor === null ? null : withoutNative(projection.liveExecutor),
    attention: { active: keptAttention, primary: keptAttention.at(-1) ?? null },
    interactions: {
      active: interactions.kept.map((item) => ({ ...item, native: { id: null, detail: null } })),
      resolved: [],
    },
    signal:
      projection.signal === null
        ? null
        : { ...projection.signal, reason: clamp(projection.signal.reason, level.textLimit) },
    stopped:
      projection.stopped === null
        ? null
        : { ...projection.stopped, reason: clamp(projection.stopped.reason, level.textLimit) },
    ...(todoList !== undefined && level.keepTodoList ? { todoList } : {}),
  };
  return {
    foldVersion: CLOUD_SESSION_FOLD_VERSION,
    compatibility: SESSION_PROJECTION_CHECKPOINT_COMPATIBILITY,
    throughSequence,
    fold: {
      ...fold,
      projection: trimmed,
      pendingExecutorStarts: newest(fold.pendingExecutorStarts, level.pending).kept,
      pendingAttachmentCommands: newest(fold.pendingAttachmentCommands, level.pending).kept,
      pendingTurnCommands: newest(fold.pendingTurnCommands, level.pending).kept,
    },
    dropped: {
      attention: dropped.attention + attention.dropped,
      interactions: dropped.interactions + interactions.dropped,
    },
    truncated,
  };
}

/**
 * An attachment without the adapter-native detail (recovery locators,
 * diagnostics) the reducer only carries along: no reader of the cloud fold
 * may see it, and it is the one part of an attachment whose size an adapter
 * decides.
 */
function withoutNative(attachment: SessionAttachmentProjection): SessionAttachmentProjection {
  return {
    ...attachment,
    native: null,
    failure: attachment.failure === null ? null : { ...attachment.failure, diagnostic: null },
  };
}

/**
 * Every open attachment, the newest `closed` others, and the newest one that
 * ever opened: the reducer asks "did any attachment open before?" to mark a
 * re-attach, and a kept opened row answers it as the whole list would.
 */
function keptAttachments(
  attachments: readonly SessionAttachmentProjection[],
  closed: number,
): SessionAttachmentProjection[] {
  const others = attachments.filter(({ status }) => status !== "open");
  const keep = new Set(newest(others, closed).kept.map(({ id }) => id));
  const opened = attachments.findLast(({ openedAt }) => openedAt !== null);
  if (opened !== undefined) keep.add(opened.id);
  return attachments.filter(({ id, status }) => status === "open" || keep.has(id));
}

/** What a reader of one Session's current state sees: the fields of the bounded fold. */
export interface CloudSessionView {
  /** The Session as folded: its current title, and its birth fields. */
  session: Session;
  status: SessionProjection["status"];
  latestTurnId: string | null;
  latestTurnOrigin: SessionOrigin | null;
  turnActive: boolean;
  lastTurnOutcome: SessionTurnOutcome | null;
  lastTurnStopDetail: SessionStopDetail | null;
  /** The one open attachment, or `null`. */
  liveAttachment: SessionAttachmentProjection | null;
  /** The newest executor start still waiting for its attachment. */
  pendingExecutorStartId: string | null;
  attention: { active: SessionAttention[]; primary: SessionAttention | null; dropped: number };
  interactions: { active: SessionInteraction[]; dropped: number };
  /** Waiting on its person: an open interaction or an attention only they can clear. */
  needsUser: boolean;
  signal: SessionProjection["signal"];
  stopped: SessionProjection["stopped"];
  modelSelection: ModelSelection | null;
  modelTier: ModelTier | null;
  modelAuto: ModelAutoPick | null;
  usage: SessionUsageSummary;
  todoList: SessionTodoList | null;
  latestReply: SessionReplyLocation | null;
  resumedAfterStop: boolean;
  lastActivityAt: number;
  bornTicketless: boolean;
  throughSequence: number;
  truncated: boolean;
}

export function cloudSessionView(state: CloudSessionState): CloudSessionView {
  const projection = state.fold.projection;
  return {
    session: projection.session,
    status: projection.status,
    latestTurnId: projection.latestTurnId,
    latestTurnOrigin: projection.latestTurnOrigin,
    turnActive: projection.turnActive,
    lastTurnOutcome: projection.lastTurnOutcome,
    lastTurnStopDetail: projection.lastTurnStopDetail ?? null,
    liveAttachment: projection.liveExecutor,
    pendingExecutorStartId: projection.pendingExecutorStart?.id ?? null,
    attention: {
      active: [...projection.attention.active],
      primary: projection.attention.primary,
      dropped: state.dropped.attention,
    },
    interactions: {
      active: [...projection.interactions.active],
      dropped: state.dropped.interactions,
    },
    needsUser: sessionAwaitsUser(projection),
    signal: projection.signal,
    stopped: projection.stopped,
    modelSelection: projection.modelSelection,
    modelTier: projection.modelTier,
    modelAuto: projection.modelAuto ?? null,
    usage: projection.usage,
    todoList: projection.todoList ?? null,
    latestReply: projection.latestReply ?? null,
    resumedAfterStop: projection.resumedAfterStop,
    lastActivityAt: projection.lastActivityAt,
    bornTicketless: projection.bornTicketless,
    throughSequence: state.throughSequence,
    truncated: state.truncated,
  };
}
