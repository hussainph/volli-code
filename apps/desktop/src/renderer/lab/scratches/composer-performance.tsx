/**
 * What one keystroke costs, with the `@` picker open over a real-sized index.
 *
 * The composer is the surface a person is *in* — every other latency in this
 * app is something you wait for, and this one is something you feel under your
 * fingers. The complaint that produced this rig was "very not responsive", and
 * the cause was structural rather than incidental: `composerPicker` ran in the
 * composer's render body, unmemoized, with the whole project file index as an
 * argument. So every keystroke ranked the repo — filter, score, sort, slice,
 * O(n log n) — inside the same commit as the controlled textarea's own value
 * update, and the character could not appear until the sort finished.
 *
 * ## What is measured, and why it is the right number
 *
 * A discrete `input` event is flushed SYNCHRONOUSLY by React: the urgent render
 * and its commit happen inside `dispatchEvent`, before it returns. So the wall
 * clock around one dispatch is exactly the main thread blocked between the key
 * going down and the character being able to paint. That is the figure a hand
 * feels, and it is the figure this reports — per keystroke, as a distribution,
 * because a burst's worst key is what makes typing feel like it is catching.
 *
 * Two paces, and both are real:
 *
 *  - **burst** — no yield between keys, which is what a fast typist and an
 *    autorepeat both produce. It is also the pace at which deferred work is
 *    allowed to be *skipped*: React drops a low-priority render that a newer
 *    keystroke has superseded, so the ranking runs once at the end of the burst
 *    rather than once per character. That skipping is the whole design.
 *  - **frame** — one paint between keys, so every deferred render actually
 *    lands. This is the honest worst case for the deferred version, because
 *    nothing gets skipped; if the numbers hold here they hold everywhere.
 *
 * The React Profiler figure beside it is the same work seen from inside, and it
 * includes the deferred renders the wall clock deliberately excludes. Read the
 * two together: `blockedMs` is what the hand feels, `profilerMs` is what the
 * frame budget pays.
 *
 * ## Two departures from the lab's ordinary shape, both borrowed from
 * `chat-performance.tsx`, and for the same reasons
 *
 *  1. Its own React root, outside the lab's `<StrictMode>`. StrictMode
 *     double-invokes render, which would double every Profiler duration and
 *     roughly double the blocked time — a benchmark reporting two renders where
 *     the app does one is not measuring the app.
 *  2. Measurement is driven from `window.composerPerf`, not from the buttons.
 *     The buttons are for feeling it; the object is for Playwright.
 *
 * Still dev-mode React, so absolute times are an upper bound. The ratio between
 * runs and the shape of the distribution are the trustworthy signal.
 *
 * `?files=N` sets the index size (default 8000 — a mid-sized repo). `?query=`
 * sets what gets typed after the `@`.
 */
import * as React from "react";
import { createRoot } from "react-dom/client";
import type { IndexedFile } from "@volli/shared";

import { SessionComposer, type ComposerModel } from "@renderer/components/chat/composer-ui";
import { ContentColumn } from "@renderer/components/layout/content-column";
import { Button } from "@renderer/components/ui/button";

export const title = "Composer · keystroke latency";
export const note = "Blocked-per-keystroke with the @ picker open over a synthetic file index";
export const viewport = "window" as const;

/* ------------------------------------------------------------- instrument */

interface ProfilerSample {
  actualDuration: number;
}

let profilerLog: ProfilerSample[] = [];

