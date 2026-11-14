import type { UIMessage } from "ai";
import { activityDescriptor, activityStatus, segmentTurn, type BundleRow } from "./activity";
import type { ChatSessionFrame, ChatTranscriptState } from "./transcript";
import type { TranscriptRow } from "./transcript-rows";
import { workPositionKey } from "./work-position";
import { workGist } from "./work-gist";
export { workGist } from "./work-gist";

export type WorkTranscriptRow =
  | Exclude<TranscriptRow, { kind: "turn" }>
  | (Extract<TranscriptRow, { kind: "turn" }> & { viewKey?: string })
  | { kind: "work"; work: TranscriptWorkWindow };

export interface TranscriptWorkWindow {
  key: string;
  rows: readonly BundleRow[];
  startedAt: number | null;
  endedAt: number | null;
  state: "complete" | "open" | "interrupted";
}

/** First recorded appearance, never the clock of a replay or a later tool-result update. */
export function transcriptMessageTimes(
  frames: readonly ChatSessionFrame[],
): ReadonlyMap<string, number> {
  const times = new Map<string, number>();
  for (const frame of frames) {
    const message = frame.transcript?.message;
    const time = frame.event?.occurredAt;
    if (message && time !== undefined && Number.isFinite(time) && !times.has(message.id))
      times.set(message.id, time);
  }
  return times;
}

type Boundary = {
  row: Exclude<WorkTranscriptRow, { kind: "work" }>;
  messageId: string | null;
  sequence: number | null;
  time: number | null;
  order: number;
};
type Activity = {
  row: BundleRow;
  messageId: string;
  positionKey: string;
  sequence: number | null;
  start: number | null;
  order: number;
  slot: number;
  /** One past the last boundary of its own message recorded before it: it may not move above that. */
  lower: number;
};

/**
 * Boundaries per block when searching for the first one an entry precedes.
 * This runs on every streamed chunk over the whole transcript (VC-1145), so the
 * search skips a block whose largest clock and ledger position cannot follow
 * the entry instead of asking every boundary.
 */
const BLOCK = 32;

/**
 * One slot's work, in an order that is a function of its entries, not of how
 * a sort engine happens to pair them. A pairwise comparator that switches
 * between start, ledger sequence and source order per pair is not transitive
 * once some entries lack a clock, so a wall-clock step backwards could pull a
 * later tool above reasoning it followed.
 *
 * An entry with neither a recorded start nor an observed position (settled
 * reasoning, an unreadable tool) is a fixed barrier at its recorded place. The
 * runs between barriers are ordered by one key each: start, then sequence when
 * the whole run has one, then view key (parallel calls with the same start have
 * no serial order, and the key keeps reverse completion from changing owner);
 * else observed sequence, keeping recorded order at a tie except that timed
 * calls side by side still order by start; else recorded order.
 */
function orderSlot(entries: readonly Activity[] | undefined): readonly Activity[] | undefined {
  if (!entries) return undefined;
  const ordered: Activity[] = [];
  let run: Activity[] = [];
  for (const entry of entries) {
    if (unplaced(entry)) {
      ordered.push(...orderRun(run), entry);
      run = [];
    } else run.push(entry);
  }
  ordered.push(...orderRun(run));
  return ordered;
}

function orderRun(run: readonly Activity[]): readonly Activity[] {
  if (run.every((entry) => entry.start !== null)) return byStart(run);
  if (!run.every((entry) => entry.sequence !== null)) return run;
  const bySequence = run.toSorted(
    (left, right) => left.sequence! - right.sequence! || left.order - right.order,
  );
  const ordered: Activity[] = [];
  let timed: Activity[] = [];
  bySequence.forEach((entry, index) => {
    if (entry.start === null) {
      ordered.push(...byStart(timed), entry);
      timed = [];
    } else {
      if (timed.length > 0 && timed[0]!.sequence !== entry.sequence) {
        ordered.push(...byStart(timed));
        timed = [];
      }
      timed.push(entry);
    }
    if (index === bySequence.length - 1) ordered.push(...byStart(timed));
  });
  return ordered;
}

/** Entries that all carry a start: start, then sequence if all have one, then view key. */
function byStart(run: readonly Activity[]): readonly Activity[] {
  const sequenced = run.every((entry) => entry.sequence !== null);
  return run.toSorted(
    (left, right) =>
      left.start! - right.start! ||
      (sequenced ? left.sequence! - right.sequence! : 0) ||
      left.positionKey.localeCompare(right.positionKey),
  );
}

/** Neither a recorded start nor an observed position: fixed at its recorded place. */
function unplaced(entry: Activity): boolean {
  return entry.start === null && entry.sequence === null;
}

function clock(value: number | null | undefined): number | null {
  return value !== undefined && value !== null && Number.isFinite(value) ? value : null;
}
function unfinished(row: BundleRow): boolean {
  return row.kind === "reasoning"
    ? row.streaming
    : ["running", "pending"].includes(activityStatus(row.part));
}

