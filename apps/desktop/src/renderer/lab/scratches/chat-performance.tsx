/**
 * Does the memoized transcript still need windowing?
 *
 * The perf pass (incremental projection cache, `React.memo(ChatTurn)` plus
 * stable-identity wrappers, collapsed detail no longer mounting, cached adapter
 * hashes) removed the per-token ceiling. What it could not remove was the cost
 * of a prop every row shared: `turnContext` carried `working`, so both flips of
 * a turn re-rendered the whole transcript. This scratch is what put a number on
 * that (3000 turns: 2,150 ms) and what confirms the fix — `working` left the
 * context, only the live turn is told, and the same flip is now ~7 ms.
 *
 * Nothing here re-implements the transcript. `ChatTurn` and `TurnContext` are
 * imported from `chat-session.tsx`, so is the `holdList` stability helper, and
 * the container is the real `Conversation`/`StickToBottom`. That import is the
 * point: a benchmark holding its own copy of the component drifts from the
 * thing it claims to measure, and then reports the copy's numbers as the app's.
 * Only the fixtures and the instrumentation are local.
 *
 * Two deliberate departures from the lab's ordinary shape, both so the numbers
 * mean something:
 *
 *  1. The transcript is mounted into its OWN React root, outside the lab's
 *     `<StrictMode>`. StrictMode double-invokes render, which would double every
 *     render count and inflate every Profiler duration. A benchmark that reports
 *     two renders where the app does one is not measuring the app.
 *  2. Measurement is driven from `window.chatPerf`, not from the buttons. The
 *     buttons are for looking at it; the object is for Playwright. Each entry
 *     `flushSync`es the mutation so React's work is bracketed by wall clock, and
 *     resolves after a double rAF so the paint is included too.
 *
 * Still dev-mode React: absolute times are an upper bound (production is
 * meaningfully faster). The scaling across 100/1000/3000 and the ratio between
 * the token case and the `working` case are the trustworthy signal.
 *
 * Fenced code is in the fixture — one assistant turn in four ends on a 22–37
 * line block — and it is the single biggest thing in these numbers: it more
 * than doubles the DOM, because Shiki gives every token its own span. `?nocode`
 * drops the fences and reproduces the prose-only figures this scratch used to
 * report, so the two are comparable from one run.
 *
 * The fences cycle three texts rather than being unique per turn, and Shiki
 * caches tokenization by code text, so all but the first three highlight out of
 * that cache. Real transcripts have distinct blocks and pay tokenization every
 * time. Treat the with-code figures as a floor, not a ceiling.
 *
 * `streamFence()` is the exception to all of that and the reason those numbers
 * are a floor: it streams ONE turn a chunk at a time through two closed fences
 * and stops inside a third, so every chunk hands Shiki a code string it has
 * never seen. It is the transport-independent half of the delta-frames work
 * (`docs/plans/delta-frames.md`, probe 3) — the wire decides how text arrives,
 * this decides what the renderer does with a fence one character longer.
 */
import * as React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  ACTIVITY_METADATA_KEY,
  type ActivityDescriptor,
  type ActivityKind,
  type ActivityOutcome,
  type SessionInteraction,
} from "@volli/shared";
import type { DynamicToolUIPart, ReasoningUIPart, UIMessage } from "ai";

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@ai-elements/conversation";
import { FileMentionProvider } from "@ai-elements/chat-markdown";
import { groupTurns } from "@renderer/chat/activity";
import { ContentColumn } from "@renderer/components/layout/content-column";
import { cn } from "@renderer/lib/utils";

import { ChatTurn, holdList, sameMessages, type TurnContext } from "./chat-session";

export const title = "Chat transcript · performance";
export const note =
  "Mount, token, working-flip, scroll and heap at 100 / 1000 / 3000 turns, plus the open-fence stream";
export const viewport = "window" as const;

/* ------------------------------------------------------------- instrument */

interface ProfilerSample {
  phase: "mount" | "update" | "nested-update";
  actualDuration: number;
  baseDuration: number;
}

/** Reset before each measured action; read after it. */
let turnRenders = 0;
let profilerLog: ProfilerSample[] = [];

function onTranscriptRender(
  _id: string,
  phase: ProfilerSample["phase"],
  actualDuration: number,
  baseDuration: number,
): void {
  profilerLog.push({ phase, actualDuration, baseDuration });
}

function armCounters(): void {
  turnRenders = 0;
  profilerLog = [];
}

function profilerMs(): number {
  return round(profilerLog.reduce((total, sample) => total + sample.actualDuration, 0));
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function raf(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve(performance.now())));
}

/**
 * The first rAF after a DOM mutation runs *before* that frame is painted; the
 * second runs after it. So the second callback's timestamp is the first moment
 * the pixels are on screen, ± one frame.
 */
async function nextPaint(): Promise<number> {
  await raf();
  return raf();
}

interface HeapMemory {
  usedJSHeapSize: number;
}

/** Chromium-only, and not a precise figure — there is no GC we can force first. */
function heapMb(): number | null {
  const memory = (performance as Performance & { memory?: HeapMemory }).memory;
  return memory ? round(memory.usedJSHeapSize / 1_048_576) : null;
}

function transcriptNode(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-perf-transcript]");
}

function domNodes(): number {
  return transcriptNode()?.querySelectorAll("*").length ?? 0;
}

/**
 * Read from the DOM rather than a mirrored copy: an odd number of flips leaves
 * the transcript in the other state, and a benchmark that then reports a
 * `working` run as an idle one is measuring the wrong half.
 */
function isWorking(): boolean {
  return document.querySelector("[data-perf-working]")?.textContent === "working";
}

/** `StickToBottom.Content` renders the scroller as the content div's parent. */
function scroller(): HTMLElement | null {
  return transcriptNode()?.parentElement ?? null;
}

/** Every Shiki token in the turn: the highlighter's whole output, counted. */
function codeSpans(root: HTMLElement | null): number {
  return root?.querySelectorAll("pre span").length ?? 0;
}

