/**
 * Renderer stalls in main's log (VC-1091): `volli:renderer-stalls`.
 *
 * Each window batches its long frames (Long Animation Frames) and slow inputs
 * (Event Timing), labelled with the interaction it was in
 * (`renderer/src/lib/renderer-stalls.ts`). Here every stall in a batch is
 * checked against the closed vocabulary (`readRendererStallBatch`) and
 * written as one `renderer-stall` line beside main's own `main-stall` lines:
 * the window, `door: "renderer"`, the `operation` (`long-animation-frame`,
 * `longtask`, or the input event), the `label`, its durations, and for a
 * frame the longest script as file + function.
 *
 * Once an hour, on the same cadence as `main stall load`, a
 * `renderer stall load` line rolls the window up: how many stalls of each
 * kind, their total and longest, the labels and scripts that stalled most,
 * and how many were dropped.
 *
 * A window cannot flood the log: each may write {@link RENDERER_STALL_BUDGET}
 * stalls a window of time; past that they are counted as dropped, and the
 * next line after the window turns says how many. The channel is
 * client-local: nothing on it reaches a host.
 *
 * Logs only. Nothing here changes what a window does or when.
 */
import { hostLogger, MAIN_STALL_DEFAULTS } from "@volli/host-core/log";
import { readRendererStallBatch, type RendererStall } from "@volli/shared";

/** Stalls one window may write per `windowMs`. */
export const RENDERER_STALL_BUDGET = Object.freeze({ stalls: 120, windowMs: 60_000 });

/** Entries the roll-up names in each of its top lists. */
const TOP = 5;

interface Budget {
  windowStart: number;
  used: number;
  dropped: number;
}

/** A sender: its id keeps one window's budget from another's, and names it in each line. */
interface Sender {
  readonly id: number;
}

