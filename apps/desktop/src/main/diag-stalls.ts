/**
 * DIAGNOSTIC (VC-716) — TEMPORARY, never in the final diff.
 *
 * Main-thread stall attribution for menu-bar entry on CI. Live only when
 * `VOLLI_DIAG_DIR` is set on an unpackaged build (`initDiag` is called with
 * `isDev`); otherwise every export is a pass-through.
 *
 * Records:
 *   - marks: named instants (ms since process start, `performance.now()`);
 *   - spans: named synchronous sections with their duration;
 *   - stalls: every event-loop lag over 50 ms (a 20 ms interval sampler);
 *   - eld: `monitorEventLoopDelay` histograms, cut into phases by `phase()`;
 *   - a V8 CPU profile of the main thread (`VOLLI_DIAG_PROFILE=1`).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector";
import { join } from "node:path";
import { monitorEventLoopDelay, performance, type IntervalHistogram } from "node:perf_hooks";

type Phase = {
  name: string;
  from: number;
  to: number;
  count: number;
  min: number;
  mean: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
};

type DiagState = {
  dir: string;
  tag: string;
  marks: Array<[string, number]>;
  spans: Array<[string, number, number]>;
  stalls: Array<[number, number]>;
  phases: Phase[];
  phaseFrom: number;
  histogram: IntervalHistogram;
  profiler: Session | null;
  profileClock: { perfNow: number; hrUs: number } | null;
};

let state: DiagState | null = null;

const ms = (ns: number): number => Math.round(ns / 1e5) / 10;
const now = (): number => Math.round(performance.now() * 10) / 10;

export function initDiag(isDev: boolean): void {
  const dir = process.env["VOLLI_DIAG_DIR"];
  if (!isDev || dir === undefined || dir === "" || state !== null) return;
  mkdirSync(dir, { recursive: true });
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  state = {
    dir,
    tag: process.env["VOLLI_DIAG_TAG"] ?? "app",
    marks: [["diag-init", now()]],
    spans: [],
    stalls: [],
    phases: [],
    phaseFrom: now(),
    histogram,
    profiler: null,
    profileClock: null,
  };
  const sampleMs = 20;
  let last = performance.now();
  const sampler = setInterval(() => {
    const at = performance.now();
    const lag = at - last - sampleMs;
    if (lag > 50 && state !== null) state.stalls.push([Math.round(last), Math.round(lag)]);
    last = at;
  }, sampleMs);
  sampler.unref();
  if (process.env["VOLLI_DIAG_PROFILE"] === "1") {
    const session = new Session();
    session.connect();
    session.post("Profiler.enable");
    session.post("Profiler.setSamplingInterval", { interval: 500 });
    session.post("Profiler.start");
    state.profiler = session;
    state.profileClock = {
      perfNow: performance.now(),
      hrUs: Number(process.hrtime.bigint() / 1000n),
    };
  }
  (globalThis as { volliDiag?: unknown }).volliDiag = {
    mark: diagMark,
    phase: diagPhase,
    dump: diagDump,
    now: () => performance.now(),
    markAt: (name: string) => state?.marks.find(([n]) => n === name)?.[1],
  };
}

export function diagMark(name: string): void {
  state?.marks.push([name, now()]);
}

export function diagSpan<T>(name: string, run: () => T): T {
  if (state === null) return run();
  const start = performance.now();
  try {
    return run();
  } finally {
    const end = performance.now();
    state?.spans.push([name, Math.round(start * 10) / 10, Math.round((end - start) * 10) / 10]);
  }
}

/** Close the current event-loop-delay phase under `name` and start the next. */
export function diagPhase(name: string): Phase | null {
  if (state === null) return null;
  const h = state.histogram;
  const phase: Phase = {
    name,
    from: state.phaseFrom,
    to: now(),
    count: h.count,
    min: ms(h.min),
    mean: ms(h.mean),
    p50: ms(h.percentile(50)),
    p90: ms(h.percentile(90)),
    p99: ms(h.percentile(99)),
    max: ms(h.max),
  };
  state.phases.push(phase);
  h.reset();
  state.phaseFrom = phase.to;
  return phase;
}

/** Write the record (and the CPU profile, stopping it) under `<dir>/<tag>-<label>-<pid>`. */
export function diagDump(label: string): Promise<string> {
  const current = state;
  if (current === null) return Promise.resolve("");
  const base = join(current.dir, `${current.tag}-${label}-${process.pid}`);
  const record = {
    tag: current.tag,
    label,
    pid: process.pid,
    dumpedAt: now(),
    marks: current.marks,
    spans: current.spans,
    stalls: current.stalls,
    phases: current.phases,
    profileClock: current.profileClock,
  };
  writeFileSync(`${base}.json`, JSON.stringify(record));
  const session = current.profiler;
  if (session === null) return Promise.resolve(base);
  current.profiler = null;
  return new Promise((resolve) => {
    session.post("Profiler.stop", (error, result) => {
      if (error === null && result?.profile !== undefined) {
        writeFileSync(`${base}.cpuprofile`, JSON.stringify(result.profile));
      }
      session.disconnect();
      resolve(base);
    });
  });
}