/**
 * Whether a mutation landed inside a highlighted block.
 *
 * The split is the interesting half of the fence probe. Re-highlighting a
 * block that survives shows up INSIDE — the `<pre>` stays and its spans churn.
 * Discarding the block and building a new one shows up OUTSIDE, because the
 * record's target is then the parent that swapped the `<pre>` itself. So a
 * large outside count on a message that is only growing means whole-block
 * re-parse, not incremental highlighting.
 */
function mutatedInsideCode(record: MutationRecord): boolean {
  const target = record.target;
  const element = target instanceof Element ? target : target.parentElement;
  return element?.closest("pre") != null;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return round(sorted[index] ?? 0);
}

/* ------------------------------------------------------------- the API */

interface MountResult {
  turns: number;
  messages: number;
  reactMs: number;
  profilerMs: number;
  paintMs: number;
  turnsRendered: number;
  domNodes: number;
  heapMb: number | null;
}

interface UpdateResult {
  samples: number;
  turnsRenderedMedian: number;
  reactMsMedian: number;
  reactMsMax: number;
  profilerMsMedian: number;
  paintMsMedian: number;
}

interface ScrollResult {
  mode: string;
  frames: number;
  pxPerFrame: number;
  medianFrameMs: number;
  p95FrameMs: number;
  framesOver16: number;
  framesOver50: number;
  scrollHeight: number;
  landedAt: number;
}

/**
 * A moment where the rendered span count went DOWN while the source only grew
 * — the flicker signature of a block being thrown away and re-parsed rather
 * than extended. `at` is characters streamed, not milliseconds, so the same
 * collapse names the same point in the answer on every machine.
 */
interface SpanCollapse {
  at: number;
  from: number;
  to: number;
}

interface FenceStreamResult {
  chunks: number;
  /** The whole measured window: the stream plus the fixed post-stream drain. */
  durationMs: number;
  finalChars: number;
  mutationsTotal: number;
  mutationsInCode: number;
  longTaskMs: number;
  longTaskCount: number;
  spanCollapses: readonly SpanCollapse[];
}

interface PerfApi {
  build(turns: number): Promise<MountResult>;
  token(samples?: number): Promise<UpdateResult>;
  flipWorking(samples?: number): Promise<UpdateResult>;
  streamFence(): Promise<FenceStreamResult>;
  scroll(mode?: "flick" | "traverse"): Promise<ScrollResult>;
  /** Whether the live turn is actually animating — the correctness half. */
  animating(): { working: boolean; animatedSpans: number; inLastTurn: number };
  stats(): {
    turns: number;
    working: boolean;
    domNodes: number;
    heapMb: number | null;
    scrollHeight: number;
  };
  results: Record<string, unknown>;
  ready: boolean;
}

declare global {
  interface Window {
    chatPerf?: PerfApi;
  }
}

/** Written by the harness on mount; the API is nothing without them. */
interface Controls {
  setMessages: React.Dispatch<React.SetStateAction<readonly UIMessage[]>>;
  setWorking: React.Dispatch<React.SetStateAction<boolean>>;
  setEpoch: React.Dispatch<React.SetStateAction<number>>;
  report(line: string): void;
}

const controls: Partial<Controls> = {};

function need<K extends keyof Controls>(key: K): NonNullable<Controls[K]> {
  const value = controls[key];
  if (value === undefined) throw new Error(`chat-perf: harness not mounted (${String(key)})`);
  return value as NonNullable<Controls[K]>;
}

let currentTurns = 0;

async function build(turns: number): Promise<MountResult> {
  // Empty first, and remount the container, so the measured commit is a pure
  // mount rather than a mount racing the previous transcript's unmount.
  flushSync(() => {
    need("setMessages")([]);
    need("setEpoch")((epoch) => epoch + 1);
  });
  await nextPaint();

  // Built outside the timed window: fixture construction is not React's cost.
  const messages = buildTranscript(turns);
  armCounters();
  const started = performance.now();
  flushSync(() => need("setMessages")(messages));
  const committed = performance.now();
  const painted = await nextPaint();

  currentTurns = turns;
  const result: MountResult = {
    turns,
    messages: messages.length,
    reactMs: round(committed - started),
    profilerMs: profilerMs(),
    paintMs: round(painted - started),
    turnsRendered: turnRenders,
    domNodes: domNodes(),
    heapMb: heapMb(),
  };
  publish(`mount:${turns}`, result);
  return result;
}

/**
 * One landed token, exactly as the projection delivers one: the last message is
 * replaced, every earlier message keeps its object, and `holdList` is left to
 * decide how many rows that is allowed to touch.
 */
function appendToken(messages: readonly UIMessage[], text: string): readonly UIMessage[] {
  const last = messages[messages.length - 1];
  if (!last) return messages;
  const parts = last.parts.map((part, index) =>
    index === last.parts.length - 1 && part.type === "text"
      ? { ...part, text: part.text + text }
      : part,
  );
  return [...messages.slice(0, -1), { ...last, parts }];
}

async function measureUpdates(
  name: string,
  samples: number,
  mutate: () => void,
): Promise<UpdateResult> {
  const react: number[] = [];
  const profiler: number[] = [];
  const paint: number[] = [];
  const rendered: number[] = [];

  for (let index = 0; index < samples; index += 1) {
    armCounters();
    const started = performance.now();
    flushSync(mutate);
    const committed = performance.now();
    const painted = await nextPaint();
    react.push(committed - started);
    profiler.push(profilerMs());
    paint.push(painted - started);
    rendered.push(turnRenders);
  }

  const sortedReact = [...react].toSorted((a, b) => a - b);
  const result: UpdateResult = {
    samples,
    turnsRenderedMedian: percentile(
      [...rendered].toSorted((a, b) => a - b),
      0.5,
    ),
    reactMsMedian: percentile(sortedReact, 0.5),
    reactMsMax: round(Math.max(...react)),
    profilerMsMedian: percentile(
      [...profiler].toSorted((a, b) => a - b),
      0.5,
    ),
    paintMsMedian: percentile(
      [...paint].toSorted((a, b) => a - b),
      0.5,
    ),
  };
  publish(`${name}:${currentTurns}`, result);
  return result;
}

