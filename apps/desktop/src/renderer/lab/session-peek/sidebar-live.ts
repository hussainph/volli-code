/**
 * VC-30 × VC-108 — the sidebar over time: what is UNREAD, and an Active order
 * that holds still.
 *
 * Everything else in the integration scratch is a still life. These two
 * questions only exist in motion — a result arriving while you look elsewhere,
 * a row moving out from under the pointer — so this is the pure half that lets
 * the scratch play a few minutes of a working afternoon through the SHIPPED
 * listing builder and show what each rule does to it.
 *
 * UNREAD IS ITS OWN AXIS, not another activity state (the VC-108 audit's core
 * finding, kept). A Session becomes unread when a turn ends while it is not in
 * front, or when a person says so; it becomes read when it is opened, when a
 * reply is sent to it, or when its conversation is viewed. A peek alone never
 * reads it (decided 2026-09-30: a glance must not clear what was not read; the
 * scratch keeps the alternatives only to compare). Nothing about reading
 * changes a Session's activity or its recency: a
 * read receipt is not work.
 *
 * WHAT UNREAD DOES TO THE BANDS: an unread Session is not done with you, so the
 * clock cannot retire it. It stays in Active past the 30-minute quiet window
 * until it is read, and a Previous Session marked unread comes back. Previous
 * therefore means "seen, or nothing to see" — never merely "old".
 *
 * THE HELD ORDER (the owner's rule, 2026-09-29): the shipped band sorts by
 * recency on every build, so a working Session climbs on each tool call and a
 * click target moves several times a minute. Held, the band keeps each row
 * where it is. Decided (2026-09-29/30), a row moves for exactly two reasons:
 *
 *   • a new QUESTION: it floats to the very top, because a Session waiting on
 *     the person is the one row they must not have to hunt for;
 *   • a new TURN (idle → working, which a person usually caused) or a first
 *     appearance: it goes to the top too, but lands under the questions still
 *     open, so a busy Session cannot push one out of first place.
 *
 * Everything else — tool calls, a finished turn, an ANSWER, a read — leaves a
 * row where it is. An answered question is pinned where it floated: it does
 * not step down under another one still asked, because the person just acted
 * on it. "hold" keeps the rule's literal reading (questions move nothing), to
 * compare. While a person is pointing into the sidebar or has a peek open,
 * nothing moves at all: moves wait, and land when they leave. Moves land
 * without animation (decided 2026-09-30).
 */
import type { ChatSessionRecord, ChatWaitingReason } from "@volli/shared";

import type {
  ActiveSessionListing,
  ActiveSessionRow,
  BuildActiveSessionListingInput,
  PreviousSessionRow,
} from "@renderer/components/sidebar/active-session-listing";

import { NOW } from "../fixtures";
import { CHAT_RECORDS, LISTING_INPUT } from "./sidebar-corpus";
import { corpusIdOf } from "./sidebar-model";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** What a script or a person can change about one chat Session. */
export interface LiveOverlay {
  readonly activity: ChatSessionRecord["activity"];
  readonly waitingOn: ChatWaitingReason | null;
  readonly lastActivityAt: number;
  readonly live: boolean;
}

/** The lab's world: a clock, what has changed per Session, and who is unread. */
export interface World {
  readonly now: number;
  /** Corpus id → the fields that have moved off the corpus record. */
  readonly sessions: Readonly<Record<string, LiveOverlay>>;
  /** Corpus id → when it became unread. Absent means read (or never finished a turn). */
  readonly unread: Readonly<Record<string, number>>;
}

/**
 * Where the afternoon starts. Two results nobody has looked at yet: a turn
 * that died fourteen minutes ago, and a ticketless Session that finished six
 * hours ago — which is the case the shipped band loses, because the clock
 * moved it to Previous long before anyone read it.
 */
export const WORLD_START: World = {
  now: NOW,
  sessions: {},
  unread: { "chat-a4": NOW - 14 * MINUTE, "chat-p8": NOW - 6 * 60 * MINUTE },
};

export type WorldEvent =
  | { readonly kind: "advance"; readonly ms: number }
  /** A tool call or a streamed message: the Session did something, and nothing else changed. */
  | { readonly kind: "tool-call"; readonly id: string }
  /** idle → working: a new turn, usually because a person sent something. */
  | { readonly kind: "turn-start"; readonly id: string }
  /** working → idle. Unread unless it happened in front of the person. */
  | { readonly kind: "turn-complete"; readonly id: string; readonly inFront: boolean }
  | { readonly kind: "ask"; readonly id: string }
  /** waiting → working: the question was answered and the same turn carries on. */
  | { readonly kind: "answer"; readonly id: string }
  | { readonly kind: "read"; readonly id: string }
  | { readonly kind: "unread"; readonly id: string }
  /** Put one Session's live fields back — the Undo of a send that never left. */
  | { readonly kind: "restore"; readonly id: string; readonly overlay: LiveOverlay | null };

const BASE = new Map(CHAT_RECORDS.map((record) => [record.sessionId, record]));

