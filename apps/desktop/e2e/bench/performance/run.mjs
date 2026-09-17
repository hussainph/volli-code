#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  APP_DIR,
  REPO,
  assertBuiltRendererLoaded,
  assertProfileIsolated,
  cardById,
  closeAppBounded,
  launch,
  startTerminalSession,
  tabStrip,
  tabStripNewChatButton,
  TICKET_TAB_STRIP,
} from "../../lib/smoke-kit.mjs";
import { busyLoadName, startBusyLoad } from "./background-load.mjs";
import { generateFixture, verifyFixture } from "./fixture.mjs";
import { DEFAULT_SEED, PRESET_NAMES, REAL_BUSY_CORE_DEFAULT, presetNamed } from "./presets.mjs";
import { sessionProjectionRequest, sessionRpcRoundTrip } from "./session-rpc-round-trip.mjs";
import { ticketSwitchBreakdown, TICKET_SWITCH_MARKS } from "./ticket-switch-breakdown.mjs";

const execFileAsync = promisify(execFile);
const CHAT_BENCH = join(APP_DIR, "e2e", "chat-window-bench.mjs");
const DEFAULT_STREAM_STEPS = 120;
const DEFAULT_STREAM_TOKEN_RATE = 30;
// The loaded arm must FIT inside its exposure: the arm fails if measurement is
// still running when the deadline lands. Twenty full-app repetitions against
// the `real` fixture take about nineteen minutes idle on the machine this was
// written on, and materially longer with two cores busy, so a twenty-minute
// exposure guaranteed the failure it was meant to bound. This is deliberately
// generous; it is a ceiling, not a target, and a run that ends early holds the
// load until the deadline so both arms stay comparable.
const DEFAULT_LOAD_DURATION_SECONDS = 3_600;
const WARNING =
  "Performance numbers are comparable only on the same machine, in the same power/thermal state, with the same load arm.";
const INTERACTIONS = Object.freeze([
  ["cold_launch", "Cold launch to interactive"],
  ["long_chat", "Long-chat first paint and interactive"],
  ["stream_scroll", "Simultaneous streaming and scrolling"],
  ["new_chat", "+ Chat to usable composer"],
  ["new_terminal", "New terminal session"],
  ["sidebar_toggle", "Sidebar open/close frame times"],
  ["ticket_switch", "Switch between ticket workspaces"],
  ["board_render", "Board render"],
  ["board_scroll", "Board column scroll"],
  ["rpc_round_trip", "Session RPC projection round trip"],
]);
/** Every interaction id, in order — what a run with no `--interactions` covers. */
export const INTERACTION_IDS = Object.freeze(INTERACTIONS.map(([id]) => id));

export function parseArgs(argv) {
  const args = {
    preset: "real",
    seed: DEFAULT_SEED,
    repetitions: 20,
    busyCores: Math.min(
      REAL_BUSY_CORE_DEFAULT,
      Math.max(1, os.availableParallelism?.() ?? os.cpus().length - 1),
    ),
    loadDurationSeconds: DEFAULT_LOAD_DURATION_SECONDS,
    arms: ["idle", "loaded"],
    streamSteps: DEFAULT_STREAM_STEPS,
    streamTokenRate: DEFAULT_STREAM_TOKEN_RATE,
    skipBuild: false,
    keepFixture: false,
    streamOnly: false,
  };
  const valueAfter = (argument, index) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--preset") args.preset = valueAfter(argument, index++);
    else if (argument === "--seed") args.seed = Number(valueAfter(argument, index++));
    else if (argument === "--repetitions") {
      args.repetitions = Number(valueAfter(argument, index++));
    } else if (argument === "--busy-cores") {
      args.busyCores = Number(valueAfter(argument, index++));
    } else if (argument === "--load-duration-seconds") {
      args.loadDurationSeconds = Number(valueAfter(argument, index++));
    } else if (argument === "--arms") args.arms = valueAfter(argument, index++).split(",");
    else if (argument === "--stream-steps") {
      args.streamSteps = Number(valueAfter(argument, index++));
    } else if (argument === "--stream-token-rate") {
      args.streamTokenRate = Number(valueAfter(argument, index++));
    } else if (argument === "--fixture") args.fixture = valueAfter(argument, index++);
    else if (argument === "--output") args.output = valueAfter(argument, index++);
    else if (argument === "--skip-build") args.skipBuild = true;
    else if (argument === "--keep-fixture") args.keepFixture = true;
    else if (argument === "--stream-only") args.streamOnly = true;
    else if (argument === "--interactions")
      args.interactions = valueAfter(argument, index++).split(",");
    else if (argument === "--help") args.help = true;
    else throw new Error(`Unknown benchmark argument ${argument}`);
  }
  presetNamed(args.preset);
  if (!Number.isSafeInteger(args.seed)) throw new Error("--seed must be a safe integer");
  if (!Number.isInteger(args.repetitions) || args.repetitions < 2) {
    throw new Error("--repetitions must be an integer >= 2");
  }
  if (!Number.isInteger(args.busyCores) || args.busyCores < 1) {
    throw new Error("--busy-cores must be a positive integer");
  }
  if (!Number.isSafeInteger(args.loadDurationSeconds) || args.loadDurationSeconds < 1) {
    throw new Error("--load-duration-seconds must be a positive integer");
  }
  if (
    args.arms.length === 0 ||
    new Set(args.arms).size !== args.arms.length ||
    !args.arms.every((arm) => arm === "idle" || arm === "loaded")
  ) {
    throw new Error("--arms accepts idle, loaded, or idle,loaded without duplicates");
  }
  if (!Number.isInteger(args.streamSteps) || args.streamSteps < 2) {
    throw new Error("--stream-steps must be an integer >= 2");
  }
  if (!Number.isFinite(args.streamTokenRate) || args.streamTokenRate <= 0) {
    throw new Error("--stream-token-rate must be a positive number");
  }
  if (args.interactions !== undefined) {
    const known = new Set(INTERACTIONS.map(([id]) => id));
    const unknown = args.interactions.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new Error(`--interactions names no such interaction: ${unknown.join(", ")}`);
    }
  }
  return args;
}

export function usage() {
  return [
    "Usage: pnpm bench:desktop -- [options]",
    "",
    `  --preset NAME              fixture scale: ${PRESET_NAMES.join("|")} (default: real)`,
    "  --seed N                   fixture seed; the same seed is the same database",
    "  --repetitions N            samples per interaction and load arm (default: 20)",
    "  --busy-cores N             loaded arm worker count (default: 2)",
    `  --load-duration-seconds N  fixed loaded-arm exposure (default: ${DEFAULT_LOAD_DURATION_SECONDS})`,
    "  --arms idle,loaded         arms to run",
    "  --output DIR               write benchmark.json (raw samples), benchmark.summary.json",
    "                             (compact, committable aggregates) and benchmark.md here",
    "  --fixture DIR              reuse a generated fixture profile",
    `  --stream-steps N           scrolling frames per stream sample (default: ${DEFAULT_STREAM_STEPS})`,
    `  --stream-token-rate N      scripted stream rate in tokens/s (default: ${DEFAULT_STREAM_TOKEN_RATE})`,
    "  --skip-build               use current built app and chat bench",
    "  --stream-only              run only the stream+scroll renderer bench",
    `  --interactions a,b         measure only these (${INTERACTIONS.map(([id]) => id).join(", ")})`,
    "  --keep-fixture             keep generated fixture and run profiles",
    "",
    WARNING,
  ].join("\n");
}

function round(value) {
  return value === null ? null : Math.round(value * 1_000) / 1_000;
}

export function addNullableMeasurements(...values) {
  return values.every((value) => Number.isFinite(value))
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
}

export function summarize(values) {
  const usable = values
    .filter((value) => Number.isFinite(value))
    .map(Number)
    .toSorted((a, b) => a - b);
  if (usable.length === 0) return null;
  const quantile = (q) => usable[Math.max(0, Math.ceil(usable.length * q) - 1)];
  const mean = usable.reduce((sum, value) => sum + value, 0) / usable.length;
  const variance = usable.reduce((sum, value) => sum + (value - mean) ** 2, 0) / usable.length;
  return {
    n: usable.length,
    min: round(usable[0]),
    p50: round(quantile(0.5)),
    p95: round(quantile(0.95)),
    max: round(usable.at(-1)),
    mean: round(mean),
    variance: round(variance),
  };
}

