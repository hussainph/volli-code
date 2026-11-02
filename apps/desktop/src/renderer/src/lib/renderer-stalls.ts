/**
 * Renderer stall signals (VC-1091): this window's long frames and slow
 * inputs, each labelled with what the person was doing, sent to main's log.
 *
 * Two Chromium timelines, observed natively — no polling, no wrapping of app
 * code, and a callback only when something already ran long:
 *
 * - **Long Animation Frames** (`long-animation-frame`): a frame whose work
 *   held the page, with the scripts that ran in it. The longest script is
 *   kept as file + function, nothing else. Chromium (152, Electron 44)
 *   attributes only scripts served over http(s) or inline: the dev renderer
 *   on Vite's localhost has it, the bundle on `volli-app://` does not, so a
 *   packaged frame carries its durations and label alone. A build without
 *   LoAF falls back to `longtask` (no script attribution either).
 * - **Event Timing** (`event`): an input from the event to the next paint, in
 *   three parts — the delay before its first handler, its handlers, and the
 *   paint after. One interaction's events (keydown, keypress, keyup) keep only
 *   the slowest, so a slow keystroke reads as one stall, not three.
 *
 * **Labels.** The code that starts an interaction calls
 * {@link markInteraction} (`pane-switch`, `ticket-open`, `draft-typing`, …);
 * an ongoing one holds a label instead ({@link holdInteraction}: `stream`
 * while a turn is running in view). An entry takes the newest mark that
 * overlaps it — the mark's span plus {@link INTERACTION_TTL_MS} — else a
 * held label, else `idle`. Marks are matched by the entry's own start and
 * end, not by when the observer delivered it, because delivery comes later.
 * A mark costs a clock read and an array write.
 *
 * **Batching.** Stalls are queued and sent at most once per
 * {@link STALL_FLUSH_MS}, at most `RENDERER_STALL_BOUNDS.maxStalls` a batch;
 * past that they are counted, and the count rides the next batch. Main
 * budgets each window again.
 *
 * Logs only: nothing here changes what any code does or when. Nothing is
 * stored, and nothing a person typed or read is ever in a stall.
 */
import {
  RENDERER_STALL_BOUNDS,
  rendererInputOperation,
  rendererScriptInvoker,
  rendererStallFile,
  rendererStallFunction,
  rendererStallMs,
  type InteractionLabel,
  type RendererFrameOperation,
  type RendererFrameStall,
  type RendererInputStall,
  type RendererStall,
  type RendererStallBatch,
  type RendererStallScript,
} from "@volli/shared";

/** A frame or input at least this long is a stall: one a person feels. */
export const STALL_THRESHOLD_MS = 100;
/** How long after its last mark an interaction still claims a stall. */
export const INTERACTION_TTL_MS = 1000;
/** The shortest gap between two batches. */
export const STALL_FLUSH_MS = 2000;
/** Marks remembered: enough to label whatever the observers have yet to deliver. */
const MARK_CAPACITY = 32;
/** How long a released hold stays matchable. */
const HOLD_RETENTION_MS = 60_000;

/** A label code sets: every one but `idle`, which is the absence of one. */
export type MarkedInteraction = Exclude<InteractionLabel, "idle">;

interface Span {
  readonly label: MarkedInteraction;
  readonly from: number;
  to: number;
}

export interface InteractionTimeline {
  /** Marks the start (or continuation) of an interaction, now. */
  mark(label: MarkedInteraction): void;
  /** Holds a label until the returned release is called. Release is idempotent. */
  hold(label: MarkedInteraction): () => void;
  /** The label an entry spanning `[start, end]` takes. */
  labelFor(start: number, end: number): InteractionLabel;
}

export interface InteractionTimelineOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
}

function performanceNow(): number {
  return globalThis.performance.now();
}

/** The marks and holds that label stalls. One per window; tests make their own. */
export function createInteractionTimeline(
  options: InteractionTimelineOptions = {},
): InteractionTimeline {
  const now = options.now ?? performanceNow;
  const ttlMs = options.ttlMs ?? INTERACTION_TTL_MS;
  const marks: Span[] = [];
  let holds: Span[] = [];

  const pruneHolds = (at: number): void => {
    holds = holds.filter((span) => span.to >= at - HOLD_RETENTION_MS);
  };

  return {
    mark(label) {
      const at = now();
      const last = marks.at(-1);
      // Keystrokes re-mark constantly: one span stretches rather than flooding the ring.
      if (last !== undefined && last.label === label && at - last.to <= ttlMs) {
        last.to = at;
        return;
      }
      marks.push({ label, from: at, to: at });
      if (marks.length > MARK_CAPACITY) marks.shift();
    },
    hold(label) {
      const at = now();
      pruneHolds(at);
      const span: Span = { label, from: at, to: Number.POSITIVE_INFINITY };
      holds.push(span);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        span.to = now();
      };
    },
    labelFor(start, end) {
      for (let index = marks.length - 1; index >= 0; index -= 1) {
        const span = marks[index]!;
        if (span.from <= end && span.to + ttlMs >= start) return span.label;
      }
      for (let index = holds.length - 1; index >= 0; index -= 1) {
        const span = holds[index]!;
        if (span.from <= end && span.to >= start) return span.label;
      }
      return "idle";
    },
  };
}

