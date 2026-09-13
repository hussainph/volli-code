#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";

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
import { generateFixture, verifyFixture } from "./fixture.mjs";
import { DEFAULT_SEED, REAL_BUSY_CORE_DEFAULT, presetNamed } from "./presets.mjs";

const execFileAsync = promisify(execFile);
const CHAT_BENCH = join(APP_DIR, "e2e", "chat-window-bench.mjs");
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
  ["rpc_round_trip", "Session RPC projection round trip"],
]);

function parseArgs(argv) {
  const args = {
    preset: "real",
    seed: DEFAULT_SEED,
    repetitions: 20,
    busyCores: Math.min(
      REAL_BUSY_CORE_DEFAULT,
      Math.max(1, os.availableParallelism?.() ?? os.cpus().length - 1),
    ),
    arms: ["idle", "loaded"],
    streamSteps: 120,
    streamTokenRate: 30,
    slowdownMs: 0,
    skipBuild: false,
    keepFixture: false,
    streamOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--preset") args.preset = argv[++index];
    else if (argument === "--seed") args.seed = Number(argv[++index]);
    else if (argument === "--repetitions") args.repetitions = Number(argv[++index]);
    else if (argument === "--busy-cores") args.busyCores = Number(argv[++index]);
    else if (argument === "--arms") args.arms = argv[++index].split(",");
    else if (argument === "--stream-steps") args.streamSteps = Number(argv[++index]);
    else if (argument === "--stream-token-rate") args.streamTokenRate = Number(argv[++index]);
    else if (argument === "--slowdown-ms") args.slowdownMs = Number(argv[++index]);
    else if (argument === "--fixture") args.fixture = argv[++index];
    else if (argument === "--output") args.output = argv[++index];
    else if (argument === "--skip-build") args.skipBuild = true;
    else if (argument === "--keep-fixture") args.keepFixture = true;
    else if (argument === "--stream-only") args.streamOnly = true;
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
  if (!args.arms.every((arm) => arm === "idle" || arm === "loaded")) {
    throw new Error("--arms accepts idle, loaded, or idle,loaded");
  }
  if (!Number.isInteger(args.streamSteps) || args.streamSteps < 2) {
    throw new Error("--stream-steps must be an integer >= 2");
  }
  if (!Number.isFinite(args.streamTokenRate) || args.streamTokenRate <= 0) {
    throw new Error("--stream-token-rate must be a positive number");
  }
  if (!Number.isFinite(args.slowdownMs) || args.slowdownMs < 0) {
    throw new Error("--slowdown-ms must be a non-negative number");
  }
  return args;
}

function usage() {
  return [
    "Usage: pnpm bench:desktop -- [options]",
    "",
    "  --preset small|real|2x    fixture scale (default: real)",
    "  --repetitions N           samples per interaction and load arm (default: 20)",
    "  --busy-cores N             loaded arm worker count (default: 2)",
    "  --arms idle,loaded         arms to run",
    "  --output DIR               write benchmark.json and benchmark.md here",
    "  --fixture DIR              reuse a generated fixture profile",
    "  --stream-token-rate N      scripted stream rate in tokens/s (default: 30)",
    "  --skip-build               use current built app and chat bench",
    "  --stream-only              run only the stream+scroll renderer bench",
    "  --slowdown-ms N            opt-in renderer slow path for sensitivity proof",
    "  --keep-fixture             keep generated fixture and run profiles",
    "",
    WARNING,
  ].join("\n");
}

function round(value) {
  return value === null ? null : Math.round(value * 1_000) / 1_000;
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

function aggregateInteraction(id, label, samples) {
  const frames = samples.flatMap((sample) => sample.frameTimesMs ?? []);
  const longTasks = samples.flatMap((sample) => sample.longTasksMs ?? []);
  const extra = {};
  for (const key of [
    "firstPaintMs",
    "openMs",
    "closeMs",
    "scrollDistancePx",
    "streamedCharacters",
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
        countPerSample: summarize(samples.map((sample) => sample.longTasksMs?.length ?? 0)),
        durationMs: summarize(longTasks),
      },
      ...extra,
    },
  };
}

function backgroundLoadGap(arms) {
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

async function startBusyLoad(count) {
  const workers = [];
  const progress = Array.from({ length: count }, () => ({
    ready: false,
    iterations: 0,
    checksum: 0,
  }));
  await Promise.all(
    Array.from(
      { length: count },
      (_value, index) =>
        new Promise((resolvePromise, reject) => {
          const worker = new Worker(new URL("./busy-worker.mjs", import.meta.url), {
            workerData: { index },
          });
          workers.push(worker);
          worker.on("message", (message) => {
            progress[index] = { ...progress[index], ...message };
            if (message.ready) resolvePromise();
          });
          worker.on("error", reject);
        }),
    ),
  );
  // Start measurements only after every worker has completed real work and a
  // warmup scheduling window has established the named load arm.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
  if (progress.some((entry) => entry.iterations === 0)) {
    await Promise.all(workers.map((worker) => worker.terminate()));
    throw new Error("busy-core load workers did not make progress during warmup");
  }
  const startedAt = performance.now();
  return {
    name: `${count}-busy-core`,
    workers: count,
    progress,
    async stop() {
      await Promise.all(workers.map((worker) => worker.terminate()));
      return {
        durationMs: round(performance.now() - startedAt),
        workers: count,
        progress,
      };
    },
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

async function waitForBoard(page, ticketCount, timeout = 60_000) {
  await page.getByRole("button", { name: "New ticket", exact: true }).waitFor({
    state: "visible",
    timeout,
  });
  await page.waitForFunction(
    (expected) => document.querySelectorAll("[data-board-ticket-slot]").length === expected,
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
    const responsiveness = await page.evaluate(async () => {
      const scroller = document.querySelector('[role="log"] > div');
      if (!(scroller instanceof HTMLElement)) return false;
      const before = scroller.scrollTop;
      const maximum = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const target = before > 0 ? Math.max(0, before - 16) : Math.min(maximum, 16);
      scroller.scrollTop = target;
      await new Promise((resolvePromise) => requestAnimationFrame(resolvePromise));
      await new Promise((resolvePromise) => requestAnimationFrame(resolvePromise));
      return maximum === 0 || Math.abs(scroller.scrollTop - target) < 1;
    });
    if (!responsiveness) throw new Error("long-chat scroller did not become interactive");
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
    droppedFrames: close.droppedFrames + open.droppedFrames,
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
  const row = page.getByText(targetTitle, { exact: true });
  await row.waitFor({ state: "visible", timeout: 30_000 });
  await row.click();
}

async function measureTicketSwitch(page, app, targetTitle, targetDisplayId) {
  return measured(
    page,
    app,
    () => selectTicketFromPalette(page, targetTitle, targetDisplayId),
    async () => {
      await tabStrip(page, TICKET_TAB_STRIP)
        .getByRole("tab", { name: targetDisplayId, exact: true })
        .waitFor({ state: "visible", timeout: 30_000 });
    },
  );
}

async function measureBoardRender(page, app, ticketCount) {
  return measured(
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
}

async function measureRpc(page, app, sessionId) {
  await startCapture(page);
  try {
    const rpc = await page.evaluate(async (id) => {
      const started = performance.now();
      const response = await window.api.sessionRpc.request({
        procedure: "session.projection",
        input: { sessionId: id },
      });
      return { response, latencyMs: performance.now() - started };
    }, sessionId);
    if (!rpc.response.ok) throw new Error(`RPC failed: ${JSON.stringify(rpc.response)}`);
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

async function fullAppIteration({ fixtureDirectory, runRoot, armName, index, manifest }) {
  const profile = join(runRoot, `${armName}-${String(index + 1).padStart(2, "0")}`);
  await cloneFixture(fixtureDirectory, profile);
  const errors = [];
  let app;
  let launchStarted;
  try {
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

    await openTicket(page, manifest.longChat.displayId);
    console.log("  measuring long chat");
    const longChat = await measureLongChat(page, app, "VC-353 long chat benchmark");
    console.log("  measuring new chat");
    const newChat = await measureNewChat(page, app, manifest.longChat.displayId);
    console.log("  measuring new terminal");
    const terminal = await measureNewTerminal(page, app, join(profile, "terminal-ready.txt"));
    console.log("  measuring sidebar");
    const sidebar = await measureSidebar(page, app);
    console.log("  preparing ticket switch");
    await selectTicketFromPalette(page, "Benchmark ticket 0001", manifest.longChat.displayId);
    await tabStrip(page, TICKET_TAB_STRIP)
      .getByRole("tab", { name: manifest.longChat.displayId, exact: true })
      .waitFor({ state: "visible", timeout: 30_000 });
    console.log("  measuring ticket switch");
    const switchDisplayId = `${manifest.projectPrefix}-2`;
    const ticketSwitch = await measureTicketSwitch(
      page,
      app,
      "Benchmark ticket 0002",
      switchDisplayId,
    );
    console.log("  measuring RPC");
    const rpc = await measureRpc(page, app, manifest.longChat.sessionId);
    console.log("  measuring board render");
    const board = await measureBoardRender(page, app, manifest.counts.tickets);
    return {
      samples: {
        cold_launch: cold,
        long_chat: longChat,
        new_chat: newChat,
        new_terminal: terminal,
        sidebar_toggle: sidebar,
        ticket_switch: ticketSwitch,
        board_render: board,
        rpc_round_trip: rpc,
      },
      rendererErrors: errors.slice(0, 20),
    };
  } finally {
    if (app !== undefined) await closeAppBounded(app).catch(() => null);
    if (process.env.VOLLI_PERF_KEEP_RUNS !== "1") {
      await fs.rm(profile, { recursive: true, force: true });
    }
  }
}

async function runChatBench({
  manifest,
  repetitions,
  streamSteps,
  streamTokenRate,
  slowdownMs,
  skipBuild,
  label,
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
      "--slowdown-ms",
      String(slowdownMs),
      "--label",
      label,
      ...(skipBuild ? ["--skip-build"] : []),
    ],
    { cwd: APP_DIR, env: { ELECTRON_DISABLE_SECURITY_WARNINGS: "1" } },
  );
  const match = /__BENCH__(?<json>.*)__BENCH__/s.exec(output);
  if (match?.groups?.json === undefined) throw new Error("chat window bench printed no report");
  const report = JSON.parse(match.groups.json);
  if (report.failure !== undefined) throw new Error(`chat window bench failed: ${report.failure}`);
  return report;
}

async function runArm({ args, fixtureDirectory, runRoot, manifest, loaded, chatBuilt }) {
  const load = loaded ? await startBusyLoad(args.busyCores) : null;
  const name = load?.name ?? "idle";
  console.log(`\n=== ${name} arm ===`);
  const byInteraction = Object.fromEntries(INTERACTIONS.map(([id]) => [id, []]));
  const rendererErrors = [];
  let armResult;
  try {
    if (!args.streamOnly) {
      for (let index = 0; index < args.repetitions; index += 1) {
        console.log(`full app sample ${index + 1}/${args.repetitions}`);
        const result = await fullAppIteration({
          fixtureDirectory,
          runRoot,
          armName: name,
          index,
          manifest,
        });
        for (const [id, sample] of Object.entries(result.samples)) byInteraction[id].push(sample);
        rendererErrors.push(...result.rendererErrors);
      }
    }
    console.log(`stream+scroll samples ${args.repetitions} × ${args.streamSteps} frames`);
    const chat = await runChatBench({
      manifest,
      repetitions: args.repetitions,
      streamSteps: args.streamSteps,
      streamTokenRate: args.streamTokenRate,
      slowdownMs: args.slowdownMs,
      skipBuild: chatBuilt.value,
      label: `${args.preset}-${name}`,
    });
    chatBuilt.value = true;
    if (chat.streamingSamples.some((sample) => sample.ok !== true)) {
      throw new Error(
        `stream+scroll bench returned a failed sample: ${JSON.stringify(chat.streamingSamples)}`,
      );
    }
    byInteraction.stream_scroll.push(...chat.streamingSamples);
    armResult = {
      name,
      busyCores: load?.workers ?? 0,
      streamTokenRate: args.streamTokenRate,
      streamContent: "live-prose-open-code-fence-close-prose",
      slowdownMs: args.slowdownMs,
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
  } finally {
    const loadSummary = await load?.stop();
    if (loadSummary !== undefined) {
      console.log(`stopped ${load.workers} busy workers`);
      if (armResult !== undefined) armResult.load = loadSummary;
    }
  }
  return armResult;
}

function markdown(report) {
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
      if (interaction.id === "sidebar_toggle") {
        lines.push(
          `| ${arm.name} | ↳ close / open | ${summary.closeMs?.p50 ?? "—"} / ${summary.openMs?.p50 ?? "—"} ms | ${summary.closeMs?.p95 ?? "—"} / ${summary.openMs?.p95 ?? "—"} ms | — | — | — | — | — |`,
        );
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
    `- \`interactive\` means all ${report.fixture.counts.tickets.toLocaleString()} board cards and the New ticket control are present after two animation frames. Long-chat first paint is the first visible transcript turn; interactive additionally requires a responsive transcript scroller.`,
    "- Frame loss uses a per-sample refresh interval (25th percentile of ordinary rAF deltas), not a hard-coded 60 Hz budget. Long tasks are Chromium `PerformanceObserver` `longtask` entries.",
    `- Streaming uses the existing real-\`ChatPlane\` Electron bench with the preset's long-transcript message count. It grows one assistant message under the production working/live lifecycle at ${report.config.streamTokenRate} tokens/s, traverses prose → an incrementally growing open TypeScript fence → a closed fence → prose, and moves the transcript scroller every animation frame in the same loop.`,
    "- The loaded arm is named `N-busy-core`: N Node worker threads run the fixed integer-mixing loop in `busy-worker.mjs` continuously from before Electron launch through the last sample; actual arm duration and worker checksums are recorded in JSON.",
    "- RSS is Electron `app.getAppMetrics()` renderer working-set size. RPC is the native tRPC `session.projection` request through the preload IPC bridge.",
    "",
    "Raw samples and complete host/fixture metadata are in the adjacent JSON report.",
    "",
  );
  return lines.join("\n");
}

async function writeReports(report, output) {
  const directory = resolve(output);
  await fs.mkdir(directory, { recursive: true });
  const jsonPath = join(directory, "benchmark.json");
  const markdownPath = join(directory, "benchmark.md");
  await Promise.all([
    fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`),
    fs.writeFile(markdownPath, markdown(report)),
  ]);
  return { jsonPath, markdownPath };
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
    schemaVersion: 1,
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
      busyCores: args.busyCores,
      streamSteps: args.streamSteps,
      streamTokenRate: args.streamTokenRate,
      streamContent: "live-prose-open-code-fence-close-prose",
      slowdownMs: args.slowdownMs,
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
    const defaultOutput = join(
      REPO,
      "performance-results",
      `${args.preset}-${new Date().toISOString().replaceAll(":", "-")}`,
    );
    const paths = await writeReports(report, args.output ?? defaultOutput);
    console.log(`\nJSON: ${paths.jsonPath}`);
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
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