export function aggregateInteraction(id, label, samples) {
  const frames = samples.flatMap((sample) =>
    Array.isArray(sample.frameTimesMs) ? sample.frameTimesMs : [],
  );
  const longTasks = samples.flatMap((sample) =>
    Array.isArray(sample.longTasksMs) ? sample.longTasksMs : [],
  );
  const settleLongTasks = samples.flatMap((sample) =>
    Array.isArray(sample.settleLongTasksMs) ? sample.settleLongTasksMs : [],
  );
  const extra = {};
  for (const key of [
    "firstPaintMs",
    "openMs",
    "closeMs",
    "settleLatencyMs",
    "scrollDistancePx",
    "streamedCharacters",
    "liveCodeBlocks",
    "liveHighlightedCodeBlocks",
    "liveHighlightedTokens",
    "settledCodeBlocks",
    "settledHighlightedCodeBlocks",
    "settledHighlightedTokens",
    "resizeObserverCallbacks",
    "resizeObserverCallbacksPerSecond",
    // The ticket switch's phase split (VC-385). Plain per-sample scalars, so
    // each one gets the same percentile treatment as the latency it divides.
    "paletteOpenMs",
    "paletteResolveMs",
    "workspaceRebuildMs",
    "descriptionEditorMs",
    "settleMs",
    "sessionsListMs",
    // What the board was holding when the measurement ended (VC-316). Both are
    // per-sample scalars, so they take the same percentile treatment as the
    // latency they explain.
    "boardTickets",
    "mountedCards",
  ]) {
    const summary = summarize(samples.map((sample) => sample[key]));
    if (summary !== null) extra[key] = summary;
  }
  return {
    id,
    label,
    samples,
    summary: {
      latencyMs: summarize(samples.map((sample) => sample.latencyMs)),
      rendererRssMb: summarize(samples.map((sample) => sample.rendererRssMb)),
      frameTimeMs: summarize(frames),
      droppedFrames: summarize(samples.map((sample) => sample.droppedFrames)),
      longTasks: {
        observedCount: longTasks.length,
        countPerSample: summarize(
          samples.map((sample) =>
            Array.isArray(sample.longTasksMs) ? sample.longTasksMs.length : null,
          ),
        ),
        durationMs: summarize(longTasks),
      },
      settleLongTasks: {
        observedCount: settleLongTasks.length,
        countPerSample: summarize(samples.map((sample) => sample.settleLongTasksMs?.length ?? 0)),
        durationMs: summarize(settleLongTasks),
      },
      ...extra,
    },
  };
}

export function backgroundLoadGap(arms) {
  const idle = arms.find((arm) => arm.busyCores === 0);
  const loaded = arms.find((arm) => arm.busyCores > 0);
  if (idle === undefined || loaded === undefined) return null;
  const idleById = new Map(idle.interactions.map((interaction) => [interaction.id, interaction]));
  return {
    from: idle.name,
    to: loaded.name,
    interactions: loaded.interactions.flatMap((interaction) => {
      const baseline = idleById.get(interaction.id);
      const idleP50 = baseline?.summary.latencyMs?.p50;
      const idleP95 = baseline?.summary.latencyMs?.p95;
      const loadedP50 = interaction.summary.latencyMs?.p50;
      const loadedP95 = interaction.summary.latencyMs?.p95;
      if ([idleP50, idleP95, loadedP50, loadedP95].some((value) => value == null)) return [];
      return [
        {
          id: interaction.id,
          label: interaction.label,
          p50DeltaMs: round(loadedP50 - idleP50),
          p50Ratio: idleP50 === 0 ? null : round(loadedP50 / idleP50),
          p95DeltaMs: round(loadedP95 - idleP95),
          p95Ratio: idleP95 === 0 ? null : round(loadedP95 / idleP95),
        },
      ];
    }),
  };
}

async function command(executable, args, options = {}) {
  const result = await execFileAsync(executable, args, {
    cwd: options.cwd ?? REPO,
    env: { ...process.env, ...options.env },
    maxBuffer: 100 * 1024 * 1024,
    signal: options.signal,
  });
  return result.stdout;
}

async function buildProducts() {
  console.log("building production desktop renderer/main…");
  await new Promise((resolvePromise, reject) => {
    const child = spawn("pnpm", ["run", "build"], {
      cwd: REPO,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`pnpm run build exited ${code}`)),
    );
  });
}

async function hostMetadata() {
  const git = async (...args) => (await command("git", args)).trim();
  const sysctl = async (key) =>
    command("/usr/sbin/sysctl", ["-n", key])
      .then((value) => value.trim())
      .catch(() => "unknown");
  const swVers = async (key) =>
    command("/usr/bin/sw_vers", [`-${key}`])
      .then((value) => value.trim())
      .catch(() => "unknown");
  const [sha, status, model, cpu, macosVersion, macosBuild] = await Promise.all([
    git("rev-parse", "HEAD"),
    git("status", "--porcelain"),
    sysctl("hw.model"),
    sysctl("machdep.cpu.brand_string"),
    swVers("productVersion"),
    swVers("buildVersion"),
  ]);
  return {
    device: {
      model,
      cpu,
      logicalCores: os.cpus().length,
      availableParallelism: os.availableParallelism?.() ?? os.cpus().length,
      memoryBytes: os.totalmem(),
      architecture: process.arch,
    },
    os: { platform: process.platform, release: os.release(), macosVersion, macosBuild },
    git: { sha, dirty: status.length > 0 },
    node: process.version,
  };
}

async function cloneFixture(source, destination) {
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(dirname(destination), { recursive: true });
  await fs.cp(source, destination, {
    recursive: true,
    force: true,
    mode: fsConstants.COPYFILE_FICLONE,
  });
  await fs.mkdir(join(destination, "pi-agent"), { recursive: true });
}

async function rendererRssMb(app) {
  return app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const pid = BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId();
    const metric = electronApp.getAppMetrics().find((entry) => entry.pid === pid);
    return metric === undefined ? null : metric.memory.workingSetSize / 1024;
  });
}

async function settleFrames(page, count = 2) {
  await page.evaluate(async (frames) => {
    for (let index = 0; index < frames; index += 1) {
      await new Promise((resolvePromise) => requestAnimationFrame(resolvePromise));
    }
  }, count);
}

async function bufferedLongTasks(page) {
  return page.evaluate(
    () =>
      new Promise((resolvePromise) => {
        if (typeof PerformanceObserver === "undefined") {
          resolvePromise([]);
          return;
        }
        const entries = [];
        const observer = new PerformanceObserver((list) => {
          entries.push(...list.getEntries().map((entry) => entry.duration));
        });
        try {
          observer.observe({ type: "longtask", buffered: true });
        } catch {
          resolvePromise([]);
          return;
        }
        setTimeout(() => {
          observer.disconnect();
          resolvePromise(entries);
        }, 0);
      }),
  );
}

async function startCapture(page) {
  await page.evaluate(() => {
    const held = window.vc353Capture;
    held?.observer?.disconnect();
    if (held) held.active = false;
    const capture = {
      active: true,
      started: performance.now(),
      frames: [],
      longTasks: [],
      observer: null,
    };
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) capture.longTasks.push(entry.duration);
    });
    try {
      observer.observe({ type: "longtask", buffered: false });
      capture.observer = observer;
    } catch {
      observer.disconnect();
    }
    const pump = (stamp) => {
      if (!capture.active) return;
      capture.frames.push(stamp);
      requestAnimationFrame(pump);
    };
    requestAnimationFrame(pump);
    window.vc353Capture = capture;
  });
}

async function captureElapsed(page) {
  return page.evaluate(() => performance.now() - window.vc353Capture.started);
}

async function stopCapture(page) {
  return page.evaluate(() => {
    const capture = window.vc353Capture;
    capture.active = false;
    capture.observer?.disconnect();
    const frameTimesMs = capture.frames
      .slice(1)
      .map((value, index) => value - capture.frames[index]);
    const fast = frameTimesMs.filter((value) => value > 0 && value < 50).toSorted((a, b) => a - b);
    const refreshIntervalMs = fast.length === 0 ? null : fast[Math.floor(fast.length * 0.25)];
    const droppedFrames =
      refreshIntervalMs === null
        ? null
        : frameTimesMs.reduce(
            (sum, duration) => sum + Math.max(0, Math.round(duration / refreshIntervalMs) - 1),
            0,
          );
    return {
      latencyMs: performance.now() - capture.started,
      frameTimesMs,
      refreshIntervalMs,
      droppedFrames,
      longTasksMs: capture.longTasks,
    };
  });
}

async function measured(page, app, action, ready) {
  await startCapture(page);
  try {
    await action();
    await ready();
    await settleFrames(page);
    return { ...(await stopCapture(page)), rendererRssMb: await rendererRssMb(app) };
  } catch (error) {
    await stopCapture(page).catch(() => null);
    throw error;
  }
}

/**
 * The board is drawn: the New ticket control is up, the board is holding every
 * ticket the fixture has, and its columns have painted cards.
 *
 * It used to be "one `[data-board-ticket-slot]` per ticket", which stopped
 * being the same statement when VC-316 bounded what a column mounts. Counting
 * slots now measures the WINDOW, so a windowed board would never satisfy it
 * and an unwindowed one would satisfy it for the wrong reason. The board
 * publishes what it holds (`data-board-ticket-count`) and each column
 * publishes both numbers, so this asks the board for the count and the columns
 * for evidence they actually rendered — and the mounted count is reported as a
 * measurement (`boardMountCounts`) rather than asserted as a constant.
 */
