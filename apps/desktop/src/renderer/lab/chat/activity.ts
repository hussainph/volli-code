/**
 * Chat activity projection — the pure half of the transcript renderer.
 *
 * Everything here switches on `ActivityKind` from `@volli/shared`. There are no
 * harness tool names in this file and there must never be: a second adapter
 * renames every tool and the transcript still reads correctly. When a harness
 * has not stamped a descriptor yet the row degrades to the `"other"` presenter
 * with the native tool name as its verb, which is a first-class shape rather
 * than a broken one.
 *
 * Layering: this module answers "what does this row say"; `activity-ui.tsx`
 * answers "what does it look like". Presenters are total functions of a
 * context object, so a row's text is unit-testable without React.
 */
import {
  activityDuration,
  isDurableActivity,
  isReadOnlyActivity,
  readActivityDescriptor,
  type ActivityDescriptor,
  type ActivityKind,
} from "@volli/shared";
import type { DynamicToolUIPart, ReasoningUIPart, UIMessage } from "ai";

type MessagePart = UIMessage["parts"][number];

/* ------------------------------------------------------------------ blocks */

export type ActivityItem =
  | { kind: "reasoning"; part: ReasoningUIPart; key: string }
  | { kind: "tool"; part: DynamicToolUIPart; key: string };

export type ToolItem = { part: DynamicToolUIPart; key: string };

export type ChatBlock =
  | { kind: "text"; part: Extract<MessagePart, { type: "text" }>; key: string }
  | { kind: "activity"; items: ActivityItem[]; key: string }
  | { kind: "tool-run"; items: ToolItem[]; key: string }
  | { kind: "attention"; part: DynamicToolUIPart; key: string };

/**
 * Errors, denials and approval requests can never sit inside a rolling window
 * or a folded group — they break out as their own block so a failed read is
 * never invisible behind "Explored 4 reads".
 */
export function needsAttention(state: DynamicToolUIPart["state"]): boolean {
  return state === "output-error" || state === "output-denied" || state === "approval-requested";
}

/**
 * Reads a descriptor, or synthesizes one from the raw part when the harness has
 * not stamped `volli.activity` yet. The synthetic descriptor is deliberately
 * `"other"`: guessing a kind from a tool name is exactly the coupling the
 * seam exists to remove.
 */
export function activityDescriptor(part: DynamicToolUIPart): ActivityDescriptor {
  const stamped = readActivityDescriptor(part.toolMetadata);
  if (stamped) return stamped;
  return {
    kind: "other",
    nativeToolName: part.toolName,
    subject: {
      label: bestEffortSubject("input" in part ? part.input : undefined),
      path: null,
      lineRange: null,
    },
    outcome: null,
    startedAt: null,
    endedAt: null,
  };
}

/** Hidden from the transcript; the plan projects to the rail instead. */
export function isPlanActivity(part: DynamicToolUIPart): boolean {
  return activityDescriptor(part).kind === "plan";
}

/**
 * `trim()` alone is not enough: zero-width space and word joiner are not
 * whitespace per spec, and a text part carrying only those renders nothing
 * while still costing a block.
 */
export function isBlankText(text: string): boolean {
  return text.replace(/[\u200B-\u200D\uFEFF]/g, "").trim().length === 0;
}

export function groupMessageParts(parts: readonly MessagePart[], messageId: string): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  let activity: ActivityItem[] | null = null;
  let run: ToolItem[] | null = null;

  const flushActivity = () => {
    if (activity && activity.length > 0) {
      blocks.push({
        kind: "activity",
        items: activity,
        key: `${messageId}:activity:${blocks.length}`,
      });
    }
    activity = null;
  };
  const flushRun = () => {
    if (run && run.length > 0) {
      blocks.push({ kind: "tool-run", items: run, key: `${messageId}:run:${blocks.length}` });
    }
    run = null;
  };
  const flush = () => {
    flushActivity();
    flushRun();
  };

  parts.forEach((part, index) => {
    const key = `${messageId}:${index}`;
    if (part.type === "text") {
      // A blank text part is not a block. A harness opens one before it has
      // words (OpenCode does) and can leave a whitespace-only one between tool
      // calls; rendered, it is a zero-height block that still collects the gap
      // on *both* sides of itself, so one boundary measures 12px and its
      // neighbour 24px for no reason the reader can see. Worse, it `flush()`es
      // — which is what splits a single run of exploration into two stacked
      // headers that each summarize half of it.
      if (isBlankText(part.text)) return;
      flush();
      blocks.push({ kind: "text", part, key });
      return;
    }
    if (part.type === "reasoning") {
      flushRun();
      activity ??= [];
      activity.push({ kind: "reasoning", part, key });
      return;
    }
    if (part.type !== "dynamic-tool") return;
    if (isPlanActivity(part)) return;

    const readOnly = isReadOnlyActivity(activityDescriptor(part).kind);
    if (needsAttention(part.state)) {
      // Counted by the group it came from — a collapsed group may hide detail,
      // never outcome — then flushed so the card stands on its own.
      if (readOnly && activity) activity.push({ kind: "tool", part, key });
      flush();
      blocks.push({ kind: "attention", part, key });
      return;
    }
    if (readOnly) {
      flushRun();
      activity ??= [];
      activity.push({ kind: "tool", part, key });
      return;
    }
    flushActivity();
    run ??= [];
    run.push({ part, key });
  });

  flush();
  return blocks;
}