/**
 * The open-fence cost, C4 in the migration-readiness audit: one assistant turn
 * streamed a chunk per frame through two closed fences and stopped inside a
 * third, counting what the renderer did to the DOM while it grew.
 *
 * Delta transport cannot touch this number — the wire only decides how the
 * text arrives, not what the markdown renderer does with a fence that is one
 * character longer than it was. So this probe is the evidence for (or against)
 * a renderer policy change, and it is deliberately measured on ONE turn: the
 * transcript-wide numbers above would bury a per-block effect in mount cost.
 *
 * Three counters over the same window:
 *
 *  - `childList` mutations in the turn's subtree, split inside/outside `<pre>`
 *    (see `mutatedInsideCode` — the split is what tells re-highlight apart
 *    from re-parse).
 *  - Long tasks, which is where a re-tokenization actually hurts: a fence
 *    re-highlighted on the main thread is a dropped frame, not a slow one.
 *  - Span collapses, sampled per mutation batch. Text only ever grows here, so
 *    a span count that falls is a block that was discarded and rebuilt.
 *
 * Absolute milliseconds vary per machine and are dev-mode React besides. The
 * mutation counts, the collapse list and the chunk schedule are fixed inputs
 * with no randomness anywhere, so those are the figures to compare across runs.
 */
async function streamFence(): Promise<FenceStreamResult> {
  // Empty and remount first: a stream measured on top of the 100-turn default
  // would be counting that transcript's unmount as the answer's first frames.
  flushSync(() => {
    need("setMessages")([]);
    need("setWorking")(true);
    need("setEpoch")((epoch) => epoch + 1);
  });
  await nextPaint();

  // The first chunk mounts the turn; measurement starts after it, so the
  // number is the streaming cost and not the cost of the bubble appearing.
  const first = FENCE_CHUNKS[0] ?? "";
  flushSync(() => need("setMessages")([fenceMessage(first)]));
  await nextPaint();

  const root = transcriptNode();
  if (!root) throw new Error("chat-perf: no transcript");

  let mutationsTotal = 0;
  let mutationsInCode = 0;
  let chars = first.length;
  let spans = codeSpans(root);
  const spanCollapses: SpanCollapse[] = [];

  const sampleBatch = (records: readonly MutationRecord[]): void => {
    for (const record of records) {
      mutationsTotal += 1;
      if (mutatedInsideCode(record)) mutationsInCode += 1;
    }
    const next = codeSpans(root);
    if (next < spans) spanCollapses.push({ at: chars, from: spans, to: next });
    spans = next;
  };

  const mutations = new MutationObserver(sampleBatch);
  mutations.observe(root, { childList: true, subtree: true });

  let longTaskMs = 0;
  let longTaskCount = 0;
  const countTasks = (entries: readonly PerformanceEntry[]): void => {
    for (const entry of entries) {
      longTaskCount += 1;
      longTaskMs += entry.duration;
    }
  };
  const tasks = new PerformanceObserver((list) => countTasks(list.getEntries()));
  tasks.observe({ type: "longtask", buffered: false });

  const started = performance.now();
  for (let index = 1; index < FENCE_CHUNKS.length; index += 1) {
    const chunk = FENCE_CHUNKS[index] ?? "";
    flushSync(() => need("setMessages")((messages) => appendToken(messages, chunk)));
    chars += chunk.length;
    await nextPaint();
  }

  // Streamdown hands a fence to Shiki asynchronously, so the last block's spans
  // land after the final chunk's commit. A fixed drain keeps that work inside
  // the window instead of leaving it to be counted by whatever runs next.
  const drainUntil = performance.now() + FENCE_DRAIN_MS;
  while (performance.now() < drainUntil) await raf();

  sampleBatch(mutations.takeRecords());
  mutations.disconnect();
  countTasks(tasks.takeRecords());
  tasks.disconnect();
  const durationMs = performance.now() - started;

  currentTurns = 1;
  flushSync(() => need("setWorking")(false));

  const result: FenceStreamResult = {
    chunks: FENCE_CHUNKS.length,
    durationMs: round(durationMs),
    finalChars: chars,
    mutationsTotal,
    mutationsInCode,
    longTaskMs: round(longTaskMs),
    longTaskCount,
    spanCollapses,
  };
  publish("fence", result);
  return result;
}

/**
 * Bottom to top, which is both the direction a reader travels scrollback and
 * the one that escapes `use-stick-to-bottom`'s lock — scrolling down toward the
 * bottom re-arms it and the library would fight the benchmark for the scroller.
 */
async function scrollBench(mode: "flick" | "traverse"): Promise<ScrollResult> {
  const element = scroller();
  if (!element) throw new Error("chat-perf: no scroller");
  const travel = element.scrollHeight - element.clientHeight;
  element.scrollTop = travel;
  await nextPaint();

  const frames = mode === "flick" ? Math.min(90, Math.floor(travel / 600)) : 90;
  const step = mode === "flick" ? 600 : travel / frames;
  const deltas: number[] = [];
  let previous = await raf();
  for (let index = 1; index <= frames; index += 1) {
    element.scrollTop = travel - step * index;
    const now = await raf();
    deltas.push(now - previous);
    previous = now;
  }

  const sorted = [...deltas].toSorted((a, b) => a - b);
  const result: ScrollResult = {
    mode,
    frames,
    pxPerFrame: Math.round(step),
    medianFrameMs: percentile(sorted, 0.5),
    p95FrameMs: percentile(sorted, 0.95),
    framesOver16: deltas.filter((delta) => delta > 16.7).length,
    framesOver50: deltas.filter((delta) => delta > 50).length,
    scrollHeight: element.scrollHeight,
    landedAt: Math.round(element.scrollTop),
  };
  publish(`scroll-${mode}:${currentTurns}`, result);
  return result;
}

function publish(key: string, value: object): void {
  const api = window.chatPerf;
  if (api) api.results[key] = value;
  controls.report?.(`${key} ${JSON.stringify(value)}`);
}

