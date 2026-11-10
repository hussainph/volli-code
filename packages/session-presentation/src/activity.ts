/**
 * Chat activity projection — the pure half of the transcript renderer.
 *
 * Everything here switches on `ActivityKind` from `@volli/shared`. There are no
 * harness tool names in this file and there must never be: a second adapter
 * renames every tool and the transcript still reads correctly. When a harness
 * has not stamped a descriptor yet the row degrades to the `"other"` presenter,
 * which names the tool in readable words (`Used Linear · Create issue`) and
 * keeps the raw name in its detail — a first-class shape rather than a broken
 * one.
 *
 * Every row's verb is chosen here from its status, never in the UI: a row that
 * is still running says so in the present tense, a failed one says it failed,
 * and the title alone tells a screen reader what the glyph tells the eye.
 *
 * Layering: this module answers "what does this row say"; `activity-ui.tsx`
 * answers "what does it look like". Presenters are total functions of a
 * context object, so a row's text is unit-testable without React.
 */
import {
  activityDuration,
  isDurableActivity,
  readActivityDescriptor,
  type ActivityBrowse,
  type ActivityBrowseAction,
  type ActivityDescriptor,
  type ActivityKind,
} from "@volli/shared";
import type { DynamicToolUIPart, ReasoningUIPart, UIMessage } from "ai";
import { humanMcpToolName, humanToolName } from "./tool-names";

type MessagePart = UIMessage["parts"][number];

/* ---------------------------------------------------------------- segments */

/**
 * A row inside a bundle. Reasoning has its own glyph and disclosure,
 * using the same alignment as tool rows without a redundant group header.
 */
export type BundleRow =
  | {
      kind: "reasoning";
      part: ReasoningUIPart;
      key: string;
      /**
       * Whether the model is still writing *this* thought — which is not what
       * the part's own state says. A harness may leave a reasoning part
       * `streaming` for the rest of the turn (OpenCode did), so a row trusting
       * it spins forever and its
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
 * A bundle owns the rows behind one disclosure; its rendering and guide rail
 * belong to the client, not this projection.
 *
 */
export type ChatSegment =
  | { kind: "text"; part: Extract<MessagePart, { type: "text" }>; key: string }
  | { kind: "bundle"; rows: BundleRow[]; key: string };

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

/** The grouping key of one rendered transcript part. */
function transcriptPartKey(messageId: string, index: number): string {
  return `${messageId}:${index}`;
}

export function segmentMessageParts(
  parts: readonly MessagePart[],
  messageId: string,
): ChatSegment[] {
  return segmentParts(
    parts.map((part, index) => ({ part, key: transcriptPartKey(messageId, index) })),
  );
}

/**
 * One turn's segments, across however many messages the harness split it into.
 *
 * A harness may emit an assistant message *per step* (OpenCode did), so a
 * single reply arrives as a dozen messages. Segmenting each one alone put a
 * bundle boundary at every
 * step: four stacked `Ran 2 commands` headers where one `Ran 8 commands` was
 * meant, and any step that only thought became a bare reasoning row between
 * them. That seam is invisible to the reader and must not be felt — a turn is
 * everything the agent did between two things the *user* said.
 */
export function segmentTurn(messages: readonly UIMessage[]): ChatSegment[] {
  const parts: KeyedPart[] = [];
  for (const message of messages) {
    message.parts.forEach((part, index) =>
      parts.push({ part, key: transcriptPartKey(message.id, index) }),
    );
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
      // words (OpenCode did) and can leave a whitespace-only one between tool
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
    bundle ??= [];
    bundle.push({ kind: "tool", part, key });
  });

  flush();
  return settleThoughts(segments);
}

/**
 * Exactly one thought may be live, and only if nothing came after it.
 *
 * The harness cannot be trusted for this: OpenCode never flipped a reasoning
 * part back off `streaming`, so every thought in a turn claimed to still be
 * running and each one's timer counted from its own start to the end of the
 * turn. But
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
 * The placeholder belongs to the turn rather than the reasoning row.
 * A reasoning part can render nothing until it has words without hiding
 * the indication that the turn is still awaiting output.
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
  // `time`/`times` is the fallback only: a browse bundle counts the PAGES it
  // touched, and reaches these words only when it knows none. See browsePhrase.
  browse: { past: "browsed", present: "browsing", one: "time", many: "times" },
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

/**
 * A failure or denial inside the bundle. This is an outcome signal, never an
 * instruction to open the reader's disclosure. A non-zero command counts;
 * a search that found nothing does not.
 */
export function bundleNeedsAttention(rows: readonly BundleRow[]): boolean {
  return bundleToolRows(rows).some((row) => isAlarming(describeActivity(row.part).status));
}

function isAlarming(status: ActivityStatus): boolean {
  return status === "failed" || status === "denied";
}

