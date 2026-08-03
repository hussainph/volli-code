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
  readActivityDescriptor,
  type ActivityDescriptor,
  type ActivityKind,
} from "@volli/shared";
import type { DynamicToolUIPart, ReasoningUIPart, UIMessage } from "ai";

type MessagePart = UIMessage["parts"][number];

/* ---------------------------------------------------------------- segments */

/**
 * A row inside a bundle. Reasoning is not special: it is a row like any other,
 * with its own glyph and its own disclosure, which is where Cursor and t3code
 * both landed. A standalone "Thought" header above the machinery said the same
 * thing twice and gave the transcript a second left edge to disagree about.
 */
export type BundleRow =
  | {
      kind: "reasoning";
      part: ReasoningUIPart;
      key: string;
      /**
       * Whether the model is still writing *this* thought — which is not what
       * the part's own state says. OpenCode leaves a reasoning part `streaming`
       * for the rest of the turn, so a row trusting it spins forever and its
       * timer reports the whole turn's duration as the thought's. A thought is
       * over the moment anything follows it, and the projection is the only
       * place that knows what followed.
       */
      streaming: boolean;
    }
  | { kind: "tool"; part: DynamicToolUIPart; key: string };

/**
 * The transcript is a flat list of two things: what the agent said, and one
 * bundle per contiguous run of everything else.
 *
 * The old model had four nested levels — turn fold over block over group header
 * over rows — and each level needed its own spacing rule, its own left edge and
 * its own fold state. They composed into a rhythm no single rule could fix.
 * Here depth is never indentation: a bundle's rows sit at the same left edge as
 * the summary that counts them, and the caret is the only thing that says one
 * contains the other.
 *
 * One thing leaves the bundle, and only one: a call gated on a decision. It
 * blocks the reader and it needs controls, so it must not sit behind a
 * disclosure at all — and the decision belongs *where it happened*, beside the
 * command it is about, rather than as a card at the foot of the transcript with
 * the row it gates left saying only that it is waiting. Failures and denials
 * stay inside; the summary confesses them in red and `needsAttention` opens the
 * bundle, which costs the transcript no second left edge.
 */
export type ChatSegment =
  | { kind: "text"; part: Extract<MessagePart, { type: "text" }>; key: string }
  | { kind: "bundle"; rows: BundleRow[]; key: string }
  | { kind: "attention"; part: DynamicToolUIPart; key: string };

/** Outcomes a bundle must not swallow silently. */
export function needsAttention(state: DynamicToolUIPart["state"]): boolean {
  return state === "output-error" || state === "output-denied" || state === "approval-requested";
}

/** The one state that leaves the bundle: it blocks, and it needs controls. */
export function isBlocking(state: DynamicToolUIPart["state"]): boolean {
  return state === "approval-requested";
}

/**
 * The harness's own id for the decision a call is waiting on, which is the same
 * id the interaction carries in `native.id`. Null on every other state, so a row
 * can be asked without narrowing it first.
 */
export function approvalId(part: DynamicToolUIPart): string | null {
  return part.state === "approval-requested" ? part.approval.id : null;
}

/**
 * Every decision a transcript row is already showing.
 *
 * The foot slot takes what is left. Without this an interaction correlated to a
 * visible call would be drawn twice — once on its row and once under the
 * composer — and answering one copy would leave the other on screen until the
 * projection caught up.
 */
export function gatedApprovalIds(messages: readonly UIMessage[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "dynamic-tool") continue;
      const id = approvalId(part);
      if (id !== null) ids.add(id);
    }
  }
  return ids;
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

interface KeyedPart {
  part: MessagePart;
  key: string;
}

export function segmentMessageParts(
  parts: readonly MessagePart[],
  messageId: string,
): ChatSegment[] {
  return segmentParts(parts.map((part, index) => ({ part, key: `${messageId}:${index}` })));
}

/**
 * One turn's segments, across however many messages the harness split it into.
 *
 * OpenCode emits an assistant message *per step*, so a single reply arrives as
 * a dozen messages. Segmenting each one alone put a bundle boundary at every
 * step: four stacked `Ran 2 commands` headers where one `Ran 8 commands` was
 * meant, and any step that only thought became a bare reasoning row between
 * them. That seam is invisible to the reader and must not be felt — a turn is
 * everything the agent did between two things the *user* said.
 */
export function segmentTurn(messages: readonly UIMessage[]): ChatSegment[] {
  const parts: KeyedPart[] = [];
  for (const message of messages) {
    message.parts.forEach((part, index) => parts.push({ part, key: `${message.id}:${index}` }));
  }
  return segmentParts(parts);
}