/**
 * Whether the turn still owes the reader a sign of life.
 *
 * The placeholder lives here, at the turn, rather than inside the reasoning row
 * — the arrangement OpenCode's desktop client, Codex and t3code all converged
 * on. It means a reasoning part is free to render nothing until it actually has
 * words, instead of being the thing that has to hold the floor while empty.
 */
export function isAwaitingFirstOutput(messages: readonly UIMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return true;
  return groupMessageParts(last.parts, last.id).length === 0;
}

/* -------------------------------------------------------------------- turn */

/** Every tool part the turn ran, in order, wherever the projection put it. */
export function turnToolParts(blocks: readonly ChatBlock[]): DynamicToolUIPart[] {
  const parts: DynamicToolUIPart[] = [];
  for (const block of blocks) {
    if (block.kind === "activity") {
      for (const item of block.items) if (item.kind === "tool") parts.push(item.part);
    } else if (block.kind === "tool-run") {
      for (const item of block.items) parts.push(item.part);
    } else if (block.kind === "attention") {
      parts.push(block.part);
    }
  }
  return parts;
}

/**
 * Wall-clock across the turn, from the first tool that started to the last that
 * ended. Not the sum of the parts: work overlaps, and the reader is asking how
 * long they waited, not how much the machine did.
 */
export function turnDuration(blocks: readonly ChatBlock[]): number | null {
  let first: number | null = null;
  let last: number | null = null;
  for (const part of turnToolParts(blocks)) {
    const { startedAt, endedAt } = activityDescriptor(part);
    if (startedAt !== null && (first === null || startedAt < first)) first = startedAt;
    if (endedAt !== null && (last === null || endedAt > last)) last = endedAt;
  }
  if (first === null || last === null || last < first) return null;
  return last - first;
}

/**
 * The receipt a folded turn leaves. Duration when the harness timestamped its
 * work, a step count when it did not — Perplexity's phrasing, and the honest
 * fallback, since a count is something we can always derive. A turn that only
 * thought says so.
 */
export function turnSummary(blocks: readonly ChatBlock[]): string {
  const elapsed = formatDuration(turnDuration(blocks));
  if (elapsed !== null) return `Worked for ${elapsed}`;
  const steps = turnToolParts(blocks).length;
  if (steps > 0) return `Completed ${steps} ${steps === 1 ? "step" : "steps"}`;
  return "Thought";
}

export interface TurnFold {
  /** Blocks a folded turn still shows, in order. */
  visible: ChatBlock[];
  /** How many blocks the fold hides. Zero means this turn has nothing to fold. */
  hidden: number;
  /** Header text, empty when `hidden` is zero. */
  summary: string;
}

/**
 * What a turn shows once it is scrollback.
 *
 * The deliverable survives and the process folds — the split Cursor, Codex and
 * Perplexity all landed on, and the reason their transcripts read as answers
 * while ours read as machinery. The deliverable is the *trailing* run of prose:
 * mid-turn narration is commentary on work you are no longer looking at, but
 * the last thing said is what the turn was for.
 *
 * A turn holding an unresolved question or a failure never folds. Those are the
 * two things the transcript must not make the reader go hunting for.
 */