function onComposerRender(_id: string, _phase: string, actualDuration: number): void {
  profilerLog.push({ actualDuration });
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function raf(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function nextPaint(): Promise<void> {
  await raf();
  await raf();
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const at = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return round(sorted[at] ?? 0);
}

function textareaNode(): HTMLTextAreaElement {
  const node = document.querySelector<HTMLTextAreaElement>("[data-perf-composer] textarea");
  if (node === null) throw new Error("composer-perf: harness not mounted");
  return node;
}

/**
 * Write a value React's own `onChange` will see.
 *
 * React reads the input's value off the DOM node, and it caches the last value
 * it saw on the node itself to de-duplicate events. Assigning `.value` directly
 * updates that cache too, so the synthetic `input` event that follows looks like
 * a no-op and the handler never fires. Going through the prototype's setter
 * writes the DOM without touching React's tracker — the standard technique for
 * driving a controlled input from outside React.
 */
function setNativeValue(node: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("composer-perf: no value setter");
  setter.call(node, value);
}

interface TypeResult {
  pace: "burst" | "frame";
  files: number;
  keys: number;
  /** Main thread blocked inside the keystroke's own synchronous flush. */
  totalBlockedMs: number;
  medianBlockedMs: number;
  p95BlockedMs: number;
  maxBlockedMs: number;
  /** Every render React did during the run, deferred ones included. */
  profilerMs: number;
  commits: number;
  /** Rows the picker is showing when the burst ends — proof it was open. */
  rowsAtEnd: number;
  pickerOpen: boolean;
}

/**
 * Type `query` into the box one character at a time, after a seed that opens
 * the `@` picker.
 *
 * The seed is committed and painted BEFORE the clock starts, so the measured
 * keys are all "picker already open, index already ranked once" — the state
 * someone is actually in while they finish typing a path.
 */
async function typeQuery(pace: "burst" | "frame", query: string = QUERY): Promise<TypeResult> {
  const node = textareaNode();
  const seed = "look at @";
  setNativeValue(node, seed);
  node.setSelectionRange(seed.length, seed.length);
  node.dispatchEvent(new Event("input", { bubbles: true }));
  await nextPaint();

  profilerLog = [];
  const blocked: number[] = [];
  let text = seed;
  for (const character of query) {
    text += character;
    setNativeValue(node, text);
    node.setSelectionRange(text.length, text.length);
    const event = new Event("input", { bubbles: true });
    const started = performance.now();
    node.dispatchEvent(event);
    blocked.push(performance.now() - started);
    if (pace === "frame") await nextPaint();
  }
  await nextPaint();

  const sorted = [...blocked].toSorted((left, right) => left - right);
  const rows = document.querySelectorAll('[data-slot="composer-picker"] [cmdk-item]').length;
  const result: TypeResult = {
    pace,
    files: fileCount(),
    keys: blocked.length,
    totalBlockedMs: round(blocked.reduce((total, sample) => total + sample, 0)),
    medianBlockedMs: percentile(sorted, 0.5),
    p95BlockedMs: percentile(sorted, 0.95),
    maxBlockedMs: round(Math.max(...blocked)),
    profilerMs: round(profilerLog.reduce((total, sample) => total + sample.actualDuration, 0)),
    commits: profilerLog.length,
    rowsAtEnd: rows,
    pickerOpen: rows > 0,
  };
  publish(`type-${pace}`, result);
  return result;
}

/**
 * The caret moving with nothing else changing — the render nobody counts.
 *
 * Arrowing through a draft fires no `onChange` at all; it only moves the caret
 * the picker reads. Whether that costs a whole composer re-render is a question
 * about one context value's identity, and this is where it is answered.
 */
async function moveCaret(steps: number): Promise<object> {
  const node = textareaNode();
  const seed = "a fairly ordinary sentence typed into the box before anything else happens";
  setNativeValue(node, seed);
  node.setSelectionRange(seed.length, seed.length);
  node.dispatchEvent(new Event("input", { bubbles: true }));
  await nextPaint();

  profilerLog = [];
  const blocked: number[] = [];
  for (let step = 1; step <= steps; step += 1) {
    const at = Math.max(0, seed.length - step);
    node.setSelectionRange(at, at);
    const started = performance.now();
    // The caret keys reach the picker through `onKeyUp`, which is what the app
    // wires them to — `selectionchange` alone is not what the composer listens
    // for on a key.
    node.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "ArrowLeft" }));
    blocked.push(performance.now() - started);
    // A PAINT BETWEEN EVERY ARROW, and the rig is wrong without it. Dispatched
    // back to back in one task, React batches all of them into a single commit
    // and the run reports one render for twenty-four keys — which is not what a
    // hand on an arrow key produces, and hides the exact cost this measures.
    await nextPaint();
  }

  const sorted = [...blocked].toSorted((left, right) => left - right);
  const result = {
    steps,
    totalBlockedMs: round(blocked.reduce((total, sample) => total + sample, 0)),
    medianBlockedMs: percentile(sorted, 0.5),
    profilerMs: round(profilerLog.reduce((total, sample) => total + sample.actualDuration, 0)),
    commits: profilerLog.length,
  };
  publish("caret", result);
  return result;
}

interface PerfApi {
  type(pace: "burst" | "frame", query?: string): Promise<TypeResult>;
  caret(steps?: number): Promise<object>;
  results: Record<string, unknown>;
  ready: boolean;
}

declare global {
  interface Window {
    composerPerf?: PerfApi;
  }
}

const report: { write?: (line: string) => void } = {};

function publish(key: string, value: object): void {
  const api = window.composerPerf;
  if (api) api.results[key] = value;
  report.write?.(`${key} ${JSON.stringify(value)}`);
}

/* --------------------------------------------------------------- fixtures */

const DIRECTORIES = [
  "src/main",
  "src/main/db",
  "src/main/pty",
  "src/preload",
  "src/renderer/src/chat",
  "src/renderer/src/components/board",
  "src/renderer/src/components/chat",
  "src/renderer/src/components/sessions",
  "src/renderer/src/components/ui",
  "src/renderer/src/editor",
  "src/renderer/src/stores",
  "packages/shared/src",
  "packages/session-engine/src",
  "packages/cli/src",
  "docs/plans",
  ".volli/artifacts",
];