/**
 * The one line a bundle shows at rest: `Read 4 files, ran 3 commands, edited
 * activity.ts`.
 *
 * Phrases are per kind in first-appearance order, so the sentence reads in the
 * order the work happened. While any row is in flight every phrase takes the
 * present participle. The client supplies the progress glyph, never an ellipsis.
 * This is the detailed breakdown; workGist supplies the compact group title.
 *
 * Reasoning is deliberately uncounted. It is a row inside, and a header that
 * also said "thought twice" would be describing the rows rather than the work.
 * Empty for a bundle that is reasoning only: then the row *is* the summary, and
 * a header above it would be the same sentence at two indents.
 */
export function bundleSummary(rows: readonly BundleRow[]): SummarySegment[] {
  const tools = bundleToolRows(rows);
  if (tools.length === 0) return [];

  // A Map iterates in insertion order, and a kind is inserted the first time it
  // appears — so the Map itself is the first-appearance order the sentence needs.
  // Only successful or active rows earn a kind's completion/progress verb.
  // Failed edits may have changed nothing (or only part of a file), denials
  // never executed, and legacy not-run calls have no receipt. Count those
  // endings separately rather than calling them completed work.
  const groups = new Map<ActivityKind, DynamicToolUIPart[]>();
  let notRun = 0;
  for (const row of tools) {
    const status = describeActivity(row.part).status;
    if (status === "not-run") {
      notRun += 1;
      continue;
    }
    if (isAlarming(status)) continue;
    const kind = activityDescriptor(row.part).kind;
    const group = groups.get(kind);
    if (group) group.push(row.part);
    else groups.set(kind, [row.part]);
  }

  const segments: SummarySegment[] = [];
  if (groups.size > 0) {
    // One tense for the whole sentence: `Read 2 files, running 1 command…`
    // mixed a finished clause and a live one, and read as two reports. While
    // anything is still in flight the bundle is work in progress, so every
    // clause is; once it settles, every clause is done.
    const streaming = tools.some((row) => isRowActive(row.part));
    const phrase = [...groups]
      .map(([kind, parts]) => kindPhrase(kind, parts, streaming))
      .join(", ")
      .replace(/^./, (character) => character.toUpperCase());
    // In progress is the header's spinner to say, never trailing punctuation.
    segments.push({ text: phrase, tone: "neutral" });
  }

  // Counted from the status each row shows, so the summary and its rows agree.
  const statuses = tools.map((row) => describeActivity(row.part).status);
  const failed = statuses.filter((status) => status === "failed").length;
  const denied = statuses.filter((status) => status === "denied").length;
  if (failed > 0) segments.push({ text: `${failed} failed`, tone: "danger" });
  if (denied > 0) segments.push({ text: `${denied} denied`, tone: "danger" });
  if (notRun > 0) segments.push({ text: `${notRun} not run`, tone: "muted" });
  return segments;
}

function kindPhrase(
  kind: ActivityKind,
  parts: readonly DynamicToolUIPart[],
  streaming: boolean,
): string {
  const phrase = KIND_PHRASES[kind];
  const verb = streaming ? phrase.present : phrase.past;
  if (kind === "browse") return browsePhrase(verb, phrase, parts);
  if (isDurableActivity(kind) && parts.length <= NAMED_SUBJECT_LIMIT) {
    const names = parts.map(subjectName).filter((name): name is string => name !== null);
    if (names.length === parts.length && names.length > 0) return `${verb} ${joinNames(names)}`;
  }
  return `${verb} ${parts.length} ${parts.length === 1 ? phrase.one : phrase.many}`;
}

/**
 * A browse bundle names the PAGES it touched, not how many calls it took
 * (VC-238 §3): ten acts on one sign-in form are one page's worth of work, and
 * `browsed 10 times` says nothing a person can use. Counting distinct pages is
 * what makes the header behave like the file kinds' — `read 4 files` counts
 * four files, not four reads.
 *
 * Falls back to counting calls only when no page is known at all, which is a
 * bundle of `browser_tabs` listings or of calls refused before any tab was in
 * hand.
 */
function browsePhrase(
  verb: string,
  phrase: KindPhrase,
  parts: readonly DynamicToolUIPart[],
): string {
  const pages = [...new Set(parts.map(subjectLabel).filter((one): one is string => one !== null))];
  if (pages.length === 0) {
    return `${verb} ${parts.length} ${parts.length === 1 ? phrase.one : phrase.many}`;
  }
  if (pages.length <= NAMED_SUBJECT_LIMIT) return `${verb} ${joinNames(pages)}`;
  return `${verb} ${pages.length} pages`;
}

/** The subject as the presenter set it — whole, since a page is not a path. */
function subjectLabel(part: DynamicToolUIPart): string | null {
  const label = activityDescriptor(part).subject.label;
  return label === null || label.trim().length === 0 ? null : label;
}

/** Basename only: the phrase is a sentence, and a sentence with a path in it is not. */
function subjectName(part: DynamicToolUIPart): string | null {
  const label = activityDescriptor(part).subject.label;
  if (label === null || label.trim().length === 0) return null;
  return splitPath(label).basename || label;
}