export function foldTurn(blocks: readonly ChatBlock[]): TurnFold {
  if (blocks.some((block) => block.kind === "attention")) {
    return { visible: [...blocks], hidden: 0, summary: "" };
  }
  let start = blocks.length;
  while (start > 0 && blocks[start - 1]?.kind === "text") start -= 1;
  if (start === 0) return { visible: [...blocks], hidden: 0, summary: "" };
  return {
    visible: blocks.slice(start),
    hidden: start,
    summary: turnSummary(blocks.slice(0, start)),
  };
}

/* ----------------------------------------------------------------- summary */

export type SummaryTone = "neutral" | "muted" | "danger";
export interface SummarySegment {
  text: string;
  tone: SummaryTone;
}

const KIND_NOUNS: Record<ActivityKind, { one: string; many: string }> = {
  "run-command": { one: "command", many: "commands" },
  "read-file": { one: "read", many: "reads" },
  "edit-file": { one: "edit", many: "edits" },
  "write-file": { one: "file", many: "files" },
  search: { one: "search", many: "searches" },
  "list-directory": { one: "list", many: "lists" },
  "fetch-url": { one: "fetch", many: "fetches" },
  plan: { one: "plan", many: "plans" },
  delegate: { one: "subagent", many: "subagents" },
  other: { one: "tool", many: "tools" },
};

/** Rows the group renders. The attention states already left as their own card. */
export function activityToolItems(
  items: readonly ActivityItem[],
): Extract<ActivityItem, { kind: "tool" }>[] {
  return items.filter(
    (item): item is Extract<ActivityItem, { kind: "tool" }> =>
      item.kind === "tool" && !needsAttention(item.part.state),
  );
}

export function isActivityStreaming(items: readonly ActivityItem[]): boolean {
  return items.some(
    (item) =>
      (item.kind === "reasoning" && item.part.state === "streaming") ||
      (item.kind === "tool" &&
        (item.part.state === "input-streaming" ||
          item.part.state === "input-available" ||
          item.part.state === "approval-requested")),
  );
}

/**
 * The folded header, which counts the tools and nothing else — reasoning speaks
 * for itself on its own status line, so a header that also said "Thought" would
 * be saying it twice. Empty when the group is reasoning only.
 *
 * Segments rather than a string so a group can confess an outcome —
 * `Explored 4 reads · 1 failed` — with the failure carrying its own tone
 * instead of hiding inside neutral prose.
 */
export function activitySummary(
  items: readonly ActivityItem[],
  options?: { streaming?: boolean },
): SummarySegment[] {
  const tools = items.filter((item): item is Extract<ActivityItem, { kind: "tool" }> => {
    return item.kind === "tool";
  });
  if (tools.length === 0) return [];
  const streaming = options?.streaming === true || isActivityStreaming(items);
  const failed = tools.filter((item) => needsAttention(item.part.state)).length;
  const phrase = countPhrase(tools.map((item) => activityDescriptor(item.part).kind));
  const segments: SummarySegment[] = [
    { text: `${streaming ? "Exploring" : "Explored"} ${phrase}`, tone: "neutral" },
  ];
  if (failed > 0) segments.push({ text: `${failed} failed`, tone: "danger" });
  return segments;
}

/** The counted header above a rolling tail of tool rows. Ticks as the run grows. */
export function runSummary(items: readonly ToolItem[]): SummarySegment[] {
  const kinds = items.map((item) => activityDescriptor(item.part).kind);
  const failed = items.filter((item) => needsAttention(item.part.state)).length;
  const segments: SummarySegment[] = [{ text: countPhrase(kinds) || "Activity", tone: "neutral" }];
  if (failed > 0) segments.push({ text: `${failed} failed`, tone: "danger" });
  return segments;
}

/** First-appearance order, so the phrase reads in the order the work happened. */
function countPhrase(kinds: readonly ActivityKind[]): string {
  const counts = new Map<ActivityKind, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts]
    .map(([kind, count]) => {
      const noun = KIND_NOUNS[kind];
      return `${count} ${count === 1 ? noun.one : noun.many}`;
    })
    .join(", ");
}

/* -------------------------------------------------------------------- tail */

export const TAIL_LIMIT = 3;

/**
 * The rolling tail. The active row is pinned; at most `limit` completed rows sit
 * above it and everything older is absorbed into the counted header. Turn height
 * is therefore constant — 30 tool calls occupy the space of 4.
 */