function installApi(): void {
  window.chatPerf = {
    ready: true,
    results: {},
    build,
    token: (samples = 12) =>
      measureUpdates("token", samples, () =>
        need("setMessages")((messages) => appendToken(messages, " tok")),
      ),
    flipWorking: (samples = 6) =>
      measureUpdates("working", samples, () => need("setWorking")((working) => !working)),
    streamFence,
    scroll: (mode = "flick") => scrollBench(mode),
    // Streamdown marks animated text with `data-sd-animate`, so "is the live
    // turn still streaming" is answerable from the DOM rather than by eye. The
    // second figure is the one that matters: the spans must all be in the LAST
    // turn, because a settled turn that animates is the bug this change removes.
    animating: () => {
      const content = transcriptNode()?.firstElementChild ?? null;
      const last = content?.lastElementChild ?? null;
      return {
        working: isWorking(),
        animatedSpans: transcriptNode()?.querySelectorAll("[data-sd-animate]").length ?? 0,
        inLastTurn: last?.querySelectorAll("[data-sd-animate]").length ?? 0,
      };
    },
    stats: () => ({
      turns: currentTurns,
      working: isWorking(),
      domNodes: domNodes(),
      heapMb: heapMb(),
      scrollHeight: scroller()?.scrollHeight ?? 0,
    }),
  };
}

/* ------------------------------------------------------------- fixtures */

function outcome(patch: Partial<ActivityOutcome>): ActivityOutcome {
  return {
    exitCode: null,
    matchCount: null,
    fileCount: null,
    lineCount: null,
    bytes: null,
    addedLines: null,
    removedLines: null,
    diff: null,
    summary: null,
    ...patch,
  };
}

function descriptor(
  kind: ActivityKind,
  patch: Partial<ActivityDescriptor> = {},
): ActivityDescriptor {
  return {
    kind,
    nativeToolName: patch.nativeToolName ?? kind,
    subject: { label: null, path: null, lineRange: null, ...patch.subject },
    outcome: patch.outcome ?? null,
    startedAt: patch.startedAt ?? 0,
    endedAt: patch.endedAt ?? 2400,
  };
}

function metadata(value: ActivityDescriptor): DynamicToolUIPart["toolMetadata"] {
  return { [ACTIVITY_METADATA_KEY]: value } as DynamicToolUIPart["toolMetadata"];
}

function tool(
  id: string,
  activity: ActivityDescriptor,
  options: { output?: unknown; input?: unknown; failed?: boolean } = {},
): DynamicToolUIPart {
  const base = {
    type: "dynamic-tool" as const,
    toolName: activity.nativeToolName,
    toolCallId: id,
    toolMetadata: metadata(activity),
  };
  if (options.failed) {
    return {
      ...base,
      state: "output-error",
      input: options.input ?? null,
      errorText: "ENOENT: no such file or directory, open 'src/missing.ts'",
    };
  }
  return {
    ...base,
    state: "output-available",
    input: options.input ?? null,
    output: options.output ?? null,
  };
}

function reasoning(text: string): ReasoningUIPart {
  return { type: "reasoning", text, state: "done" };
}

const DIFF = `@@ -12,7 +12,9 @@ export function projectSession(frames: readonly Frame[]) {
-  const messages = frames.map(toMessage);
+  const messages = incremental(frames, cache);
+  if (messages === cache.messages) return cache.projection;
   return { messages, interactions: openInteractions(frames) };
 }
@@ -48,3 +50,8 @@ function toMessage(frame: Frame) {
-  return { id: frame.id, role: frame.role, parts: frame.parts };
+  const held = PARTS.get(frame);
+  if (held) return held;
+  const message = { id: frame.id, role: frame.role, parts: frame.parts };
+  PARTS.set(frame, message);
+  return message;
 }`;

const GREP_OUTPUT = [
  "packages/session-engine/src/projection.ts:41:export function projectSession(",
  "packages/session-engine/src/projection.ts:88:  const cache = new WeakMap<Frame, UIMessage>();",
  "packages/opencode-adapter/src/stream.ts:132:  return projectSession(frames);",
  "apps/desktop/src/renderer/lab/chat/session-controller.ts:214:  projectSession(batch);",
  "apps/desktop/src/renderer/lab/chat/message-projection.ts:19:import { projectSession }",
].join("\n");

const LONG_OUTPUT = Array.from(
  { length: 140 },
  (_unused, index) =>
    `${String(index + 1).padStart(4)}  const frame${index} = frames[${index}] ?? fallbackFrame("f-${index}");`,
).join("\n");

/**
 * Fenced code, which is the most expensive thing a transcript renders: every
 * line becomes a row of per-token spans, and Streamdown hands the block to
 * Shiki asynchronously, so a fence costs a second commit after the mount as
 * well as the mount itself. Three shapes and three languages, 22–37 lines, so
 * no single grammar or length is the whole measurement.
 */
const CODE_FENCES = [
  `\`\`\`ts
const PARTS = new WeakMap<Frame, UIMessage>();

interface ProjectionCache {
  readonly frames: readonly Frame[];
  readonly messages: readonly UIMessage[];
  readonly projection: SessionProjection;
}

export function projectSession(
  frames: readonly Frame[],
  cache: ProjectionCache,
): SessionProjection {
  if (frames === cache.frames) return cache.projection;

  const messages = frames.map((frame) => {
    const held = PARTS.get(frame);
    if (held) return held;
    const message: UIMessage = {
      id: frame.id,
      role: frame.role,
      parts: frame.parts,
    };
    PARTS.set(frame, message);
    return message;
  });

  if (sameMessages(messages, cache.messages)) return cache.projection;
  return { messages, interactions: openInteractions(frames) };
}
\`\`\``,
  `\`\`\`tsx
const ChatTurn = React.memo(function ChatTurn({
  messages,
  context,
  live,
}: ChatTurnProps) {
  const segments = React.useMemo(
    () => (messages[0]?.role === "assistant" ? segmentTurn(messages) : null),
    [messages],
  );

  if (segments?.length === 0) return null;

  return (
    <Message from={messages[0].role}>
      <MessageContent>
        {segments?.map((segment) => (
          <div key={segment.key}>{renderSegment(segment, context, live)}</div>
        ))}
      </MessageContent>
    </Message>
  );
});
\`\`\``,
  `\`\`\`bash
# reproduce, then measure
pnpm lab &
sleep 3

for turns in 100 1000 3000; do
  echo "--- $turns turns"
  node scripts/chat-perf.mjs --turns "$turns" --json > "perf-$turns.json"
done

vp run -r typecheck
vp run -r test
vp fmt
\`\`\``,
];