/**
 * Consecutive assistant messages collapse into one turn; anything else stands
 * alone. Grouping by adjacency rather than by a stamped `turnId` keeps this
 * working for a harness that never stamps one — a user message is the only
 * thing that can start a turn, and that is observable everywhere.
 */
export function groupTurns(messages: readonly UIMessage[]): UIMessage[][] {
  const turns: UIMessage[][] = [];
  for (const message of messages) {
    const last = turns[turns.length - 1];
    if (last && message.role === "assistant" && last[0]?.role === "assistant") last.push(message);
    else turns.push([message]);
  }
  return turns;
}

function segmentParts(entries: readonly KeyedPart[]): ChatSegment[] {
  const segments: ChatSegment[] = [];
  let bundle: BundleRow[] | null = null;

  const flush = () => {
    const first = bundle?.[0];
    if (bundle && first)
      segments.push({ kind: "bundle", rows: bundle, key: `${first.key}:bundle` });
    bundle = null;
  };

  entries.forEach(({ part, key }) => {
    if (part.type === "text") {
      // A blank text part is not a segment. A harness opens one before it has
      // words (OpenCode does) and can leave a whitespace-only one between tool
      // calls; rendered, it is a zero-height row that still collects the gap on
      // *both* sides of itself, and it `flush()`es — which is what split a
      // single run of exploration into two stacked headers each summarizing
      // half of it.
      if (isBlankText(part.text)) return;
      flush();
      segments.push({ kind: "text", part, key });
      return;
    }
    if (part.type === "reasoning") {
      bundle ??= [];
      // Settled by default; `settleThoughts` promotes the one that is still
      // being written, and drops the wordless ones nothing will ever fill.
      bundle.push({ kind: "reasoning", part, key, streaming: false });
      return;
    }
    if (part.type !== "dynamic-tool") return;
    if (isPlanActivity(part)) return;
    if (isBlocking(part.state)) {
      flush();
      segments.push({ kind: "attention", part, key });
      return;
    }
    bundle ??= [];
    bundle.push({ kind: "tool", part, key });
  });

  flush();
  return settleThoughts(segments);
}

/**
 * Exactly one thought may be live, and only if nothing came after it.
 *
 * The harness cannot be trusted for this: OpenCode never flips a reasoning part
 * back off `streaming`, so every thought in a turn claimed to still be running
 * and each one's timer counted from its own start to the end of the turn. But
 * the transcript already knows the answer structurally — a tool call, a
 * sentence, or another thought after this one all mean the model finished
 * thinking. Only the final row in the turn can still be in progress.
 *
 * Wordless thoughts are dropped in the same pass rather than at push time,
 * because whether an empty part is a placeholder or a leftover depends entirely
 * on whether anything followed it — the same question.
 */
function settleThoughts(segments: readonly ChatSegment[]): ChatSegment[] {
  const last = segments[segments.length - 1];
  const live = last?.kind === "bundle" ? last.rows[last.rows.length - 1] : undefined;
  if (live?.kind === "reasoning" && live.part.state === "streaming") live.streaming = true;

  const kept: ChatSegment[] = [];
  for (const segment of segments) {
    if (segment.kind !== "bundle") {
      kept.push(segment);
      continue;
    }
    const rows = segment.rows.filter(
      (row) => row.kind !== "reasoning" || row.streaming || !isBlankText(row.part.text),
    );
    // The key was stamped when the bundle opened, so dropping rows out of it
    // never re-keys the segment and never remounts an open disclosure.
    if (rows.length > 0) kept.push({ ...segment, rows });
  }
  return kept;
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
  const turns = groupTurns(messages);
  const turn = turns[turns.length - 1];
  if (!turn || turn[0]?.role !== "assistant") return true;
  // The whole turn, not its newest message: a harness that opens a fresh
  // message per step would otherwise re-arm the placeholder at every step,
  // under a bundle that is already reporting the same work.
  return segmentTurn(turn).length === 0;
}

/* ----------------------------------------------------------------- summary */

export type SummaryTone = "neutral" | "muted" | "danger" | "attention";
export interface SummarySegment {
  text: string;
  tone: SummaryTone;
}

interface KindPhrase {
  past: string;
  present: string;
  one: string;
  many: string;
}