async function waitForBoard(page, ticketCount, timeout = 60_000) {
  await page.getByRole("button", { name: "New ticket", exact: true }).waitFor({
    state: "visible",
    timeout,
  });
  await page.waitForFunction(
    (expected) => {
      const board = document.querySelector("[data-board-ticket-count]");
      if (board === null) return false;
      if (Number(board.getAttribute("data-board-ticket-count")) !== expected) return false;
      const columns = [...document.querySelectorAll("[data-column-count]")];
      if (columns.length === 0) return false;
      // Every non-empty column has painted at least one card. Without this the
      // count attribute alone would pass on the frame the board first renders,
      // before a single card exists.
      return columns.every(
        (column) =>
          Number(column.getAttribute("data-column-count")) === 0 ||
          Number(column.getAttribute("data-column-mounted")) > 0,
      );
    },
    ticketCount,
    { timeout },
  );
}

async function openTicket(page, displayId) {
  await cardById(page, displayId).dblclick();
  await tabStrip(page, TICKET_TAB_STRIP)
    .getByRole("tab", { name: displayId, exact: true })
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function clickTicketBody(page, displayId) {
  await tabStrip(page, TICKET_TAB_STRIP).getByRole("tab", { name: displayId, exact: true }).click();
}

async function measureLongChat(page, app, title) {
  const row = page.getByText(title, { exact: true }).first();
  await row.waitFor({ state: "visible", timeout: 30_000 });
  await startCapture(page);
  try {
    await row.click();
    await page.locator('[role="log"] .is-user, [role="log"] .is-assistant').first().waitFor({
      state: "visible",
      timeout: 120_000,
    });
    const firstPaintMs = await captureElapsed(page);
    // "Interactive" is a question about the scroller answering within a window,
    // not about one assignment surviving exactly two frames. A long transcript
    // that is still hydrating legitimately re-anchors its own scroll position
    // — tail pinning is the product working, not a stall — and a single-shot
    // assertion races that, which showed up as one failed iteration in twenty.
    // So poll to a deadline, and accept either landing on the target or moving
    // in response to it; report elapsed time so a slow answer is still visible
    // in the sample rather than hidden by a pass.
    const responsiveness = await page.evaluate(async (deadlineMs) => {
      const scroller = document.querySelector('[role="log"] > div');
      if (!(scroller instanceof HTMLElement)) return { responsive: false, why: "no scroller" };
      const startedAt = performance.now();
      let attempts = 0;
      while (performance.now() - startedAt < deadlineMs) {
        attempts += 1;
        const before = scroller.scrollTop;
        const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (maximum === 0) {
          return { responsive: true, attempts, elapsedMs: performance.now() - startedAt };
        }
        const target = before > 0 ? Math.max(0, before - 16) : Math.min(maximum, 16);
        scroller.scrollTop = target;
        await new Promise((resolvePromise) => requestAnimationFrame(resolvePromise));
        await new Promise((resolvePromise) => requestAnimationFrame(resolvePromise));
        const landed = Math.abs(scroller.scrollTop - target) < 1;
        const moved = Math.abs(scroller.scrollTop - before) >= 1;
        if (landed || moved) {
          return { responsive: true, attempts, elapsedMs: performance.now() - startedAt };
        }
      }
      return { responsive: false, why: "scroller never answered", attempts, elapsedMs: deadlineMs };
    }, 10_000);
    if (!responsiveness.responsive) {
      throw new Error(
        `long-chat scroller did not become interactive: ${responsiveness.why} after ${responsiveness.attempts ?? 0} attempts`,
      );
    }
    return {
      ...(await stopCapture(page)),
      firstPaintMs,
      rendererRssMb: await rendererRssMb(app),
    };
  } catch (error) {
    await stopCapture(page).catch(() => null);
    throw error;
  }
}

async function measureNewChat(page, app, displayId) {
  await clickTicketBody(page, displayId);
  const textarea = page.locator('textarea[aria-label="Message"]:visible');
  const before = await tabStrip(page, TICKET_TAB_STRIP).getByRole("tab").count();
  return measured(
    page,
    app,
    () => tabStripNewChatButton(page, TICKET_TAB_STRIP).click(),
    async () => {
      await page.waitForFunction(
        ({ expected }) =>
          document.querySelectorAll('[role="tablist"][aria-label="Ticket tabs"] [role="tab"]')
            .length > expected,
        { expected: before },
        { timeout: 30_000 },
      );
      await textarea.waitFor({ state: "visible", timeout: 30_000 });
      await page.waitForFunction(
        () => {
          const boxes = Array.from(document.querySelectorAll('textarea[aria-label="Message"]'));
          const box = boxes.find(
            (node) => node instanceof HTMLElement && node.offsetParent !== null,
          );
          return box instanceof HTMLTextAreaElement && !box.disabled;
        },
        undefined,
        { timeout: 30_000 },
      );
      await textarea.focus();
      if (!(await textarea.evaluate((node) => document.activeElement === node))) {
        throw new Error("new chat composer did not accept focus");
      }
    },
  );
}

async function measureNewTerminal(page, app, readyFile) {
  await page.getByRole("button", { name: "Home", exact: true }).first().click();
  await tabStrip(page, "Home tabs").waitFor({ state: "visible", timeout: 30_000 });
  const before = await page.locator('[aria-label^="Close Terminal"]').count();
  return measured(
    page,
    app,
    () => startTerminalSession(page),
    async () => {
      await page.waitForFunction(
        (expected) => document.querySelectorAll('[aria-label^="Close Terminal"]').length > expected,
        before,
        { timeout: 30_000 },
      );
      const terminalHost = page.locator("[data-terminal-renderer]:visible").last();
      await terminalHost.waitFor({ state: "visible", timeout: 30_000 });
      const terminalId = await terminalHost.getAttribute("data-terminal-renderer");
      if (terminalId === null) throw new Error("new terminal has no durable id");
      const shellCommand = `stty size > '${readyFile.replaceAll("'", "'\\\"'\\\"'")}'`;
      const result = await page.evaluate(
        ({ sessionId, shellCommand: input }) => window.api.terminal.run(sessionId, input),
        { sessionId: terminalId, shellCommand },
      );
      if (!result.ok || result.exitCode !== 0) {
        throw new Error(`new terminal readiness command failed: ${JSON.stringify(result)}`);
      }
      const value = await fs.readFile(readyFile, "utf8").catch(() => "");
      if (!/^\d+\s+\d+\s*$/.test(value)) {
        throw new Error(`new terminal returned an invalid grid: ${JSON.stringify(value)}`);
      }
    },
  );
}

async function measureSidebar(page, app) {
  const toggle = page.getByRole("button", { name: "Toggle navigation sidebar", exact: true });
  const state = () => page.locator("[data-volli-shell]").getAttribute("data-volli-shell");
  const phase = async () => {
    const before = await state();
    return measured(
      page,
      app,
      () => toggle.click(),
      async () => {
        await page.waitForFunction(
          (previous) =>
            document.querySelector("[data-volli-shell]")?.getAttribute("data-volli-shell") !==
            previous,
          before,
          { timeout: 5_000 },
        );
        await settleFrames(page, 16);
      },
    );
  };
  const close = await phase();
  const open = await phase();
  return {
    latencyMs: close.latencyMs + open.latencyMs,
    closeMs: close.latencyMs,
    openMs: open.latencyMs,
    frameTimesMs: [...close.frameTimesMs, ...open.frameTimesMs],
    droppedFrames: addNullableMeasurements(close.droppedFrames, open.droppedFrames),
    longTasksMs: [...close.longTasksMs, ...open.longTasksMs],
    refreshIntervalMs: close.refreshIntervalMs ?? open.refreshIntervalMs,
    rendererRssMb: open.rendererRssMb,
  };
}

async function selectTicketFromPalette(page, targetTitle, targetDisplayId) {
  await page.getByRole("button", { name: "Search tickets and sessions", exact: true }).click();
  const input = page.getByPlaceholder("Search tickets and sessions…");
  await input.waitFor({ state: "visible", timeout: 10_000 });
  await input.fill(targetDisplayId);
  // Scoped to the palette's own list, not the page. A page-wide text match also
  // finds the OPEN ticket's `h1`, which carries the same title — harmless in a
  // full run, where the interactions before this one have navigated away, and a
  // strict-mode violation the moment `--interactions ticket_switch` skips them
  // and leaves the workspace on screen. The flag is the cheap way to measure
  // just this interaction, so it has to be the supported way too.
  const row = page.getByLabel("Suggestions").getByText(targetTitle, { exact: true });
  await row.waitFor({ state: "visible", timeout: 30_000 });
  await row.click();
}

async function waitForTicketWorkspace(page, targetTitle, targetDisplayId) {
  const bodyTab = tabStrip(page, TICKET_TAB_STRIP).getByRole("tab", {
    name: targetDisplayId,
    exact: true,
  });
  await bodyTab.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(
    ({ displayId, title }) => {
      // This predicate is serialized into Playwright's page context with the callback.
      // oxlint-disable-next-line unicorn/consistent-function-scoping
      const visible = (node) =>
        node instanceof HTMLElement &&
        node.offsetParent !== null &&
        node.getBoundingClientRect().width > 0 &&
        node.getBoundingClientRect().height > 0;
      const tabs = Array.from(
        document.querySelectorAll('[role="tablist"][aria-label="Ticket tabs"] [role="tab"]'),
      );
      const selected = tabs.find(
        (node) =>
          node.textContent?.trim() === displayId && node.getAttribute("aria-selected") === "true",
      );
      const heading = Array.from(document.querySelectorAll('[role="button"]')).find(
        (node) => node.textContent?.trim() === title && visible(node),
      );
      const editor = Array.from(
        document.querySelectorAll('[aria-label="Ticket description"]'),
      ).find(visible);
      return (
        selected !== undefined && visible(selected) && heading !== undefined && editor !== undefined
      );
    },
    { displayId: targetDisplayId, title: targetTitle },
    { timeout: 30_000 },
  );
  const editor = page.getByLabel("Ticket description", { exact: true }).first();
  await editor.focus();
  const acceptedFocus = await editor.evaluate(
    (node) => node === document.activeElement || node.contains(document.activeElement),
  );
  if (!acceptedFocus) {
    throw new Error(`${targetDisplayId} ticket workspace content did not accept focus`);
  }
}

async function openTicketWorkspaceFromPalette(page, targetTitle, targetDisplayId) {
  await selectTicketFromPalette(page, targetTitle, targetDisplayId);
  await waitForTicketWorkspace(page, targetTitle, targetDisplayId);
}

/**
 * Switch on the renderer's phase marks and clear anything an earlier
 * repetition left on the timeline.
 *
 * Both halves matter. The flag is what makes `markPerfPhase` write at all
 * (`@renderer/lib/perf-marks`), and the clear is what keeps the reducer's
 * "latest stamp wins" honest: the warm-up switches this measurement runs
 * before it starts capturing stamp the same mark names, and a stale
 * `ticket-description.ready` from the previous open would otherwise be read as
 * this switch's.
 */
async function armPhaseMarks(page) {
  await page.evaluate((names) => {
    window.volliPerfMarks = true;
    for (const name of names) performance.clearMarks(name);
  }, Object.values(TICKET_SWITCH_MARKS));
}

async function phaseMarks(page, names) {
  return page.evaluate(
    (wanted) =>
      performance
        .getEntriesByType("mark")
        .filter((entry) => wanted.includes(entry.name))
        .map((entry) => ({ name: entry.name, startTime: entry.startTime })),
    names,
  );
}

async function measureTicketSwitch(page, app, targetTitle, targetDisplayId) {
  await armPhaseMarks(page);
  const sample = await measured(
    page,
    app,
    async () => {
      // The start boundary is stamped on the page's own timeline, in the same
      // clock as every other mark, so the segments subtract cleanly. It sits
      // immediately before the first input of the switch — which is what makes
      // opening the palette part of the number, and therefore visible as its
      // own phase instead of hidden inside the total.
      await page.evaluate((name) => performance.mark(name), TICKET_SWITCH_MARKS.start);
      await selectTicketFromPalette(page, targetTitle, targetDisplayId);
    },
    () => waitForTicketWorkspace(page, targetTitle, targetDisplayId),
  );
  const breakdown = ticketSwitchBreakdown({
    marks: await phaseMarks(page, Object.values(TICKET_SWITCH_MARKS)),
    latencyMs: sample.latencyMs,
  });
  const { missingMarks, ...phases } = breakdown;
  if (missingMarks.length > 0) {
    // Not a soft finding. A missing mark means the renderer and this harness
    // disagree about a boundary's name, and a split that quietly reports
    // `null` for a phase is worse than no split at all — it reads as "we
    // measured that and it was nothing".
    throw new Error(
      `ticket switch phase marks missing: ${missingMarks.join(", ")} — renderer marks and ticket-switch-breakdown.mjs have drifted`,
    );
  }
  return { ...sample, ...phases };
}

/**
 * What the board is actually holding in the DOM right now (VC-316).
 *
 * `boardTickets` is what the columns HOLD and `mountedCards` is what they have
 * actually put in the DOM. Both come from the columns' own published numbers
 * rather than from counting nodes, because counting nodes is exactly what
 * stopped answering the first question when VC-316 bounded the second.
 */
async function boardMountCounts(page) {
  return page.evaluate(() => {
    const columns = [...document.querySelectorAll("[data-column-count]")];
    const sum = (attribute) =>
      columns.reduce((total, column) => total + Number(column.getAttribute(attribute)), 0);
    return { boardTickets: sum("data-column-count"), mountedCards: sum("data-column-mounted") };
  });
}

async function measureBoardRender(page, app, ticketCount) {
  const sample = await measured(
    page,
    app,
    async () => {
      await page.getByRole("button", { name: "Home", exact: true }).first().click();
      const boardTab = tabStrip(page, "Home tabs").getByRole("tab", {
        name: "Board",
        exact: true,
      });
      if (await boardTab.isVisible().catch(() => false)) await boardTab.click();
    },
    () => waitForBoard(page, ticketCount),
  );
  // Taken AFTER the measured window closes: reading the DOM mid-capture would
  // put this harness's own layout flush inside the frame times it reports.
  return { ...sample, ...(await boardMountCounts(page)) };
}

/**
 * Frame times while the fullest column is scrolled end to end.
 *
 * The board's own scroller, not the page's: each column carries its own
 * overflow (`data-column-scroller`), so a board-wide scroll measures nothing.
 * The column with the most scrollable distance is the one a windowing change
 * has to keep smooth, so that is the one this drives.
 */
async function measureBoardScroll(page, app) {
  return measured(
    page,
    app,
    async () => {
      const moved = await page.evaluate(async () => {
        const scrollers = Array.from(document.querySelectorAll("[data-column-scroller]")).filter(
          (node) => node instanceof HTMLElement,
        );
        const target = scrollers
          .map((node) => ({ node, distance: node.scrollHeight - node.clientHeight }))
          .toSorted((a, b) => b.distance - a.distance)
          .at(0);
        if (target === undefined || target.distance <= 0) return 0;
        const frame = () =>
          new Promise((resolvePromise) => requestAnimationFrame(() => resolvePromise(undefined)));
        // A fixed number of steps rather than a fixed pixel stride: the point is
        // one comparable gesture across 300 and 10,000 cards, and a fixed stride
        // would make the tall board a thirty-times longer measurement.
        const steps = 60;
        let travelled = 0;
        for (let step = 1; step <= steps; step += 1) {
          const before = target.node.scrollTop;
          target.node.scrollTop = (target.distance * step) / steps;
          await frame();
          travelled += Math.abs(target.node.scrollTop - before);
        }
        return travelled;
      });
      if (moved <= 0) {
        // A fixture whose tallest column fits on screen cannot answer this
        // arm's question, and reporting a clean zero for it would read as a
        // measured result. Fail loudly and name the remedy.
        throw new Error(
          "no board column had anything to scroll — this fixture's columns all fit on screen; run board_scroll against a taller preset",
        );
      }
      return moved;
    },
    async () => {},
  ).then(async (sample) => ({ ...sample, ...(await boardMountCounts(page)) }));
}

async function measureRpc(page, app, sessionId) {
  await startCapture(page);
  try {
    const rpc = await page.evaluate(sessionRpcRoundTrip, sessionProjectionRequest(sessionId));
    await settleFrames(page);
    return {
      ...(await stopCapture(page)),
      latencyMs: rpc.latencyMs,
      rendererRssMb: await rendererRssMb(app),
    };
  } catch (error) {
    await stopCapture(page).catch(() => null);
    throw error;
  }
}

/**
 * One repetition of the full-app arm.
 *
 * `wanted` is the interaction filter (`--interactions`). A change that affects
 * one interaction measures only that one instead of forking this harness;
 * every skipped measurement returns `null`, and an interaction with no samples
 * is left out of the report rather than reported as a zero.
 */
async function fullAppIteration({
  fixtureDirectory,
  runRoot,
  armName,
  index,
  manifest,
  wanted,
  signal,
}) {
  const profile = join(runRoot, `${armName}-${String(index + 1).padStart(2, "0")}`);
  await cloneFixture(fixtureDirectory, profile);
  const errors = [];
  let app;
  let launchStarted;
  let abortedClose;
  const closeOnAbort = () => {
    if (app !== undefined && abortedClose === undefined) {
      abortedClose = closeAppBounded(app).catch(() => null);
    }
  };
  signal?.addEventListener("abort", closeOnAbort, { once: true });
  try {
    signal?.throwIfAborted();
    app = await launch({
      dbPath: join(profile, "volli.db"),
      userDataDir: profile,
      beforeLaunch: () => {
        launchStarted = performance.now();
      },
      extraEnv: {
        VOLLI_QUIET_WINDOWS: "1",
        PI_CODING_AGENT_DIR: join(profile, "pi-agent"),
        VOLLI_WORKTREE_HOME_DIR: join(profile, "runtime-worktrees"),
      },
    });
    signal?.throwIfAborted();
    if (launchStarted === undefined) throw new Error("launch timing seam did not run");
    await assertProfileIsolated(app, profile);
    const page = await app.firstWindow();
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.waitForLoadState("domcontentloaded");
    assertBuiltRendererLoaded(page);
    await waitForBoard(page, manifest.counts.tickets, 120_000);
    await settleFrames(page);
    const coldPaint = await page.evaluate(
      () => performance.getEntriesByName("first-contentful-paint").at(0)?.startTime ?? null,
    );
    const cold = {
      latencyMs: performance.now() - launchStarted,
      firstPaintMs: coldPaint,
      frameTimesMs: [],
      droppedFrames: null,
      longTasksMs: await bufferedLongTasks(page),
      rendererRssMb: await rendererRssMb(app),
    };

    /** Runs one measurement, or skips it when this run did not ask for it. */
    const measure = async (id, label, run) => {
      if (!wanted.has(id)) return null;
      console.log(`  measuring ${label}`);
      return run();
    };

    await openTicket(page, manifest.longChat.displayId);
    // Every string this benchmark looks for comes from the fixture manifest,
    // which publishes what the production projection folds to. A literal here
    // would silently become a 30-second locator timeout the day the fixture's
    // event mix retitles a Session.
    const longChat = await measure("long_chat", "long chat", () =>
      measureLongChat(page, app, manifest.longChat.title),
    );
    const newChat = await measure("new_chat", "new chat", () =>
      measureNewChat(page, app, manifest.longChat.displayId),
    );
    const terminal = await measure("new_terminal", "new terminal", () =>
      measureNewTerminal(page, app, join(profile, "terminal-ready.txt")),
    );
    const sidebar = await measure("sidebar_toggle", "sidebar", () => measureSidebar(page, app));
    let ticketSwitch = null;
    if (wanted.has("ticket_switch")) {
      console.log("  preparing ticket switch");
      const { displayId: switchDisplayId, title: switchTitle } = manifest.switchTarget;
      await openTicketWorkspaceFromPalette(
        page,
        manifest.longChat.ticketTitle,
        manifest.longChat.displayId,
      );
      await openTicketWorkspaceFromPalette(page, switchTitle, switchDisplayId);
      await openTicketWorkspaceFromPalette(
        page,
        manifest.longChat.ticketTitle,
        manifest.longChat.displayId,
      );
      console.log("  measuring ticket switch");
      ticketSwitch = await measureTicketSwitch(page, app, switchTitle, switchDisplayId);
    }
    const rpc = await measure("rpc_round_trip", "RPC", () =>
      measureRpc(page, app, manifest.longChat.sessionId),
    );
    const board = await measure("board_render", "board render", () =>
      measureBoardRender(page, app, manifest.counts.tickets),
    );
    // After the board render arm by construction: it needs the board in front,
    // and `measureBoardRender` is what puts it there. When board render is
    // filtered out, this puts the board in front itself.
    let boardScroll = null;
    if (wanted.has("board_scroll")) {
      if (board === null) {
        await page.getByRole("button", { name: "Home", exact: true }).first().click();
        await waitForBoard(page, manifest.counts.tickets);
        await settleFrames(page);
      }
      console.log("  measuring board scroll");
      boardScroll = await measureBoardScroll(page, app);
    }
    return {
      samples: {
        cold_launch: wanted.has("cold_launch") ? cold : null,
        long_chat: longChat,
        new_chat: newChat,
        new_terminal: terminal,
        sidebar_toggle: sidebar,
        ticket_switch: ticketSwitch,
        board_render: board,
        board_scroll: boardScroll,
        rpc_round_trip: rpc,
      },
      rendererErrors: errors.slice(0, 20),
    };
  } finally {
    signal?.removeEventListener("abort", closeOnAbort);
    if (abortedClose !== undefined) await abortedClose;
    else if (app !== undefined) await closeAppBounded(app).catch(() => null);
    if (process.env.VOLLI_PERF_KEEP_RUNS !== "1") {
      await fs.rm(profile, { recursive: true, force: true });
    }
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function failedHealthChecks(value, path = "checks", failures = []) {
  if (value === false) {
    failures.push(path);
    return failures;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => failedHealthChecks(entry, `${path}[${index}]`, failures));
    return failures;
  }
  if (!isRecord(value)) return failures;
  for (const [key, entry] of Object.entries(value)) {
    if (["ok", "passed", "healthy", "reached"].includes(key) && entry !== true) {
      failures.push(`${path}.${key}`);
    } else {
      failedHealthChecks(entry, `${path}.${key}`, failures);
    }
  }
  return failures;
}

export function validateChatBenchReport(
  report,
  { expectedSamples, expectedSteps, requireCodeFence = false },
) {
  if (!isRecord(report)) throw new Error("ChatPlane bench report must be an object");
  if (Object.hasOwn(report, "failure")) {
    throw new Error(`ChatPlane bench reported a failure: ${String(report.failure)}`);
  }
  if (!Array.isArray(report.errors)) {
    throw new Error("ChatPlane bench report is missing its console error list");
  }
  if (report.errors.length > 0) {
    // The bench page records uncaught errors with their stacks. Console text
    // alone names an error without saying where it came from, and this gate
    // fails whole runs, so whoever reads the failure gets the frames too.
    const stacks = Array.isArray(report.errorDetails)
      ? report.errorDetails
          .filter((detail) => isRecord(detail) && typeof detail.stack === "string")
          .map((detail) => `\n---\n${detail.stack}`)
          .join("")
      : "";
    throw new Error(
      `ChatPlane bench reported console errors: ${report.errors.join(" | ")}${stacks}`,
    );
  }
  if (!isRecord(report.checks)) {
    throw new Error("ChatPlane bench report is missing health checks");
  }
  if (!isRecord(report.checks.firstTurn) || report.checks.firstTurn.reached !== true) {
    throw new Error("ChatPlane health check failed: checks.firstTurn.reached");
  }
  const failures = [...new Set(failedHealthChecks(report.checks))];
  if (failures.length > 0) {
    throw new Error(`ChatPlane health checks failed: ${failures.join(", ")}`);
  }
  if (!Array.isArray(report.streamingSamples)) {
    throw new Error("ChatPlane bench report is missing streaming samples");
  }
  if (report.streamingSamples.length !== expectedSamples) {
    throw new Error(
      `ChatPlane bench returned ${report.streamingSamples.length} streaming samples; expected ${expectedSamples}`,
    );
  }
  report.streamingSamples.forEach((sample, index) => {
    const at = `streamingSamples[${index}]`;
    if (!isRecord(sample) || sample.ok !== true) {
      throw new Error(`ChatPlane ${at} failed`);
    }
    if (sample.steps !== expectedSteps) {
      throw new Error(
        `ChatPlane ${at} used ${String(sample.steps)} steps; expected ${expectedSteps}`,
      );
    }
    if (sample.streamedWhileWorking !== true) {
      throw new Error(`ChatPlane ${at} did not stream in the working state`);
    }
    if (sample.streamedWhileTurnActive !== true) {
      throw new Error(`ChatPlane ${at} did not stream while the turn was active`);
    }
    // The fence contract belongs to a full-length run. A documented quick
    // smoke (`--stream-steps 30`) legitimately ends while the fence is still
    // open, and failing it would make the fast harness check unusable; a
    // baseline, which is what these numbers are published from, must reach
    // every phase. `requireCodeFence` is true exactly when the run used the
    // default step count and token rate.
    if (requireCodeFence) {
      if (sample.codeFenceOpened !== true || sample.codeFenceClosed !== true) {
        throw new Error(`ChatPlane ${at} did not open and close the default code fence`);
      }
      // Streamdown defers offscreen code with `content-visibility`, so a probe
      // that streamed into no mounted, highlighted block measured nothing and
      // would otherwise report a clean zero.
      if (
        sample.liveCodeBlocks < 1 ||
        sample.settledCodeBlocks < 1 ||
        sample.settledHighlightedCodeBlocks < 1
      ) {
        throw new Error(`ChatPlane ${at} missed its live-fence contract`);
      }
    }
    if (!Number.isFinite(sample.latencyMs) || sample.latencyMs < 0) {
      throw new Error(`ChatPlane ${at} has invalid latency`);
    }
    if (!Array.isArray(sample.frameTimesMs) || !Array.isArray(sample.longTasksMs)) {
      throw new Error(`ChatPlane ${at} is missing frame or long-task measurements`);
    }
  });
  return report;
}

export function validateRendererErrors(errors, label = "renderer") {
  if (!Array.isArray(errors)) throw new Error(`${label} console error list is missing`);
  if (errors.length > 0) throw new Error(`${label} reported console errors: ${errors.join(" | ")}`);
}

function validateInteraction(interaction, expectedSamples) {
  if (!isRecord(interaction) || typeof interaction.id !== "string") {
    throw new Error("benchmark interaction is malformed");
  }
  if (!Array.isArray(interaction.samples) || interaction.samples.length !== expectedSamples) {
    throw new Error(
      `${interaction.id} returned ${interaction.samples?.length ?? 0} samples; expected ${expectedSamples}`,
    );
  }
  interaction.samples.forEach((sample, index) => {
    if (!isRecord(sample) || !Number.isFinite(sample.latencyMs) || sample.latencyMs < 0) {
      throw new Error(`${interaction.id} sample ${index + 1} has invalid latency`);
    }
  });
  if (interaction.summary?.latencyMs?.n !== expectedSamples) {
    throw new Error(`${interaction.id} latency summary does not include every sample`);
  }
}

export function validateBenchmarkReport(report) {
  if (!isRecord(report) || !isRecord(report.config) || !Array.isArray(report.arms)) {
    throw new Error("benchmark report is malformed");
  }
  // What this run was ASKED to measure, not what a full run would have.
  // `--interactions` is how a change that touches one interaction avoids the
  // other eight (VC-385); the run honoured it, so validation has to as well,
  // or the flag produces numbers it then refuses to write down.
  const expectedInteractions = report.config.streamOnly
    ? ["stream_scroll"]
    : (report.config.interactions ?? INTERACTIONS.map(([id]) => id));
  const expectedArmNames = report.config.arms.map((arm) =>
    arm === "idle"
      ? "idle"
      : busyLoadName(report.config.busyCores, report.config.loadDurationSeconds * 1_000),
  );
  const actualArmNames = report.arms.map((arm) => arm?.name);
  if (
    actualArmNames.length !== expectedArmNames.length ||
    actualArmNames.some((name, index) => name !== expectedArmNames[index])
  ) {
    throw new Error(
      `benchmark arms differ: expected ${expectedArmNames.join(", ")}; got ${actualArmNames.join(", ")}`,
    );
  }

  for (const arm of report.arms) {
    validateRendererErrors(arm.rendererErrors, `${arm.name} app renderer`);
    if (!Array.isArray(arm.interactions)) {
      throw new Error(`${arm.name} interactions are missing`);
    }
    const actualInteractions = arm.interactions.map((interaction) => interaction.id);
    if (
      actualInteractions.length !== expectedInteractions.length ||
      new Set(actualInteractions).size !== actualInteractions.length ||
      expectedInteractions.some((id) => !actualInteractions.includes(id))
    ) {
      throw new Error(
        `${arm.name} interactions differ: expected ${expectedInteractions.join(", ")}; got ${actualInteractions.join(", ")}`,
      );
    }
    for (const interaction of arm.interactions) {
      validateInteraction(interaction, report.config.repetitions);
    }
    // The chat-window bench is the streaming interaction's other half, so it
    // is validated only when this run measured streaming at all. A filtered
    // run never launches it and has no report to check.
    if (expectedInteractions.includes("stream_scroll")) {
      const stream = arm.interactions.find((interaction) => interaction.id === "stream_scroll");
      validateChatBenchReport(
        {
          ...arm.chatWindow,
          streamingSamples: stream?.samples,
        },
        {
          expectedSamples: report.config.repetitions,
          expectedSteps: report.config.streamSteps,
          requireCodeFence:
            report.config.streamSteps === DEFAULT_STREAM_STEPS &&
            report.config.streamTokenRate === DEFAULT_STREAM_TOKEN_RATE,
        },
      );
    }

    const loaded = arm.busyCores > 0;
    if (!loaded && arm.load !== undefined)
      throw new Error("idle arm unexpectedly recorded busy load");
    if (loaded) {
      const expectedDurationMs = report.config.loadDurationSeconds * 1_000;
      if (
        arm.busyCores !== report.config.busyCores ||
        !isRecord(arm.load) ||
        arm.load.configuredDurationMs !== expectedDurationMs
      ) {
        throw new Error(`${arm.name} load metadata differs from the configured load arm`);
      }
      // A run that measured every interaction holds its exposure open for the
      // whole configured duration; the two narrowed shapes stop as soon as
      // their measurements are done, and each says so in its own words.
      // `--interactions` is the ordinary way to measure one interaction, so
      // its early stop is an expected ending, not a broken arm.
      const narrowed = !expectedInteractions.includes("stream_scroll");
      const expectedCompletion = report.config.streamOnly
        ? "quick-smoke-early-stop"
        : narrowed
          ? "narrowed-interactions-early-stop"
          : "fixed-duration-complete";
      if (arm.load.completion !== expectedCompletion) {
        throw new Error(`${arm.name} load ended as ${String(arm.load.completion)}`);
      }
      // Only a full arm can be asked whether it received one COMPLETE
      // fixed-duration exposure. A narrowed arm deliberately did not, and
      // holding it to that bar would fail every run the flag exists to enable.
      if (
        !report.config.streamOnly &&
        !narrowed &&
        (!Number.isFinite(arm.load.exposureDurationMs) ||
          arm.load.exposureDurationMs < expectedDurationMs ||
          !Number.isFinite(arm.load.measurementsDurationMs) ||
          arm.load.measurementsDurationMs >= expectedDurationMs)
      ) {
        throw new Error(`${arm.name} did not receive one complete fixed-duration exposure`);
      }
      if (
        narrowed &&
        (!Number.isFinite(arm.load.exposureDurationMs) ||
          !Number.isFinite(arm.load.measurementsDurationMs) ||
          arm.load.measurementsDurationMs > arm.load.exposureDurationMs)
      ) {
        throw new Error(`${arm.name} load did not cover its own measurements`);
      }
    }
  }
  return report;
}

async function runChatBench({
  manifest,
  repetitions,
  streamSteps,
  streamTokenRate,
  skipBuild,
  label,
  signal,
}) {
  const output = await command(
    process.execPath,
    [
      CHAT_BENCH,
      "--sessions",
      "1",
      "--turns",
      String(manifest.counts.transcriptMessages),
      "--stream-samples",
      String(repetitions),
      "--stream-steps",
      String(streamSteps),
      "--stream-token-rate",
      String(streamTokenRate),
      "--label",
      label,
      ...(skipBuild ? ["--skip-build"] : []),
    ],
    {
      cwd: APP_DIR,
      // NODE_ENV is stated, not inherited: this process may have created a
      // Vite dev server to read the fixture through production modules, and
      // that sets `development` for everything spawned afterwards. The bench
      // pins it too; a measured build is worth saying twice.
      env: { ELECTRON_DISABLE_SECURITY_WARNINGS: "1", NODE_ENV: "production" },
      signal,
    },
  );
  const match = /__BENCH__(?<json>.*)__BENCH__/s.exec(output);
  if (match?.groups?.json === undefined) throw new Error("chat window bench printed no report");
  const report = JSON.parse(match.groups.json);
  return validateChatBenchReport(report, {
    expectedSamples: repetitions,
    expectedSteps: streamSteps,
    requireCodeFence:
      streamSteps === DEFAULT_STREAM_STEPS && streamTokenRate === DEFAULT_STREAM_TOKEN_RATE,
  });
}

async function runArm({ args, fixtureDirectory, runRoot, manifest, loaded, chatBuilt }) {
  const load = loaded
    ? await startBusyLoad(args.busyCores, args.loadDurationSeconds * 1_000)
    : null;
  const name = load?.name ?? "idle";
  console.log(`\n=== ${name} arm ===`);
  const byInteraction = Object.fromEntries(INTERACTIONS.map(([id]) => [id, []]));
  const wanted = new Set(args.interactions ?? INTERACTIONS.map(([id]) => id));
  const rendererErrors = [];
  const underLoad = (label, operation) =>
    load === null ? operation(undefined) : load.run(label, operation);
  let completingExposure = false;
  try {
    // Still one launch per repetition even when a single interaction is
    // wanted: cold launch is the state every other measurement starts from,
    // and reusing a window would measure a different thing. A narrowed run is
    // for iteration, not publishing: interactions with no samples are left
    // out of the report rather than reported as zeros.
    if (!args.streamOnly && INTERACTIONS.some(([id]) => id !== "stream_scroll" && wanted.has(id))) {
      // One discarded iteration before every arm.
      //
      // Arms run in sequence, so without this the first arm pays for a cold
      // page cache on a 373 MB fixture and a cold Electron code cache while
      // the second arm inherits both warm. That confound is larger than the
      // effect being measured: the first published run of this matrix showed
      // the LOADED arm faster than idle on every interaction, with the idle
      // arm's first launch its slowest sample and its variance an order of
      // magnitude wider. A warm-up per arm makes the two arms differ by the
      // load rather than by their position in the run. It is discarded, never
      // summarized, and its cost is two iterations.
      console.log(`warm-up iteration (discarded) for ${name}`);
      const warmup = await underLoad(`${name} warm-up`, (signal) =>
        fullAppIteration({
          fixtureDirectory,
          runRoot,
          armName: `${name}-warmup`,
          index: 0,
          manifest,
          wanted,
          signal,
        }),
      );
      // A broken renderer during warm-up is still a broken renderer.
      validateRendererErrors(warmup.rendererErrors, `${name} warm-up`);
      for (let index = 0; index < args.repetitions; index += 1) {
        const label = `full app sample ${index + 1}/${args.repetitions}`;
        console.log(label);
        const result = await underLoad(label, (signal) =>
          fullAppIteration({
            fixtureDirectory,
            runRoot,
            armName: name,
            index,
            manifest,
            wanted,
            signal,
          }),
        );
        validateRendererErrors(result.rendererErrors, `${name} ${label}`);
        for (const [id, sample] of Object.entries(result.samples)) {
          if (sample !== null) byInteraction[id].push(sample);
        }
        rendererErrors.push(...result.rendererErrors);
      }
    }
    if (!wanted.has("stream_scroll")) {
      const armResult = {
        name,
        busyCores: load?.workers ?? 0,
        interactions: INTERACTIONS.flatMap(([id, label]) =>
          byInteraction[id].length === 0
            ? []
            : [aggregateInteraction(id, label, byInteraction[id])],
        ),
        rendererErrors: rendererErrors.slice(0, 50),
      };
      if (load !== null) {
        completingExposure = true;
        armResult.load = await load.finish({
          completeExposure: false,
          reason: "narrowed-interactions-early-stop",
        });
        console.log(`stopped ${load.workers} busy workers (${armResult.load.completion})`);
      }
      return armResult;
    }
    console.log(`stream+scroll samples ${args.repetitions} × ${args.streamSteps} stream steps`);
    const chat = await underLoad("stream+scroll bench", (signal) =>
      runChatBench({
        manifest,
        repetitions: args.repetitions,
        streamSteps: args.streamSteps,
        streamTokenRate: args.streamTokenRate,
        skipBuild: chatBuilt.value,
        label: `${args.preset}-${name}`,
        signal,
      }),
    );
    chatBuilt.value = true;
    byInteraction.stream_scroll.push(...chat.streamingSamples);
    const armResult = {
      name,
      busyCores: load?.workers ?? 0,
      streamTokenRate: args.streamTokenRate,
      streamContent: "live-prose-4kb-open-code-fence-96-growth-close-prose",
      interactions: INTERACTIONS.flatMap(([id, label]) =>
        byInteraction[id].length === 0 ? [] : [aggregateInteraction(id, label, byInteraction[id])],
      ),
      chatWindow: {
        steps: chat.steps,
        checks: chat.checks,
        errors: chat.errors,
      },
      rendererErrors: rendererErrors.slice(0, 50),
    };
    if (load !== null) {
      completingExposure = true;
      const completeExposure = !args.streamOnly;
      if (completeExposure) {
        console.log(
          `measurements complete; holding ${name} until its fixed deadline if time remains`,
        );
      }
      armResult.load = await load.finish({
        completeExposure,
        reason: "quick-smoke-early-stop",
      });
      console.log(`stopped ${load.workers} busy workers (${armResult.load.completion})`);
    }
    return armResult;
  } catch (error) {
    if (load !== null && !completingExposure) {
      const summary = await load
        .finish({ completeExposure: false, reason: "failed-arm-early-stop" })
        .catch(() => null);
      console.error(
        `stopped ${load.workers} busy workers (${summary?.completion ?? "cleanup failed"})`,
      );
    }
    throw error;
  }
}

export function summaryReport(report) {
  const loadedArm = report.arms.find((arm) => arm.busyCores > 0);
  return {
    schemaVersion: 1,
    generatedAt: report.generatedAt,
    device: report.host.device,
    macos: {
      version: report.host.os.macosVersion,
      build: report.host.os.macosBuild,
    },
    build: {
      sha: report.host.git.sha,
      dirty: report.host.git.dirty,
    },
    fixture: {
      preset: report.fixture.preset,
      seed: report.fixture.seed,
    },
    backgroundLoad: {
      name:
        loadedArm?.name ??
        busyLoadName(report.config.busyCores, report.config.loadDurationSeconds * 1_000),
      workerCount: report.config.busyCores,
      durationMs: report.config.loadDurationSeconds * 1_000,
      durationSeconds: report.config.loadDurationSeconds,
    },
    repetitions: report.config.repetitions,
    warmupIterationsPerArm: report.config.warmupIterationsPerArm ?? 0,
    arms: report.arms.map((arm) => ({
      name: arm.name,
      busyCores: arm.busyCores,
      interactions: arm.interactions.map((interaction) => ({
        id: interaction.id,
        label: interaction.label,
        aggregates: interaction.summary,
      })),
    })),
    armGap: report.backgroundLoadGap,
  };
}

export function markdown(report) {
  // What this run covered and how its load really ended. Both belong in the
  // Markdown rather than only in the JSON, because the JSON is not committed
  // (`docs/performance-benchmark.md`) and the Markdown is therefore the whole
  // of what a later reader gets. A report that does not say it measured one
  // interaction reads as a full matrix; a loaded report that quotes the
  // fixed-duration contract it did not meet is simply wrong.
  const measuredIds = report.config.interactions ?? INTERACTION_IDS;
  const everyInteraction = measuredIds.length === INTERACTION_IDS.length;
  const interactionsLine = everyInteraction
    ? `Interactions measured: all ${INTERACTION_IDS.length} (no \`--interactions\` filter).`
    : `Interactions measured: ${measuredIds.map((id) => `\`${id}\``).join(", ")} — a narrowed run (\`--interactions\`); every other interaction was skipped and is absent from the table below.`;
  const loadedArms = report.arms.filter((arm) => arm.busyCores > 0);
  const loadEndings = [...new Set(loadedArms.map((arm) => arm.load?.completion ?? "unknown"))];
  const lines = [
    "# Desktop performance baseline",
    "",
    `> ${WARNING}`,
    "",
    `Generated: ${report.generatedAt}`,
    `Git: \`${report.host.git.sha}\`${report.host.git.dirty ? " (dirty working tree)" : ""}`,
    `Device: ${report.host.device.model} — ${report.host.device.cpu}, ${report.host.device.logicalCores} logical cores, ${(report.host.device.memoryBytes / 2 ** 30).toFixed(1)} GiB`,
    `macOS: ${report.host.os.macosVersion} (${report.host.os.macosBuild})`,
    `Fixture: \`${report.fixture.preset}\`, seed \`${report.fixture.seed}\`, ${report.fixture.counts.sessions.toLocaleString()} Sessions / ${report.fixture.counts.sessionEvents.toLocaleString()} Session Events / ${report.fixture.counts.tickets.toLocaleString()} Tickets`,
    `Sampling: ${report.config.repetitions} repetitions per interaction and arm; arms: ${report.arms.map((arm) => arm.name).join(", ")}.`,
    `Each arm discards ${report.config.warmupIterationsPerArm ?? 0} warm-up iteration(s) first, so the arms differ by load rather than by which met a cold cache.`,
    `Loaded-arm contract: ${report.config.busyCores} busy cores for a fixed ${report.config.loadDurationSeconds.toLocaleString()} seconds.`,
    ...(loadedArms.length === 0
      ? []
      : [
          `Loaded-arm ending: ${loadEndings.join(", ")}. \`fixed-duration-complete\` is the only one that met the contract above; every other value means the load stopped when its measurements did, so the exposure was sized to the run rather than to the configured duration.`,
        ]),
    interactionsLine,
    "",
    "## Results",
    "",
    "| Load | Interaction | latency p50 | latency p95 | variance | frame p95 | dropped p95 | long tasks p95 | RSS p95 |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const arm of report.arms) {
    for (const interaction of arm.interactions) {
      const summary = interaction.summary;
      lines.push(
        `| ${arm.name} | ${interaction.label} | ${summary.latencyMs?.p50 ?? "—"} ms | ${summary.latencyMs?.p95 ?? "—"} ms | ${summary.latencyMs?.variance ?? "—"} ms² | ${summary.frameTimeMs?.p95 ?? "—"} ms | ${summary.droppedFrames?.p95 ?? "—"} | ${summary.longTasks.countPerSample?.p95 ?? "—"} | ${summary.rendererRssMb?.p95 ?? "—"} MB |`,
      );
      if (summary.firstPaintMs !== undefined) {
        lines.push(
          `| ${arm.name} | ↳ first paint | ${summary.firstPaintMs?.p50 ?? "—"} ms | ${summary.firstPaintMs?.p95 ?? "—"} ms | ${summary.firstPaintMs?.variance ?? "—"} ms² | — | — | — | — |`,
        );
      }
      // What the board was holding, and what it had mounted, when this sample
      // ended (VC-316). Printed for whichever board arm ran: a latency figure
      // for a board is only readable beside the number of cards it drew.
      if (summary.mountedCards !== undefined) {
        lines.push(
          `| ${arm.name} | ↳ mounted cards / held | ${summary.mountedCards?.p50 ?? "—"} / ${summary.boardTickets?.p50 ?? "—"} | ${summary.mountedCards?.p95 ?? "—"} / ${summary.boardTickets?.p95 ?? "—"} | — | — | — | — | — |`,
        );
      }
      if (interaction.id === "sidebar_toggle") {
        lines.push(
          `| ${arm.name} | ↳ close / open | ${summary.closeMs?.p50 ?? "—"} / ${summary.openMs?.p50 ?? "—"} ms | ${summary.closeMs?.p95 ?? "—"} / ${summary.openMs?.p95 ?? "—"} ms | — | — | — | — | — |`,
        );
      }
      if (interaction.id === "ticket_switch") {
        // The phases sum back to the latency above them, so a reader can see
        // which part of the switch a change moved (VC-385). `sessions.list` is
        // called out separately because it sits INSIDE "find row" and is
        // VC-388's cost appearing in this window.
        for (const [key, label] of [
          ["paletteOpenMs", "open palette"],
          ["paletteResolveMs", "find row"],
          ["workspaceRebuildMs", "rebuild workspace"],
          ["descriptionEditorMs", "description editor"],
          ["settleMs", "settle"],
          ["sessionsListMs", "(of which sessions.list)"],
        ]) {
          if (summary[key] === undefined) continue;
          lines.push(
            `| ${arm.name} | ↳ ${label} | ${summary[key]?.p50 ?? "—"} ms | ${summary[key]?.p95 ?? "—"} ms | ${summary[key]?.variance ?? "—"} ms² | — | — | — | — |`,
          );
        }
      }
    }
  }
  if (report.backgroundLoadGap !== null) {
    lines.push(
      "",
      `## Background-load gap (${report.backgroundLoadGap.from} → ${report.backgroundLoadGap.to})`,
      "",
      "| Interaction | p50 delta | p50 ratio | p95 delta | p95 ratio |",
      "|---|---:|---:|---:|---:|",
      ...report.backgroundLoadGap.interactions.map(
        (interaction) =>
          `| ${interaction.label} | ${interaction.p50DeltaMs} ms | ${interaction.p50Ratio ?? "—"}× | ${interaction.p95DeltaMs} ms | ${interaction.p95Ratio ?? "—"}× |`,
      ),
    );
  }
  lines.push(
    "",
    "## Method",
    "",
    "- The app measurements launch the production Vite/Electron build against a fresh APFS-cloned copy of the deterministic, file-backed migrated fixture for every repetition.",
    `- \`interactive\` means the board is holding all ${report.fixture.counts.tickets.toLocaleString()} tickets (\`data-board-ticket-count\`), every non-empty column has painted cards, and the New ticket control is present after two animation frames. It is NOT "every card is in the DOM": since VC-316 a column mounts a window around its scroll offset, and how many cards that was is reported per sample as \`mounted cards / slots\` rather than assumed. Long-chat first paint is the first visible transcript turn; interactive additionally requires a responsive transcript scroller.`,
    "- Frame loss uses a per-sample refresh interval (25th percentile of ordinary rAF deltas), not a hard-coded 60 Hz budget. Long tasks are Chromium `PerformanceObserver` `longtask` entries.",
    `- Streaming uses the existing real-\`ChatPlane\` Electron bench with the preset's long-transcript message count. It grows one assistant message under the production \`turnActive\` lifecycle at ${report.config.streamTokenRate} tokens/s, traverses prose → a roughly 4 KB TypeScript fence → 96 more growing snapshots → a closed fence → prose, and moves the transcript scroller inside the live row on both paint frames per stream step. This keeps the growing fence visible rather than letting Streamdown defer it as offscreen content. The concurrent window ends before the final settle-time highlight; raw samples report that cost separately.`,
    `- The loaded arm is named \`N-busy-core-for-${report.config.loadDurationSeconds}s\`: N Node worker threads run one fixed integer-mixing loop against a shared monotonic deadline. A full arm fails if measurement reaches that deadline. What happens otherwise depends on the run, and the "Loaded-arm ending" line above states which of these this one did: a full arm holds the load until the configured exposure is complete (\`fixed-duration-complete\`), a quick stream-only smoke stops early (\`quick-smoke-early-stop\`), and a run narrowed with \`--interactions\` stops as soon as its measurements are done (\`narrowed-interactions-early-stop\`) — that last exposure is sized to the measurements, so it is comparable to another narrowed run but not to a full matrix.`,
    "- Ticket switching first makes both workspaces usable, returns to the first, then times selection and focus-readiness of the already-open second workspace.",
    "- RSS is Electron `app.getAppMetrics()` renderer working-set size. RPC is the native tRPC `session.projection` request through the preload IPC bridge.",
    "",
    "Raw samples and complete host/fixture metadata are in benchmark.json; benchmark.summary.json is the compact, committable aggregate artifact.",
    "",
  );
  return lines.join("\n");
}

export async function writeReports(report, output) {
  const directory = resolve(output);
  await fs.mkdir(directory, { recursive: true });
  const jsonPath = join(directory, "benchmark.json");
  const summaryPath = join(directory, "benchmark.summary.json");
  const markdownPath = join(directory, "benchmark.md");
  await Promise.all([
    fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`),
    fs.writeFile(summaryPath, `${JSON.stringify(summaryReport(report), null, 2)}\n`),
    fs.writeFile(markdownPath, markdown(report)),
  ]);
  return { jsonPath, summaryPath, markdownPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.skipBuild) await buildProducts();

  const ownerRoot =
    args.fixture === undefined ? await fs.mkdtemp(join(os.tmpdir(), "volli-perf-")) : null;
  const fixtureDirectory = resolve(
    args.fixture ?? join(ownerRoot, `${args.preset}-seed-${args.seed}`),
  );
  let generated;
  if (args.fixture === undefined) {
    console.log(`generating ${args.preset} fixture at ${fixtureDirectory}…`);
    generated = await generateFixture({
      preset: args.preset,
      seed: args.seed,
      outputDirectory: fixtureDirectory,
      force: true,
    });
  } else {
    const manifest = JSON.parse(
      await fs.readFile(join(fixtureDirectory, "performance-fixture.json"), "utf8"),
    );
    generated = { manifest, userDataDir: fixtureDirectory };
  }
  const verification = await verifyFixture(fixtureDirectory, { preset: args.preset });
  const runOwnerRoot = ownerRoot ?? (await fs.mkdtemp(join(os.tmpdir(), "volli-perf-runs-")));
  const runRoot = join(runOwnerRoot, "runs");
  const host = await hostMetadata();
  const report = {
    schemaVersion: 2,
    warning: WARNING,
    generatedAt: new Date().toISOString(),
    host,
    fixture: {
      ...generated.manifest,
      verification,
    },
    config: {
      command: process.argv.join(" "),
      repetitions: args.repetitions,
      // Stated in the artifact because it changes what the numbers mean: each
      // arm discards one iteration first so the arms differ by load rather
      // than by which of them met a cold cache.
      warmupIterationsPerArm: args.streamOnly ? 0 : 1,
      busyCores: args.busyCores,
      loadDurationSeconds: args.loadDurationSeconds,
      streamSteps: args.streamSteps,
      streamTokenRate: args.streamTokenRate,
      streamContent: "live-prose-4kb-open-code-fence-96-growth-close-prose",
      streamOnly: args.streamOnly,
      // The interaction filter this run was invoked with, stated in the
      // artifact because it changes what the report covers: a reader comparing
      // two files has to be able to see that one measured a single interaction
      // and the other measured all nine.
      interactions: args.interactions ?? INTERACTIONS.map(([id]) => id),
      arms: args.arms,
    },
    arms: [],
  };
  const chatBuilt = { value: args.skipBuild };
  try {
    for (const arm of args.arms) {
      report.arms.push(
        await runArm({
          args,
          fixtureDirectory,
          runRoot,
          manifest: generated.manifest,
          loaded: arm === "loaded",
          chatBuilt,
        }),
      );
    }
    report.backgroundLoadGap = backgroundLoadGap(report.arms);
    validateBenchmarkReport(report);
    const defaultOutput = join(
      REPO,
      "performance-results",
      `${args.preset}-${new Date().toISOString().replaceAll(":", "-")}`,
    );
    const paths = await writeReports(report, args.output ?? defaultOutput);
    console.log(`\nJSON: ${paths.jsonPath}`);
    console.log(`Summary JSON: ${paths.summaryPath}`);
    console.log(`Markdown: ${paths.markdownPath}`);
    console.log(`\n${WARNING}`);
  } finally {
    if (!args.keepFixture && ownerRoot !== null) {
      await fs.rm(ownerRoot, { recursive: true, force: true });
    } else if (ownerRoot === null) {
      await fs.rm(runOwnerRoot, { recursive: true, force: true });
      console.log(`fixture reused: ${fixtureDirectory}`);
    } else {
      console.log(`fixture retained: ${fixtureDirectory}`);
    }
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  // A run drives Electron through Playwright for tens of minutes. When a load
  // arm aborts, in-flight browser calls reject after the harness has stopped
  // awaiting them, and Node's default handler kills the process with a bare
  // `TimeoutError` and a stack made entirely of Playwright internals — no
  // arm, no interaction, nothing a reader can act on. Name it instead, and
  // still fail: a benchmark that swallowed this would publish a partial
  // matrix as if it were whole.
  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    console.error(
      `benchmark aborted by an unhandled rejection — most often an Electron or Playwright call\n` +
        `that outlived its load arm's deadline. Raise --load-duration-seconds if the loaded arm\n` +
        `no longer fits its exposure on this machine.\n\n${detail}`,
    );
    process.exit(1);
  });
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