/**
 * The fence probe's answer: prose, a 46-line TypeScript fence, prose, a 44-line
 * fence in a second grammar, prose, and then a third fence the stream stops
 * INSIDE — the open-fence case, where every remaining chunk lands in a block
 * that has no closing marker yet.
 *
 * Deliberately not one of `CODE_FENCES`. Shiki caches tokenization by code
 * text, so replaying those blocks would report cache hits; and a fence that
 * grows by a chunk is a different string every time, which is the case a real
 * streamed answer pays and the one this probe exists to price.
 */
const FENCE_STREAM = [
  "Traced it. The adapter already has the deltas — it is the flush that throws them away, and everything downstream is paying for that one decision.",
  "",
  "Here is the fold the runtime would keep in memory, with the overlay cleared at the settle point:",
  "",
  "```ts",
  "interface KeyedTranscriptPart {",
  "  readonly key: string;",
  "  readonly part: UIMessagePart;",
  "}",
  "",
  "interface KeyedTranscriptMessage {",
  "  readonly id: string;",
  "  readonly role: UIMessage['role'];",
  "  readonly metadata?: unknown;",
  "  readonly parts: readonly KeyedTranscriptPart[];",
  "}",
  "",
  "export function foldDelta(",
  "  base: KeyedTranscriptMessage | undefined,",
  "  delta: TranscriptDelta,",
  "): KeyedTranscriptMessage {",
  "  switch (delta.op) {",
  "    case 'reset':",
  "      return delta.message;",
  "    case 'metadata': {",
  "      if (!base) throw new Error('overlay: metadata before baseline');",
  "      return { ...base, metadata: delta.metadata };",
  "    }",
  "    case 'part.remove': {",
  "      if (!base) throw new Error('overlay: remove before baseline');",
  "      const parts = base.parts.filter((entry) => entry.key !== delta.key);",
  "      return parts.length === base.parts.length ? base : { ...base, parts };",
  "    }",
  "    case 'part.append': {",
  "      if (!base) throw new Error('overlay: append before baseline');",
  "      const parts = base.parts.map((entry) =>",
  "        entry.key === delta.key && entry.part.type === 'text'",
  "          ? { ...entry, part: { ...entry.part, text: entry.part.text + delta.text } }",
  "          : entry,",
  "      );",
  "      return { ...base, parts };",
  "    }",
  "    case 'part.upsert': {",
  "      const parts = base ? [...base.parts] : [];",
  "      const at = parts.findIndex((entry) => entry.key === delta.key);",
  "      const next = { key: delta.key, part: delta.part };",
  "      if (at === -1) parts.splice(delta.index, 0, next);",
  "      else parts[at] = next;",
  "      return { id: delta.key, role: 'assistant', ...base, parts };",
  "    }",
  "  }",
  "}",
  "```",
  "",
  "The projection back to a durable `UIMessage` is the boring half — strip the keys and hand the parts on, so a subscriber that never learned about overlays sees the shape it always saw.",
  "",
  "The adapter side is where the ops are actually decided. Per SSE event only the touched part is re-projected, and the old slice against the new one picks the op:",
  "",
  "```tsx",
  "function opFor(",
  "  key: string,",
  "  index: number,",
  "  previous: readonly UIMessagePart[],",
  "  next: readonly UIMessagePart[],",
  "): TranscriptDelta | null {",
  "  if (previous.length !== 1 || next.length !== 1) {",
  "    return { op: 'part.upsert', key, index, part: next[0] };",
  "  }",
  "",
  "  const before = previous[0];",
  "  const after = next[0];",
  "  if (!before || !after) return null;",
  "",
  "  const growable =",
  "    before.type === 'text' &&",
  "    after.type === 'text' &&",
  "    after.text.startsWith(before.text) &&",
  "    after.text.length > before.text.length;",
  "",
  "  if (growable) {",
  "    return { op: 'part.append', key, text: after.text.slice(before.text.length) };",
  "  }",
  "",
  "  return { op: 'part.upsert', key, index, part: after };",
  "}",
  "",
  "export function DeltaBoundary({ messageId, children }: DeltaBoundaryProps) {",
  "  const overlay = useOverlay(messageId);",
  "  const durable = useDurableMessage(messageId);",
  "  const shown = overlay ? projectOverlay(overlay) : durable;",
  "",
  "  if (!shown) return null;",
  "",
  "  return (",
  "    <MessageContent data-overlay={overlay ? 'transient' : 'durable'}>",
  "      {children(shown)}",
  "    </MessageContent>",
  "  );",
  "}",
  "```",
  "",
  "Anything ambiguous — a reorder, a provider snapshot that disagrees with the buffer, a part that changed type — falls back to `reset`, which is exactly today's behavior and is correct by construction.",
  "",
  "Last piece, the ceiling the wire probe should assert once this lands:",
  "",
  "```ts",
  "it('streams deltas, not snapshots', async () => {",
  "  const network = new FakeNetwork();",
  "  const adapter = createOpenCodeAdapter({ network });",
  "  const emitted: HarnessObservation[] = [];",
  "",
  "  await adapter.attach({ sink: (observation) => emitted.push(observation) });",
  "  await network.scriptAnswer(LONG_FENCED_ANSWER);",
  "  await adapter.drain();",
  "",
  "  const bytes = emitted.reduce(",
  "    (total, observation) => total + JSON.stringify(observation).length,",
  "    0,",
  "  );",
].join("\n");

/**
 * One chunk per frame, every chunk the same size — the schedule is a fixed
 * array so two runs of the probe stream the identical bytes at the identical
 * points. 32 characters is roughly a provider's token batch, and small enough
 * that a fence crosses several frames rather than appearing whole in one.
 */
const FENCE_CHUNK_CHARS = 32;
const FENCE_DRAIN_MS = 400;