function joinNames(names: readonly string[]): string {
  /* v8 ignore next -- the sole call site only reaches here with names.length > 0, so a length-1 array's index 0 is never undefined. */
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/* ----------------------------------------------------------------- rows */

export function isRowActive(part: DynamicToolUIPart): boolean {
  const status = activityStatus(part);
  return status === "pending" || status === "running";
}

/**
 * `not-run` is a legacy row's honest ending: the interaction machinery that
 * would have driven it further is gone (VC-504), no execution result was ever
 * recorded, and the row must neither claim success (`done`) nor look alive
 * (`pending`/`running`). It is not settled — it has no receipt to show.
 */
export type ActivityStatus = "pending" | "running" | "done" | "denied" | "failed" | "not-run";

export function activityStatus(part: DynamicToolUIPart): ActivityStatus {
  switch (part.state) {
    case "input-streaming":
      return "pending";
    case "input-available":
      return "running";
    // Retired AI SDK approval states survive only in transcripts recorded
    // before the approval machinery was removed. Neither carries an execution
    // result, so neither may read as `done`; the row stays read-only and says
    // the call never ran. A recorded refusal keeps its honest `denied`.
    case "approval-requested":
      return "not-run";
    case "approval-responded":
      return part.approval.approved ? "not-run" : "denied";
    case "output-error":
      return "failed";
    case "output-denied":
      return "denied";
    case "output-available":
      return part.preliminary === true ? "running" : "done";
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
  /**
   * The words before the object, in the tense the row's status earns:
   * `Running`, `Ran`, `Failed to run`, `Denied running`. Empty only when the
   * sentence starts with its object (`pnpm lint exited with code 1`).
   */
  verb: string;
  /** Mono. The path, the command, the pattern. */
  object: string | null;
  /**
   * Words after the object, when the sentence needs them: `exited with code 1`.
   * Absent on every row whose sentence ends with its object.
   */
  after?: string | null;
  /** Non-null when clicking the object should open a workspace artifact. */
  openPath: string | null;
  /**
   * Non-null when clicking the object should open a Session — a `delegate`
   * row's child (VC-9). Beside `openPath` rather than overloading it, because
   * a Session id is not a path and the surface that opens one is not the
   * surface that opens the other.
   */
  openSessionId?: string | null;
  meta: string | null;
  metaTone: SummaryTone;
  detail: ActivityDetail | null;
}

export interface ActivityRow extends ActivityFacts {
  kind: ActivityKind;
  status: ActivityStatus;
  nativeToolName: string;
  /** Words after the object (`exited with code 1`); null when there are none. */
  after: string | null;
  /**
   * The shell command retained on the tool call itself, including newlines.
   *
   * `object` is what every row renders inline; this separate value is the
   * disclosure's source, so a long bash invocation is not reduced to the
   * single-line summary the header needs.
   */
  command: string | null;
  errorText: string | null;
  /**
   * The browser facet, for a `browse` row's card (VC-238): which tab to look
   * up live, and which picture to show. Null on every other kind, and on a
   * browse descriptor that carried no facet.
   */
  browse: ActivityBrowse | null;
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
 * One verb in the forms a row's status picks between. `base` is the bare
 * infinitive the other sentences are built from — `Failed to run`,
 * `Run pnpm test` while the call is still being written — so a kind names its
 * verb once and every status reads in the same words.
 */
interface ActivityVerbs {
  base: string;
  running: string;
  done: string;
}

/**
 * The verb a row's status earns (shadcn Trace's convention): done work in the
 * past (`Ran pnpm build`), work in flight in the present (`Running pnpm
 * build`), work not started yet as the bare step (`Run pnpm build`), and
 * the two endings that did not go well say so in words (`Failed to run …`,
 * `Denied running …`). A legacy row that never executed claims nothing.
 */
function tensed(verbs: ActivityVerbs, status: ActivityStatus): string {
  switch (status) {
    case "pending":
      return upperFirst(verbs.base);
    case "running":
      return verbs.running;
    case "failed":
      return `Failed to ${verbs.base}`;
    case "denied":
      return `Denied ${lowerFirst(verbs.running)}`;
    case "not-run":
      return "Not run";
    case "done":
      return verbs.done;
  }
}

function upperFirst(value: string): string {
  return value.replace(/^./, (character) => character.toUpperCase());
}

function lowerFirst(value: string): string {
  return value.replace(/^./, (character) => character.toLowerCase());
}

const KIND_VERBS = {
  "run-command": { base: "run", running: "Running", done: "Ran" },
  "read-file": { base: "read", running: "Reading", done: "Read" },
  "edit-file": { base: "edit", running: "Editing", done: "Edited" },
  "write-file": { base: "create", running: "Creating", done: "Created" },
  search: { base: "grep", running: "Grepping", done: "Grepped" },
  "list-directory": { base: "list", running: "Listing", done: "Listed" },
  "fetch-url": { base: "fetch", running: "Fetching", done: "Fetched" },
  plan: { base: "plan", running: "Planning", done: "Planned" },
  delegate: { base: "delegate to", running: "Delegating to", done: "Delegated to" },
} satisfies Partial<Record<ActivityKind, ActivityVerbs>>;

/**
 * Per-kind presenters. Each is a pure function of the context, so the meta
 * formula for a kind is one testable expression rather than a branch buried in
 * JSX. The right column is the whole gap between this transcript and the
 * reference apps: every resting row earns a number.
 */
export const ACTIVITY_PRESENTERS: Record<ActivityKind, ActivityParse> = {
  "run-command": (context) => {
    // The descriptor is a durable summary; the call input is the command Pi was
    // asked to run. Prefer that source so a stale or abbreviated descriptor can
    // never hide the actual bash invocation from the person reviewing it.
    const object = commandInput(context.input) ?? context.descriptor.subject.label;
    if (isShellStop(context.descriptor)) {
      // A deliberate stop ends a command with a signal's exit (143), and that
      // is what was asked for: the row says it stopped, never that it failed.
      return {
        verb: tensed(STOP_VERBS, context.status),
        object,
        openPath: null,
        meta: durationMeta(context),
        metaTone: "muted",
        detail: outputDetail(context),
      };
    }
    const exitCode =
      isSettled(context.status) && context.status !== "denied" ? commandExitCode(context) : null;
    if (exitCode !== null && isSearchMiss(object, exitCode)) {
      // A search that found nothing exits 1, and that is an answer: the row
      // reads as a command that ran, never as one that failed.
      return {
        verb: tensed(KIND_VERBS["run-command"], "done"),
        object,
        openPath: null,
        meta: "no matches",
        metaTone: "muted",
        detail: outputDetail(context),
      };
    }
    const exited = exitCode !== null && exitCode !== 0;
    const exit = `exited with code ${exitCode}`;
    return {
      // `pnpm lint exited with code 1` — the code is the failure, so the
      // sentence says it rather than `Ran` beside a red number.
      verb: exited
        ? object === null
          ? upperFirst(exit)
          : ""
        : tensed(KIND_VERBS["run-command"], context.status),
      object,
      after: exited && object !== null ? exit : null,
      openPath: null,
      // The command is already the headline; the meta is the cost.
      meta: durationMeta(context),
      metaTone: "muted",
      detail: outputDetail(context),
    };
  },

  "read-file": (context) => {
    const range = context.descriptor.subject.lineRange;
    return {
      verb: tensed(KIND_VERBS["read-file"], context.status),
      object: context.descriptor.subject.label,
      openPath: context.descriptor.subject.path,
      // Only a partial read has anything to confess.
      meta: range ? `${range.start}–${range.end}` : null,
      metaTone: "muted",
      detail: numberedDetail(context),
    };
  },

  "edit-file": (context) => ({
    verb: tensed(KIND_VERBS["edit-file"], context.status),
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
      verb: tensed(KIND_VERBS["write-file"], context.status),
      object: context.descriptor.subject.label,
      openPath: context.descriptor.subject.path,
      meta: isSettled(context.status) && added !== null ? `+${added}` : null,
      metaTone: "muted",
      detail: contentDetail(context),
    };
  },

  search: (context) => ({
    verb: tensed(KIND_VERBS.search, context.status),
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
      verb: tensed(KIND_VERBS["list-directory"], context.status),
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
    // A harness need not report a byte count (OpenCode did not), so size is the
    // richer meta when one offers it and duration is the honest fallback when
    // none does.
    const bytes = context.descriptor.outcome?.bytes ?? null;
    return {
      verb: tensed(KIND_VERBS["fetch-url"], context.status),
      object: context.descriptor.subject.label,
      openPath: null,
      meta: isSettled(context.status) ? (formatBytes(bytes) ?? durationMeta(context)) : null,
      metaTone: "muted",
      detail: outputDetail(context),
    };
  },

  delegate: (context) => {
    const subject = context.descriptor.subject;
    // Two stampings share this kind. Volli's own `session_delegate` (VC-9)
    // fills `agentName` and, once the child exists, `sessionId` — so the row
    // reads `Delegated to  Token hunt` and its object opens the child Session.
    // A harness that stamps neither names the subagent through
    // `nativeToolName` instead (`Delegated to explore  Find the streaming
    // seam`), and its subject swaps while running as the adapter restamps the
    // child's last line.
    const named = subject.agentName ?? null;
    const agent = named === null ? readableToolName(context.descriptor.nativeToolName) : null;
    const verbs = KIND_VERBS.delegate;
    return {
      verb: tensed(
        agent === null
          ? verbs
          : {
              base: `${verbs.base} ${agent}`,
              running: `${verbs.running} ${agent}`,
              done: `${verbs.done} ${agent}`,
            },
        context.status,
      ),
      object: named ?? subject.label,
      openPath: null,
      openSessionId: subject.sessionId ?? null,
      meta: joinMeta([context.descriptor.outcome?.summary ?? null, durationMeta(context)]),
      metaTone: "muted",
      detail: outputDetail(context),
    };
  },

  plan: (context) => ({
    verb: tensed(KIND_VERBS.plan, context.status),
    object: context.descriptor.subject.label,
    openPath: null,
    ...NO_META,
    detail: planDetail(context),
  }),

  browse: (context) => browseFacts(context),

  other: (context) => {
    // A tool this file has no words for is named in readable ones — an MCP
    // tool by its server and tool (`Used Linear · Create issue`), anything
    // else by its own name with the separators taken out. The raw name is
    // never the verb; it stays in the detail, where the call's shape is.
    const nativeToolName = context.descriptor.nativeToolName;
    const name = readableToolName(nativeToolName);
    const label = context.descriptor.subject.label;
    return {
      verb: tensed(
        { base: `use ${name}`, running: `Using ${name}`, done: `Used ${name}` },
        context.status,
      ),
      // A harness that knows no better subject repeats the tool's own name;
      // the verb already says it, readably.
      object: label === nativeToolName ? null : label,
      openPath: context.descriptor.subject.path,
      meta: durationMeta(context),
      metaTone: "muted",
      // The one kind allowed to show its raw shape, and only in the detail.
      detail: signatureDetail(context),
    };
  },
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

/**
 * One description per part, for as long as that part exists.
 *
 * A presenter is not free: it runs the whole detail budget — `parseDiff`,
 * `numberLines`, `parseMatches`, 400 lines of it — and the transcript repaints
 * on every streamed token, so a settled row fifty calls back was re-parsing its
 * own 300-line diff for a screen that had not changed. Identity is a sound key
 * because transcript parts are immutable snapshots: a harness that changes a
 * call commits a new part rather than editing the old one (`message-projection.ts`),
 * so a part that has not changed cannot have a different description, and one
 * that has is a different object and misses.
 *
 * This keeps the function pure in the sense that matters — same part in, same
 * row out — and strengthens it to referential equality, which is what lets the
 * UI memoize on the result. The row is shared, so callers read it, never write
 * to it.
 */
const DESCRIPTIONS = new WeakMap<DynamicToolUIPart, ActivityRow>();

export function describeActivity(part: DynamicToolUIPart): ActivityRow {
  const cached = DESCRIPTIONS.get(part);
  if (cached) return cached;
  const row = buildActivityRow(part);
  DESCRIPTIONS.set(part, row);
  return row;
}

function buildActivityRow(part: DynamicToolUIPart): ActivityRow {
  const recorded = activityContext(part);
  // The presenters see the status the row will show, so the verb and the
  // glyph cannot disagree: a refused browse call is `Failed to click`, and a
  // search that found nothing is not a failure.
  const context = { ...recorded, status: presentedStatus(recorded) };
  const facts = ACTIVITY_PRESENTERS[context.descriptor.kind](context);
  const command = context.descriptor.kind === "run-command" ? facts.object : null;
  return {
    ...facts,
    after: facts.after ?? null,
    kind: context.descriptor.kind,
    status: context.status,
    nativeToolName: context.descriptor.nativeToolName,
    command,
    errorText: context.errorText,
    browse: context.descriptor.browse ?? null,
  };
}

/* ------------------------------------------------------------------- browse */

/**
 * One verb per browser action, in Volli's words. Element actions take the
 * element as their object and the page as their meta; page actions take the
 * page. The card under the row is the UI's, keyed on `ActivityRow.browse`,
 * so the presenter leaves `detail` empty for every action that has a tab —
 * except a tab listing, which has no tab and shows its text.
 */
const BROWSE_VERBS: Record<ActivityBrowseAction, string> = {
  open: "Opened",
  back: "Went back",
  forward: "Went forward",
  reload: "Reloaded",
  click: "Clicked",
  type: "Typed into",
  press: "Pressed",
  select: "Selected in",
  hover: "Hovered",
  scroll: "Scrolled",
  wait: "Waited",
  read: "Read page",
  screenshot: "Screenshot",
  console: "Read console",
  tabs: "Listed tabs",
  find: "Searched for",
};

/**
 * The other forms of each browser verb. The done form is `BROWSE_VERBS`, which
 * the Browser Trace replay shares, so a finished row and its replay frame
 * still name the call in the same words.
 */
const BROWSE_TENSES: Record<ActivityBrowseAction, Omit<ActivityVerbs, "done">> = {
  open: { base: "open", running: "Opening" },
  back: { base: "go back", running: "Going back" },
  forward: { base: "go forward", running: "Going forward" },
  reload: { base: "reload", running: "Reloading" },
  click: { base: "click", running: "Clicking" },
  type: { base: "type into", running: "Typing into" },
  press: { base: "press", running: "Pressing" },
  select: { base: "select in", running: "Selecting in" },
  hover: { base: "hover", running: "Hovering" },
  scroll: { base: "scroll", running: "Scrolling" },
  wait: { base: "wait", running: "Waiting" },
  read: { base: "read the page", running: "Reading page" },
  screenshot: { base: "take a screenshot", running: "Taking a screenshot" },
  console: { base: "read the console", running: "Reading console" },
  tabs: { base: "list tabs", running: "Listing tabs" },
  find: { base: "search for", running: "Searching for" },
};

function browseVerb(action: ActivityBrowseAction, status: ActivityStatus): string {
  return tensed({ ...BROWSE_TENSES[action], done: BROWSE_VERBS[action] }, status);
}

/** Actions whose object is an element the page named, quoted as the page's words. */
const ELEMENT_ACTIONS: ReadonlySet<ActivityBrowseAction> = new Set([
  "click",
  "type",
  "select",
  "hover",
]);

/** Actions whose object is what the model pressed or which way it scrolled. */
const PAGE_INPUT_ACTIONS: ReadonlySet<ActivityBrowseAction> = new Set(["press", "scroll"]);

/**
 * The status a row shows, where the recorded one would say the wrong thing.
 *
 * Browse (VC-238 §9): the harness calls a refusal and a page that failed to
 * load both a success — a refusal is a result it was handed, and a navigation
 * onto a broken page still answers with a perfectly good snapshot — so
 * without this the row would wear a tick over the two outcomes a person most
 * needs to see.
 *
 * Commands: a known non-zero exit is a failure even when the harness handed
 * the call back as a success, so the glyph says what the title says
 * (`pnpm lint exited with code 1`). Two exits are not: a search that exits 1
 * has found nothing, which Pi's bash reports as an error like any other
 * non-zero exit — an answer, not a failure — and a background shell stopped on
 * purpose exits with its signal's code because it was asked to.
 *
 * Only once the call has settled; a live row's status is always the harness's.
 */
function presentedStatus(context: ActivityContext): ActivityStatus {
  if (!isSettled(context.status) || context.status === "denied") return context.status;
  const facet = context.descriptor.browse ?? null;
  if (facet !== null) {
    return facet.refusal !== null || facet.error !== null ? "failed" : context.status;
  }
  if (context.descriptor.kind !== "run-command" || isShellStop(context.descriptor)) {
    return context.status;
  }
  const exitCode = commandExitCode(context);
  if (exitCode === null || exitCode === 0) return context.status;
  const command = commandInput(context.input) ?? context.descriptor.subject.label;
  return isSearchMiss(command, exitCode) ? "done" : "failed";
}

function browseFacts(context: ActivityContext): ActivityFacts {
  const facet = context.descriptor.browse ?? null;
  if (facet === null) {
    const page = context.descriptor.subject.label;
    const verbs = { base: "browse", running: "Browsing", done: "Browsed" };
    return {
      verb: tensed(verbs, context.status),
      object: page,
      openPath: null,
      ...NO_META,
      detail: null,
    };
  }
  const facts = browseActionFacts(context, facet);
  // A refusal outranks whatever the meta would have said: the call did not
  // happen, and the card carries the rule and Volli's words for it. A page
  // that did not load is the next-loudest thing the row can say; the card
  // carries Volli's sentence for that too.
  if (facet.refusal !== null) return { ...facts, meta: "refused", metaTone: "danger" };
  if (facet.error !== null) return { ...facts, meta: "did not load", metaTone: "danger" };
  return facts;
}

/**
 * What one browser action says on its own: the verb, and the object when the
 * action has one the row names — an element (quoted as the page's words), a
 * key, or a direction. The transcript row and a Browser Trace frame (VC-453)
 * both read it, so the row and the replay of the same call cannot name it
 * differently; the row adds the page as its meta, the replay draws the page
 * beside the caption.
 */
export function browseCaption(
  action: ActivityBrowseAction,
  target: string | null,
): { verb: string; object: string | null } {
  const verb = BROWSE_VERBS[action];
  if (ELEMENT_ACTIONS.has(action)) return { verb, object: quotedTarget(target) };
  if (PAGE_INPUT_ACTIONS.has(action)) return { verb, object: target };
  // A find's object is the model's own query, quoted even when it looks like
  // a ref: it is words searched for, never a handle.
  if (action === "find") return { verb, object: target === null ? null : `“${target}”` };
  return { verb, object: null };
}

function browseActionFacts(context: ActivityContext, facet: ActivityBrowse): ActivityFacts {
  const page = context.descriptor.subject.label;
  const verb = browseVerb(facet.action, context.status);
  if (
    ELEMENT_ACTIONS.has(facet.action) ||
    PAGE_INPUT_ACTIONS.has(facet.action) ||
    facet.action === "find"
  ) {
    return {
      ...browseCaption(facet.action, facet.target),
      verb,
      openPath: null,
      meta: page,
      metaTone: "muted",
      detail: null,
    };
  }
  if (facet.action === "wait") {
    return { verb, object: null, openPath: null, meta: page, metaTone: "muted", detail: null };
  }
  if (facet.action === "console") {
    const errors = facet.errorCount;
    return {
      verb,
      object: page,
      openPath: null,
      meta:
        errors === null
          ? null
          : errors === 0
            ? "no errors"
            : `${errors} ${errors === 1 ? "error" : "errors"}`,
      metaTone: errors !== null && errors > 0 ? "danger" : "muted",
      detail: null,
    };
  }
  if (facet.action === "tabs") {
    return { verb, object: null, openPath: null, ...NO_META, detail: outputDetail(context) };
  }
  return {
    verb,
    object: page,
    openPath: null,
    meta: facet.action === "open" ? durationMeta(context) : null,
    metaTone: "muted",
    detail: null,
  };
}

/**
 * The page's name for an element, in quotes; a bare ref (`e5`) unquoted, since
 * it is Volli's handle rather than the page's words.
 */
function quotedTarget(target: string | null): string | null {
  if (target === null) return null;
  return /^e\d+$/.test(target) ? target : `“${target}”`;
}

/**
 * The exit code a settled command reports: the descriptor's, else the final
 * receipt in a failed command. Pi bash appends `Command exited with code N`
 * (`agent-runtime/src/pi/vendor/pi-harness/tools/bash.ts`). Its activity error
 * passes through `safeStopMessage`, collapsing newlines; the descriptor summary
 * retains the original failure text. Read that anchored receipt for failed bash
 * only, never infer an exit from successful stdout or an arbitrary substring.
 */
function commandExitCode(context: ActivityContext): number | null {
  const recorded = context.descriptor.outcome?.exitCode ?? null;
  if (recorded !== null) return recorded;
  // Keep the recorded failure evidence even after a search miss is presented
  // as done; only output-error parts carry errorText in the SDK union.
  if (context.errorText === null) return null;
  const receipt = /(?:^|\n)Command exited with code (\d+)\s*$/;
  const match =
    receipt.exec(context.errorText) ??
    (context.descriptor.nativeToolName === "bash"
      ? receipt.exec(context.descriptor.outcome?.summary ?? "")
      : null);
  return match?.[1] === undefined ? null : Number(match[1]);
}

const STOP_VERBS: ActivityVerbs = { base: "stop", running: "Stopping", done: "Stopped" };

/**
 * The marker agent-runtime puts on a background-shell kill's subject
 * (`SHELL_MARKERS` in `pi/activity.ts`): the one row that is a deliberate stop
 * rather than a command's own ending. A read of a shell that exited with a
 * signal's code carries no such mark, and is judged by its exit like any other.
 */
const SHELL_STOP_MARKER = "(background · killed)";

function isShellStop(descriptor: ActivityDescriptor): boolean {
  return descriptor.subject.label?.endsWith(SHELL_STOP_MARKER) === true;
}

/**
 * A command whose exit status 1 means "no matches", as Codex treats them: the
 * program word (any directory in front of it) and, for git, its subcommand.
 */
const SEARCH_COMMAND = /^(?:\S*\/)?(?:rg|grep|egrep|fgrep|ag|ack|git\s+grep)(?:\s|$)/;

/**
 * Whether a command's exit is a search that found nothing. The status of a
 * chain or pipeline is its last command's, so that is the one that decides:
 * `cd src && rg seam` missed, `rg seam | head` did not exit 1 because of rg.
 * Leading `NAME=value` assignments are the environment, not the program.
 */
function isSearchMiss(command: string | null, exitCode: number): boolean {
  if (exitCode !== 1 || command === null) return false;
  const last = lastCommand(command);
  return last !== null && SEARCH_COMMAND.test(last.replace(/^(?:[A-Za-z_]\w*=\S*\s+)*/, ""));
}

/**
 * Find the final shell step without treating a regex's quoted `|` or `;` as
 * shell syntax. Substitutions, groups, redirections and backgrounding are
 * deliberately opaque: exit 1 there need not be a search result at all.
 */
function lastCommand(command: string): string | null {
  let start = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command.charAt(index);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else if (quote === '"' && (character === "`" || command.startsWith("$(", index))) return null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "|" || command.startsWith("&&", index)) {
      if (command.startsWith("||", index) || command.startsWith("&&", index)) index += 1;
      start = index + 1;
    } else if (character === ";" || character === "\n") start = index + 1;
    else if ("&()`<>#".includes(character)) return null;
  }
  return quote !== null || escaped ? null : command.slice(start).trim();
}

function commandInput(input: unknown): string | null {
  if (!isRecord(input) || typeof input.command !== "string") return null;
  return input.command.trim().length > 0 ? input.command : null;
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

/** Keeps compatibility todo snapshots readable as inline history, not a live product dock. */
function planDetail(context: ActivityContext): ActivityDetail | null {
  const lines = planLines(context.input) ?? planLines(context.output);
  return lines === null ? null : { view: "output", text: clampLines(lines.join("\n")) };
}

function planLines(value: unknown): string[] | null {
  const todos = planTodos(value);
  if (todos === null) return null;
  const lines: string[] = [];
  for (const todo of todos) {
    if (!isRecord(todo) || typeof todo.content !== "string" || todo.content.length === 0) continue;
    const status = typeof todo.status === "string" ? todo.status.toLowerCase() : "pending";
    const glyph =
      status === "completed" || status === "complete" || status === "done"
        ? "✓"
        : status === "in_progress" || status === "active" || status === "running"
          ? "→"
          : status === "cancelled" || status === "canceled"
            ? "×"
            : "○";
    lines.push(`${glyph} ${todo.content}`);
  }
  return lines.length > 0 ? lines : null;
}

function planTodos(value: unknown): unknown[] | null {
  if (typeof value === "string") {
    try {
      return planTodos(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) return value;
  return isRecord(value) && Array.isArray(value.todos) ? value.todos : null;
}

function contentDetail(context: ActivityContext): ActivityDetail | null {
  const text =
    writtenContent(context.input) ?? readableText(context.input) ?? readableText(context.output);
  return text === null ? null : { view: "output", text: clampLines(text) };
}

/**
 * The file a Write call created, from the call's own input record
 * (`{ path, content }`). The generic reader below does not take a plain-text
 * `content` field, and the call's output is only the harness confirmation —
 * without this the row would show "ok" instead of the file (VC-125).
 */
function writtenContent(input: unknown): string | null {
  if (!isRecord(input) || typeof input.content !== "string") return null;
  return input.content.trim().length > 0 ? input.content : null;
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

/**
 * The call as it was made: the tool's raw name with its arguments, then what
 * it returned. The raw name is here because the row's verb is the readable
 * one — `mcp__linear__create_issue__1a2b3c4d` is what a person greps logs for.
 */
function signatureDetail(context: ActivityContext): ActivityDetail | null {
  const nativeToolName = context.descriptor.nativeToolName;
  const args = compactSignature(context.input);
  const text = readableText(context.output);
  // A call with nothing to show, under a verb that already spells its name
  // exactly, has no detail: there is nothing the row is hiding.
  if (args === null && text === null && readableToolName(nativeToolName) === nativeToolName) {
    return null;
  }
  const signature = `${nativeToolName}${args ?? "()"}`;
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
    /* v8 ignore next -- all three capture groups are mandatory in the regex (no `?`), so a successful exec() never leaves them undefined. */
    if (file === undefined || lineNumber === undefined) continue;
    const entry = groups.get(file) ?? { lines: [], total: 0 };
    entry.total += 1;
    if (entry.lines.length < MATCH_LINES_PER_FILE) {
      /* v8 ignore next -- same guarantee as above: the third capture group is never undefined. */
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

// Pi joins OpenAI's successive summaries into one reasoning channel. Only a
// thought that starts with a summary heading opts in: ordinary bold emphasis
// elsewhere must not become a status. A complete standalone paragraph heading
// advances the status; an unfinished heading keeps the last complete one.
const FIRST_BOLD = /^\s*\*\*([^*\n]+)\*\*/;
// One line, read on its own: no quantifier can run across a newline, so a
// stream of blank lines costs linear time rather than polynomial.
const HEADING_LINE = /^\s*\*\*([^*\n]+)\*\*\s*$/;

function latestReasoningHeading(text: string): string | null {
  const first = FIRST_BOLD.exec(text)?.[1]?.trim();
  if (!first) return null;
  let heading = first;
  let afterBlank = true;
  for (const line of text.split("\n")) {
    const candidate = afterBlank ? HEADING_LINE.exec(line)?.[1]?.trim() : undefined;
    if (candidate) heading = candidate;
    afterBlank = line.trim() === "";
  }
  return heading;
}

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
  const header = latestReasoningHeading(text);
  const elapsed = notableDuration(options.durationMs ?? null);
  // A live thought carries no number. Its duration is not known yet, and a
  // counter pinned beside a verb that is still being written is exactly the
  // layout fight the reference apps document avoiding — the number is a receipt
  // for a finished thought, not a progress bar for a running one.
  if (options.streaming) return { verb: header ?? "Thinking", meta: null };
  if (header) return { verb: header, meta: elapsed };
  return { verb: elapsed ? `Thought for ${elapsed}` : "Thought", meta: null };
}

/* ------------------------------------------------------------------- shared */

/**
 * Share the specialized row's readable fallback. This is display only: configured
 * MCP names still join by exact identity in `transcriptMcpNames`, and override
 * this fallback in `presentTranscriptTool`. Never infer identity from the name.
 */
function readableToolName(nativeToolName: string): string {
  if (nativeToolName.startsWith("mcp__")) {
    const { server, tool } = humanMcpToolName(nativeToolName);
    return `${server} · ${tool}`;
  }
  return humanToolName(nativeToolName).trim().toLowerCase() || nativeToolName;
}

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
  const content = contentText(value.content);
  if (content !== null) return content;
  for (const key of ["output", "text", "stdout", "result", "body"]) {
    const nested = value[key];
    if (typeof nested === "string" && nested.trim().length > 0) return nested;
  }
  return null;
}

/** Pi returns bash stdout as text blocks, not the string-shaped fixture output. */
function contentText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const text = value
    .flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");
  return text.trim().length > 0 ? text : null;
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