const STEMS = [
  "composer",
  "composer-ui",
  "composer-picker",
  "chat-plane",
  "session-model",
  "activity",
  "transcript",
  "client",
  "registry",
  "index",
  "listing",
  "worktree",
  "ticket",
  "board-dnd",
  "file-refs",
  "text-position",
];

const EXTENSIONS = [".ts", ".tsx", ".md", ".css", ".json"];

/**
 * A synthetic index the ranking has to do real work on.
 *
 * Names collide across directories on purpose — that is what a repo looks like,
 * and it is the case the subsequence matcher cannot short-circuit. Deterministic
 * from the index, so two runs rank identical arrays and the only thing that
 * moved between them is the code.
 */
function buildIndex(count: number): readonly IndexedFile[] {
  const files: IndexedFile[] = [];
  for (let at = 0; at < count; at += 1) {
    const directory = DIRECTORIES[at % DIRECTORIES.length] ?? "src";
    const stem = STEMS[Math.floor(at / DIRECTORIES.length) % STEMS.length] ?? "file";
    const extension = EXTENSIONS[at % EXTENSIONS.length] ?? ".ts";
    const relPath = `${directory}/${stem}-${at}${extension}`;
    files.push({
      relPath,
      kind: extension === ".md" ? "markdown" : "other",
      artifact: directory === ".volli/artifacts",
    });
  }
  return files;
}

const MODELS: readonly ComposerModel[] = [
  {
    id: "anthropic/sonnet-4.5",
    providerId: "anthropic",
    providerLabel: "Anthropic",
    modelId: "sonnet-4.5",
    label: "sonnet-4.5",
    reasoningLevels: ["low", "medium", "high"],
  },
];

const SELECTION = { providerId: "anthropic", modelId: "sonnet-4.5", reasoningLevel: "medium" };

function search(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

const FILE_COUNT = Number.parseInt(search().get("files") ?? "", 10) || 8000;
const QUERY = search().get("query") ?? "components/chat/composer";

function fileCount(): number {
  return FILE_COUNT;
}

/* ---------------------------------------------------------------- harness */

function PerfHarness() {
  const [value, setValue] = React.useState("");
  const [lines, setLines] = React.useState<readonly string[]>([]);
  const files = React.useMemo(() => buildIndex(FILE_COUNT), []);

  React.useEffect(() => {
    report.write = (line) => setLines((current) => [...current.slice(-11), line]);
    window.composerPerf = {
      ready: true,
      results: {},
      type: (pace, query = QUERY) => typeQuery(pace, query),
      caret: (steps = 24) => moveCaret(steps),
    };
    return () => {
      report.write = undefined;
    };
  }, []);

  return (
    <div className="flex h-svh flex-col gap-4 overflow-y-auto bg-background p-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ui text-muted-foreground">
          <span className="text-foreground tabular-nums">{FILE_COUNT}</span> files ·{" "}
          <span className="text-foreground">@{QUERY}</span>
        </span>
        <Button type="button" size="sm" variant="outline" onClick={() => void typeQuery("burst")}>
          Type · burst
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void typeQuery("frame")}>
          Type · frame
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void moveCaret(24)}>
          Move caret ×24
        </Button>
      </div>

      <pre className="min-h-24 rounded-row border border-border bg-muted/40 p-3 text-label whitespace-pre-wrap text-muted-foreground">
        {lines.length === 0 ? "no runs yet" : lines.join("\n")}
      </pre>

      <ContentColumn>
        <div data-perf-composer>
          <React.Profiler id="composer" onRender={onComposerRender}>
            <SessionComposer
              value={value}
              onValueChange={setValue}
              models={MODELS}
              selection={SELECTION}
              onSelectionChange={() => undefined}
              files={files}
              working={false}
              ready
              queued={[]}
              onQueuedChange={() => undefined}
              onSteerQueued={() => undefined}
              onSubmit={() => undefined}
              onStop={() => undefined}
            />
          </React.Profiler>
        </div>
      </ContentColumn>
    </div>
  );
}

/**
 * Its own root, outside the lab's `<StrictMode>` — see the header. Created once
 * and never unmounted: this scratch is a measuring instrument, and an unmount
 * racing a remount is one more thing in the numbers.
 */
export default function ComposerPerformanceScratch() {
  const host = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const node = host.current;
    if (!node || node.dataset.perfMounted === "1") return;
    node.dataset.perfMounted = "1";
    createRoot(node).render(<PerfHarness />);
  }, []);

  return <div ref={host} className="h-svh w-full" />;
}