const FENCE_CHUNKS: readonly string[] = Array.from(
  { length: Math.ceil(FENCE_STREAM.length / FENCE_CHUNK_CHARS) },
  (_unused, index) =>
    FENCE_STREAM.slice(index * FENCE_CHUNK_CHARS, (index + 1) * FENCE_CHUNK_CHARS),
);

function fenceMessage(text: string): UIMessage {
  return { id: "fence", role: "assistant", parts: [{ type: "text", text }] };
}

const PROSE = [
  "I traced the projection seam and the cache is holding: the incremental path only rebuilds the frames that actually moved, so a batch of one arrives as a batch of one all the way down to the transcript.",
  "Two things were re-deriving on every tick. The first was `groupTurns`, which ran inline in the JSX and so re-grouped the whole transcript for one token. The second was the segmentation, which parses diffs and grep output on the way through.\n\nBoth are keyed now.",
  "Here is what the adapter is doing on each part: `HASHES.get(part) ?? computeHash(part)`, then `HASHES.set(part, hash)`.\n\nA `WeakMap` rather than a string key, because the part *is* the identity — a re-emitted part is a different object and one nothing happened to is the object it already was.",
  "Done. The collapsed detail no longer mounts, which is the one that mattered for scrollback: a settled transcript is mostly closed disclosures, and each was rendering a capped-but-real 400 lines into a hidden grid row.",
  "The remaining question is the shared context. Every row takes it, so anything that changes it repaints everything — and `working` changes it twice a turn.",
];

const LONG_PROSE = [
  "## What I found",
  "",
  "The transcript's cost is not in any single row. It is in the fact that a turn is a component and a component is a subscription: whatever the turn reads, the turn re-renders for.",
  "",
  "There are three shared readings in the current shape:",
  "",
  "1. `working` — flips at the start and end of every turn, and is read by every assistant text segment to decide whether it is animating.",
  "2. `interactions` — the opened-interaction index, read so a resolution message in scrollback can name what it answered.",
  "3. `onOpenFile` — stable, and the only one of the three that already behaves.",
  "",
  "The first is the one that costs. `isAnimating` is a prop on `MessageResponse`, which is memoized on `children` identity and on `isAnimating`, so a flip invalidates the markdown renderer for every assistant turn on screen — and markdown is the expensive leaf, not the tool rows.",
  "",
  "The memo is `React.useMemo<TurnContext>(() => ({ working, onOpenFile, interactions, open, resolving, onResolve }), [answer, interactions, onOpenFile, openedInteractions, resolving, working])` — and `working` is the member that moves twice a turn.",
  "",
  "Splitting it is mechanical: settled turns do not need `working` at all, because only the live turn can be animating. A second context — or simply passing `isAnimating` down the live turn's own path — would leave every row above the cursor untouched by a flip.",
  "",
  "The alternative is windowing, which fixes mount and memory as well but brings its own costs: measured heights for a list whose rows expand, a scroll anchor that survives a bundle opening, and a find-in-page that no longer works because most of the conversation is not in the DOM.",
  "",
  "Neither is free. Which one to reach for depends entirely on whether mount or repaint is the binding constraint, which is what this scratch is for.",
].join("\n");

/**
 * The control: `?nocode` builds the same transcript with no fences, which is
 * what this scratch measured before they were in the fixture. Read once, so a
 * run cannot change shape halfway through.
 */
const CONTROL_NO_CODE = new URLSearchParams(window.location.search).has("nocode");

/**
 * One assistant turn's messages. Shapes cycle so no size is a single case, and
 * every fourth turn ends on a fenced block — the share a real coding transcript
 * carries, and the reason these numbers are higher than the prose-only ones.
 */
function assistantTurn(index: number): UIMessage[] {
  const messages = assistantTurnBody(index);
  if (CONTROL_NO_CODE || index % 4 !== 0) return messages;
  const last = messages[messages.length - 1];
  if (last) {
    last.parts = [
      ...last.parts,
      { type: "text", text: CODE_FENCES[(index / 4) % CODE_FENCES.length] ?? "" },
    ];
  }
  return messages;
}

