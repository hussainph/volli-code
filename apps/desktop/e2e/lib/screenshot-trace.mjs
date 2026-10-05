/**
 * Bounded failure-only screenshot diagnostics for Electron smokes.
 *
 * VC-638: `database-recovery-smoke` lost `page.screenshot` to a 5s timeout twice
 * on loaded CI runners while identical code passed on rerun. The capture itself
 * is never changed or retried here. When a capture fails and a trace path is
 * supplied, one bounded evidence pass records JSONL via `traceClose`:
 *
 * - A renderer probe: document readiness/visibility/font status plus short
 *   heading and body text, and whether `requestAnimationFrame` fires within a
 *   small budget. `rafFired: false` with a returned probe means page JS is
 *   alive but no frame callback was observed in the budget; this alone does not
 *   identify a native compositor cause. A probe deadline means the renderer main
 *   thread (or the IPC to it) did not answer within the budget.
 * - An Electron main probe: PID, process type and CPU, per-process app
 *   metrics, and every BrowserWindow/webContents' destroyed/visible/minimized/
 *   bounds/loading/crashed state.
 * - One `ps` snapshot with CPU and scheduler state, filtered to the tracked
 *   child and its descendants via `descendantProcesses`. Never a global match
 *   on process names: that would grab another Session's or the live app's
 *   processes.
 *
 * On an explicit `sample: true` opt-in (never automatic in CI), the tracked
 * main and descendants are additionally native-sampled with /usr/bin/sample
 * (2s duration, 60s command budget) on darwin failures only.
 *
 * Every diagnostic rejection or deadline is recorded and swallowed; the caller
 * always sees the exact original screenshot rejection. A null trace path makes
 * the helper a straight pass-through: no probes, no I/O, no timers.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createDeadline, descendantProcesses } from "./smoke-kit.mjs";
import { traceClose } from "./shutdown-trace.mjs";

const execFileAsync = promisify(execFile);

/**
 * Runs in the renderer: one round trip for document state plus a rAF budget.
 * A settled `rafFired: false` distinguishes a stalled frame pump from dead
 * page JS, which would never resolve the enclosing evaluate at all.
 *
 * @returns {Promise<{readyState: string, visibilityState: string,
 *   fontsStatus: string | null, title: string, headings: string[],
 *   bodyText: string, rafFired: boolean, rafElapsedMs: number | null,
 *   rafBudgetMs: number}>}
 */
export function collectPageDiagnostics() {
  const rafBudgetMs = 1000;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .map((heading) => (heading.textContent ?? "").trim())
      .filter(Boolean)
      .slice(0, 5)
      .map((heading) => heading.slice(0, 80));
    let settled = false;
    let timer;
    const finish = (rafFired) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({
        readyState: document.readyState,
        visibilityState: document.visibilityState,
        fontsStatus: document.fonts?.status ?? null,
        title: document.title,
        headings,
        bodyText: (document.body?.innerText ?? document.body?.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200),
        rafFired,
        rafElapsedMs: rafFired ? Date.now() - startedAt : null,
        rafBudgetMs,
      });
    };
    timer = setTimeout(() => finish(false), rafBudgetMs);
    requestAnimationFrame(() => finish(true));
  });
}

/**
 * Runs in Electron main via `app.evaluate`: app metrics and the live window
 * and webContents inventory, each entry guarded so one destroyed host object
 * cannot cost the whole probe.
 *
 * @param {{app: Electron.App, BrowserWindow: typeof Electron.BrowserWindow,
 *   webContents: typeof Electron.webContents}} electron
 */
export function collectMainDiagnostics(electron) {
  const { app, BrowserWindow, webContents } = electron;
  return {
    pid: process.pid,
    processType: process.type,
    cpu: process.getCPUUsage?.() ?? null,
    metrics: app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      name: metric.name ?? null,
      cpuPercent:
        typeof metric.cpu?.percentCPUUsage === "number" ? metric.cpu.percentCPUUsage : null,
    })),
    windows: BrowserWindow.getAllWindows().map((window) => {
      try {
        const destroyed = window.isDestroyed();
        return {
          id: window.id,
          destroyed,
          visible: destroyed ? null : window.isVisible(),
          minimized: destroyed ? null : window.isMinimized(),
          bounds: destroyed ? null : window.getBounds(),
        };
      } catch (error) {
        return { id: window.id, probeError: error.message };
      }
    }),
    contents: webContents.getAllWebContents().map((content) => {
      try {
        const destroyed = content.isDestroyed();
        return {
          id: content.id,
          type: destroyed ? null : content.getType(),
          destroyed,
          loading: destroyed ? null : content.isLoading(),
          crashed: destroyed
            ? null
            : typeof content.isCrashed === "function"
              ? content.isCrashed()
              : null,
          url: destroyed ? null : String(content.getURL?.() ?? "").slice(0, 200),
        };
      } catch (error) {
        return { id: content.id, probeError: error.message };
      }
    }),
  };
}