/** This window's timeline. */
const windowTimeline = createInteractionTimeline();

/**
 * Says an interaction starts now: the stalls that overlap it carry its label.
 * Call it where the interaction begins — the store action a switch commits
 * through, the keystroke handler — never in render.
 */
export function markInteraction(label: MarkedInteraction): void {
  windowTimeline.mark(label);
}

/** Holds an ongoing interaction's label (`stream`) until the release is called. */
export function holdInteraction(label: MarkedInteraction): () => void {
  return windowTimeline.hold(label);
}

// ---- entries → stalls ------------------------------------------------------

/** The slice of a LoAF script entry (`PerformanceScriptTiming`) a stall reads. */
export interface ScriptTimingLike {
  readonly duration: number;
  readonly sourceURL?: string;
  readonly sourceFunctionName?: string;
  readonly invokerType?: string;
}

/** The slice of a LoAF or longtask entry a stall reads. */
export interface FrameEntryLike {
  readonly entryType: string;
  readonly startTime: number;
  readonly duration: number;
  readonly blockingDuration?: number;
  readonly renderStart?: number;
  readonly styleAndLayoutStart?: number;
  readonly scripts?: readonly ScriptTimingLike[];
}

/** The slice of an Event Timing entry a stall reads. */
export interface EventEntryLike {
  readonly name: string;
  readonly startTime: number;
  readonly duration: number;
  readonly processingStart: number;
  readonly processingEnd: number;
  readonly interactionId?: number;
}

/** A duration the browser measured, as the wire carries it; zero for one it could not. */
function wholeMs(value: number): number {
  return rendererStallMs(value) ?? 0;
}

function topScript(scripts: readonly ScriptTimingLike[]): RendererStallScript | undefined {
  let top: ScriptTimingLike | undefined;
  for (const script of scripts)
    if (top === undefined || script.duration > top.duration) top = script;
  if (top === undefined) return undefined;
  const fn = rendererStallFunction(top.sourceFunctionName);
  return {
    file: rendererStallFile(top.sourceURL),
    ...(fn === undefined ? {} : { function: fn }),
    invoker: rendererScriptInvoker(top.invokerType),
    durationMs: wholeMs(top.duration),
  };
}

/** A part from a timestamp to the frame's end, when the timestamp was set. */
function tailMs(entry: FrameEntryLike, from: number | undefined): number | undefined {
  if (from === undefined || from <= 0) return undefined;
  return wholeMs(entry.startTime + entry.duration - from);
}

/** A long frame as a stall. */
export function frameStall(entry: FrameEntryLike, label: InteractionLabel): RendererFrameStall {
  const operation: RendererFrameOperation =
    entry.entryType === "longtask" ? "longtask" : "long-animation-frame";
  const blockingMs = rendererStallMs(entry.blockingDuration);
  const renderMs = tailMs(entry, entry.renderStart);
  const styleLayoutMs = tailMs(entry, entry.styleAndLayoutStart);
  const script = entry.scripts === undefined ? undefined : topScript(entry.scripts);
  return {
    kind: "frame",
    operation,
    label,
    durationMs: wholeMs(entry.duration),
    ...(blockingMs === null ? {} : { blockingMs }),
    ...(renderMs === undefined ? {} : { renderMs }),
    ...(styleLayoutMs === undefined ? {} : { styleLayoutMs }),
    // None attributed is not "none ran": Chromium attributes only scripts
    // served over http(s) or inline, so a bundle on the app's own scheme
    // reports every frame with an empty list. Absent, not zero.
    ...(entry.scripts === undefined || entry.scripts.length === 0
      ? {}
      : { scripts: entry.scripts.length }),
    ...(script === undefined ? {} : { script }),
  };
}

/** A slow input as a stall, in its three parts. */
export function inputStall(entry: EventEntryLike, label: InteractionLabel): RendererInputStall {
  const end = entry.startTime + entry.duration;
  return {
    kind: "input",
    operation: rendererInputOperation(entry.name),
    label,
    durationMs: wholeMs(entry.duration),
    inputDelayMs: wholeMs(entry.processingStart - entry.startTime),
    processingMs: wholeMs(entry.processingEnd - entry.processingStart),
    presentationMs: wholeMs(end - entry.processingEnd),
  };
}

/**
 * One delivery's slow inputs, one per interaction: the slowest of the events
 * that share an `interactionId`. Events outside an interaction (hover, move)
 * are dropped when the browser says which are which; a stall of theirs is the
 * frame's, and the frame observer has it.
 */
export function slowestPerInteraction(
  entries: readonly EventEntryLike[],
  thresholdMs: number,
): EventEntryLike[] {
  const byInteraction = new Map<number, EventEntryLike>();
  const unkeyed: EventEntryLike[] = [];
  for (const entry of entries) {
    if (entry.duration < thresholdMs) continue;
    const id = entry.interactionId;
    if (id === undefined) {
      unkeyed.push(entry);
      continue;
    }
    if (id === 0) continue;
    const kept = byInteraction.get(id);
    if (kept === undefined || entry.duration > kept.duration) byInteraction.set(id, entry);
  }
  return [...byInteraction.values(), ...unkeyed];
}