export function liveOf(world: World, id: string): LiveOverlay | null {
  const overlay = world.sessions[id];
  if (overlay !== undefined) return overlay;
  const record = BASE.get(id);
  return record === undefined
    ? null
    : {
        activity: record.activity,
        waitingOn: record.waitingOn,
        lastActivityAt: record.lastActivityAt,
        live: record.live,
      };
}

function withLive(world: World, id: string, patch: Partial<LiveOverlay>): World {
  const current = liveOf(world, id);
  if (current === null) return world;
  return { ...world, sessions: { ...world.sessions, [id]: { ...current, ...patch } } };
}

function withoutUnread(world: World, id: string): World {
  if (world.unread[id] === undefined) return world;
  const { [id]: _read, ...rest } = world.unread;
  return { ...world, unread: rest };
}

export function applyWorld(world: World, event: WorldEvent): World {
  switch (event.kind) {
    case "advance":
      return { ...world, now: world.now + event.ms };
    case "tool-call":
      return withLive(world, event.id, { lastActivityAt: world.now });
    case "turn-start":
      return withLive(world, event.id, {
        activity: "working",
        waitingOn: null,
        live: true,
        lastActivityAt: world.now,
      });
    case "turn-complete": {
      const done = withLive(world, event.id, {
        activity: "idle",
        waitingOn: null,
        lastActivityAt: world.now,
      });
      return event.inFront ? done : { ...done, unread: { ...done.unread, [event.id]: world.now } };
    }
    case "ask":
      return withLive(world, event.id, {
        activity: "waiting",
        waitingOn: "question",
        lastActivityAt: world.now,
      });
    case "answer":
      return withLive(world, event.id, {
        activity: "working",
        waitingOn: null,
        lastActivityAt: world.now,
      });
    case "read":
      return withoutUnread(world, event.id);
    case "unread":
      return { ...world, unread: { ...world.unread, [event.id]: world.now } };
    case "restore": {
      if (event.overlay !== null) {
        return { ...world, sessions: { ...world.sessions, [event.id]: event.overlay } };
      }
      const { [event.id]: _restored, ...rest } = world.sessions;
      return { ...world, sessions: rest };
    }
  }
}

/** The shipped builder's input for this world: the corpus records with their live fields. */
export function listingInputOf(
  world: World,
): Omit<BuildActiveSessionListingInput, "now" | "filter"> {
  const chatSessions: ChatSessionRecord[] = [];
  for (const record of CHAT_RECORDS) {
    const overlay = world.sessions[record.sessionId];
    chatSessions.push(overlay === undefined ? record : { ...record, ...overlay });
  }
  return { ...LISTING_INPUT, chatSessions };
}

/* ----------------------------------------------------------------- the script */

/** What the script can make a Session do. A turn's end becomes unread or not at play time. */
export interface ScriptEvent {
  readonly kind: "tool-call" | "turn-start" | "ask" | "turn-end";
  readonly id: string;
}

export interface ScriptStep {
  /** How much time passes before this happens. */
  readonly after: number;
  readonly event: ScriptEvent;
  /** What happened, in the words the scratch shows. */
  readonly note: string;
}

/**
 * Two and a half minutes of an ordinary afternoon, chosen so that every rule
 * gets exercised: two working Sessions trading tool calls (the shipped band
 * swaps them each time), a turn finishing out of sight (unread, and in the
 * shipped band a drop), a quiet Session starting a new turn, and a working
 * Session asking a question — the only two moves the held order makes.
 */
export const SCRIPT: readonly ScriptStep[] = [
  {
    after: 10 * SECOND,
    event: { kind: "tool-call", id: "chat-a3" },
    note: "Warm-park timer ran a tool",
  },
  {
    after: 10 * SECOND,
    event: { kind: "tool-call", id: "chat-a2" },
    note: "Chat (VLT-14) ran a tool",
  },
  {
    after: 15 * SECOND,
    event: { kind: "turn-end", id: "chat-a3" },
    note: "Warm-park timer finished its turn — unread",
  },
  {
    after: 10 * SECOND,
    event: { kind: "tool-call", id: "chat-a2" },
    note: "Chat (VLT-14) ran a tool",
  },
  {
    after: 20 * SECOND,
    event: { kind: "turn-start", id: "chat-a5" },
    note: "Backlog scan started a new turn — held, it moves up, under the question",
  },
  {
    after: 10 * SECOND,
    event: { kind: "tool-call", id: "chat-a5" },
    note: "Backlog scan ran a tool",
  },
  {
    after: 15 * SECOND,
    event: { kind: "tool-call", id: "chat-a2" },
    note: "Chat (VLT-14) ran a tool",
  },
  {
    after: 20 * SECOND,
    event: { kind: "ask", id: "chat-a2" },
    note: "Chat (VLT-14) asked a question — held, it floats to the top",
  },
  {
    after: 15 * SECOND,
    event: { kind: "tool-call", id: "chat-a5" },
    note: "Backlog scan ran a tool",
  },
  {
    after: 30 * SECOND,
    event: { kind: "turn-end", id: "chat-a5" },
    note: "Backlog scan finished its turn — unread",
  },
];