/**
 * Presentation-only ownership. Visible boundaries keep canonical order. Tool
 * starts can be overlay-only, so current message position is NOT start order:
 * a durable notice is appended before the overlay it interrupted. The live
 * fold retains the overlay's ledger position through settlement. Replay uses
 * recorded tool starts; where neither survives, placement remains unconfirmed
 * at the recorded shape, never a fabricated clock or reordered message.
 */
export function projectWorkWindows(
  source: readonly TranscriptRow[],
  messageTimes: ReadonlyMap<string, number>,
  active: boolean,
  evidence?: Pick<ChatTranscriptState, "frames" | "activityFirstOverlaySequence">,
): readonly WorkTranscriptRow[] {
  const sequences = new Map<string, number>();
  const updateSequences = new Map<string, number>();
  const eventTimes = new Map<number, number>();
  for (const frame of evidence?.frames ?? []) {
    const id = frame.transcript?.message.id;
    if (id) {
      if (!sequences.has(id)) sequences.set(id, frame.sequence);
      updateSequences.set(id, Math.max(updateSequences.get(id) ?? 0, frame.sequence));
    }
    const time = clock(frame.event?.occurredAt);
    if (time !== null) eventTimes.set(frame.sequence, time);
  }
  const latest = new Map<
    string,
    { part: Extract<BundleRow, { kind: "tool" }>["part"]; sequence: number }
  >();
  for (const row of source) {
    if (row.kind !== "turn") continue;
    for (const message of row.messages)
      for (const part of message.parts) {
        if (part.type !== "dynamic-tool") continue;
        const prior = latest.get(part.toolCallId);
        const live = ["running", "pending"].includes(activityStatus(part));
        const priorLive =
          prior === undefined || ["running", "pending"].includes(activityStatus(prior.part));
        const sequence = updateSequences.get(message.id) ?? 0;
        // An overlay is appended after durable results, but a stale running
        // shape is not newer than a settled result of the same call.
        if (prior && !priorLive && live) continue;
        if (prior && priorLive === live && sequence < prior.sequence) continue;
        latest.set(part.toolCallId, { part, sequence });
      }
  }
  const boundaries: Boundary[] = [];
  const activities: Activity[] = [];
  const owned = new Set<string>();
  // Each message's latest boundary so far: an activity's lower bound is read
  // here once rather than searched for over every boundary.
  const lastBoundaryOf = new Map<string, number>();
  let order = 0;
  const boundary = (row: Boundary["row"], messageId: string | null, sequence: number | null) => {
    if (messageId !== null) lastBoundaryOf.set(messageId, boundaries.length);
    boundaries.push({
      row,
      messageId,
      sequence,
      order: order++,
      time:
        messageId === null
          ? // Non-message boundaries always carry their durable sequence.
            clock(eventTimes.get(sequence!))
          : clock(messageTimes.get(messageId)),
    });
  };
  for (const row of source) {
    if (row.kind !== "turn") {
      if (row.kind === "host-notice")
        boundary(row, row.messageId, sequences.get(row.messageId) ?? null);
      else
        boundary(
          row,
          null,
          row.kind === "compaction"
            ? row.compaction.sequence
            : row.kind === "reasoning-drop"
              ? row.drop.sequence
              : row.refresh.sequence,
        );
      continue;
    }
    if (row.messages[0]?.role !== "assistant") {
      for (const message of row.messages)
        boundary(
          { kind: "turn", messages: [message] },
          message.id,
          sequences.get(message.id) ?? null,
        );
      continue;
    }
    const byPart = new Map<string, { message: UIMessage; index: number }>();
    for (const message of row.messages)
      message.parts.forEach((_, index) => byPart.set(`${message.id}:${index}`, { message, index }));
    for (const segment of segmentTurn(row.messages)) {
      if (segment.kind === "text") {
        const message = byPart.get(segment.key)!.message;
        boundary(
          { kind: "turn", viewKey: segment.key, messages: [{ ...message, parts: [segment.part] }] },
          message.id,
          sequences.get(message.id) ?? null,
        );
        continue;
      }
      for (const original of segment.rows) {
        const { message, index } = byPart.get(original.key)!;
        const key = workPositionKey(original.part, message.id, index)!;
        if (owned.has(key)) continue;
        owned.add(key);
        const activity: BundleRow =
          original.kind === "tool"
            ? // Every tool was registered in the first pass over these messages.
              { ...original, key, part: latest.get(original.part.toolCallId)!.part }
            : { ...original, key };
        activities.push({
          row: activity,
          messageId: message.id,
          positionKey: key,
          order: order++,
          slot: boundaries.length,
          lower: (lastBoundaryOf.get(message.id) ?? -1) + 1,
          sequence: evidence?.activityFirstOverlaySequence.get(key) ?? null,
          start:
            activity.kind === "tool" ? clock(activityDescriptor(activity.part).startedAt) : null,
        });
      }
    }
  }
  // The largest clock and ledger position in each block of boundaries.
  const blockTime: number[] = [];
  const blockSequence: number[] = [];
  boundaries.forEach((item, index) => {
    const block = Math.floor(index / BLOCK);
    blockTime[block] = Math.max(blockTime[block] ?? -Infinity, item.time ?? -Infinity);
    blockSequence[block] = Math.max(blockSequence[block] ?? -Infinity, item.sequence ?? -Infinity);
  });
  const slots = new Map<number, Activity[]>();
  // Unplaced work (neither a start nor an observed position) keeps its recorded
  // slot, and nothing placed may cross it between slots either: the nearest one
  // before an entry bounds how early it may move, the nearest after how late.
  // Recorded slots never decrease with recorded order, so both are one pass.
  const nextUnplacedSlot: number[] = [];
  for (let index = activities.length - 1, next = Infinity; index >= 0; index -= 1) {
    nextUnplacedSlot[index] = next;
    if (unplaced(activities[index]!)) next = activities[index]!.slot;
  }
  let previousUnplacedSlot = -Infinity;
  for (const [position, entry] of activities.entries()) {
    if (unplaced(entry)) previousUnplacedSlot = entry.slot;
    else {
      const follows = (item: Boundary): boolean | null => {
        // A recorded start is stronger than a delayed reconnect baseline, but
        // equal-millisecond clocks prove no order at all. Resolve their tie
        // with retained ledger evidence, else keep the original placement.
        if (entry.start !== null && item.time !== null && entry.start !== item.time)
          return item.time > entry.start;
        if (entry.sequence !== null && item.sequence !== null)
          return item.sequence > entry.sequence;
        if (entry.start !== null && entry.start === item.time) return item.order > entry.order;
        return null;
      };
      // The first boundary it precedes. The search starts below its own
      // message's last boundary, preserving within-message part order even
      // when its clock is settlement. A boundary can follow only by a later
      // (or equal, then ordered) clock or a later ledger position, so a block
      // whose largest of both cannot is skipped whole.
      const mayFollow = (block: number): boolean =>
        (entry.start !== null && blockTime[block]! >= entry.start) ||
        (entry.sequence !== null && blockSequence[block]! > entry.sequence);
      let target = boundaries.length;
      for (let index = entry.lower; index < boundaries.length; index += 1) {
        if (index % BLOCK === 0 && !mayFollow(index / BLOCK)) index += BLOCK - 1;
        else if (follows(boundaries[index]!) === true) {
          target = index;
          break;
        }
      }
      // Every boundary it would cross must be ordered against it. Neither end
      // is above `lower`: the target is searched from there and the recorded
      // slot is past its own message's boundaries.
      const crosses = (): boolean => {
        for (
          let index = Math.min(target, entry.slot);
          index < Math.max(target, entry.slot);
          index += 1
        )
          if (follows(boundaries[index]!) === null) return false;
        return true;
      };
      if (target >= previousUnplacedSlot && target <= nextUnplacedSlot[position]! && crosses())
        entry.slot = target;
    }
    const group = slots.get(entry.slot);
    if (group) group.push(entry);
    else slots.set(entry.slot, [entry]);
  }
  const result: WorkTranscriptRow[] = [];
  for (let slot = 0; slot <= boundaries.length; slot += 1) {
    const group = orderSlot(slots.get(slot));
    if (group?.length) {
      const rows = group.map((entry) => entry.row);
      const previousTime = boundaries[slot - 1]?.time ?? null;
      const starts = group.map((entry) => entry.start);
      const minimum = starts.every((start) => start !== null)
        ? Math.min(...(starts as number[]))
        : null;
      const startedAt = minimum === null ? null : Math.max(minimum, previousTime ?? minimum);
      const next = boundaries[slot];
      // An uncovered terminal row invalidates the tail endpoint. Taking the
      // maximum of the subset that happened to carry clocks invents coverage.
      const ends = rows.map((row) =>
        row.kind === "tool" && !unfinished(row)
          ? clock(activityDescriptor(row.part).endedAt)
          : null,
      );
      const tailEnd = ends.every(
        (end, index) => end !== null && group[index]!.start !== null && end >= group[index]!.start!,
      )
        ? Math.max(...(ends as number[]))
        : null;
      const endpoint = next ? next.time : !active ? tailEnd : null;
      const endedAt =
        endpoint !== null && startedAt !== null && endpoint >= startedAt ? endpoint : null;
      result.push({
        kind: "work",
        work: {
          key: `${group[0]!.positionKey}:work`,
          rows,
          startedAt,
          endedAt,
          state: next
            ? "complete"
            : active
              ? "open"
              : rows.some(unfinished)
                ? "interrupted"
                : "complete",
        },
      });
    }
    const next = boundaries[slot];
    if (next) result.push(next.row);
  }
  return result;
}

/** Compatibility entry point for receipts; both group surfaces share one gist. */
export function workDurationLabel(work: TranscriptWorkWindow): string {
  return workGist(work.rows, work.state);
}
