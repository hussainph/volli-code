#!/usr/bin/env node
/**
 * Sidebar pin/unpin performance bench (VC-359) — manually run, not part of `vp test`.
 *
 * Runs the real built app with four visible restty panes in an isolated profile,
 * observes the terminal hosts while the ordinary Cmd+B path closes and opens the
 * sidebar, and records renderer frame intervals plus Electron process CPU.
 *
 * TWO ARMS, and the gap between them is the whole point of the ticket. `--busy`
 * is how many CPU-burning worker threads this bench starts BEFORE Electron and
 * stops after the report, so the loaded arm is manufactured here rather than
 * described here. A local stand-in: when VC-353's background-load generator
 * lands, this should call that instead of rolling its own busy loop.
 *
 *   pnpm -C apps/desktop run build
 *   node apps/desktop/e2e/sidebar-transition-bench.mjs --label after --busy 0
 *   node apps/desktop/e2e/sidebar-transition-bench.mjs --label after --busy 2
 *
 * It EXITS NON-ZERO on a fixture fault, a lost terminal identity, an endpoint
 * that never settles, a renderer console error, a reduced-motion endpoint that
 * took long enough to have been animated, and — unless `--no-budget` is passed
 * — a pin whose worst frame missed the budget. `--budget-ms` moves that bar.
 */
import { promises as fs } from "node:fs";
import { Worker } from "node:worker_threads";

import {
  assertBuiltRendererLoaded,
  assertProfileIsolated,
  launch,
  makeGitRepo,
  makeScratch,
  seedProjects,
  sleep,
  startTerminalSession,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const LABEL = flag("label", "run");
const PANES = Number(flag("panes", "4"));
const SAMPLE_MS = Number(flag("sample-ms", "500"));
const BUSY = Number(flag("busy", "0"));
const CHECK_BEHAVIOR = !args.includes("--skip-behavior-checks");
const CHECK_BUDGET = !args.includes("--no-budget");
// One dropped frame inside a 200ms pin is a stutter a person can see; two
// consecutive 60Hz frames is where it stops being deniable. The bar is the
// WORST frame, not the mean, because the mean of a 200ms transition with one
// 300ms stall still reads as smooth.
const BUDGET_MS = Number(flag("budget-ms", "33.3"));
// Reduced motion is an endpoint SWAP. Anything under a third of the shorter
// clock (CLOSE_MS = 160) could not have been a played animation, and anything
// over it is a bug this bench must not pass.
const REDUCED_SETTLE_MS = 50;

if (!Number.isInteger(PANES) || PANES < 1) throw new Error(`invalid --panes: ${PANES}`);
if (!Number.isFinite(SAMPLE_MS) || SAMPLE_MS < 250) {
  throw new Error(`invalid --sample-ms: ${SAMPLE_MS}`);
}
if (!Number.isInteger(BUSY) || BUSY < 0) throw new Error(`invalid --busy: ${BUSY}`);
if (!Number.isFinite(BUDGET_MS) || BUDGET_MS <= 0) throw new Error(`invalid --budget-ms`);

/**
 * The background load, manufactured rather than assumed. Fixed integer mixing
 * with no allocation, so each worker is a steady core of CPU and never a GC
 * partner for the process under test.
 */
function startBackgroundLoad(workers) {
  const running = Array.from(
    { length: workers },
    () =>
      new Worker(
        `let mix = 1;
         for (;;) { for (let i = 0; i < 5e6; i += 1) mix = (mix * 1103515245 + 12345) >>> 1; }`,
        { eval: true },
      ),
  );
  return async () => {
    await Promise.allSettled(running.map((worker) => worker.terminate()));
  };
}

const LOAD = BUSY === 0 ? "idle" : `${BUSY}-busy-core`;
const stopBackgroundLoad = startBackgroundLoad(BUSY);

const scratchState = await makeScratch("volli-sidebar-transition-bench-");
const { scratch, userDataDir, dbPath, cleanup } = scratchState;
await fs.mkdir(scratch, { recursive: true });
console.log(`scratch: ${scratch}`);
console.log(`fixture: real app, ${PANES} visible restty panes; load arm: ${LOAD}`);

/** Summarize the rAF timestamps recorded during one sample window. */
function frameSummary(timestamps) {
  const intervals = timestamps.slice(1).map((time, index) => time - timestamps[index]);
  const elapsed = timestamps.length > 1 ? timestamps.at(-1) - timestamps[0] : 0;
  const sorted = intervals.toSorted((a, b) => a - b);
  const percentile = (ratio) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
  return {
    frames: intervals.length,
    fps: elapsed > 0 ? (intervals.length * 1000) / elapsed : 0,
    meanMs:
      intervals.length > 0
        ? intervals.reduce((sum, value) => sum + value, 0) / intervals.length
        : 0,
    p95Ms: percentile(0.95),
    maxMs: sorted.at(-1) ?? 0,
    over16_7: intervals.filter((value) => value > 16.7).length,
    over33_3: intervals.filter((value) => value > 33.3).length,
  };
}

/** Electron process CPU over one 250ms reading after the samples complete. */
async function processCpu(app) {
  // Electron reports usage since the previous getAppMetrics() call. Prime the
  // counters first; otherwise a probe's only reading is commonly all zeroes.
  await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics());
  await sleep(250);
  return app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((metric) => ({
      type: metric.type,
      pid: metric.pid,
      cpu: metric.cpu?.percentCPUUsage ?? 0,
    })),
  );
}