/** Screenshot options may hold unserializable values; never let that throw. */
function safeJson(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return String(value);
  }
}

function deadline(clock, label, timeoutMs) {
  const now = clock.now ?? Date.now;
  return createDeadline({ label, expiresAt: now() + timeoutMs, clock });
}

async function runPageProbe(run, tracePath, { clock, pageProbeTimeoutMs }) {
  try {
    const probe = await deadline(clock, "screenshot page probe", pageProbeTimeoutMs).run(() =>
      run.page.evaluate(collectPageDiagnostics),
    );
    traceClose(tracePath, "screenshot-page-probe", probe);
  } catch (error) {
    traceClose(tracePath, "screenshot-page-probe-failed", { error: error.message });
  }
}

async function runMainProbe(run, tracePath, { clock, mainProbeTimeoutMs }) {
  try {
    const probe = await deadline(clock, "screenshot main probe", mainProbeTimeoutMs).run(() =>
      run.app.evaluate(collectMainDiagnostics),
    );
    traceClose(tracePath, "screenshot-main-probe", probe);
  } catch (error) {
    traceClose(tracePath, "screenshot-main-probe-failed", { error: error.message });
  }
}

/** Split `ps -axo pid=,ppid=,%cpu=,stat=,comm=` tail columns into fields. */
function parseProcessLine(entry) {
  const match = /^(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(entry.command);
  if (!match) return { ...entry, cpuPercent: null, stat: null };
  const cpuPercent = Number(match[1]);
  return {
    ...entry,
    cpuPercent: Number.isNaN(cpuPercent) ? null : cpuPercent,
    stat: match[2],
    command: match[3],
  };
}

function trackedRootEntry(output, rootPid) {
  for (const line of output.split("\n")) {
    const fields = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (fields && Number(fields[1]) === rootPid) {
      return parseProcessLine({ pid: rootPid, ppid: Number(fields[2]), command: fields[3] });
    }
  }
  return null;
}

/**
 * @returns {Promise<{rootPid: number, rootPresent: boolean, descendants: {pid: number}[]} | null>}
 *   the tracked tree for the sampler, or null when no snapshot was taken.
 */
async function runProcessSnapshot(run, tracePath, { clock, psTimeoutMs, runPs }) {
  const rootPid = run.child?.pid;
  if (!Number.isInteger(rootPid)) {
    traceClose(tracePath, "screenshot-process-snapshot-failed", {
      error: "tracked child pid unavailable",
    });
    return null;
  }
  try {
    const { stdout } = await deadline(clock, "screenshot process snapshot", psTimeoutMs).run(() =>
      runPs("/bin/ps", ["-axo", "pid=,ppid=,%cpu=,stat=,comm="], {
        timeout: psTimeoutMs,
        maxBuffer: 2 * 1024 * 1024,
      }),
    );
    const root = trackedRootEntry(stdout, rootPid);
    const descendants = descendantProcesses(stdout, rootPid).map(parseProcessLine);
    traceClose(tracePath, "screenshot-process-snapshot", { root, descendants });
    return { rootPid, rootPresent: root !== null, descendants };
  } catch (error) {
    traceClose(tracePath, "screenshot-process-snapshot-failed", { error: error.message });
    return null;
  }
}

async function sampleTrackedProcesses(
  child,
  tracePath,
  snapshot,
  { platform, runSample, sampleTimeoutMs },
) {
  if (platform !== "darwin") {
    traceClose(tracePath, "screenshot-sample-skipped", { platform });
    return;
  }
  if (!snapshot) {
    traceClose(tracePath, "sample-failed", { error: "tracked process snapshot unavailable" });
    return;
  }
  // Never attach by a stale PID after the tracked child exits. A missing root
  // in the snapshot is not evidence of a live owned process either.
  if (!snapshot.rootPresent || child?.exitCode != null || child?.signalCode != null) {
    traceClose(tracePath, "screenshot-sample-skipped", { reason: "tracked child no longer live" });
    return;
  }
  const targets = [
    { pid: snapshot.rootPid, command: "tracked Electron main" },
    ...snapshot.descendants,
  ];
  await Promise.all(
    targets.map(async ({ pid }) => {
      try {
        await runSample(
          "/usr/bin/sample",
          [String(pid), "2", "-file", `${tracePath}.${pid}.sample.txt`],
          { timeout: sampleTimeoutMs },
        );
      } catch (error) {
        traceClose(tracePath, "sample-failed", { sampledPid: pid, error: error.message });
      }
    }),
  );
}

async function collectFailureDiagnostics(run, options, tracePath, screenshotError, seams, timing) {
  traceClose(tracePath, "screenshot-failed", {
    ...timing,
    error: screenshotError instanceof Error ? screenshotError.message : String(screenshotError),
    options: safeJson(options),
  });
  const trackedTree = await Promise.all([
    runPageProbe(run, tracePath, seams),
    runMainProbe(run, tracePath, seams),
    runProcessSnapshot(run, tracePath, seams),
  ]).then(([, , snapshot]) => snapshot);
  if (seams.sample) await sampleTrackedProcesses(run.child, tracePath, trackedTree, seams);
}

/**
 * `run.page.screenshot(options)` unchanged, plus bounded failure-only
 * diagnostics appended as JSONL to `tracePath` via `traceClose`.
 *
 * The screenshot call and its rejection are sacred: the exact options object
 * goes to `page.screenshot` and the exact original rejection propagates, no
 * matter what the diagnostics do. With a null/absent `tracePath` (or a
 * successful capture) nothing at all runs beyond the screenshot itself.
 *
 * Native sampling is an explicit opt-in for local failure triage, never an
 * automatic CI behavior.
 *
 * @param {{page: {screenshot: (options: unknown) => Promise<unknown>,
 *   evaluate: (fn: unknown) => Promise<unknown>},
 *   app?: {evaluate: (fn: unknown) => Promise<unknown>},
 *   child?: {pid: number}}} run a smoke run object (`database-recovery` shape)
 * @param {unknown} options forwarded to `page.screenshot` untouched
 * @param {string | null} tracePath JSONL evidence file; null disables all
 *   diagnostics
 * @param {{sample?: boolean, platform?: string,
 *   clock?: {now?: () => number, setTimeout?: (callback: () => void, delay: number) => unknown,
 *            clearTimeout?: (timer: unknown) => void},
 *   runPs?: (file: string, args: string[], options: object) => Promise<{stdout: string}>,
 *   runSample?: (file: string, args: string[], options: object) => Promise<unknown>,
 *   pageProbeTimeoutMs?: number, mainProbeTimeoutMs?: number,
 *   psTimeoutMs?: number, sampleTimeoutMs?: number}} [seams] test injection
 *   points for platform, commands and probe bounds
 * @returns {Promise<unknown>} whatever `page.screenshot` resolved with
 */
export async function screenshotWithTrace(
  run,
  options,
  tracePath,
  {
    sample = false,
    platform = process.platform,
    clock = {},
    runPs = execFileAsync,
    runSample = execFileAsync,
    pageProbeTimeoutMs = 3000,
    mainProbeTimeoutMs = 3000,
    psTimeoutMs = 2000,
    sampleTimeoutMs = 60000,
  } = {},
) {
  const captureStartedAt = Date.now();
  try {
    return await run.page.screenshot(options);
  } catch (error) {
    const captureFailedAt = Date.now();
    if (tracePath) {
      try {
        await collectFailureDiagnostics(
          run,
          options,
          tracePath,
          error,
          {
            sample,
            platform,
            clock,
            runPs,
            runSample,
            pageProbeTimeoutMs,
            mainProbeTimeoutMs,
            psTimeoutMs,
            sampleTimeoutMs,
          },
          {
            captureStartedAt,
            captureFailedAt,
            captureElapsedMs: captureFailedAt - captureStartedAt,
          },
        );
      } catch (diagnosticError) {
        console.error(`screenshot diagnostics failed: ${diagnosticError.message}`);
      }
    }
    throw error;
  }
}