/** One step of the script as world events: the time passing, then the thing. */
export function scriptEvents(step: ScriptStep, inFront: string): readonly WorldEvent[] {
  const { event } = step;
  const happened: WorldEvent =
    event.kind === "turn-end"
      ? { kind: "turn-complete", id: event.id, inFront: inFront === event.id }
      : { kind: event.kind, id: event.id };
  return [{ kind: "advance", ms: step.after }, happened];
}

/* ------------------------------------------------------------------ the bands */

/** The three phases the held order reads. Everything that is not busy is at rest. */
export type Phase = "working" | "waiting" | "idle";

export function phaseOf(row: ActiveSessionRow): Phase {
  if (row.attention !== null) return "waiting";
  return row.activity === "working" ? "working" : "idle";
}

/**
 * A Previous row carried into Active because it is unread. Every field says
 * what the Previous row already knew; nothing is invented to make it fit.
 */
export function asActiveRow(row: PreviousSessionRow): ActiveSessionRow {
  return {
    id: row.id,
    ticket: row.ticket,
    title: row.title,
    source: row.kind === "chat" ? "Chat" : "Terminal",
    harnessId: row.harnessId,
    activity: row.activity === "interrupted" ? "interrupted" : "idle",
    activitySource: "reported",
    attention: null,
    waitingOn: null,
    lastActivityAt: row.endedOrQuietAt,
    provenance: row.provenance,
    target: row.target,
  };
}

/**
 * Who is in Active for this world: the shipped band, then every unread Session
 * the clock would have retired, newest first — in the shipped order, which is
 * also where the held order starts.
 */
export function activeMembers(
  listing: Pick<ActiveSessionListing, "active" | "previous">,
  unread: World["unread"],
): readonly ActiveSessionRow[] {
  const kept = listing.previous
    .filter((row) => unread[corpusIdOf(row.id)] !== undefined)
    .map(asActiveRow);
  return [...listing.active, ...kept];
}

/** Whether a new question floats to the top of a held band, or holds its place too. */
export type QuestionRule = "hold" | "float";

/** The order a held band last committed to, and the phase each row was in then. */
export interface HeldOrder {
  readonly order: readonly string[];
  readonly phases: Readonly<Record<string, Phase>>;
}

/** What a band commits to: the order it drew, and the phase every member was in when it did. */
export function commitOf(order: readonly string[], rows: readonly ActiveSessionRow[]): HeldOrder {
  return {
    order,
    phases: Object.fromEntries(rows.map((row) => [row.id, phaseOf(row)])),
  };
}

/**
 * Where each row goes, given where the band last committed and what changed
 * since. `rows` is this build's Active membership in the shipped order.
 *
 *   1. With nothing committed, the shipped order: the held band starts where
 *      the shipped one would (questions first).
 *   2. Rows still present keep their committed places — an answered question
 *      included: an answer moves nothing.
 *   3. With `float`, a row that has just started asking goes to the very top.
 *   4. A row that is new to the band, or that went idle → working since the
 *      commit, goes to the top — with `float`, just under the lowest question
 *      still open, so it cannot push one down. Several land in the shipped
 *      order, newest first.
 *
 * `float` is positional, not a sort: it never regroups the band, so a row a
 * person just answered stays where it floated to.
 */
export function heldTarget(
  held: HeldOrder | null,
  rows: readonly ActiveSessionRow[],
  questions: QuestionRule,
): readonly string[] {
  if (held === null) return rows.map((row) => row.id);
  const phase = new Map(rows.map((row) => [row.id, phaseOf(row)]));
  const asked =
    questions === "float"
      ? rows
          .filter((row) => phase.get(row.id) === "waiting" && held.phases[row.id] !== "waiting")
          .map((row) => row.id)
      : [];
  const askedSet = new Set(asked);
  const lifted = rows
    .filter((row) => {
      if (askedSet.has(row.id)) return false;
      const before = held.phases[row.id];
      return before === undefined || (before === "idle" && phase.get(row.id) === "working");
    })
    .map((row) => row.id);
  const moved = new Set([...asked, ...lifted]);
  const kept = [...asked, ...held.order.filter((id) => phase.has(id) && !moved.has(id))];
  if (questions === "hold") return [...lifted, ...kept];
  const under = kept.findLastIndex((id) => phase.get(id) === "waiting") + 1;
  return [...kept.slice(0, under), ...lifted, ...kept.slice(under)];
}

/**
 * What a frozen band draws: exactly the committed rows in the committed order
 * — including one the clock or a read would now retire, so nothing leaves from
 * under the pointer — with anything genuinely new appended at the bottom,
 * where adding it moves no row a person could be aiming at.
 */
export function frozenOrder(held: HeldOrder, members: readonly string[]): readonly string[] {
  const committed = new Set(held.order);
  return [...held.order, ...members.filter((id) => !committed.has(id))];
}

export function sameOrder(a: HeldOrder | null, b: HeldOrder): boolean {
  if (a === null || a.order.length !== b.order.length) return false;
  if (a.order.some((id, index) => id !== b.order[index])) return false;
  return a.order.every((id) => a.phases[id] === b.phases[id]);
}
