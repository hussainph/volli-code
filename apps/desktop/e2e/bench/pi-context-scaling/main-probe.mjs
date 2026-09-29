/**
 * VC-445 probes that run INSIDE Electron main, through `electronApp.evaluate`.
 *
 * Every export here is serialized by Playwright and re-evaluated in the main
 * process, so each function must be self-contained: no closure over this
 * module, Node built-ins reached through `process.getBuiltinModule`, Electron
 * handed in as the first argument. The shared state lives on one global,
 * `VOLLI_VC445_PROBE`, and is installed once per launch.
 *
 * Two loop-delay instruments run together in each window, on purpose:
 *
 * - `monitorEventLoopDelay({ resolution: 1 })`, the histogram the Session RPC
 *   bench (`bench/session-rpc/electron-main.cjs`) and VC-403 already use. Its
 *   values include the 1 ms timer period itself.
 * - A 10 ms `setInterval` whose raw gaps are kept — the `eventLoopLagDuring`
 *   pattern from `src/main/worktree/read.test.ts` (VC-369). A gap includes the
 *   10 ms period. These raw gaps are what the report pools across repetitions
 *   and what it lines up against the renderer's IPC samples in time, since a
 *   histogram's percentiles cannot be merged after the fact.
 *
 * GC is observed with `PerformanceObserver({ entryTypes: ["gc"] })`. A GC this
 * bench forces is flagged by V8 (`kGCCallbackFlagForced`, 4) and is excluded
 * from the per-window counts, which are meant to describe the app's own GCs.
 */

/* oxlint-disable unicorn/consistent-function-scoping -- every export is serialized into main by Playwright, so its helpers must live inside it. */

/** Install the observer and helpers. Idempotent within one process. */
export function installMainProbe() {
  const state = globalThis.VOLLI_VC445_PROBE;
  if (state !== undefined) return { installed: false, pid: process.pid };
  const perf = process.getBuiltinModule("node:perf_hooks");
  const v8 = process.getBuiltinModule("node:v8");
  const vm = process.getBuiltinModule("node:vm");
  v8.setFlagsFromString("--expose_gc");
  const gc = vm.runInNewContext("gc");
  const gcEntries = [];
  const observer = new perf.PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcEntries.push({
        epochMs: perf.performance.timeOrigin + entry.startTime,
        durationMs: entry.duration,
        kind: entry.detail?.kind ?? null,
        flags: entry.detail?.flags ?? null,
      });
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  globalThis.VOLLI_VC445_PROBE = { gc, gcEntries, observer, window: null };
  return { installed: true, pid: process.pid };
}

/**
 * Two full collections a beat apart, so finalizers and weak callbacks settle.
 *
 * Each `gc()` is a synchronous, non-incremental full mark-compact, so its
 * wall time is the stop-the-world pause a full collection of THIS live heap
 * costs main. The second one runs over an already-collected heap and is the
 * one the report quotes: it is the pause attributable to what is still live.
 */
export async function forceGc() {
  const { gc } = globalThis.VOLLI_VC445_PROBE;
  const perf = process.getBuiltinModule("node:perf_hooks");
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pausesMs = [];
  for (let index = 0; index < 2; index += 1) {
    const started = perf.performance.now();
    gc();
    pausesMs.push(Math.round((perf.performance.now() - started) * 1000) / 1000);
    await wait(150);
  }
  return { pausesMs };
}

/** Main's own memory, and every process's working set as Electron reports it. */
export function memorySnapshot({ app }) {
  const v8 = process.getBuiltinModule("node:v8");
  const usage = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  const metrics = app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    serviceName: metric.serviceName ?? null,
    name: metric.name ?? null,
    // Electron reports these in KiB.
    workingSetKiB: metric.memory?.workingSetSize ?? null,
    peakWorkingSetKiB: metric.memory?.peakWorkingSetSize ?? null,
    privateKiB: metric.memory?.privateBytes ?? null,
    cpuPercent: metric.cpu?.percentCPUUsage ?? null,
  }));
  const main = metrics.find((metric) => metric.pid === process.pid) ?? null;
  return {
    epochMs: Date.now(),
    pid: process.pid,
    processMemory: {
      rss: usage.rss,
      heapTotal: usage.heapTotal,
      heapUsed: usage.heapUsed,
      external: usage.external,
      arrayBuffers: usage.arrayBuffers,
    },
    v8Heap: {
      usedHeapSize: heap.used_heap_size,
      totalHeapSize: heap.total_heap_size,
      heapSizeLimit: heap.heap_size_limit,
      mallocedMemory: heap.malloced_memory,
      numberOfNativeContexts: heap.number_of_native_contexts,
    },
    mainMetric: main,
    metrics,
  };
}

