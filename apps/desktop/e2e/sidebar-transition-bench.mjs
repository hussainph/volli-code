#!/usr/bin/env node
/**
 * Sidebar pin/unpin performance bench (VC-359) — manually run, not part of `vp test`.
 *
 * Runs the real built app with four visible restty panes in an isolated profile,
 * observes the terminal hosts while the ordinary Cmd+B path closes and opens the
 * sidebar, and records renderer frame intervals plus Electron process CPU.
 *
 * Run both revisions under the same load arm. `--load` records the arm's
 * externally-managed name; it does not manufacture CPU load itself:
 *   pnpm -C apps/desktop run build
 *   node apps/desktop/e2e/sidebar-transition-bench.mjs --label before --load idle
 */
import { promises as fs } from "node:fs";

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
const LOAD = flag("load", "unspecified");
const PANES = Number(flag("panes", "4"));
const SAMPLE_MS = Number(flag("sample-ms", "500"));
const CHECK_BEHAVIOR = !args.includes("--skip-behavior-checks");

if (!Number.isInteger(PANES) || PANES < 1) throw new Error(`invalid --panes: ${PANES}`);
if (!Number.isFinite(SAMPLE_MS) || SAMPLE_MS < 250) {
  throw new Error(`invalid --sample-ms: ${SAMPLE_MS}`);
}

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
      resizeIpcCalls: 0,
      resizeIpcPatch: "not attempted",
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

    try {
      const original = window.api.terminal.resize;
      window.api.terminal.resize = (...callArgs) => {
        if (state.running) state.resizeIpcCalls += 1;
        return original(...callArgs);
      };
      state.resizeIpcPatch = window.api.terminal.resize === original ? "read-only" : "installed";
    } catch (error) {
      state.resizeIpcPatch = `read-only: ${error instanceof Error ? error.message : String(error)}`;
    }

    window.volliSidebarBench = {
      start() {
        state.callbacks = 0;
        state.entries = 0;
        state.widths = [];
        state.timestamps = [];
        state.resizeIpcCalls = 0;
        state.running = true;
      },
      stop() {
        state.running = false;
        return {
          callbacks: state.callbacks,
          entries: state.entries,
          widths: [...state.widths],
          timestamps: [...state.timestamps],
          resizeIpcCalls: state.resizeIpcCalls,
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
      resizeIpcPatch: state.resizeIpcPatch,
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
    const settledSidebar = async (expected) => {
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
      return page.evaluate(() => {
        const content = document.querySelector("[data-sidebar-layout]");
        if (!(content instanceof HTMLElement)) return null;
        return {
          layout: content.dataset.sidebarLayout,
          active: content.hasAttribute("data-sidebar-content-motion"),
          translate: getComputedStyle(content).translate,
        };
      });
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
    await page.keyboard.press("Meta+b");
    const reducedOpen = await settledSidebar("framed");
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
    machine: `${process.platform}/${process.arch}`,
    fixture: { kind: "real", terminalPanes: PANES },
    sampleMs: SAMPLE_MS,
    probe,
    samples: [idle, close, open],
    behaviorChecks,
    processCpu: await processCpu(app),
    consoleErrors,
  };

  console.log(
    "\nlabel\taction ms\tresize callbacks\tresize entries\tPTY resize IPC\tfps\tp95 ms\tmax ms\t>33ms",
  );
  for (const reading of report.samples) {
    console.log(
      [
        reading.label,
        reading.actionMs,
        reading.callbacks,
        reading.entries,
        reading.resizeIpcCalls,
        reading.frame.fps.toFixed(1),
        reading.frame.p95Ms.toFixed(1),
        reading.frame.maxMs.toFixed(1),
        reading.frame.over33_3,
      ].join("\t"),
    );
  }
  console.log(`\n__BENCH__${JSON.stringify(report)}__BENCH__`);
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
  await cleanup();
}