// ---- batching --------------------------------------------------------------

export interface StallBatcher {
  push(stall: RendererStall): void;
  /** Sends what is queued now, and cancels the pending send. */
  flush(): void;
}

export interface StallBatcherOptions {
  readonly send: (batch: RendererStallBatch) => void;
  readonly flushMs?: number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

/**
 * Queues stalls and sends them as one batch at most every `flushMs`, the
 * first stall arming the send. A full queue counts the rest as dropped.
 */
export function createStallBatcher(options: StallBatcherOptions): StallBatcher {
  const flushMs = options.flushMs ?? STALL_FLUSH_MS;
  const setTimer = options.setTimer ?? ((run, ms) => globalThis.setTimeout(run, ms));
  const clearTimer =
    options.clearTimer ??
    ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  let queue: RendererStall[] = [];
  let dropped = 0;
  let timer: unknown = null;

  const flush = (): void => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (queue.length === 0 && dropped === 0) return;
    const batch: RendererStallBatch = { stalls: queue, dropped };
    queue = [];
    dropped = 0;
    try {
      options.send(batch);
    } catch {
      // A batch that cannot be sent is not an error anyone can act on.
    }
  };

  return {
    push(stall) {
      if (queue.length < RENDERER_STALL_BOUNDS.maxStalls) queue.push(stall);
      else dropped += 1;
      if (timer === null) timer = setTimer(flush, flushMs);
    },
    flush,
  };
}

// ---- the observers ---------------------------------------------------------

/** The preload door: `window.api.log.stalls`. */
export type RendererStallDoor = (batch: RendererStallBatch) => void;

/** The slice of `PerformanceObserver` the signals use. */
export interface ObserverHost {
  readonly supportedEntryTypes: readonly string[];
  new (callback: (list: { getEntries(): readonly unknown[] }) => void): {
    observe(options: { type: string; buffered?: boolean; durationThreshold?: number }): void;
    disconnect(): void;
  };
}

export interface RendererStallSignalsOptions {
  /** `PerformanceObserver`; absent where the page has none. */
  readonly observer?: ObserverHost;
  readonly door?: () => RendererStallDoor | null;
  readonly timeline?: InteractionTimeline;
  readonly thresholdMs?: number;
  readonly batcher?: (send: (batch: RendererStallBatch) => void) => StallBatcher;
}

function windowDoor(): RendererStallDoor | null {
  const log = (globalThis as { window?: { api?: { log?: { stalls?: RendererStallDoor } } } }).window
    ?.api?.log;
  return log?.stalls ?? null;
}

/** Which frame timeline this build observes: LoAF, else Long Tasks, else none. */
export function frameEntryType(supported: readonly string[]): RendererFrameOperation | null {
  if (supported.includes("long-animation-frame")) return "long-animation-frame";
  if (supported.includes("longtask")) return "longtask";
  return null;
}

/**
 * Starts observing this window's long frames and slow inputs. Returns the
 * undo, which disconnects both observers and sends what is queued.
 * Does nothing where there is no observer or no door to send through.
 */
export function installRendererStallSignals(options: RendererStallSignalsOptions = {}): () => void {
  const observer =
    options.observer ?? (globalThis as { PerformanceObserver?: ObserverHost }).PerformanceObserver;
  const door = (options.door ?? windowDoor)();
  if (observer === undefined || door === null) return () => undefined;
  const timeline = options.timeline ?? windowTimeline;
  const thresholdMs = options.thresholdMs ?? STALL_THRESHOLD_MS;
  const batcher = (options.batcher ?? ((send) => createStallBatcher({ send })))(door);
  const observers: InstanceType<ObserverHost>[] = [];

  const frameType = frameEntryType(observer.supportedEntryTypes);
  if (frameType !== null) {
    const frames = new observer((list) => {
      for (const entry of list.getEntries() as readonly FrameEntryLike[]) {
        if (entry.duration < thresholdMs) continue;
        const label = timeline.labelFor(entry.startTime, entry.startTime + entry.duration);
        batcher.push(frameStall(entry, label));
      }
    });
    frames.observe({ type: frameType, buffered: false });
    observers.push(frames);
  }

  if (observer.supportedEntryTypes.includes("event")) {
    const inputs = new observer((list) => {
      const entries = list.getEntries() as readonly EventEntryLike[];
      for (const entry of slowestPerInteraction(entries, thresholdMs)) {
        const label = timeline.labelFor(entry.startTime, entry.startTime + entry.duration);
        batcher.push(inputStall(entry, label));
      }
    });
    // Chromium's floor is 16 ms and it rounds to 8: the filter above is exact.
    inputs.observe({ type: "event", buffered: false, durationThreshold: thresholdMs });
    observers.push(inputs);
  }

  return () => {
    for (const each of observers) each.disconnect();
    batcher.flush();
  };
}