export function rollingTail<T>(
  rows: readonly T[],
  isActive: (row: T) => boolean,
  limit: number = TAIL_LIMIT,
): { hidden: number; visible: T[] } {
  const last = rows[rows.length - 1];
  const budget = last !== undefined && isActive(last) ? limit + 1 : limit;
  if (rows.length <= budget) return { hidden: 0, visible: [...rows] };
  return { hidden: rows.length - budget, visible: rows.slice(rows.length - budget) };
}

export function isRowActive(part: DynamicToolUIPart): boolean {
  const status = activityStatus(part);
  return status === "pending" || status === "running" || status === "approval";
}

/**
 * What a run of mutating rows shows when nobody has opened it.
 *
 * Live, it is the rolling tail — work in progress is worth watching. Settled,
 * only the durable rows survive. A finished command run was holding a header
 * plus three rows open forever, in scrollback nobody re-reads, and across a
 * long session that is where the transcript's bulk came from; the group of
 * read-only rows beside it has always folded to nothing on settle, so this is
 * the asymmetry closing rather than a new rule.
 *
 * Edits and writes stay because they are the turn's answer, but they stay
 * *tail-bounded* — a twelve-file change still folds to its last three and a
 * header, the same cap every other row obeys.
 *
 * `hidden` counts everything off screen, so a single header covers both the
 * rows the fold dropped and the ones the tail trimmed.
 */
export function foldRun(items: readonly ToolItem[]): { hidden: number; visible: ToolItem[] } {
  const active = (item: ToolItem) => isRowActive(item.part);
  if (items.some(active)) return rollingTail(items, active);
  const durable = items.filter((item) => isDurableActivity(activityDescriptor(item.part).kind));
  const { visible } = rollingTail(durable, active);
  return { hidden: items.length - visible.length, visible };
}

/* ----------------------------------------------------------------- rows */

export type ActivityStatus = "pending" | "running" | "approval" | "done" | "denied" | "failed";

export function activityStatus(part: DynamicToolUIPart): ActivityStatus {
  switch (part.state) {
    case "input-streaming":
      return "pending";
    case "input-available":
      return "running";
    case "approval-requested":
      return "approval";
    case "approval-responded":
      return part.approval.approved ? "running" : "denied";
    case "output-error":
      return "failed";
    case "output-denied":
      return "denied";
    default:
      return "done";
  }
}

export function isSettled(status: ActivityStatus): boolean {
  return status === "done" || status === "failed" || status === "denied";
}

export type DiffLineKind = "add" | "remove" | "context" | "hunk";
export interface DiffLine {
  /** Position in the rendered diff; identical lines repeat, so text is no key. */
  id: number;
  kind: DiffLineKind;
  text: string;
}
export interface NumberedLine {
  number: number | null;
  text: string;
}
export interface MatchGroup {
  file: string;
  lines: string[];
  hidden: number;
}

/** What the row shows when expanded. Raw JSON only ever reaches `signature`. */
export type ActivityDetail =
  | { view: "output"; text: string }
  | { view: "diff"; lines: DiffLine[] }
  | { view: "numbered"; lines: NumberedLine[] }
  | { view: "matches"; groups: MatchGroup[] }
  | { view: "signature"; text: string };

export interface ActivityFacts {
  verb: string;
  /** Mono. The path, the command, the pattern. */
  object: string | null;
  /** Non-null when clicking the object should open a workspace artifact. */
  openPath: string | null;
  meta: string | null;
  metaTone: SummaryTone;
  detail: ActivityDetail | null;
}

export interface ActivityRow extends ActivityFacts {
  kind: ActivityKind;
  status: ActivityStatus;
  nativeToolName: string;
  errorText: string | null;
}

export interface ActivityContext {
  descriptor: ActivityDescriptor;
  status: ActivityStatus;
  input: unknown;
  output: unknown;
  errorText: string | null;
  durationMs: number | null;
}

export type ActivityParse = (context: ActivityContext) => ActivityFacts;

const NO_META = { meta: null, metaTone: "neutral" as SummaryTone };

/**
 * Per-kind presenters. Each is a pure function of the context, so the meta
 * formula for a kind is one testable expression rather than a branch buried in
 * JSX. The right column is the whole gap between this transcript and the
 * reference apps: every resting row earns a number.
 */