const KIND_PHRASES: Record<ActivityKind, KindPhrase> = {
  "run-command": { past: "ran", present: "running", one: "command", many: "commands" },
  "read-file": { past: "read", present: "reading", one: "file", many: "files" },
  "edit-file": { past: "edited", present: "editing", one: "file", many: "files" },
  "write-file": { past: "created", present: "creating", one: "file", many: "files" },
  search: { past: "searched", present: "searching", one: "time", many: "times" },
  "list-directory": { past: "listed", present: "listing", one: "directory", many: "directories" },
  "fetch-url": { past: "fetched", present: "fetching", one: "page", many: "pages" },
  plan: { past: "planned", present: "planning", one: "plan", many: "plans" },
  delegate: { past: "delegated", present: "delegating", one: "task", many: "tasks" },
  other: { past: "used", present: "using", one: "tool", many: "tools" },
};

/**
 * How many files a phrase will name before it starts counting them instead.
 * Naming is the point — `edited activity.ts and activity-ui.tsx` tells you what
 * the turn was for, where `edited 2 files` makes you open it to find out — but
 * past a few names the row stops being a summary and becomes the list again.
 */
export const NAMED_SUBJECT_LIMIT = 3;

export function bundleToolRows(rows: readonly BundleRow[]): Extract<BundleRow, { kind: "tool" }>[] {
  return rows.filter((row): row is Extract<BundleRow, { kind: "tool" }> => row.kind === "tool");
}

export function isBundleStreaming(rows: readonly BundleRow[]): boolean {
  return rows.some((row) => (row.kind === "reasoning" ? row.streaming : isRowActive(row.part)));
}

/** A failure or a denial inside the bundle, which is reason enough to open it. */
export function bundleNeedsAttention(rows: readonly BundleRow[]): boolean {
  return bundleToolRows(rows).some((row) => needsAttention(row.part.state));
}

/**
 * The one line a bundle shows at rest: `Read 4 files, ran 3 commands, edited
 * activity.ts`.
 *
 * Phrases are per kind in first-appearance order, so the sentence reads in the
 * order the work happened. A kind still in flight takes the present participle
 * and the whole phrase takes an ellipsis, which is how a live bundle reports
 * progress without expanding — the only thing on screen while the agent works,
 * so it has to carry the whole load.
 *
 * Reasoning is deliberately uncounted. It is a row inside, and a header that
 * also said "thought twice" would be describing the rows rather than the work.
 * Empty for a bundle that is reasoning only: then the row *is* the summary, and
 * a header above it would be the same sentence at two indents.
 */
export function bundleSummary(rows: readonly BundleRow[]): SummarySegment[] {
  const tools = bundleToolRows(rows);
  if (tools.length === 0) return [];

  const order: ActivityKind[] = [];
  const groups = new Map<ActivityKind, DynamicToolUIPart[]>();
  for (const row of tools) {
    const kind = activityDescriptor(row.part).kind;
    const group = groups.get(kind);
    if (group) group.push(row.part);
    else {
      groups.set(kind, [row.part]);
      order.push(kind);
    }
  }

  const phrase = order
    .map((kind) => kindPhrase(kind, groups.get(kind) ?? []))
    .join(", ")
    .replace(/^./, (character) => character.toUpperCase());
  const streaming = tools.some((row) => isRowActive(row.part));
  const segments: SummarySegment[] = [{ text: streaming ? `${phrase}…` : phrase, tone: "neutral" }];

  const failed = tools.filter((row) => row.part.state === "output-error").length;
  const denied = tools.filter((row) => row.part.state === "output-denied").length;
  if (failed > 0) segments.push({ text: `${failed} failed`, tone: "danger" });
  if (denied > 0) segments.push({ text: `${denied} denied`, tone: "danger" });
  return segments;
}

function kindPhrase(kind: ActivityKind, parts: readonly DynamicToolUIPart[]): string {
  const phrase = KIND_PHRASES[kind];
  const verb = parts.some(isRowActive) ? phrase.present : phrase.past;
  if (isDurableActivity(kind) && parts.length <= NAMED_SUBJECT_LIMIT) {
    const names = parts.map(subjectName).filter((name): name is string => name !== null);
    if (names.length === parts.length && names.length > 0) return `${verb} ${joinNames(names)}`;
  }
  return `${verb} ${parts.length} ${parts.length === 1 ? phrase.one : phrase.many}`;
}

/** Basename only: the phrase is a sentence, and a sentence with a path in it is not. */
function subjectName(part: DynamicToolUIPart): string | null {
  const label = activityDescriptor(part).subject.label;
  if (label === null || label.trim().length === 0) return null;
  return splitPath(label).basename || label;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/* ----------------------------------------------------------------- rows */

export function isRowActive(part: DynamicToolUIPart): boolean {
  const status = activityStatus(part);
  return status === "pending" || status === "running" || status === "approval";
}

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
