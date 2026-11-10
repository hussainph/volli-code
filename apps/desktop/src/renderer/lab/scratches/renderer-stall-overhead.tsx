/**
 * VC-1091 — what the renderer stall signals cost a window.
 *
 * The shipped `installRendererStallSignals` observes Long Animation Frames
 * and Event Timing natively; its code runs only when the browser delivers an
 * entry that already ran long, plus one clock read and an array write per
 * `markInteraction`. This scratch measures both against the same workload
 * with the observers off and on, interleaved (off, on, off, on…) so drift
 * lands on both arms:
 *
 *   - a frame loop that rewrites a 1,500-row list each frame, and every
 *     fourth frame also holds the thread for 120 ms (a long frame to report);
 *   - a `markInteraction` per frame, the way a keystroke marks `draft-typing`.
 *
 * Reported per arm: frame time (mean / p95), the time spent inside the
 * observers' callbacks, and how many stalls reached the (fake) door. A tight
 * loop of 100,000 marks gives the per-mark cost. Results are also left on
 * `window.vc1091Overhead` for a driver to read.
 *
 * Simulated wiring: the door here counts batches instead of sending them to
 * main; everything between the browser and the door is the shipped module.
 */
import * as React from "react";
import type { RendererStall, RendererStallBatch } from "@volli/shared";

import { Button } from "@renderer/components/ui/button";
import {
  createInteractionTimeline,
  installRendererStallSignals,
  type ObserverHost,
} from "@renderer/lib/renderer-stalls";

export const title = "Renderer stall signals · observer cost (VC-1091)";
export const note =
  "Frame time with the LoAF + Event Timing observers off vs on, the callbacks' own time, and the cost of one markInteraction";

const FRAMES_PER_ARM = 48;
const ROUNDS = 3;
const ROWS = 1500;
const LONG_FRAME_MS = 120;
const MARK_LOOP = 100_000;

interface ArmResult {
  readonly frames: number;
  readonly frameMeanMs: number;
  readonly frameP95Ms: number;
  readonly callbackMs: number;
  readonly callbacks: number;
  readonly stalls: number;
  /** The first stall the door received: what a line in main's log would say. */
  readonly sample?: RendererStall;
}

interface Report {
  readonly supported: readonly string[];
  readonly off: ArmResult;
  readonly on: ArmResult;
  readonly markNs: number;
}

function round(value: number, places = 2): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function percentile(values: readonly number[], p: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function busy(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Holds the thread: the long frame the observers should report.
  }
}

function holdFrame(): void {
  busy(LONG_FRAME_MS);
}

/** `PerformanceObserver`, with each callback timed. */
function timedObserver(totals: { ms: number; calls: number }): ObserverHost {
  const Native = PerformanceObserver;
  class Timed extends Native {
    constructor(callback: PerformanceObserverCallback) {
      super((list, observer) => {
        const started = performance.now();
        callback(list, observer);
        totals.ms += performance.now() - started;
        totals.calls += 1;
      });
    }
  }
  return Timed as unknown as ObserverHost;
}

async function runArm(on: boolean, list: HTMLElement): Promise<ArmResult> {
  const totals = { ms: 0, calls: 0 };
  let stalls = 0;
  let sample: RendererStall | undefined;
  const timeline = createInteractionTimeline();
  const undo = on
    ? installRendererStallSignals({
        observer: timedObserver(totals),
        door: () => (batch: RendererStallBatch) => {
          stalls += batch.stalls.length + batch.dropped;
          sample ??= batch.stalls[0];
        },
        timeline,
      })
    : () => undefined;
  const frameMs: number[] = [];
  let last = await nextFrame();
  for (let frame = 0; frame < FRAMES_PER_ARM; frame += 1) {
    if (on) timeline.mark("draft-typing");
    const rows = list.children;
    for (let row = 0; row < rows.length; row += 1) {
      (rows[row] as HTMLElement).textContent = `row ${row} · frame ${frame}`;
    }
    // A named frame callback, so LoAF can attribute the long frame to it.
    if (frame % 4 === 3) requestAnimationFrame(holdFrame);
    const now = await nextFrame();
    frameMs.push(now - last);
    last = now;
  }
  // Let the last frame's entries arrive, then flush the batch.
  await new Promise((resolve) => setTimeout(resolve, 300));
  undo();
  return {
    frames: frameMs.length,
    frameMeanMs: round(frameMs.reduce((sum, ms) => sum + ms, 0) / frameMs.length),
    frameP95Ms: round(percentile(frameMs, 95)),
    callbackMs: round(totals.ms, 3),
    callbacks: totals.calls,
    stalls,
    ...(sample === undefined ? {} : { sample }),
  };
}