export const ACTIVITY_PRESENTERS: Record<ActivityKind, ActivityParse> = {
  "run-command": (context) => {
    const exitCode = context.descriptor.outcome?.exitCode ?? null;
    const failed = exitCode !== null && exitCode !== 0;
    return {
      verb: "Ran",
      object: context.descriptor.subject.label,
      openPath: null,
      // The command is already the headline; the meta is the cost, or the exit.
      meta: failed ? `exit ${exitCode}` : durationMeta(context),
      metaTone: failed ? "danger" : "muted",
      detail: outputDetail(context),
    };
  },

  "read-file": (context) => {
    const range = context.descriptor.subject.lineRange;
    return {
      verb: "Read",
      object: context.descriptor.subject.label,
      openPath: context.descriptor.subject.path,
      // Only a partial read has anything to confess.
      meta: range ? `${range.start}–${range.end}` : null,
      metaTone: "muted",
      detail: numberedDetail(context),
    };
  },

  "edit-file": (context) => ({
    verb: "Edited",
    object: context.descriptor.subject.label,
    openPath: context.descriptor.subject.path,
    // `+0 −0` on an in-flight edit is worse than no meta.
    meta: isSettled(context.status) ? diffStat(context.descriptor) : null,
    metaTone: "muted",
    detail: diffDetail(context),
  }),

  "write-file": (context) => {
    const outcome = context.descriptor.outcome;
    const added = outcome?.addedLines ?? outcome?.lineCount ?? null;
    return {
      verb: "Created",
      object: context.descriptor.subject.label,
      openPath: context.descriptor.subject.path,
      meta: isSettled(context.status) && added !== null ? `+${added}` : null,
      metaTone: "muted",
      detail: contentDetail(context),
    };
  },

  search: (context) => ({
    verb: "Grepped",
    object: context.descriptor.subject.label,
    openPath: null,
    // "no matches" is an answer, not a failure — it never takes an error tone.
    meta: searchMeta(context),
    metaTone: "muted",
    detail: matchesDetail(context),
  }),

  "list-directory": (context) => {
    const outcome = context.descriptor.outcome;
    const entries = outcome?.fileCount ?? outcome?.lineCount ?? null;
    return {
      verb: "Listed",
      object: context.descriptor.subject.label,
      openPath: null,
      meta:
        isSettled(context.status) && entries !== null
          ? `${entries} ${entries === 1 ? "entry" : "entries"}`
          : null,
      metaTone: "muted",
      detail: outputDetail(context),
    };
  },

  "fetch-url": (context) => {
    // OpenCode reports no byte count, so size is the richer meta when a harness
    // offers it and duration is the honest fallback when none does.
    const bytes = context.descriptor.outcome?.bytes ?? null;
    return {
      verb: "Fetched",
      object: context.descriptor.subject.label,
      openPath: null,
      meta: isSettled(context.status) ? (formatBytes(bytes) ?? durationMeta(context)) : null,
      metaTone: "muted",
      detail: outputDetail(context),
    };
  },

  delegate: (context) => ({
    // The adapter names the subagent through `nativeToolName`, so a delegate row
    // reads `explore  Find the streaming seam` rather than the harness's
    // dispatch tool. The subject swaps while running — it is the only object
    // that does — because the adapter restamps it with the child's last line.
    verb: context.descriptor.nativeToolName,
    object: context.descriptor.subject.label,
    openPath: null,
    meta: joinMeta([context.descriptor.outcome?.summary ?? null, durationMeta(context)]),
    metaTone: "muted",
    detail: outputDetail(context),
  }),

  plan: (context) => ({
    verb: "Planned",
    object: context.descriptor.subject.label,
    openPath: null,
    ...NO_META,
    detail: null,
  }),

  other: (context) => ({
    verb: context.descriptor.nativeToolName,
    object: context.descriptor.subject.label,
    openPath: context.descriptor.subject.path,
    meta: durationMeta(context),
    metaTone: "muted",
    // The one kind allowed to show its raw shape, and only in the detail.
    detail: signatureDetail(context),
  }),
};

export function activityContext(part: DynamicToolUIPart): ActivityContext {
  const descriptor = activityDescriptor(part);
  return {
    descriptor,
    status: activityStatus(part),
    input: "input" in part ? part.input : undefined,
    output: "output" in part ? part.output : undefined,
    errorText: "errorText" in part && typeof part.errorText === "string" ? part.errorText : null,
    durationMs: activityDuration(descriptor),
  };
}