function assistantTurnBody(index: number): UIMessage[] {
  const id = `a-${index}`;
  const shape = index % 5;
  const failing = index % 23 === 7;

  if (shape === 0) {
    return [
      {
        id,
        role: "assistant",
        parts: [{ type: "text", text: PROSE[index % PROSE.length] ?? "" }],
      },
    ];
  }

  if (shape === 1) {
    return [
      {
        id,
        role: "assistant",
        parts: [
          reasoning(
            "Checking where the projection is rebuilt, and whether the cache survives a batch.",
          ),
          tool(
            `${id}-1`,
            descriptor("search", {
              subject: { label: "projectSession", path: null, lineRange: null },
              outcome: outcome({ matchCount: 14, fileCount: 5 }),
            }),
            { output: GREP_OUTPUT },
          ),
          tool(
            `${id}-2`,
            descriptor("read-file", {
              subject: {
                label: "packages/session-engine/src/projection.ts",
                path: "packages/session-engine/src/projection.ts",
                lineRange: { start: 41, end: 96 },
              },
            }),
            { output: LONG_OUTPUT },
          ),
          tool(
            `${id}-3`,
            descriptor("run-command", {
              subject: { label: "vp run -r test", path: null, lineRange: null },
              outcome: outcome({ exitCode: 0 }),
            }),
            { output: "Test Files  186 passed (186)\nTests  3068 passed (3068)" },
          ),
          { type: "text", text: PROSE[(index + 1) % PROSE.length] ?? "" },
        ],
      },
    ];
  }

  if (shape === 2) {
    // Two messages, one turn — the shape OpenCode actually emits per step.
    return [
      {
        id,
        role: "assistant",
        parts: [
          tool(
            `${id}-1`,
            descriptor("edit-file", {
              subject: {
                label: "packages/session-engine/src/projection.ts",
                path: "packages/session-engine/src/projection.ts",
                lineRange: null,
              },
              outcome: outcome({ addedLines: 49, removedLines: 12, diff: DIFF }),
            }),
          ),
          tool(
            `${id}-2`,
            descriptor("edit-file", {
              subject: {
                label: "apps/desktop/src/renderer/lab/chat/activity-ui.tsx",
                path: "apps/desktop/src/renderer/lab/chat/activity-ui.tsx",
                lineRange: null,
              },
              outcome: outcome({ addedLines: 18, removedLines: 31, diff: DIFF }),
            }),
          ),
          tool(
            `${id}-3`,
            descriptor("write-file", {
              subject: {
                label: "packages/session-engine/src/projection.test.ts",
                path: "packages/session-engine/src/projection.test.ts",
                lineRange: null,
              },
              outcome: outcome({ addedLines: 41 }),
            }),
            { input: 'import { expect, it } from "vite-plus/test";\n\nit("holds", () => {});' },
          ),
        ],
      },
      {
        id: `${id}-b`,
        role: "assistant",
        parts: [
          tool(
            `${id}-4`,
            descriptor("run-command", {
              subject: { label: "vp run -r typecheck", path: null, lineRange: null },
              outcome: outcome({ exitCode: failing ? 2 : 0 }),
            }),
            { output: failing ? "2 errors" : "0 errors", failed: failing },
          ),
          tool(
            `${id}-5`,
            descriptor("list-directory", {
              subject: { label: "packages/session-engine/src/", path: null, lineRange: null },
              outcome: outcome({ fileCount: 12 }),
            }),
            { output: "projection.ts\nsession.ts\ncommands.ts\nindex.ts" },
          ),
          { type: "text", text: PROSE[(index + 2) % PROSE.length] ?? "" },
        ],
      },
    ];
  }

  if (shape === 3) {
    // Three messages, and a long output behind a collapsed disclosure.
    return [
      {
        id,
        role: "assistant",
        parts: [{ type: "text", text: PROSE[(index + 3) % PROSE.length] ?? "" }],
      },
      {
        id: `${id}-b`,
        role: "assistant",
        parts: [
          reasoning(
            "The output is 140 lines. It stays behind the disclosure — the point of the row is the verb and the object, not the dump.",
          ),
          tool(
            `${id}-1`,
            descriptor("read-file", {
              subject: {
                label: "apps/desktop/src/renderer/lab/chat/activity.ts",
                path: "apps/desktop/src/renderer/lab/chat/activity.ts",
                lineRange: { start: 1, end: 140 },
              },
            }),
            { output: LONG_OUTPUT },
          ),
          tool(
            `${id}-2`,
            descriptor("fetch-url", {
              subject: { label: "react.dev/reference/react/memo", path: null, lineRange: null },
              outcome: outcome({ bytes: 48_200 }),
            }),
            { output: LONG_OUTPUT },
          ),
        ],
      },
      {
        id: `${id}-c`,
        role: "assistant",
        parts: [{ type: "text", text: PROSE[(index + 4) % PROSE.length] ?? "" }],
      },
    ];
  }

  return [
    {
      id,
      role: "assistant",
      parts: [
        { type: "text", text: LONG_PROSE },
        tool(
          `${id}-1`,
          descriptor("delegate", {
            nativeToolName: "explore",
            subject: { label: "Find every reader of turnContext", path: null, lineRange: null },
            outcome: outcome({ summary: "9 tools" }),
            endedAt: 72_000,
          }),
          { output: "Three readers: MessageResponse, GatedCall, InteractionReceiptLine." },
        ),
        tool(
          `${id}-2`,
          descriptor("search", {
            subject: { label: "turnContext", path: null, lineRange: null },
            outcome: outcome({ matchCount: 9, fileCount: 1 }),
          }),
          { output: GREP_OUTPUT },
        ),
      ],
    },
  ];
}

function userTurn(index: number): UIMessage {
  const asks = [
    "Where is the transcript re-deriving on a token? Trace it end to end and tell me what actually re-renders.",
    "Land the memo and show me the numbers before and after — I do not want a description, I want a count.",
    "Does the collapsed detail mount? If it does, that is the whole scrollback cost and it should be a one-line fix.",
    "@packages/session-engine/src/projection.ts — is the cache keyed on the frame or on its id? Only one of those is safe.",
    "Now the harder one: what happens to every row when `working` flips at the start of a turn?",
  ];
  return {
    id: `u-${index}`,
    role: "user",
    parts: [{ type: "text", text: asks[index % asks.length] ?? "" }],
  };
}

/**
 * Exactly `turnCount` top-level turns, alternating user and assistant, always
 * ending on an assistant turn whose last part is text — that trailing text part
 * is where the token benchmark lands its character.
 */
function buildTranscript(turnCount: number): UIMessage[] {
  const messages: UIMessage[] = [];
  if (turnCount <= 0) return messages;

  let turns = 0;
  let index = 0;
  while (turns < turnCount - 1) {
    messages.push(userTurn(index));
    turns += 1;
    if (turns >= turnCount - 1) break;
    messages.push(...assistantTurn(index));
    turns += 1;
    index += 1;
  }

  messages.push({
    id: `live-${index}`,
    role: "assistant",
    parts: [
      tool(
        `live-${index}-1`,
        descriptor("run-command", {
          subject: { label: "vp run -r test:coverage", path: null, lineRange: null },
          outcome: outcome({ exitCode: 0 }),
        }),
        { output: "All files  100%" },
      ),
      { type: "text", text: "Coverage holds. Writing the summary now" },
    ],
  });
  return messages;
}

/* ------------------------------------------------------------- transcript */

const EMPTY_OPEN: readonly SessionInteraction[] = [];
const EMPTY_INDEX: ReadonlyMap<string, SessionInteraction> = new Map();
const EMPTY_RESOLVING: ReadonlySet<string> = new Set();
const MESSAGE_GAP = "flex flex-col gap-3";

/** `chat-session.tsx`'s `useStableList`, over its exported `holdList`. */
function useStableList<T>(
  items: readonly T[],
  same: (previous: T, next: T) => boolean,
): readonly T[] {
  const held = React.useRef<readonly T[]>(items);
  if (held.current !== items) held.current = holdList(held.current, items, same);
  return held.current;
}

