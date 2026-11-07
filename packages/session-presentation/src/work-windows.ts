import type { UIMessage } from "ai";
import { activityDescriptor, activityStatus, segmentTurn, type BundleRow } from "./activity";
import type { ChatSessionFrame } from "./transcript";
import type { TranscriptRow } from "./transcript-rows";

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

/**
 * View-only work ownership. A visible message or notice closes the preceding
 * window, regardless of its author. Calls keep their first owner while their
 * latest result updates that owner; a delivery is not another execution.
 * Neither input messages nor their parts, roles, ids or order are rewritten.
 */
export function projectWorkWindows(
  source: readonly TranscriptRow[],
  messageTimes: ReadonlyMap<string, number>,
  active: boolean,
): readonly WorkTranscriptRow[] {
  const latest = new Map<string, Extract<BundleRow, { kind: "tool" }>["part"]>();
  for (const row of source) {
    if (row.kind !== "turn") continue;
    for (const message of row.messages)
      for (const part of message.parts) {
        if (part.type === "dynamic-tool") latest.set(part.toolCallId, part);
      }
  }
  const result: WorkTranscriptRow[] = [];
  const owned = new Set<string>();
  let pending: BundleRow[] = [];
  const flush = (endedAt: number | null, state: TranscriptWorkWindow["state"] = "complete") => {
    const first = pending[0];
    if (!first) return;
    // A reasoning-only start has no recorded clock. Do not substitute mount
    // time or a later tool's start for the beginning of that work.
    const start = first.kind === "tool" ? activityDescriptor(first.part).startedAt : null;
    result.push({
      kind: "work",
      work: { key: `${first.key}:work`, rows: pending, startedAt: start, endedAt, state },
    });
    pending = [];
  };
  for (const row of source) {
    if (row.kind !== "turn") {
      flush(row.kind === "host-notice" ? (messageTimes.get(row.messageId) ?? null) : null);
      result.push(row);
      continue;
    }
    if (row.messages[0]?.role !== "assistant") {
      for (const message of row.messages) {
        flush(messageTimes.get(message.id) ?? null);
        result.push({ kind: "turn", messages: [message] });
      }
      continue;
    }
    const byPart = new Map<string, UIMessage>();
    for (const message of row.messages)
      message.parts.forEach((_, index) => byPart.set(`${message.id}:${index}`, message));
    for (const segment of segmentTurn(row.messages)) {
      if (segment.kind === "bundle") {
        for (const activity of segment.rows) {
          if (activity.kind === "reasoning") {
            pending.push(activity);
            continue;
          }
          if (owned.has(activity.part.toolCallId)) continue;
          owned.add(activity.part.toolCallId);
          pending.push({
            ...activity,
            part: latest.get(activity.part.toolCallId) ?? activity.part,
          });
        }
      } else {
        const message = byPart.get(segment.key)!;
        flush(messageTimes.get(message.id) ?? null);
        // A view slice retains the real message id and role. Its separate React
        // key is the original part key, not a newly minted durable identity.
        result.push({
          kind: "turn",
          viewKey: segment.key,
          messages: [{ ...message, parts: [segment.part] }],
        });
      }
    }
  }
  const unfinished = pending.some((row) =>
    row.kind === "reasoning"
      ? row.streaming
      : ["running", "pending"].includes(activityStatus(row.part)),
  );
  const ends = pending.flatMap((row) =>
    row.kind === "tool" && activityDescriptor(row.part).endedAt !== null
      ? [activityDescriptor(row.part).endedAt!]
      : [],
  );
  flush(
    !active && !unfinished && ends.length > 0 ? Math.max(...ends) : null,
    active ? "open" : unfinished ? "interrupted" : "complete",
  );
  return result;
}

export function workDurationLabel(work: TranscriptWorkWindow): string {
  const { startedAt: start, endedAt: end } = work;
  if (work.state === "interrupted") return "Work interrupted";
  if (work.state === "open") return "Working";
  if (
    start === null ||
    end === null ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end < start
  )
    return "Work details";
  const seconds = Math.floor((end - start) / 1000);
  const duration =
    seconds < 1
      ? "<1s"
      : seconds < 60
        ? `${seconds}s`
        : seconds < 3600
          ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
          : `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}m`;
  return `Worked for ${duration}`;
}