export function describeActivity(part: DynamicToolUIPart): ActivityRow {
  const context = activityContext(part);
  const facts = ACTIVITY_PRESENTERS[context.descriptor.kind](context);
  return {
    ...facts,
    kind: context.descriptor.kind,
    status: context.status,
    nativeToolName: context.descriptor.nativeToolName,
    errorText: context.errorText,
  };
}

/* --------------------------------------------------------------- formatters */

export function formatDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds - minutes * 60)}s`;
}

export function formatBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The app's change-count idiom: `+49 −12` with a real minus sign. */
export function diffStat(descriptor: ActivityDescriptor): string | null {
  const added = descriptor.outcome?.addedLines ?? null;
  const removed = descriptor.outcome?.removedLines ?? null;
  if (added === null && removed === null) return null;
  return `+${added ?? 0} −${removed ?? 0}`;
}

/**
 * Sub-second work is instant, and instant needs no number.
 *
 * Duration is the *fallback* meta — what a row shows when it has nothing
 * semantic to report. Printing `3ms` on a read spends the column on noise and
 * leaves the eye hunting for the numbers that matter (`exit 127`, `+49 −12`,
 * `1m38s`) among ones that never did. Zed gates its stopwatch at 30s for the
 * same reason. Semantic metas are never thresholded: they say what happened,
 * not how long it took.
 */
export const NOTABLE_DURATION_MS = 1000;

export function notableDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < NOTABLE_DURATION_MS) return null;
  return formatDuration(ms);
}

function durationMeta(context: ActivityContext): string | null {
  return isSettled(context.status) ? notableDuration(context.durationMs) : null;
}

function searchMeta(context: ActivityContext): string | null {
  if (!isSettled(context.status)) return null;
  const matches = context.descriptor.outcome?.matchCount ?? null;
  if (matches === null) return null;
  if (matches === 0) return "no matches";
  const files = context.descriptor.outcome?.fileCount ?? null;
  if (files === null) return `${matches}`;
  return `${matches} in ${files} ${files === 1 ? "file" : "files"}`;
}

function joinMeta(values: readonly (string | null)[]): string | null {
  const parts = values.filter((value): value is string => value !== null && value.length > 0);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/* ------------------------------------------------------------------ details */

const DETAIL_LINE_BUDGET = 400;
const MATCH_LINES_PER_FILE = 3;

function outputDetail(context: ActivityContext): ActivityDetail | null {
  const text = readableText(context.output) ?? context.descriptor.outcome?.summary ?? null;
  return text === null ? null : { view: "output", text: clampLines(text) };
}

function contentDetail(context: ActivityContext): ActivityDetail | null {
  const text = readableText(context.input) ?? readableText(context.output);
  return text === null ? null : { view: "output", text: clampLines(text) };
}

function diffDetail(context: ActivityContext): ActivityDetail | null {
  const diff = context.descriptor.outcome?.diff ?? null;
  if (diff !== null) return { view: "diff", lines: parseDiff(diff) };
  return outputDetail(context);
}

function numberedDetail(context: ActivityContext): ActivityDetail | null {
  const text = readableText(context.output);
  if (text === null) return null;
  const start = context.descriptor.subject.lineRange?.start ?? 1;
  return { view: "numbered", lines: numberLines(clampLines(text), start) };
}

function matchesDetail(context: ActivityContext): ActivityDetail | null {
  const text = readableText(context.output);
  if (text === null) return null;
  const groups = parseMatches(clampLines(text));
  if (groups.length === 0) return { view: "output", text: clampLines(text) };
  return { view: "matches", groups };
}

function signatureDetail(context: ActivityContext): ActivityDetail | null {
  const signature = compactSignature(context.input);
  const text = readableText(context.output);
  if (signature === null && text === null) return null;
  return { view: "signature", text: [signature, text].filter(Boolean).join("\n") };
}

/** `({"query":"…","limit":3})` — Codex's dim inline signature, never a blob. */
export function compactSignature(input: unknown, budget = 160): string | null {
  if (!isRecord(input)) return typeof input === "string" ? `(${truncate(input, 60)})` : null;
  const entries = Object.entries(input);
  if (entries.length === 0) return null;
  const body = entries
    .map(([key, value]) => `${JSON.stringify(key)}:${compactValue(value)}`)
    .join(",");
  return `(${truncate(`{${body}}`, budget)})`;
}

function compactValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(truncate(value, 40));
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.length}]`;
  return "{…}";
}