function merge(results: readonly ArmResult[]): ArmResult {
  const sample = results.find((result) => result.sample !== undefined)?.sample;
  const sum = (pick: (result: ArmResult) => number) =>
    results.reduce((total, result) => total + pick(result), 0);
  return {
    frames: sum((r) => r.frames),
    frameMeanMs: round(sum((r) => r.frameMeanMs) / results.length),
    frameP95Ms: round(sum((r) => r.frameP95Ms) / results.length),
    callbackMs: round(
      sum((r) => r.callbackMs),
      3,
    ),
    callbacks: sum((r) => r.callbacks),
    stalls: sum((r) => r.stalls),
    ...(sample === undefined ? {} : { sample }),
  };
}

function markCostNs(): number {
  const timeline = createInteractionTimeline();
  const labels = ["draft-typing", "pane-switch"] as const;
  const started = performance.now();
  for (let index = 0; index < MARK_LOOP; index += 1) timeline.mark(labels[index & 1]!);
  return round(((performance.now() - started) * 1e6) / MARK_LOOP, 1);
}

async function measure(list: HTMLElement): Promise<Report> {
  const off: ArmResult[] = [];
  const on: ArmResult[] = [];
  for (let pass = 0; pass < ROUNDS; pass += 1) {
    off.push(await runArm(false, list));
    on.push(await runArm(true, list));
  }
  return {
    supported: PerformanceObserver.supportedEntryTypes,
    off: merge(off),
    on: merge(on),
    markNs: markCostNs(),
  };
}

export default function RendererStallOverheadScratch() {
  const listRef = React.useRef<HTMLDivElement>(null);
  const [report, setReport] = React.useState<Report | null>(null);
  const [running, setRunning] = React.useState(false);

  const run = async () => {
    if (listRef.current === null) return;
    setRunning(true);
    try {
      const next = await measure(listRef.current);
      (window as unknown as { vc1091Overhead?: Report }).vc1091Overhead = next;
      setReport(next);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 text-ui">
      <section
        aria-label="Simulated wiring"
        className="shrink-0 rounded-card border border-border bg-muted p-4 text-ui"
      >
        <h2 className="font-medium text-foreground">Simulated wiring</h2>
        <p className="text-muted-foreground">
          Shipped stall observers and batcher over a synthetic frame loop; the door counts batches
          instead of sending them to main.
        </p>
      </section>
      <div className="flex items-center gap-3">
        <Button onClick={() => void run()} disabled={running}>
          {running ? "Measuring…" : "Measure"}
        </Button>
        <span className="text-muted-foreground">
          {ROUNDS} rounds × {FRAMES_PER_ARM} frames per arm, every fourth frame held {LONG_FRAME_MS}{" "}
          ms
        </span>
      </div>
      {report === null ? null : (
        <pre className="font-mono text-xs" data-testid="vc1091-report">
          {JSON.stringify(report, null, 2)}
        </pre>
      )}
      <div ref={listRef} className="h-40 overflow-hidden font-mono text-xs opacity-60">
        {Array.from({ length: ROWS }, (_, row) => (
          <div key={row}>row {row}</div>
        ))}
      </div>
    </div>
  );
}