interface Load {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface RendererStallLog {
  /** Writes one window's batch, or counts it against the window's budget. */
  write(sender: Sender, value: unknown): void;
  /** Stops the roll-up. Idempotent. */
  stop(): void;
}

export interface RendererStallLogOptions {
  /** How often the roll-up line is written; `main stall load`'s cadence by default. */
  readonly summaryIntervalMs?: number;
  /** A clock in milliseconds; `Date.now` unless a test pins it. */
  readonly now?: () => number;
  /** Arms the roll-up; an unref'd `setInterval` unless a test drives it. */
  readonly every?: (run: () => void, ms: number) => () => void;
}

function unrefInterval(run: () => void, ms: number): () => void {
  const timer = setInterval(run, ms);
  timer.unref();
  return () => clearInterval(timer);
}

function add(
  loads: Map<string, Load & Record<string, unknown>>,
  key: string,
  seed: Record<string, unknown>,
  ms: number,
): void {
  const load = loads.get(key) ?? { ...seed, count: 0, totalMs: 0, maxMs: 0 };
  load.count += 1;
  load.totalMs += ms;
  load.maxMs = Math.max(load.maxMs, ms);
  loads.set(key, load);
}

function top(
  loads: Map<string, Load & Record<string, unknown>>,
): readonly Record<string, unknown>[] {
  return [...loads.values()].toSorted((a, b) => b.totalMs - a.totalMs).slice(0, TOP);
}

/** One stall's line fields: identifiers and durations only. */
function stallFields(window: number, stall: RendererStall): Record<string, unknown> {
  const base = {
    window,
    door: "renderer",
    kind: stall.kind,
    operation: stall.operation,
    label: stall.label,
    durationMs: stall.durationMs,
  };
  if (stall.kind === "input") {
    return {
      ...base,
      inputDelayMs: stall.inputDelayMs,
      processingMs: stall.processingMs,
      presentationMs: stall.presentationMs,
    };
  }
  return {
    ...base,
    ...(stall.scriptTotalMs === undefined ? {} : { scriptTotalMs: stall.scriptTotalMs }),
    ...(stall.blockingMs === undefined ? {} : { blockingMs: stall.blockingMs }),
    ...(stall.renderMs === undefined ? {} : { renderMs: stall.renderMs }),
    ...(stall.styleLayoutMs === undefined ? {} : { styleLayoutMs: stall.styleLayoutMs }),
    ...(stall.scripts === undefined ? {} : { scripts: stall.scripts }),
    ...(stall.script === undefined
      ? {}
      : {
          scriptFile: stall.script.file,
          ...(stall.script.function === undefined ? {} : { scriptFunction: stall.script.function }),
          scriptInvoker: stall.script.invoker,
          scriptMs: stall.script.durationMs,
        }),
  };
}

/** Starts the renderer stall log and its hourly roll-up. One per process. */
export function startRendererStallLog(options: RendererStallLogOptions = {}): RendererStallLog {
  const now = options.now ?? Date.now;
  const summaryIntervalMs = options.summaryIntervalMs ?? MAIN_STALL_DEFAULTS.summaryIntervalMs;
  const log = hostLogger("renderer-stall");
  const budgets = new Map<number, Budget>();

  let windowStartedAt = now();
  let frames = 0;
  let inputs = 0;
  let stallMs = 0;
  let maxStallMs = 0;
  let dropped = 0;
  let labels = new Map<string, Load & Record<string, unknown>>();
  let scripts = new Map<string, Load & Record<string, unknown>>();

  const count = (stall: RendererStall): void => {
    if (stall.kind === "frame") frames += 1;
    else inputs += 1;
    stallMs += stall.durationMs;
    maxStallMs = Math.max(maxStallMs, stall.durationMs);
    add(
      labels,
      `${stall.label}\u0000${stall.kind}\u0000${stall.operation}`,
      { label: stall.label, kind: stall.kind, operation: stall.operation },
      stall.durationMs,
    );
    if (stall.kind === "frame" && stall.script !== undefined) {
      const fn = stall.script.function;
      add(
        scripts,
        `${stall.script.file}\u0000${fn ?? ""}`,
        { file: stall.script.file, ...(fn === undefined ? {} : { function: fn }) },
        stall.script.durationMs,
      );
    }
  };

  const summarize = (): void => {
    const at = now();
    log.info("renderer stall load", {
      windowMs: Math.round(at - windowStartedAt),
      stalls: frames + inputs,
      frames,
      inputs,
      stallMs,
      maxStallMs,
      dropped,
      top: top(labels),
      topScripts: top(scripts),
    });
    windowStartedAt = at;
    frames = 0;
    inputs = 0;
    stallMs = 0;
    maxStallMs = 0;
    dropped = 0;
    labels = new Map();
    scripts = new Map();
  };

  const stopSummary = (options.every ?? unrefInterval)(summarize, summaryIntervalMs);
  let stopped = false;

  return {
    write(sender, value) {
      const batch = readRendererStallBatch(value);
      if (batch === null) return;
      const at = now();
      let budget = budgets.get(sender.id);
      if (budget === undefined || at - budget.windowStart >= RENDERER_STALL_BUDGET.windowMs) {
        const over = budget?.dropped ?? 0;
        budget = { windowStart: at, used: 0, dropped: 0 };
        budgets.set(sender.id, budget);
        if (over > 0) log.warn("renderer stalls dropped", { window: sender.id, dropped: over });
      }
      dropped += batch.dropped;
      budget.dropped += batch.dropped;
      for (const stall of batch.stalls) {
        if (budget.used >= RENDERER_STALL_BUDGET.stalls) {
          budget.dropped += 1;
          dropped += 1;
          continue;
        }
        budget.used += 1;
        log.warn("renderer stall", stallFields(sender.id, stall));
        count(stall);
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      stopSummary();
    },
  };
}

/** Listens on `volli:renderer-stalls`. */
export function registerRendererStallForwarding(
  ipc: {
    on(
      channel: "volli:renderer-stalls",
      listener: (event: { sender: Sender }, batch: unknown) => void,
    ): unknown;
  },
  stalls: Pick<RendererStallLog, "write">,
): void {
  ipc.on("volli:renderer-stalls", (event, batch) => stalls.write(event.sender, batch));
}