export function parseDiff(diff: string): DiffLine[] {
  return diff
    .split("\n")
    .slice(0, DETAIL_LINE_BUDGET)
    .filter((line) => !line.startsWith("diff --git") && !line.startsWith("index "))
    .filter((line) => !line.startsWith("--- ") && !line.startsWith("+++ "))
    .map((text, id): DiffLine => {
      if (text.startsWith("@@")) return { id, kind: "hunk", text };
      if (text.startsWith("+")) return { id, kind: "add", text };
      if (text.startsWith("-")) return { id, kind: "remove", text };
      return { id, kind: "context", text };
    });
}

export function numberLines(text: string, start: number): NumberedLine[] {
  return text.split("\n").map((line, index) => ({ number: start + index, text: line }));
}

/**
 * Groups `path:line:match` output by file, keeping the first few lines of each.
 * Harness output formats vary; when nothing parses the caller falls back to the
 * plain output view rather than inventing structure.
 */
export function parseMatches(text: string): MatchGroup[] {
  const groups = new Map<string, { lines: string[]; total: number }>();
  for (const line of text.split("\n")) {
    const match = /^([^\s:][^:]*):(\d+):(.*)$/.exec(line);
    if (!match) continue;
    const [, file, lineNumber, rest] = match;
    if (file === undefined || lineNumber === undefined) continue;
    const entry = groups.get(file) ?? { lines: [], total: 0 };
    entry.total += 1;
    if (entry.lines.length < MATCH_LINES_PER_FILE) {
      entry.lines.push(`${lineNumber}  ${(rest ?? "").trim()}`);
    }
    groups.set(file, entry);
  }
  return [...groups].map(([file, entry]) => ({
    file,
    lines: entry.lines,
    hidden: entry.total - entry.lines.length,
  }));
}

/** The plain-text face of a detail, when it has one. Cards show text, not views. */
export function detailText(detail: ActivityDetail | null): string | null {
  if (detail === null) return null;
  return detail.view === "output" || detail.view === "signature" ? detail.text : null;
}

/** Paths render dim-directory / bright-basename so truncation stays scannable. */
export function splitPath(value: string): { directory: string; basename: string } {
  const index = value.lastIndexOf("/");
  if (index < 0) return { directory: "", basename: value };
  return { directory: value.slice(0, index + 1), basename: value.slice(index + 1) };
}

/* ---------------------------------------------------------------- reasoning */

// Anchored to the part, not to any line: a provider emits one summary per
// reasoning part (OpenAI gives each `summary_index` its own part), so the
// promotable header is always at position zero. With the `m` flag this promoted
// whatever bold phrase happened to open a later line mid-thought.
const FIRST_BOLD = /^\s*\*\*([^*\n]+)\*\*/;

export interface ReasoningStatus {
  verb: string;
  meta: string | null;
}

/**
 * The model's own first bold line becomes the status verb — OpenCode's TUI,
 * Codex and Cursor all landed on this independently. No collapsible: the full
 * text stays in the durable transcript for the inspector.
 */
/**
 * The body with the promoted line removed. That line is already the status verb,
 * so leaving it in place says the same sentence twice the moment the row expands.
 * Null when the header was the whole thought.
 */
export function reasoningBody(text: string): string | null {
  const stripped = text.replace(FIRST_BOLD, "").trim();
  return stripped.length > 0 ? stripped : null;
}

export function reasoningStatus(
  text: string,
  options: { streaming: boolean; durationMs?: number | null },
): ReasoningStatus {
  // `??` would keep a blank capture: `**  **` trims to "" and renders a status
  // line with a duration and no words at all.
  const matched = FIRST_BOLD.exec(text)?.[1]?.trim();
  const header = matched !== undefined && matched.length > 0 ? matched : null;
  const elapsed = notableDuration(options.durationMs ?? null);
  // A live thought carries no number. Its duration is not known yet, and a
  // counter pinned beside a verb that is still being written is exactly the
  // layout fight the reference apps document avoiding — the number is a receipt
  // for a finished thought, not a progress bar for a running one.
  if (options.streaming) return { verb: header ?? "Thinking…", meta: null };
  if (header) return { verb: header, meta: elapsed };
  return { verb: elapsed ? `Thought for ${elapsed}` : "Thought", meta: null };
}