/** Open one measurement window in main. */
export function startWindow(_electron, name) {
  const state = globalThis.VOLLI_VC445_PROBE;
  if (state.window !== null) throw new Error(`window ${state.window.name} is still open`);
  const perf = process.getBuiltinModule("node:perf_hooks");
  const histogram = perf.monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  const ticks = [];
  const origin = perf.performance.timeOrigin;
  let last = perf.performance.now();
  const timer = setInterval(() => {
    const now = perf.performance.now();
    ticks.push([Math.round((origin + now) * 100) / 100, Math.round((now - last) * 1000) / 1000]);
    last = now;
  }, 10);
  state.window = {
    name,
    histogram,
    timer,
    ticks,
    startedEpochMs: origin + perf.performance.now(),
    cpu: process.cpuUsage(),
    gcFrom: state.gcEntries.length,
  };
  return { name, startedEpochMs: state.window.startedEpochMs };
}

/** Close the window and return everything it saw. */
export function stopWindow() {
  const state = globalThis.VOLLI_VC445_PROBE;
  const window = state.window;
  if (window === null) throw new Error("no window is open");
  state.window = null;
  const perf = process.getBuiltinModule("node:perf_hooks");
  clearInterval(window.timer);
  window.histogram.disable();
  const ms = (nanoseconds) => Number(nanoseconds) / 1e6;
  const cpu = process.cpuUsage(window.cpu);
  const endedEpochMs = perf.performance.timeOrigin + perf.performance.now();
  // Only entries that STARTED inside the window, and not ones this bench forced.
  const gc = state.gcEntries
    .slice(window.gcFrom)
    .filter((entry) => entry.epochMs >= window.startedEpochMs && entry.epochMs <= endedEpochMs);
  const organic = gc.filter((entry) => ((entry.flags ?? 0) & 4) === 0);
  return {
    name: window.name,
    startedEpochMs: window.startedEpochMs,
    endedEpochMs,
    wallMs: endedEpochMs - window.startedEpochMs,
    mainCpuMs: (cpu.user + cpu.system) / 1000,
    eventLoopDelay: {
      count: window.histogram.count,
      minMs: ms(window.histogram.min),
      p50Ms: ms(window.histogram.percentile(50)),
      p95Ms: ms(window.histogram.percentile(95)),
      p99Ms: ms(window.histogram.percentile(99)),
      maxMs: ms(window.histogram.max),
      meanMs: ms(window.histogram.mean),
    },
    // [epochMs, gapMs] pairs from the 10 ms interval (eventLoopLagDuring).
    tickGaps: window.ticks,
    gc: {
      count: organic.length,
      totalMs: organic.reduce((sum, entry) => sum + entry.durationMs, 0),
      maxMs: organic.reduce((max, entry) => Math.max(max, entry.durationMs), 0),
      forcedExcluded: gc.length - organic.length,
      entries: organic.map((entry) => ({
        epochMs: Math.round(entry.epochMs * 100) / 100,
        durationMs: Math.round(entry.durationMs * 1000) / 1000,
        kind: entry.kind,
      })),
    },
  };
}

/**
 * Prove the tripwire is live in this process before trusting its silence: one
 * deliberate Node connect and one deliberate Chromium fetch to TEST-NET-1 must
 * both be refused and land in its self-test record.
 */
export async function tripwireSelfTest({ net: chromiumNet }) {
  const state = globalThis.VOLLI_NETWORK_TRIPWIRE;
  if (state === undefined) return { loaded: false, node: false, chromium: false };
  const nodeNet = process.getBuiltinModule("node:net");
  const before = state.selfTests.length;
  state.selfTestArmed = true;
  try {
    await new Promise((resolve) => {
      const socket = nodeNet.connect({ host: "192.0.2.1", port: 80 });
      socket.once("error", resolve);
      socket.once("close", resolve);
    });
    const node = state.selfTests.slice(before).some((attempt) => attempt.via === "node");
    await chromiumNet.fetch("http://192.0.2.1/").catch(() => undefined);
    const chromium = state.selfTests.slice(before).some((attempt) => attempt.via === "chromium");
    return { loaded: true, node, chromium };
  } finally {
    state.selfTestArmed = false;
  }
}

/** What the network tripwire saw in this process. */
export function tripwireState() {
  const state = globalThis.VOLLI_NETWORK_TRIPWIRE;
  if (state === undefined) return { loaded: false };
  return {
    loaded: true,
    blocked: state.blocked,
    chromiumBlocked: state.chromiumBlocked,
    selfTests: state.selfTests.length,
    allowedLoopback: state.allowedLoopback,
    allowedUnixSocket: state.allowedUnixSocket,
    chromiumAllowed: state.chromiumAllowed,
  };
}