/**
 * The render counter, without a line of instrumentation in the app.
 *
 * `ChatTurn` is the real component now, so there is nowhere inside it to count
 * from — and putting one there is exactly the drift this import removes. This
 * wrapper carries `ChatTurn`'s own props and nothing else, so its default memo
 * compare is the same comparison `ChatTurn` makes: it bails out on precisely
 * the renders `ChatTurn` bails out on, and a tick that reaches the counter is a
 * tick that reached the turn.
 *
 * A `Profiler` per turn was the other option and is worse on both counts. It
 * fires for every profiler in a commit, including subtrees that bailed out —
 * which would report every turn as re-rendered and hide the whole result — and
 * 3000 of them cost more than 3000 memo compares.
 */
const CountedTurn = React.memo(function CountedTurn(props: React.ComponentProps<typeof ChatTurn>) {
  turnRenders += 1;
  return <ChatTurn {...props} />;
});

/** `ChatPlane`'s transcript half, with the composer and the blockers removed. */
function TranscriptPane({
  messages,
  working,
}: {
  messages: readonly UIMessage[];
  working: boolean;
}) {
  const onOpenFile = React.useCallback(() => {}, []);
  // The benchmark never opens an interaction, so nothing calls this. It answers
  // "delivered" because the alternative reads as a failed decision.
  const onResolve = React.useCallback(() => Promise.resolve(true), []);

  const turnContext = React.useMemo<TurnContext>(
    () => ({
      onOpenFile,
      interactions: EMPTY_INDEX,
      open: EMPTY_OPEN,
      resolving: EMPTY_RESOLVING,
      onResolve,
    }),
    [onOpenFile, onResolve],
  );

  const turns = useStableList(
    React.useMemo(() => groupTurns(messages), [messages]),
    sameMessages,
  );

  return (
    <FileMentionProvider onOpenFile={onOpenFile}>
      <Conversation className="min-h-0 bg-background">
        <ConversationContent data-perf-transcript="" className="gap-6 px-0 pt-8 pb-24">
          {messages.length === 0 ? (
            <ConversationEmptyState className="min-h-80" title="Empty" description="" />
          ) : (
            <ContentColumn className={MESSAGE_GAP}>
              {turns.map((turn, index) => (
                <CountedTurn
                  key={turn[0]?.id}
                  messages={turn}
                  context={turnContext}
                  live={working && index === turns.length - 1}
                />
              ))}
            </ContentColumn>
          )}
        </ConversationContent>
        {messages.length > 0 ? <ConversationScrollButton className="bottom-3" /> : null}
      </Conversation>
    </FileMentionProvider>
  );
}

/* ------------------------------------------------------------- harness */

function initialTurns(): number {
  const raw = new URLSearchParams(window.location.search).get("turns");
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 100;
}

const SIZES = [100, 1000, 3000] as const;

function PerfHarness() {
  const startSize = React.useRef(initialTurns());
  const [messages, setMessages] = React.useState<readonly UIMessage[]>(() =>
    buildTranscript(startSize.current),
  );
  const [working, setWorking] = React.useState(false);
  const [epoch, setEpoch] = React.useState(0);
  // Imperative on purpose: a readout held in state would re-render the harness
  // during a measurement and put its own cost inside the number.
  const readout = React.useRef<HTMLPreElement>(null);

  React.useEffect(() => {
    controls.setMessages = setMessages;
    controls.setWorking = setWorking;
    controls.setEpoch = setEpoch;
    controls.report = (line) => {
      const node = readout.current;
      if (node) node.textContent = `${line}\n${node.textContent ?? ""}`.slice(0, 4000);
    };
    currentTurns = startSize.current;
    installApi();
  }, []);

  return (
    <div className="flex h-svh w-full flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="font-mono text-label uppercase text-muted-foreground">turns</span>
        {SIZES.map((size) => (
          <button
            key={size}
            type="button"
            onClick={() => void build(size)}
            className="rounded-full px-2.5 py-0.5 font-mono text-label text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {size}
          </button>
        ))}
        <span className="ml-3 font-mono text-label uppercase text-muted-foreground">measure</span>
        <button
          type="button"
          onClick={() => void window.chatPerf?.token()}
          className="rounded-full px-2.5 py-0.5 font-mono text-label text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          token
        </button>
        <button
          type="button"
          onClick={() => void window.chatPerf?.flipWorking()}
          className="rounded-full px-2.5 py-0.5 font-mono text-label text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          working
        </button>
        <button
          type="button"
          onClick={() => void window.chatPerf?.streamFence()}
          className="rounded-full px-2.5 py-0.5 font-mono text-label text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          fence
        </button>
        <button
          type="button"
          onClick={() => void window.chatPerf?.scroll()}
          className="rounded-full px-2.5 py-0.5 font-mono text-label text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          scroll
        </button>
        <span
          data-perf-working=""
          className={cn(
            "ml-auto font-mono text-label",
            working ? "text-primary" : "text-muted-foreground",
          )}
        >
          {working ? "working" : "idle"}
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <React.Profiler id="transcript" onRender={onTranscriptRender}>
            <TranscriptPane key={epoch} messages={messages} working={working} />
          </React.Profiler>
        </div>
        {/* Floated rather than a flex sibling: a readout column would narrow the
            transcript, and the transcript's width is one of the inputs — the
            reading measure decides how many lines a turn wraps to and therefore
            how much there is to lay out and paint. */}
        <pre
          ref={readout}
          className="pointer-events-none fixed right-2 bottom-12 z-50 max-h-72 w-80 overflow-hidden rounded-md border border-border bg-background/80 p-2 font-mono text-label text-muted-foreground"
        />
      </div>
    </div>
  );
}

/**
 * The transcript gets its own root so it is outside the lab's `<StrictMode>`.
 * Created once and never unmounted: this scratch is a measuring instrument, and
 * an unmount racing StrictMode's remount is one more thing in the numbers.
 */
export default function ChatPerformanceScratch() {
  const host = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const node = host.current;
    if (!node || node.dataset.perfMounted === "1") return;
    node.dataset.perfMounted = "1";
    createRoot(node).render(<PerfHarness />);
  }, []);

  return <div ref={host} className="h-svh w-full" />;
}