/** Start/reset the in-page observers, run one action, and collect one sample. */
async function sample(page, label, action = async () => {}) {
  await page.evaluate(() => window.volliSidebarBench.start());
  const actionStartedAt = Date.now();
  await action();
  const actionMs = Date.now() - actionStartedAt;
  // Always retain a full post-action window. Under real load even dispatching
  // the key can stall for hundreds of milliseconds; subtracting that time hid
  // the very long frame this bench exists to report.
  await sleep(SAMPLE_MS);
  const reading = await page.evaluate(() => window.volliSidebarBench.stop());
  return {
    label,
    actionMs,
    ...reading,
    frame: frameSummary(reading.timestamps),
  };
}

const projectPath = await makeGitRepo(scratch, "sidebar-project-");
// This probe owns and removes its profile. A quiet macOS shadow bundle lives
// inside that profile, so deleting it can race Electron helper shutdown after
// terminal panes have been mounted. Use the normal binary: the benchmark needs
// deterministic teardown more than it needs the smoke suite's Dock suppression.
const app = await launch({ dbPath, userDataDir, extraEnv: { VOLLI_QUIET_WINDOWS: "0" } });
const consoleErrors = [];
let page = null;

try {
  await assertProfileIsolated(app, userDataDir);
  page = await app.firstWindow();
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
  await page.waitForLoadState("domcontentloaded");
  assertBuiltRendererLoaded(page);

  await seedProjects(page, [
    {
      id: "sidebar-bench-project",
      name: "Sidebar Bench",
      path: projectPath,
      prefix: "SB",
    },
  ]);

  await page.getByRole("button", { name: "Home", exact: true }).click();
  await startTerminalSession(page);
  await waitUntil(
    "the first terminal canvas",
    () =>
      page.evaluate(
        () =>
          Array.from(document.querySelectorAll("canvas")).filter(
            (canvas) => canvas.offsetParent !== null && canvas.clientWidth > 0,
          ).length === 1,
      ),
    { timeout: 20_000 },
  );
  await sleep(2_200);

  for (let count = 2; count <= PANES; count += 1) {
    const focusPoint = await page.evaluate(() => {
      const canvases = Array.from(document.querySelectorAll("canvas")).filter(
        (canvas) => canvas.offsetParent !== null && canvas.clientWidth > 0,
      );
      const canvas = canvases.at(-1);
      if (canvas === undefined) return null;
      const rect = canvas.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    if (focusPoint === null) throw new Error("no visible terminal canvas to focus before split");
    await page.mouse.click(focusPoint.x, focusPoint.y);
    await sleep(100);
    await page.keyboard.press("Meta+d");
    await waitUntil(
      `${count} visible terminal canvases`,
      () =>
        page.evaluate(
          (expected) =>
            Array.from(document.querySelectorAll("canvas")).filter(
              (canvas) => canvas.offsetParent !== null && canvas.clientWidth > 0,
            ).length === expected,
          count,
        ),
      { timeout: 30_000 },
    );
    await sleep(500);
  }

  const probe = await page.evaluate(() => {
    const state = {
      running: false,
      callbacks: 0,
      entries: 0,
      widths: [],
      timestamps: [],
      terminalIdentityBroken: false,
    };
    const hosts = Array.from(document.querySelectorAll("[data-terminal-renderer]")).filter(
      (element) => element instanceof HTMLElement && element.offsetParent !== null,
    );
    const originalTerminalIds = hosts.map((host) => host.getAttribute("data-terminal-renderer"));
    const observer = new ResizeObserver((entries) => {
      if (!state.running) return;
      state.callbacks += 1;
      state.entries += entries.length;
      for (const entry of entries) state.widths.push(entry.contentRect.width);
    });
    for (const host of hosts) observer.observe(host);

    // Preserve object identity, not only the durable Session id. Recreating a
    // host with the same data attribute would otherwise make an unmount look
    // like success. A removal record also catches a transient detach/reinsert
    // that an endpoint-only `isConnected` check would miss.
    const identityObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const removed of record.removedNodes) {
          if (
            hosts.some(
              (host) => removed === host || (removed instanceof Element && removed.contains(host)),
            )
          ) {
            state.terminalIdentityBroken = true;
          }
        }
      }
    });
    identityObserver.observe(document.body, { childList: true, subtree: true });

    let frame = 0;
    const tick = (time) => {
      if (state.running) state.timestamps.push(time);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    // The preload API is frozen, so `window.api.terminal.resize` cannot be
    // wrapped to count PTY resize IPC directly. The terminal hosts' own
    // ResizeObserver callbacks are the cascade metric: a resize that never
    // reaches a host cannot reach its pty either.

    window.volliSidebarBench = {
      start() {
        state.callbacks = 0;
        state.entries = 0;
        state.widths = [];
        state.timestamps = [];
        state.running = true;
      },
      stop() {
        state.running = false;
        return {
          callbacks: state.callbacks,
          entries: state.entries,
          widths: [...state.widths],
          timestamps: [...state.timestamps],
        };
      },
      terminalIdentity() {
        const current = Array.from(document.querySelectorAll("[data-terminal-renderer]")).filter(
          (element) => element instanceof HTMLElement && element.offsetParent !== null,
        );
        const sameNodes =
          current.length === hosts.length && current.every((host, index) => host === hosts[index]);
        const ids = current.map((host) => host.getAttribute("data-terminal-renderer"));
        const sameIds = JSON.stringify(ids) === JSON.stringify(originalTerminalIds);
        return {
          preserved:
            !state.terminalIdentityBroken &&
            sameNodes &&
            sameIds &&
            hosts.every((host) => host.isConnected),
          removed: state.terminalIdentityBroken,
          sameNodes,
          sameIds,
          ids,
        };
      },
      dispose() {
        observer.disconnect();
        identityObserver.disconnect();
        cancelAnimationFrame(frame);
      },
    };

    return {
      terminalHosts: hosts.length,
      sidebarPinned: document.querySelector('[data-volli-shell="framed"]') !== null,
    };
  });
  await sleep(100);

  if (probe.terminalHosts !== PANES) {
    throw new Error(`expected ${PANES} visible terminal hosts, found ${probe.terminalHosts}`);
  }
  if (!probe.sidebarPinned) throw new Error("sidebar fixture did not start pinned");

  const idle = await sample(page, "idle control");
  const close = await sample(page, "close", () => page.keyboard.press("Meta+b"));
  await waitUntil("sidebar to become unpinned", () =>
    page
      .locator('[data-volli-shell="ephemeral"]')
      .count()
      .then((count) => count === 1),
  );
  const open = await sample(page, "open", () => page.keyboard.press("Meta+b"));
  await waitUntil("sidebar to become pinned", () =>
    page
      .locator('[data-volli-shell="framed"]')
      .count()
      .then((count) => count === 1),
  );

  let behaviorChecks = null;
  if (CHECK_BEHAVIOR) {
    // Reports how LONG the endpoint took, not only that it arrived. Without the
    // elapsed time a 5s allowance cannot tell an instant swap from a played
    // animation, which is the only thing the reduced-motion cases are asking.
    const settledSidebar = async (expected) => {
      const startedAt = Date.now();
      await waitUntil(
        `sidebar ${expected} endpoint to settle`,
        () =>
          page.evaluate((layout) => {
            const content = document.querySelector("[data-sidebar-layout]");
            return (
              content instanceof HTMLElement &&
              content.dataset.sidebarLayout === layout &&
              !content.hasAttribute("data-sidebar-content-motion") &&
              ["none", "0px"].includes(getComputedStyle(content).translate)
            );
          }, expected),
        { timeout: 5_000 },
      );
      const settledMs = Date.now() - startedAt;
      const reading = await page.evaluate(() => {
        const content = document.querySelector("[data-sidebar-layout]");
        if (!(content instanceof HTMLElement)) return null;
        return {
          layout: content.dataset.sidebarLayout,
          active: content.hasAttribute("data-sidebar-content-motion"),
          translate: getComputedStyle(content).translate,
        };
      });
      return { ...reading, settledMs };
    };

    /** A reduced-motion endpoint that took long enough to have been animated. */
    const assertSwapped = (what, reading) => {
      if (reading.settledMs > REDUCED_SETTLE_MS) {
        throw new Error(
          `${what} took ${reading.settledMs}ms to settle under reduced motion; ` +
            `an endpoint swap must land within ${REDUCED_SETTLE_MS}ms`,
        );
      }
    };

    // Exercise both directions of interruption. The presentation can reverse in
    // flight, but the final geometry must still settle once with no WAAPI fill or
    // native-plane stand-in marker left behind.
    await page.keyboard.press("Meta+b");
    await sleep(45);
    await page.keyboard.press("Meta+b");
    const interruptedClose = await settledSidebar("framed");

    await page.keyboard.press("Meta+b");
    await settledSidebar("ephemeral");
    await page.keyboard.press("Meta+b");
    await sleep(45);
    await page.keyboard.press("Meta+b");
    const interruptedOpen = await settledSidebar("ephemeral");
    await page.keyboard.press("Meta+b");
    await settledSidebar("framed");

    // Reduced motion is an endpoint swap, never a shortened animation. Verify
    // both endpoints and restore the ordinary media preference before reporting.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.keyboard.press("Meta+b");
    const reducedClose = await settledSidebar("ephemeral");
    assertSwapped("reduced-motion close", reducedClose);
    await page.keyboard.press("Meta+b");
    const reducedOpen = await settledSidebar("framed");
    assertSwapped("reduced-motion open", reducedOpen);
    await page.emulateMedia({ reducedMotion: "no-preference" });

    // Changing the system preference mid-journey must cancel the compositor
    // motion and settle the requested endpoint too, in both directions.
    await page.keyboard.press("Meta+b");
    await sleep(45);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const reducedDuringClose = await settledSidebar("ephemeral");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    // Let the now-invisible panel return to its ordinary parked transform before
    // exercising the opposite direction.
    await sleep(180);
    await page.keyboard.press("Meta+b");
    await sleep(45);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const reducedDuringOpen = await settledSidebar("framed");
    await page.emulateMedia({ reducedMotion: "no-preference" });

    // Terminal focus owns the shell's established instant-layout hatch. It must
    // bypass this compositor journey rather than running both state machines,
    // and the same terminal hosts must survive the round trip.
    const terminalIdentityBeforeFocus = await page.evaluate(() =>
      window.volliSidebarBench.terminalIdentity(),
    );
    await page.keyboard.press("Alt+Meta+Enter");
    await waitUntil("terminal focus to settle instantly", () =>
      page.evaluate(() => {
        const shell = document.querySelector('[data-volli-shell="focused"]');
        const content = document.querySelector('[data-sidebar-layout="ephemeral"]');
        return (
          shell?.getAttribute("data-motion") === "instant" &&
          content !== null &&
          !content.hasAttribute("data-sidebar-content-motion")
        );
      }),
    );
    const instantFocus = await page.evaluate(() => ({
      shell: document.querySelector("[data-volli-shell]")?.getAttribute("data-volli-shell"),
      motion: document.querySelector("[data-volli-shell]")?.getAttribute("data-motion"),
    }));
    await page.keyboard.press("Alt+Meta+Enter");
    await settledSidebar("framed");
    const terminalIdentityAfterFocus = await page.evaluate(() =>
      window.volliSidebarBench.terminalIdentity(),
    );

    behaviorChecks = {
      interruptedClose,
      interruptedOpen,
      reducedClose,
      reducedOpen,
      reducedDuringClose,
      reducedDuringOpen,
      instantFocus,
      terminalIdentityBeforeFocus,
      terminalIdentityAfterFocus,
      terminalsPreserved:
        terminalIdentityBeforeFocus.preserved && terminalIdentityAfterFocus.preserved,
    };
    if (!behaviorChecks.terminalsPreserved) {
      throw new Error(`terminal hosts lost identity: ${JSON.stringify(behaviorChecks)}`);
    }
  }

  const report = {
    label: LABEL,
    load: LOAD,
    busyWorkers: BUSY,
    machine: `${process.platform}/${process.arch}`,
    // Named for what it actually builds, not for VC-353's `real` fixture: this
    // is the built app with ONE Session and `PANES` live restty canvases, on a
    // fresh database. It is the expensive-sibling half of that fixture and not
    // its migrated 1,200-Session/260k-event half.
    fixture: { kind: "live-app", sessions: 1, terminalPanes: PANES },
    sampleMs: SAMPLE_MS,
    probe,
    samples: [idle, close, open],
    behaviorChecks,
    processCpu: await processCpu(app),
    consoleErrors,
  };

  console.log("\nlabel\taction ms\tresize callbacks\tresize entries\tfps\tp95 ms\tmax ms\t>33ms");
  for (const reading of report.samples) {
    console.log(
      [
        reading.label,
        reading.actionMs,
        reading.callbacks,
        reading.entries,
        reading.frame.fps.toFixed(1),
        reading.frame.p95Ms.toFixed(1),
        reading.frame.maxMs.toFixed(1),
        reading.frame.over33_3,
      ].join("\t"),
    );
  }
  console.log(`\n__BENCH__${JSON.stringify(report)}__BENCH__`);

  // A report generator answers "what happened". These make it answer "is this
  // still true", which is what a regression needs.
  if (consoleErrors.length > 0) {
    throw new Error(
      `renderer reported ${consoleErrors.length} console error(s):\n${consoleErrors.join("\n")}`,
    );
  }
  if (CHECK_BUDGET) {
    const missed = report.samples
      .filter((reading) => reading.label !== "idle control")
      .filter((reading) => reading.frame.maxMs > BUDGET_MS);
    if (missed.length > 0) {
      throw new Error(
        `frame budget of ${BUDGET_MS}ms missed on the ${LOAD} arm: ` +
          missed
            .map((reading) => `${reading.label} worst ${reading.frame.maxMs.toFixed(1)}ms`)
            .join(", "),
      );
    }
  }
} finally {
  // End the fixture PTYs explicitly before asking Electron to quit. Four live
  // login shells can keep Playwright's graceful close pending long after the
  // report was printed, which makes a successful benchmark look hung and races
  // removal of its isolated profile.
  await page
    ?.evaluate(async () => {
      window.volliSidebarBench?.dispose();
      const sessionIds = new Set(
        Array.from(document.querySelectorAll("[data-terminal-renderer]"))
          .map((element) => element.getAttribute("data-terminal-renderer"))
          .filter((sessionId) => sessionId !== null),
      );
      await Promise.allSettled(
        Array.from(sessionIds, (sessionId) => window.api.terminal.kill(sessionId)),
      );
    })
    .catch(() => {});
  await app.close().catch(() => {});
  await stopBackgroundLoad();
  await cleanup();
}