/* -------------------------------------------------------------------- todos */

export type SessionTodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type SessionTodoPriority = "high" | "medium" | "low";

export interface SessionTodo {
  id: string;
  content: string;
  status: SessionTodoStatus;
  priority: SessionTodoPriority;
}

export function projectSessionTodos(messages: readonly UIMessage[]): SessionTodo[] | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message || message.role !== "assistant") continue;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex];
      if (part?.type !== "dynamic-tool" || !isPlanActivity(part)) continue;
      if (part.state === "output-error" || part.state === "output-denied") continue;
      const todos = extractTodos(part);
      if (todos) return todos;
    }
  }
  return null;
}

export function extractTodos(part: DynamicToolUIPart): SessionTodo[] | null {
  const fromInput = todosFromUnknown("input" in part ? part.input : undefined);
  if (fromInput) return fromInput;
  return todosFromUnknown("output" in part ? part.output : undefined);
}

/**
 * Todos are often `{content,status,priority}` with no id, and tool output may be
 * a JSON string of the array. Returns `[]` for an explicit empty list, `null`
 * when the value is not a todo list at all.
 */
export function todosFromUnknown(value: unknown): SessionTodo[] | null {
  const resolved = coerceTodoList(value);
  if (!resolved) return null;
  if (resolved.length === 0) return [];
  const todos: SessionTodo[] = [];
  for (let index = 0; index < resolved.length; index += 1) {
    const item = resolved[index];
    if (!isRecord(item)) continue;
    const content =
      typeof item.content === "string"
        ? item.content
        : typeof item.title === "string"
          ? item.title
          : typeof item.text === "string"
            ? item.text
            : null;
    const status = normalizeTodoStatus(item.status);
    const priority = normalizeTodoPriority(item.priority);
    if (!content || !status) continue;
    const id =
      typeof item.id === "string" && item.id.trim().length > 0
        ? item.id
        : `todo-${index}-${content.slice(0, 24)}`;
    todos.push({ id, content, status, priority: priority ?? "medium" });
  }
  // A payload that was a todo list but whose rows all failed to parse reads as
  // empty rather than missing, so the dock can clear.
  return todos;
}

function coerceTodoList(value: unknown): unknown[] | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return coerceTodoList(JSON.parse(trimmed) as unknown);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.todos)) return value.todos;
  return null;
}

function normalizeTodoStatus(value: unknown): SessionTodoStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[-\s]/g, "_");
  if (
    normalized === "pending" ||
    normalized === "in_progress" ||
    normalized === "completed" ||
    normalized === "cancelled"
  ) {
    return normalized;
  }
  if (normalized === "complete" || normalized === "done") return "completed";
  if (normalized === "canceled") return "cancelled";
  if (normalized === "active" || normalized === "running") return "in_progress";
  return null;
}

function normalizeTodoPriority(value: unknown): SessionTodoPriority | null {
  if (value === undefined || value === null || value === "") return "medium";
  if (typeof value !== "string") return "medium";
  const normalized = value.trim().toLowerCase();
  if (normalized === "high" || normalized === "medium" || normalized === "low") return normalized;
  return "medium";
}

/* ------------------------------------------------------------------- shared */

/**
 * Conventional subject keys first, then any short string scalar. These are
 * argument names, not tool names — the fallback stays harness-neutral.
 */
const SUBJECT_KEYS = [
  "path",
  "filePath",
  "file_path",
  "command",
  "pattern",
  "query",
  "url",
  "glob",
  "prompt",
  "description",
] as const;

export function bestEffortSubject(input: unknown): string | null {
  if (typeof input === "string") return input.trim() || null;
  if (!isRecord(input)) return null;
  for (const key of SUBJECT_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.trim().length > 0 && value.length <= 240) {
      return value.trim();
    }
  }
  return null;
}

function readableText(value: unknown): string | null {
  if (typeof value === "string") return value.trim().length > 0 ? value : null;
  if (!isRecord(value)) return null;
  for (const key of ["output", "text", "content", "stdout", "result", "body"]) {
    const nested = value[key];
    if (typeof nested === "string" && nested.trim().length > 0) return nested;
  }
  return null;
}

function clampLines(text: string, budget = DETAIL_LINE_BUDGET): string {
  const lines = text.split("\n");
  if (lines.length <= budget) return text;
  return `${lines.slice(0, budget).join("\n")}\n…`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
