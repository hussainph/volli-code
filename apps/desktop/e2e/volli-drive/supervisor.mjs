#!/usr/bin/env node
/**
 * volli-drive supervisor: ONE per instance, detached from the CLI that
 * launched it. It owns the Playwright Electron connection, the loopback fake
 * provider and the instance's evidence, and answers CLI calls over
 * `<scratch>/drive.sock`, one at a time.
 *
 *   node supervisor.mjs <evidence>/spec.json
 *
 * It launches only through `assertLaunchable` (dev builds carrying the guard,
 * home containment and the shell recorder; packed apps are refused), and
 * stops the instance (keeping the evidence) the moment the live process does
 * not prove the guard active. It stops itself after `idleMs` without a
 * command. It only ever signals processes it can prove it started: the
 * Electron child by pid AND start time, that child's process group and its
 * descendants — never anything matched by name or path.
 */
import { appendFileSync, createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { spawn } from "node:child_process";
import {
  APP_DIR,
  ELECTRON,
  assertProfileIsolated,
  closeAppBounded,
  launch,
  launchEnvFor,
  pathExists,
  smokeExecutableFor,
  waitUntil,
  writeFakeLoginShell,
} from "../lib/smoke-kit.mjs";
import {
  HARNESS_CONTAINMENT_MARKER,
  HARNESS_GUARD_MARKER,
  HARNESS_RECORDER_SYMBOL,
  HARNESS_TRAP_SYMBOL,
  HARNESS_VIOLATION_EXIT_CODE,
  RECORDED_SHELL_METHODS,
  SAFE_STORAGE_METHODS,
  REPO,
  assertLaunchable,
  bundleCarriesGuard,
  createRegistry,
  electronExtraEnv,
  findInSnapshot,
  instanceLayout,
  killExactly,
  makeScratchRepo,
  ownedProcesses,
  processIdentity,
  processTable,
  readSnapshot,
  snapshotRefs,
} from "./lib/core.mjs";
import {
  CLOUD_LAUNCH_KEY,
  CLOUD_RUNNER_KEY,
  cleanQuitProblems,
  immediateQuit,
  cloudElectronEnv,
  cloudFixtureFromSupervisorEnv,
  completeDevSignIn,
  launchMarkerUser,
  observedChildExit,
  quitCloudLaunchFromTray,
  readAppState,
  recordedDevSignIn,
  recordedRunnerId,
} from "./lib/cloud-acceptance.mjs";
import { seedFixture } from "./lib/fixtures.mjs";
import {
  isCheckingPage,
  isUpdatingPage,
  seedDatabase,
  seedDatabaseProblems,
} from "./lib/seed-database.mjs";
import { serve } from "./lib/protocol.mjs";
import { quitNativeWindow, reopenNativeWindow } from "./lib/native-window-lifecycle.mjs";
import { settingsNative } from "./lib/settings-native.mjs";
import {
  assertAcceptanceRunner,
  acceptanceScript,
  acceptanceWorkspaceReady,
  prepareRemoteAcceptance,
} from "./lib/remote-acceptance.mjs";

import { guardedChatWindowBench } from "./lib/chat-window-bench.mjs";
import { stopResult } from "./lib/stop-result.mjs";
import { assertRestoreRestart } from "./lib/restore-acceptance.mjs";
import { deploymentElectronEnv, recordedWorkosSignIn } from "./lib/deployment.mjs";

const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));
const L = instanceLayout(spec.scratch, spec.evidence);
for (const dir of [
  L.userDataDir,
  L.home,
  L.piAgentDir,
  L.harnessDir,
  L.worktreeHome,
  L.projectsDir,
  L.binDir,
  L.zdotDir,
  L.logsDir,
  L.snapshotsDir,
  L.screenshotsDir,
]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
// The supervisor's own git (the fixture repo) reads no system or personal
// config either: a personal `commit.gpgsign` could otherwise reach an agent.
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = join(L.home, ".gitconfig");
process.env.HOME = L.home;
delete process.env.SSH_AUTH_SOCK;
delete process.env.SSH_AGENT_PID;

const registry = createRegistry(spec.driveHome);
const t0 = performance.now();
const timings = {};
const mark = (name) => (timings[name] = Math.round(performance.now() - t0));
const iso = () => new Date().toISOString();
const slog = (line) => appendFileSync(L.supervisorLog, `${iso()} ${line}\n`);
const transcript = (entry) =>
  appendFileSync(L.transcript, `${JSON.stringify({ at: iso(), ...entry })}\n`);

let app = null;
let mainPage = null;
let electronPid = null;
/** { pid, pgid, started }: the Electron child, as ps saw it at launch. */
let electronIdentity = null;
let electronExit = null;
/**
 * The exact ChildProcess of the Electron pid this supervisor launched,
 * captured at launch. Playwright disposes its dispatcher once that process
 * exits, so a cloud instance's quit is proven from this handle afterwards.
 */
let electronChild = null;
/** A cloud instance's last Tray quit and close record, kept for the manifest. */
let lastTrayQuit = null;
let lastCloudClose = null;
let provider = null;
let remoteFixture = null;
let server = null;
let seeded = null;
let stopping = false;
/** A supervised restart is closing Electron: that exit is expected, not the end of the run. */
let restarting = false;
let restarts = 0;
/** What Electron was launched with, reused unchanged by a supervised restart. */
let launchEnv = null;
/** The Volli Cloud fixture (`launch --cloud`), from the supervisor's environment only. */
const cloud = spec.cloud ? cloudFixtureFromSupervisorEnv(process.env) : null;
if (spec.cloud && cloud === null) throw new Error("a cloud instance needs the fixture env");
let generation = 0;
let captureCounter = 0;
let current = { generation: 0, window: null, refs: new Set() };
let shotCounter = 0;
let lastCommandAt = Date.now();
let idleTimer = null;

// ---- windows ---------------------------------------------------------------

async function windowsList() {
  if (!app) return [];
  const pages = app.windows();
  return Promise.all(
    pages.map(async (page, index) => ({
      index,
      name: page === mainPage ? "main" : `window-${index}`,
      title: await page.title().catch(() => ""),
      url: page.url(),
    })),
  );
}

async function pickWindow(name) {
  if (name === undefined || name === "main") {
    if (!mainPage || mainPage.isClosed()) throw new Error("the instance has no bound main window");
    return { page: mainPage, name: "main" };
  }
  const pages = app.windows();
  if (pages.length === 0) throw new Error("the instance has no open window");
  const list = await windowsList();
  const hit = list.find(
    (w) => w.name === name || w.title.toLowerCase().includes(String(name).toLowerCase()),
  );
  if (!hit) throw new Error(`no window "${name}" (have: ${list.map((w) => w.name).join(", ")})`);
  return { page: pages[hit.index], name: hit.name };
}

function wireWindow(page) {
  const index = () => app.windows().indexOf(page);
  const label = () => (page === mainPage ? "main" : `window-${index()}`);
  page.on("console", (message) =>
    appendFileSync(
      L.consoleLog,
      `${JSON.stringify({ at: iso(), window: label(), type: message.type(), text: message.text() })}\n`,
    ),
  );
  page.on("pageerror", (error) =>
    appendFileSync(
      L.consoleLog,
      `${JSON.stringify({ at: iso(), window: label(), type: "pageerror", text: String(error?.stack ?? error) })}\n`,
    ),
  );
}

// ---- snapshot / act ----------------------------------------------------------

async function snapshot({ window, depth, timeout, waitForText, gone } = {}) {
  const { page, name } = await pickWindow(window);
  // Even a rejected aria capture can replace Playwright's ref registry. Do not
  // leave the previous generation actionable if this capture fails.
  current = { generation, window: null, refs: new Set() };
  const capture = ++captureCounter;
  const { text, ...readiness } = await readSnapshot(page, {
    depth,
    timeout,
    waitForText,
    gone,
    onEmpty: (raw, timing) => {
      const path = join(L.snapshotsDir, `empty-${capture}-${timing.attempt}-${name}.txt`);
      writeFileSync(path, raw);
      transcript({
        cmd: "snapshot-empty",
        capture,
        window: name,
        path,
        url: page.url(),
        ...timing,
      });
    },
  });
  generation += 1;
  current = { generation, window: name, refs: snapshotRefs(text) };
  const path = join(L.snapshotsDir, `gen-${String(generation).padStart(4, "0")}-${name}.txt`);
  writeFileSync(path, text);
  transcript({ cmd: "snapshot-ready", capture, generation, window: name, path, ...readiness });
  return {
    generation,
    window: name,
    url: page.url(),
    title: await page.title(),
    path,
    text,
    readiness,
  };
}

const ACT_KINDS = new Set(["click", "type", "press", "select", "hover", "scroll", "wait"]);
const NEEDS_REF = new Set(["click", "type", "select", "hover"]);

async function act(args) {
  const { kind, ref, text, key, direction, window } = args;
  const gen = Number(args.gen);
  if (!ACT_KINDS.has(kind)) throw new Error(`unknown kind "${kind}" (${[...ACT_KINDS].join("|")})`);
  if (!Number.isInteger(gen))
    throw new Error("--gen is required: pass the generation of the snapshot that minted the ref");
  if (gen !== current.generation) {
    throw new Error(
      `stale generation ${gen}: the current snapshot is generation ${current.generation}. Take a fresh snapshot.`,
    );
  }
  if (NEEDS_REF.has(kind) && !ref) throw new Error(`${kind} needs --ref`);
  if (ref && !current.refs.has(ref)) {
    throw new Error(`ref ${ref} is not in generation ${gen}'s snapshot`);
  }
  const { page, name } = await pickWindow(window ?? current.window);
  if (name !== current.window)
    throw new Error(`generation ${gen} was taken of window ${current.window}, not ${name}`);
  const target = ref ? page.locator(`aria-ref=${ref}`) : null;
  const timeout = 10_000;
  // Motion evidence: consecutive compositor frames of this window from just
  // before the action until recordMs after it, never a screen capture.
  const recording = args.recordMs === undefined ? null : await startFrames(page, name);
  const started = performance.now();
  switch (kind) {
    case "click":
      await target.click({ timeout });
      break;
    case "type":
      if (text === undefined) throw new Error("type needs --text");
      try {
        await target.fill(text, { timeout });
      } catch {
        await target.click({ timeout });
        await page.keyboard.type(text);
      }
      break;
    case "press":
      if (!key) throw new Error("press needs --key (e.g. Enter, Escape, Meta+k)");
      if (target) await target.press(key, { timeout });
      else await page.keyboard.press(key);
      break;
    case "select":
      await target.selectOption(text ?? "", { timeout });
      break;
    case "hover":
      await target.hover({ timeout });
      break;
    case "scroll":
      if (target) await target.hover({ timeout });
      await page.mouse.wheel(0, direction === "up" ? -600 : 600);
      break;
    case "wait":
      await page.waitForTimeout(Math.min(Number(args.waitMs ?? 1000), 30_000));
      break;
  }
  const actionMs = Math.round(performance.now() - started);
  const frames =
    recording === null
      ? undefined
      : await recording.stop(Math.min(Math.max(Number(args.recordMs) || 0, 0), 5_000));
  // Let the renderer commit what the action caused before re-reading it.
  await page.waitForTimeout(Number(args.settleMs ?? 250));
  const fresh = await snapshot({ window: name });
  const result = {
    action: { kind, ref, key, text, direction, ms: actionMs },
    frames,
    snapshot: fresh,
  };
  transcript({
    cmd: "act",
    frames,
    gen,
    kind,
    ref,
    key,
    text,
    ms: actionMs,
    nextGeneration: fresh.generation,
  });
  return result;
}

/** Page.startScreencast frames, written as PNGs beside the screenshots. */
async function startFrames(page, windowName) {
  shotCounter += 1;
  const dir = join(
    L.screenshotsDir,
    `${String(shotCounter).padStart(3, "0")}-frames-${windowName}`,
  );
  mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const writes = [];
  const begin = performance.now();
  cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
    const at = Math.round(performance.now() - begin);
    const path = join(dir, `${String(writes.length).padStart(4, "0")}-${at}ms.png`);
    writes.push(fs.writeFile(path, Buffer.from(data, "base64")));
    void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  return {
    async stop(afterMs) {
      await page.waitForTimeout(afterMs);
      await cdp.send("Page.stopScreencast").catch(() => {});
      await Promise.all(writes);
      await cdp.detach().catch(() => {});
      return { dir, count: writes.length };
    },
  };
}

async function waitFor({ text, gone = false, timeout = 15_000, window }) {
  if (!text) throw new Error("wait needs --text");
  const started = performance.now();
  const fresh = await snapshot({ window, waitForText: text, gone, timeout: Number(timeout) });
  const ms = Math.round(performance.now() - started);
  transcript({ cmd: "wait", text, gone, ms, nextGeneration: fresh.generation });
  return { waitedMs: ms, snapshot: fresh };
}

async function screenshot({ name = "shot", window } = {}) {
  const { page, name: windowName } = await pickWindow(window);
  shotCounter += 1;
  const safe = String(name)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .slice(0, 60);
  const path = join(L.screenshotsDir, `${String(shotCounter).padStart(3, "0")}-${safe}.png`);
  const started = performance.now();
  await page.screenshot({ path });
  const ms = Math.round(performance.now() - started);
  transcript({ cmd: "screenshot", path, window: windowName, ms });
  return { path, ms };
}

// ---- doctor / metrics --------------------------------------------------------

async function memory() {
  if (!app) return null;
  const metrics = await app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((m) => ({
      pid: m.pid,
      type: m.type,
      workingSetKb: m.memory.workingSetSize,
      peakKb: m.memory.peakWorkingSetSize,
    })),
  );
  const totalMb = Math.round(metrics.reduce((sum, m) => sum + m.workingSetKb, 0) / 1024);
  return { totalMb, processes: metrics };
}

async function liveGuard() {
  return app.evaluate(
    (
      { safeStorage, shell, app: electronApp },
      { methods, symbol, shellMethods, recorderSymbol },
    ) => {
      const trap = Symbol.for(symbol);
      const recorder = Symbol.for(recorderSymbol);
      return {
        pid: process.pid,
        harnessEnv: process.env.VOLLI_HARNESS ?? null,
        // Reads each property; never calls one.
        trapped: Object.fromEntries(
          methods.map((m) => [
            m,
            typeof safeStorage[m] === "function" && safeStorage[m][trap] === true,
          ]),
        ),
        // Reads each property; never calls one.
        recorded: Object.fromEntries(
          shellMethods.map((m) => [
            m,
            typeof shell[m] === "function" && shell[m][recorder] === true,
          ]),
        ),
        mockKeychainSwitch: electronApp.commandLine.hasSwitch("use-mock-keychain"),
        passwordStore: electronApp.commandLine.getSwitchValue("password-store"),
        userData: electronApp.getPath("userData"),
        // Node's and the app's own idea of home ($HOME). Electron's
        // getPath("home") ignores $HOME on macOS; harness mode never reads
        // it — the guard record's contained agentHome is what the app uses.
        home: process.env.HOME ?? null,
        electronHome: electronApp.getPath("home"),
        isPackaged: electronApp.isPackaged,
      };
    },
    {
      methods: SAFE_STORAGE_METHODS,
      symbol: HARNESS_TRAP_SYMBOL,
      shellMethods: RECORDED_SHELL_METHODS,
      recorderSymbol: HARNESS_RECORDER_SYMBOL,
    },
  );
}

/** Emulate only the browser media preference, never app stores or macOS settings. */
async function configureMotionPreference(page) {
  if (spec.reducedMotion === true) await page.emulateMedia({ reducedMotion: "reduce" });
}

/** Read the live renderer preference rather than trusting the requested option. */
async function motionPreference() {
  return {
    forced: spec.reducedMotion === true,
    matches: await mainPage.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches),
  };
}

async function readGuardRecord() {
  try {
    return JSON.parse(await fs.readFile(join(L.harnessDir, "harness-guard.json"), "utf8"));
  } catch {
    return null;
  }
}

async function violations() {
  const text = await fs
    .readFile(join(L.harnessDir, "keychain-violations.jsonl"), "utf8")
    .catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).method);
}

/** Every path the guard and the app report must be inside our scratch tree. */
async function doctor() {
  const problems = [];
  const alive = electronPid !== null && electronExit === null;
  if (!alive) problems.push("the Electron process is not running");
  const record = await readGuardRecord();
  const live = alive ? await liveGuard().catch((e) => ({ error: e.message })) : null;
  const trappedAll = live?.trapped ? Object.values(live.trapped).every(Boolean) : false;
  const realScratch = await fs.realpath(L.scratch);
  const inside = async (path) => {
    const real = await fs.realpath(path).catch(() => path);
    return real === realScratch || real.startsWith(`${realScratch}/`);
  };
  if (!record) problems.push("no harness-guard.json: the guard never announced itself");
  if (record && record.marker !== HARNESS_GUARD_MARKER)
    problems.push("guard record has the wrong marker");
  if (record && record.pid !== electronPid)
    problems.push(`guard record pid ${record.pid} ≠ Electron pid ${electronPid}`);
  if (alive && !trappedAll) problems.push("live safeStorage is not fully trapped");
  const recordedAll = live?.recorded ? Object.values(live.recorded).every(Boolean) : false;
  if (alive && !recordedAll) problems.push("live shell.openExternal & co. are not all recorders");
  if (record && record.containment?.marker !== HARNESS_CONTAINMENT_MARKER)
    problems.push("guard record has no home containment");
  if (alive && live?.harnessEnv !== "1")
    problems.push("VOLLI_HARNESS is not 1 in the live process");
  if (alive && !live?.mockKeychainSwitch) problems.push("--use-mock-keychain is missing");
  if (alive && live?.passwordStore !== "basic") problems.push("--password-store is not basic");
  const violated = await violations();
  if (violated.length > 0) problems.push(`keychain violations: ${violated.join(", ")}`);
  const socketStat = await fs.stat(L.appSocket).catch(() => null);
  const isolation = {
    scratch: realScratch,
    userData: live?.userData ?? null,
    userDataInside: live?.userData ? await inside(live.userData) : null,
    home: live?.home ?? null,
    homeInside: live?.home ? await inside(live.home) : null,
    agentHome: record?.containment?.agentHome ?? null,
    agentHomeInside: record?.containment?.agentHome
      ? await inside(record.containment.agentHome)
      : false,
    externalRequests: (
      await fs.readFile(join(L.harnessDir, "external-requests.jsonl"), "utf8").catch(() => "")
    )
      .split("\n")
      .filter(Boolean).length,
    db: L.dbPath,
    dbInside: await inside(L.dbPath),
    appSocket: L.appSocket,
    appSocketOwned: socketStat
      ? socketStat.isSocket() && socketStat.uid === process.getuid()
      : false,
    appSocketInside: await inside(L.appSocket),
    driveSocket: L.driveSocket,
    providerUrl: provider?.url ?? null,
  };
  for (const key of [
    "userDataInside",
    "homeInside",
    "agentHomeInside",
    "dbInside",
    "appSocketInside",
  ]) {
    if (isolation[key] === false)
      problems.push(`${key.replace("Inside", "")} is outside the scratch tree`);
  }
  if (alive && !isolation.appSocketOwned) problems.push("the app socket is missing or not ours");
  const reducedMotion = await motionPreference().catch((error) => ({
    forced: spec.reducedMotion === true,
    matches: null,
    error: error.message,
  }));
  if (alive && reducedMotion.forced && reducedMotion.matches !== true)
    problems.push("forced reduced motion is not active in the live renderer");
  return {
    id: spec.id,
    ok: problems.length === 0,
    problems,
    supervisorPid: process.pid,
    electron: { pid: electronPid, alive, exit: electronExit },
    build: {
      kind: spec.build,
      commit: spec.commit,
      dirty: spec.dirty,
      bundle: spec.bundle,
      bundleCarriesGuard: bundleCarriesGuard(spec.bundle),
      isPackaged: live?.isPackaged ?? null,
    },
    guard: {
      active: Boolean(record) && trappedAll && recordedAll && violated.length === 0,
      record,
      live,
      violations: violated,
    },
    isolation,
    reducedMotion,
    model: seeded?.model ?? null,
    windows: await windowsList(),
    memory: alive ? await memory().catch(() => null) : null,
    idle: { lastCommandAt: new Date(lastCommandAt).toISOString(), idleMs: spec.idleMs },
    evidence: L.evidence,
  };
}

// ---- stop --------------------------------------------------------------------

/**
 * The instance's processes by identity ({pid, pgid, started}), recorded as
 * they appear: Electron, its group while it leads it, its tree, and every
 * still-running process recorded before. Kept in the registry so `stop` can
 * reap an orphaned helper by its OWN identity after Electron is gone, never
 * by the group number it once had.
 */
let members = [];

/** Everything we can prove we started: Electron, its group and tree, and recorded members. */
async function owned() {
  if (!electronIdentity) return [];
  return ownedProcesses(await processTable(), [electronIdentity, ...members]);
}

async function recordMembers() {
  if (!electronIdentity || stopping) return;
  const rows = await owned().catch(() => null);
  if (!rows) return;
  members = rows.map(({ pid, pgid, started }) => ({ pid, pgid, started }));
  await registry.update(spec.id, { members }).catch(() => {});
}

async function finalize(reason, { keepScratch = false } = {}) {
  if (stopping) return null;
  stopping = true;
  clearTimeout(idleTimer);
  slog(`stopping: ${reason}`);
  // Seen BEFORE close: once Electron exits its children are reparented, and
  // only this snapshot still ties them to us.
  const before = await owned().catch(() => []);
  let close = null;
  let trayQuit = null;
  if (spec.cloud || spec.deployment) {
    // A cloud launch stays resident on an ordinary quit: it quits for real,
    // the person's way (closeCloudInstance). One that already quit (a
    // restart's quit, then a failure) keeps that quit's record, proven again
    // from the exact child handle.
    if (app && electronExit === null) {
      const closed = await closeCloudInstance().catch((error) => ({
        trayQuit: lastTrayQuit,
        close: { kind: "error", error: error.message },
      }));
      trayQuit = closed.trayQuit;
      close = closed.close;
    } else if (electronExit !== null) {
      trayQuit = lastTrayQuit;
      try {
        close = observedChildExit(electronChild, electronPid) ?? lastCloudClose;
      } catch (error) {
        close = { kind: "error", error: error.message };
      }
    }
  } else if (app && electronExit === null) {
    close = await closeAppBounded(app).catch((error) => ({ kind: "error", error: error.message }));
  }
  let remoteCleanupError = null;
  await remoteFixture?.stop?.().catch((error) => {
    remoteCleanupError = error.message;
  });
  await provider?.close?.().catch(() => {});
  const after = await owned().catch(() => []);
  const targets = [...new Map([...before, ...after].map((p) => [p.pid, p])).values()];
  const leftovers = await killExactly(targets, { signal: "SIGKILL", graceMs: 2_000 }).catch(
    () => [],
  );
  // Keep the guard's own record and any violation beside the evidence.
  await fs.mkdir(join(L.evidence, "harness"), { recursive: true });
  for (const file of [
    "harness-guard.json",
    "keychain-violations.jsonl",
    "external-requests.jsonl",
  ]) {
    await fs.copyFile(join(L.harnessDir, file), join(L.evidence, "harness", file)).catch(() => {});
  }
  const violated = await violations();
  const manifest = {
    id: spec.id,
    reason,
    spec: { ...spec },
    timings,
    seeded,
    electron: { pid: electronPid, exit: electronExit, close, trayQuit },
    keychainViolations: violated,
    remoteCleanupError,
    keychainViolationExit: electronExit?.code === HARNESS_VIOLATION_EXIT_CODE,
    leftovers,
    scratchRemoved: !keepScratch,
    stoppedAt: iso(),
  };
  writeFileSync(L.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  transcript({ cmd: "stop", reason });
  server?.close();
  if (!keepScratch) await fs.rm(L.scratch, { recursive: true, force: true });
  await registry.remove(spec.id).catch(() => {});
  return manifest;
}

function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    await finalize(`idle for ${Math.round(spec.idleMs / 60000)} min`);
    process.exit(0);
  }, spec.idleMs);
  idleTimer.unref?.();
}

// ---- launch -------------------------------------------------------------------

async function prepareEnvironment() {
  await fs.writeFile(
    join(L.home, ".gitconfig"),
    "[user]\n\tname = Volli Drive\n\temail = drive@volli.test\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n",
  );
  await fs.writeFile(join(L.zdotDir, ".zshrc"), "# volli-drive scratch zshrc: leaves PATH alone\n");
  // `gh` reads its token from the keychain on macOS. The instance gets a gh
  // that refuses, first on PATH, so nothing the app spawns can reach it.
  const gh = join(L.binDir, "gh");
  await fs.writeFile(
    gh,
    "#!/bin/sh\necho 'gh is disabled inside volli-drive instances' >&2\nexit 1\n",
    {
      mode: 0o755,
    },
  );
  const path = `${L.binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`;
  const loginShell = await writeFakeLoginShell(L.binDir, path);
  return { path, loginShell };
}

async function boot() {
  slog(
    `supervisor ${process.pid} booting ${spec.id} (${spec.build}, fixture ${spec.fixture}, model ${spec.model})`,
  );
  // The one gate, checked again here: the supervisor can be started by hand.
  assertLaunchable(spec);
  if (spec.remoteAcceptance) assertAcceptanceRunner();
  if (spec.model === "fake") {
    const { startFakeProvider } = await import("./lib/fake-provider.mjs");
    const replies = spec.fakeScript?.slice();
    provider = await startFakeProvider({
      ...(spec.remoteAcceptance
        ? { script: acceptanceScript }
        : replies === undefined
          ? {}
          : {
              // Tool-free refinements such as auto-title must not consume a scripted
              // agent turn. With --fake-tool-free-text they answer that fixed text;
              // an absent spec field leaves undefined, so the default echo stands.
              script: (turn) =>
                Array.isArray(turn.body.tools) && turn.body.tools.length > 0
                  ? replies.shift()
                  : spec.fakeToolFreeText,
            }),
      log: (record) => slog(`[fake-provider] ${JSON.stringify(record)}`),
    });
    slog(`fake provider at ${provider.url} (${provider.providerId}/${provider.modelId})`);
  }
  mark("providerReady");
  const { path, loginShell } = await prepareEnvironment();
  if (spec.remoteAcceptance) remoteFixture = await prepareRemoteAcceptance(L, provider);
  const extraEnv = {
    ...electronExtraEnv(L, { loginShell, path, providerEnv: provider?.env ?? {} }),
    ...(spec.remoteAcceptance
      ? {
          VOLLI_EXPERIMENTAL: "cloud",
          VOLLI_HOSTD_DEV_TARBALLS: spec.remoteAcceptance.tarballs,
        }
      : {}),
    ...(cloud ? cloudElectronEnv(cloud, spec.cloud.subject, spec.cloud.email) : {}),
    ...(spec.deployment ? deploymentElectronEnv(spec.deployment) : {}),
  };
  if (spec.database) {
    // A real-sized profile to upgrade (VC-1105): cloned in before the first
    // launch, so the app's own open is what upgrades it.
    const problems = await seedDatabaseProblems(spec.database);
    if (problems.length > 0) throw new Error(problems.join("; "));
    await seedDatabase(spec.database, L.dbPath);
    mark("databaseSeeded");
    slog(`database seeded from ${spec.database}`);
  }
  mark("launchStart");
  launchEnv = extraEnv;
  const { page, live, record } = await startElectron(extraEnv);
  mark("guardVerified");
  slog(`guard verified: ${Object.keys(live.trapped).length} methods trapped, pid ${electronPid}`);

  seeded = await seedFixture(
    page,
    spec.fixture,
    L,
    provider
      ? {
          providerId: provider.providerId,
          modelId: provider.modelId,
          reasoningLevel: provider.reasoningLevel,
        }
      : null,
    {
      flushClientState: () =>
        app.evaluate(async ({ BrowserWindow, ipcMain }) => {
          const window = BrowserWindow.getAllWindows().find((candidate) =>
            candidate.webContents.getURL().startsWith("volli-app:"),
          );
          if (!window) throw new Error("fixture window disappeared before flush");
          const requestId = `drive-fixture-${Date.now()}`;
          await new Promise((resolveFlush, rejectFlush) => {
            const cleanup = () => {
              clearTimeout(timer);
              ipcMain.removeListener("volli:client-state-flushed", acked);
            };
            const acked = (event, id) => {
              if (event.sender.id !== window.webContents.id || id !== requestId) return;
              cleanup();
              resolveFlush();
            };
            const timer = setTimeout(() => {
              cleanup();
              rejectFlush(new Error("fixture client-state flush timed out"));
            }, 10000);
            ipcMain.on("volli:client-state-flushed", acked);
            window.webContents.send("volli:client-state-flush", requestId);
          });
        }),
    },
  );
  mark("fixtureSeeded");
  await waitUntil("the app's agent socket", () => pathExists(L.appSocket), { timeout: 30_000 });
  mark("ready");
  const mem = await memory().catch(() => null);
  server = await serve(L.driveSocket, handle);
  const ready = {
    id: spec.id,
    electronPid,
    supervisorPid: process.pid,
    timings,
    memory: mem,
    seeded,
    cloud: spec.cloud ?? null,
    deployment: spec.deployment ?? null,
    reducedMotion: await motionPreference(),
    guard: { trapped: Object.keys(live.trapped), switches: record.chromiumSwitches },
  };
  await recordMembers();
  setInterval(() => void recordMembers(), 10_000).unref();
  writeFileSync(L.readyFile, `${JSON.stringify(ready, null, 2)}\n`);
  transcript({ cmd: "launch", timings, memoryMb: mem?.totalMb });
  armIdle();
}

/**
 * Starts Electron on this instance's scratch tree and proves the guard in the
 * live process; the first launch and every supervised restart come through
 * here, with the same environment, profile, database and harness directory.
 */
/**
 * Launches Electron. With `databasePage` (VC-1208's quit-during-launch) it
 * returns as soon as the launch shows that database page (`check` or
 * `upgrade`), undriven and before the guard is proved; the launch after it
 * proves the guard as every launch does.
 */
async function startElectron(extraEnv, { databasePage } = {}) {
  // Quit evidence belongs to one launch, never the process that replaces it.
  lastTrayQuit = null;
  lastCloudClose = null;
  // Re-checked at the call: nothing between the gate above and here may have
  // pointed smoke-kit at a packed app.
  assertLaunchable(spec);
  app = await launch({
    dbPath: L.dbPath,
    userDataDir: L.userDataDir,
    extraEnv,
    // Also from argv, so they hold before main's own appendSwitch runs.
    extraArgs: ["--use-mock-keychain", "--password-store=basic"],
  });
  const child = app.process();
  electronChild = child;
  electronPid = child.pid;
  electronIdentity = await processIdentity(electronPid).catch(() => null);
  await registry.update(spec.id, { electronPid, electron: electronIdentity }).catch(() => {});
  child.stdout?.on("data", (chunk) => appendFileSync(L.mainLog, chunk));
  child.stderr?.on("data", (chunk) => appendFileSync(L.mainLog, chunk));
  child.on("exit", (code, signal) => {
    electronExit = { code, signal, at: iso() };
    slog(`electron exited code=${code} signal=${signal}`);
    if (code === HARNESS_VIOLATION_EXIT_CODE) slog("KEYCHAIN GUARD FAILED THE RUN (exit 86)");
    // A violation always ends the run, restart or not.
    if (restarting && code !== HARNESS_VIOLATION_EXIT_CODE) return;
    if (!stopping) {
      void finalize(
        code === HARNESS_VIOLATION_EXIT_CODE ? "keychain-violation" : "electron-exited",
        {
          keepScratch: true,
        },
      ).then(() => process.exit(1));
    }
  });
  if (databasePage !== undefined) {
    const shown = await app.firstWindow({ timeout: 240_000 });
    await shown.waitForURL(
      (url) => (databasePage === "check" ? isCheckingPage(url.href) : isUpdatingPage(url.href)),
      { timeout: 240_000 },
    );
    await shown.getByRole("status").waitFor({ timeout: 30_000 });
    return { page: shown, live: null, record: null };
  }
  app.on("window", wireWindow);
  const page = await firstAppWindow();
  mainPage = page;
  wireWindow(page);
  await page.waitForLoadState("domcontentloaded");
  mark("firstWindow");

  await assertProfileIsolated(app, L.userDataDir);
  const live = await liveGuard();
  const record = await readGuardRecord();
  const trappedAll = Object.values(live.trapped).every(Boolean);
  const recordedAll = Object.values(live.recorded).every(Boolean);
  if (
    !trappedAll ||
    !recordedAll ||
    record?.pid !== electronPid ||
    live.harnessEnv !== "1" ||
    record?.containment?.marker !== HARNESS_CONTAINMENT_MARKER
  ) {
    throw new Error(
      `harness guard NOT proven active in the live process: ${JSON.stringify({ trapped: live.trapped, recorded: live.recorded, containment: record?.containment ?? null, recordPid: record?.pid, electronPid })}`,
    );
  }
  await configureMotionPreference(page);
  if (spec.reducedMotion === true && !(await motionPreference()).matches)
    throw new Error("forced reduced motion is not active in the live renderer");
  return { page, live, record };
}

/**
 * The app's own first window. A launch that upgrades its database shows the
 * upgrade window first (VC-1105): that one is captured as evidence, with when
 * it appeared and closed, and never driven. A long routine check opens the
 * app's window on its check page (VC-1203): captured the same way, and the
 * window is the app's once the app has loaded into it.
 */
async function firstAppWindow() {
  const seen = new Set();
  for (;;) {
    for (const page of app.windows()) {
      if (seen.has(page)) continue;
      try {
        await page.waitForLoadState("domcontentloaded");
        if (isCheckingPage(page.url())) {
          await captureCheckingWindow(page);
          await page.waitForURL((url) => !isCheckingPage(url.href), {
            waitUntil: "domcontentloaded",
            timeout: 240_000,
          });
          mark("checkingWindowLoadedApp");
        }
      } catch {
        seen.add(page);
        continue;
      }
      if (!isUpdatingPage(page.url())) return page;
      seen.add(page);
      await captureUpdatingWindow(page);
    }
    await app.waitForEvent("window", { timeout: 240_000 });
  }
}

async function captureCheckingWindow(page) {
  mark("checkingWindowShown");
  try {
    await page.getByRole("status").waitFor({ timeout: 10_000 });
    const path = join(L.screenshotsDir, "000-checking-window.png");
    await page.screenshot({ path });
    // The native edge it was built with: what the window paints around and
    // under the page, which a page screenshot does not show.
    const native = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes("work=check"),
      );
      return window === undefined
        ? null
        : {
            background: window.getBackgroundColor(),
            bounds: window.getBounds(),
            mediaSourceId: window.getMediaSourceId(),
          };
    });
    transcript({
      cmd: "checking-window",
      event: "shown",
      path,
      text: await page.innerText("body"),
      native,
    });
  } catch (error) {
    transcript({ cmd: "checking-window", event: "capture-failed", error: String(error) });
  }
}

async function captureUpdatingWindow(page) {
  mark("updatingWindowShown");
  page.once("close", () => {
    mark("updatingWindowClosed");
    transcript({ cmd: "updating-window", event: "closed" });
  });
  try {
    await page.getByRole("status").waitFor({ timeout: 10_000 });
    const path = join(L.screenshotsDir, "000-updating-window.png");
    await page.screenshot({ path });
    transcript({
      cmd: "updating-window",
      event: "shown",
      path,
      text: await page.innerText("body"),
    });
  } catch (error) {
    transcript({ cmd: "updating-window", event: "capture-failed", error: String(error) });
  }
}

/**
 * A supervised restart (Volli Cloud journeys): what the app's "Restart to
 * open Volli Cloud" does, without `app.relaunch()`, which under the harness
 * would start an Electron nobody drives. Electron closes through its normal
 * quit path, then this supervisor starts it again on the SAME scratch tree,
 * profile, database, harness keys and environment, and proves the guard
 * again. The drive socket, fake provider and evidence carry on.
 */
async function restart(reason) {
  requireCloudLaunch();
  // Through the Tray's Quit Volli, as a person would (a cloud launch stays
  // resident on an ordinary quit), proven from the exact child handle.
  return restartElectron(reason, async () => await closeCloudInstance());
}

/**
 * A routine relaunch of a local instance (VC-1203): the app's ordinary quit,
 * then the same restart on the same profile and database.
 */
async function relaunch() {
  if (spec.cloud || spec.deployment) throw new Error("relaunch is local; use restart");
  return restartElectron("relaunch", closeLocalInstance);
}

/**
 * VC-1208: a relaunch that quits while the launch's database work runs, then
 * launches again normally. `work` is the page to quit on: `check` (a routine
 * launch's check) or `upgrade` (`database`, an absolute path to a closed
 * older copy, is cloned in first so the launch has one to run). With
 * `secondLaunch`, a second Electron starts on the same profile while an
 * upgrade's quit waits, and the waiting window must come forward.
 *
 * The quitting launch is never driven and its guard is not re-proved: it is
 * the same bundle and environment, and quits on the database page. The
 * launch after it is the ordinary one, guard and all.
 */
async function quitDuringLaunch(args) {
  const work = args.work === "upgrade" ? "upgrade" : "check";
  if (spec.cloud || spec.deployment) throw new Error("quit-during-launch is local");
  if (restarting) throw new Error("a restart is already running");
  restarting = true;
  try {
    const logFrom = mainLogSize();
    const { close } = await closeLocalInstance();
    if (
      !immediateQuit(close, mainLogSince(logFrom), { userDataDir: L.userDataDir }) &&
      cleanQuitProblems(close).length > 0
    )
      throw new Error(`Electron did not quit cleanly first: ${JSON.stringify(close)}`);
    await waitUntil(
      "the quit Electron's processes to exit",
      async () => (await owned()).length === 0,
      {
        timeout: 10_000,
        interval: 200,
      },
    );
    await fs.rm(L.appSocket, { force: true });
    if (work === "upgrade") {
      const problems = await seedDatabaseProblems(args.database);
      if (problems.length > 0) throw new Error(problems.join("; "));
      for (const suffix of ["", "-wal", "-shm"])
        await fs.rm(`${L.dbPath}${suffix}`, { force: true });
      await seedDatabase(args.database, L.dbPath);
    }
    // The closed database file before the launch, to compare after its exit.
    const dbBefore = work === "check" ? await databaseFileState(L.dbPath) : null;
    electronExit = null;
    mainPage = null;
    const launchStarted = performance.now();
    const { page } = await startElectron(launchEnv, { databasePage: work });
    const exited = new Promise((done) =>
      electronChild.once("exit", (code, signal) => done({ code, signal })),
    );
    const windowMs = Math.round(performance.now() - launchStarted);
    const quitLogFrom = mainLogSize();
    const asked = performance.now();
    // The process may be gone before Playwright hears back: that is the answer, not a fault.
    await app
      .evaluate(({ app: electronApp }) => setTimeout(() => electronApp.quit(), 0))
      .catch((error) => slog(`quit asked; no reply (${error.message})`));
    let second = null;
    if (work === "upgrade") {
      await page
        .getByRole("status")
        .getByText("Updating your data before quitting", { exact: true })
        .waitFor({ timeout: 30_000 });
      await page
        .screenshot({ path: join(L.screenshotsDir, "000-quit-waits-for-upgrade.png") })
        .catch((error) => slog(`quit-wait screenshot failed (${error.message})`));
      if (args.secondLaunch === true) second = await secondLaunchDuringWait();
    }
    const exit = await exited;
    const quitMs = Math.round(performance.now() - asked);
    const dbAfter = work === "check" ? await databaseFileState(L.dbPath) : null;
    const log = mainLogSince(quitLogFrom);
    const mode = /\[quit\] exit call \{[^}]*mode: '(\w+)'/s.exec(log)?.[1] ?? null;
    const database =
      dbBefore === null
        ? null
        : {
            before: dbBefore,
            after: dbAfter,
            unchanged: JSON.stringify(dbBefore) === JSON.stringify(dbAfter),
          };
    transcript({ cmd: "quit-during-launch", work, windowMs, quitMs, exit, mode, second, database });
    slog(
      `quit during ${work}: process gone ${quitMs} ms after the quit (${mode ?? "no exit line"})`,
    );
    // The launch after it: the ordinary one, guard re-proved.
    electronExit = null;
    mainPage = null;
    current = { generation: ++generation, window: null, refs: new Set() };
    for (const key of ["checkingWindowShown", "checkingWindowLoadedApp", "firstWindow"])
      delete timings[key];
    await fs.rm(L.appSocket, { force: true });
    const { live } = await startElectron(launchEnv);
    await waitUntil("the app's agent socket", () => pathExists(L.appSocket), { timeout: 30_000 });
    restarts += 1;
    await recordMembers();
    return {
      work,
      windowMs,
      quitMs,
      exit,
      mode,
      second,
      database,
      guard: Object.keys(live.trapped).length,
    };
  } finally {
    restarting = false;
  }
}

/** A database file's digest, size and stamp, and its WAL's size. */
async function databaseFileState(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const info = await fs.stat(path);
  const wal = await fs.stat(`${path}-wal`).catch(() => null);
  return {
    sha256: hash.digest("hex"),
    size: info.size,
    mtimeMs: info.mtimeMs,
    walBytes: wal?.size ?? 0,
  };
}

/** A second launch on this profile while the quit waits: the waiting window must come forward. */
async function secondLaunchDuringWait() {
  const id = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.hide();
    return window?.id ?? null;
  });
  const environment = launchEnvFor(L.dbPath, launchEnv);
  const started = performance.now();
  const child = spawn(
    smokeExecutableFor(ELECTRON, L.userDataDir, { environment }),
    [APP_DIR, `--user-data-dir=${L.userDataDir}`, "--use-mock-keychain", "--password-store=basic"],
    { env: environment, stdio: "ignore" },
  );
  const exited = new Promise((done) => child.once("exit", (code) => done(code)));
  await waitUntil(
    "the waiting window shown again",
    () =>
      app.evaluate(
        ({ BrowserWindow }, windowId) => BrowserWindow.fromId(windowId)?.isVisible() === true,
        id,
      ),
    { timeout: 60_000, interval: 100 },
  );
  const shownMs = Math.round(performance.now() - started);
  const code = await exited;
  return { shownMs, exitCode: code };
}

/** The Electron main log's size now, to read only what a quit writes after it. */
function mainLogSize() {
  try {
    return readFileSync(L.mainLog).length;
  } catch {
    return 0;
  }
}

function mainLogSince(offset) {
  try {
    return readFileSync(L.mainLog).subarray(offset).toString("utf8");
  } catch {
    return "";
  }
}

async function restartElectron(reason, closeInstance) {
  if (restarting) throw new Error("a restart is already running");
  restarting = true;
  const started = performance.now();
  try {
    const logFrom = mainLogSize();
    const { trayQuit, close } = await closeInstance();
    const quitMs = Math.round(performance.now() - started);
    // The app may end itself at once when only read-only workers are left (VC-1208).
    const immediate = immediateQuit(close, mainLogSince(logFrom), { userDataDir: L.userDataDir });
    const unclean = immediate ? [] : cleanQuitProblems(close);
    if (unclean.length > 0) {
      throw new Error(
        `Electron did not quit cleanly before the restart (${unclean.join("; ")}): ${JSON.stringify({ close, trayQuit })}`,
      );
    }
    if (electronExit?.code === HARNESS_VIOLATION_EXIT_CODE) throw new Error("keychain violation");
    // A clean quit takes its helpers with it. Nothing is signalled here: a
    // process that outlives the quit fails the restart, and `stop` reaps it
    // by identity and reports it as a leftover.
    let outlived = [];
    try {
      await waitUntil(
        "the quit Electron's processes to exit",
        async () => {
          outlived = await owned();
          return outlived.length === 0;
        },
        { timeout: 10_000, interval: 200 },
      );
    } catch (error) {
      // An unreadable process table is not proof that every helper exited.
      throw new Error(
        `processes outlived the quit before the restart, or could not be inspected: ${JSON.stringify(outlived.map((row) => ({ pid: row.pid, started: row.started })))}`,
        { cause: error },
      );
    }
    await fs.rm(L.appSocket, { force: true });
    electronExit = null;
    mainPage = null;
    current = { generation: ++generation, window: null, refs: new Set() };
    // This launch's own window marks, from its start (VC-1203).
    for (const key of ["checkingWindowShown", "checkingWindowLoadedApp", "firstWindow"])
      delete timings[key];
    const launchStart = Math.round(performance.now() - t0);
    const { live } = await startElectron(launchEnv);
    await waitUntil("the app's agent socket", () => pathExists(L.appSocket), { timeout: 30_000 });
    restarts += 1;
    const ms = Math.round(performance.now() - started);
    const windows = Object.fromEntries(
      ["checkingWindowShown", "checkingWindowLoadedApp", "firstWindow"]
        .filter((key) => timings[key] !== undefined)
        .map((key) => [key, timings[key] - launchStart]),
    );
    slog(`restart ${restarts} (${reason}): pid ${electronPid}, guard re-verified`);
    transcript({
      cmd: "restart",
      reason,
      restarts,
      electronPid,
      ms,
      quitMs,
      close: immediate ? "immediate" : close.kind,
      windows,
    });
    await recordMembers();
    return {
      restarts,
      electronPid,
      ms,
      quitMs,
      close: immediate ? "immediate" : close.kind,
      windows,
      guard: Object.keys(live.trapped).length,
    };
  } finally {
    restarting = false;
  }
}

/** Local restore proof: record ONLY Electron's native relaunch boundary. The real
 * button, handler, quit gates and durable restore intent run unmodified. */
async function restoreRestart(args) {
  assertRestoreRestart(spec, current, args);
  if (restarting) throw new Error("a restart is already running");
  const { page } = await pickWindow(current.window);
  const target = page.locator(`aria-ref=${args.ref}`);
  assertRestoreRestart(spec, current, args, await target.innerText());
  const recorder = join(L.harnessDir, "restore-relaunch.json");
  await fs.rm(recorder, { force: true });
  const child = electronChild;
  const pid = electronPid;
  restarting = true;
  const started = performance.now();
  try {
    await app.evaluate(({ app: electronApp }, path) => {
      const { writeFileSync: writeRestoreRecord } = process.getBuiltinModule("node:fs");
      // A native-boundary recorder: never spawn an Electron outside this supervisor.
      electronApp.relaunch = () =>
        writeRestoreRecord(path, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    }, recorder);
    await target.click({ timeout: 10000 });
    transcript({
      cmd: "act",
      kind: "click",
      gen: Number(args.gen),
      ref: args.ref,
      double: "app.relaunch recorder",
    });
    await waitUntil("restore's accepted quit", () => observedChildExit(child, pid) !== null, {
      timeout: 20000,
      interval: 100,
    });
    const close = observedChildExit(child, pid);
    const unclean = cleanQuitProblems(close);
    if (unclean.length) throw new Error(`restore quit was not clean: ${unclean.join("; ")}`);
    const record = JSON.parse(await fs.readFile(recorder, "utf8"));
    if (record.pid !== pid) throw new Error("restore did not request a native relaunch");
    if (!(await pathExists(join(L.userDataDir, ".volli-restore-on-restart.json"))))
      throw new Error("restore did not durably arm activation");
    await waitUntil("restore's old processes to exit", async () => (await owned()).length === 0, {
      timeout: 10000,
      interval: 200,
    });
    await fs.rm(L.appSocket, { force: true });
    electronExit = null;
    mainPage = null;
    current = { generation: ++generation, window: null, refs: new Set() };
    const { live } = await startElectron(launchEnv);
    await waitUntil("the restored app's agent socket", () => pathExists(L.appSocket), {
      timeout: 30000,
    });
    restarts += 1;
    transcript({
      cmd: "restore-restart",
      restarts,
      electronPid,
      ms: Math.round(performance.now() - started),
      close: close.kind,
      guard: Object.keys(live.trapped).length,
    });
    await recordMembers();
    return snapshot();
  } finally {
    restarting = false;
  }
}

async function handle(cmd, args) {
  lastCommandAt = Date.now();
  armIdle();
  void recordMembers();
  switch (cmd) {
    case "readme-demo": {
      if (
        spec.fixture !== "empty" ||
        spec.model !== "fake" ||
        !Array.isArray(spec.fakeScript) ||
        spec.fakeScript.length === 0 ||
        spec.cloud ||
        spec.deployment ||
        spec.remoteAcceptance
      ) {
        throw new Error("README capture requires an empty, local scripted fake-model instance");
      }
      const { page } = await pickWindow("main");
      const { captureReadmeDemo } = await import("./readme-demo.mjs");
      const result = await captureReadmeDemo({ page, app, layout: L });
      transcript({ cmd: "readme-demo", ...result });
      return result;
    }
    case "chat-window-bench": {
      const report = await guardedChatWindowBench({
        app,
        spec,
        layout: L,
        repo: REPO,
        settings: args.settings,
        doctor,
        expire: async (reason) => {
          await finalize(reason);
          process.exit(1);
        },
      });
      const guardAfter = await doctor();
      if (!guardAfter.ok) throw new Error(`bench guard failed: ${guardAfter.problems.join("; ")}`);
      report.guardAfter = guardAfter;
      writeFileSync(
        join(L.evidence, "chat-window-bench.json"),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      transcript({
        cmd,
        arm: args.settings?.arm,
        guard: report.guard.ok,
        guardAfter: guardAfter.ok,
      });
      return report;
    }
    case "acceptance-fixture":
      if (!remoteFixture) throw new Error("Not a remote acceptance instance");
      return { projectPath: remoteFixture.projectPath, originPath: remoteFixture.originPath };
    case "acceptance-arrange-box":
      if (!remoteFixture) throw new Error("Not a remote acceptance instance");
      await remoteFixture.arrangeBox();
      transcript({
        cmd: "acceptance-arrange-box",
        setup: "benign Git repo and bare remote over fixture SSH",
      });
      return { arranged: true };
    case "acceptance-model":
      if (!remoteFixture) throw new Error("Not a remote acceptance instance");
      await remoteFixture.configureModel();
      transcript({ cmd: "acceptance-model", setup: "operator model deployment configuration" });
      return { configured: true };
    case "acceptance-workspace": {
      if (!remoteFixture) throw new Error("Not a remote acceptance instance");
      const { page } = await pickWindow("main");
      // Read through the same preload/IPC registry door as the renderer. No
      // store setters, injected HostLink or fixture-generated readiness.
      const result = await page.evaluate(() =>
        window.api.sessionRpc.request({ path: "hosts.snapshot", type: "query", input: undefined }),
      );
      if (!result.ok) throw new Error(result.error.message);
      const ready = acceptanceWorkspaceReady(result.data);
      transcript({ cmd: "acceptance-workspace", ready });
      return { ready };
    }
    case "settings-native": {
      const result = await settingsNative(app, args);
      transcript({ cmd, action: args.action ?? "state", ...result });
      return result;
    }
    case "native-quit": {
      // The real application's native Quit menu item, not the menu-bar test
      // controller. No injected live-work count: a local scripted turn holds it.
      const { page } = await pickWindow("main");
      const result = await quitNativeWindow(app, page);
      mainPage = null;
      current = { generation: ++generation, window: null, refs: new Set() };
      transcript({ cmd: "native-quit", ...result });
      return result;
    }
    case "native-reopen":
      // macOS activation is the production reopen path (also used by the
      // tray's Open Volli). Never set renderer state or inject a HostLink.
      mainPage = await reopenNativeWindow(app);
      current = { generation: ++generation, window: "main", refs: new Set() };
      transcript({ cmd: "native-reopen" });
      return snapshot();
    // ---- Volli Cloud journeys (launch --cloud): setup, doubles and reads ----
    case "cloud-sign-in-browser": {
      // The browser's half of the dev sign-in: the app asked shell.openExternal
      // (recorded, never opened) for the dev issuer's loopback authorize URL.
      requireCloud();
      const since = Number(args.since ?? 0);
      let target = null;
      await waitUntil(
        "the app to ask the browser for the dev sign-in",
        async () => {
          const jsonl = await fs
            .readFile(join(L.harnessDir, "external-requests.jsonl"), "utf8")
            .catch(() => "");
          target = recordedDevSignIn(jsonl, since);
          return target !== null;
        },
        { timeout: Number(args.timeout ?? 20_000), interval: 200 },
      );
      const answer = await completeDevSignIn(target);
      transcript({
        cmd: "cloud-sign-in-browser",
        double: "browser (dev issuer, loopback)",
        ...answer,
      });
      return answer;
    }
    case "sign-in-url": {
      if (!spec.deployment) throw new Error("sign-in-url requires launch --deployment");
      const jsonl = await fs
        .readFile(join(L.harnessDir, "external-requests.jsonl"), "utf8")
        .catch(() => "");
      return recordedWorkosSignIn(jsonl, spec.deployment.workosClientId);
    }
    case "restart":
      return restart(String(args.reason ?? "requested"));
    case "relaunch":
      return relaunch();
    case "quit-during-launch":
      return quitDuringLaunch(args);
    case "restore-restart":
      return restoreRestart(args);
    case "runner-power": {
      // SIMULATED sleep: main's dual-locked seam (cloud-runner/smoke-power.ts)
      // emits the real power event; suspend resolves once the asleep report
      // landed and the runner's transport is held down. No OS sleep happens.
      requireCloud();
      const action = args.action;
      if (action !== "suspend" && action !== "resume")
        throw new Error("runner-power suspend|resume");
      const started = performance.now();
      const result = await app.evaluate(async (_electron, which) => {
        const seam = globalThis.volliCloudRunnerPower;
        if (seam === undefined) return { installed: false };
        await seam[which]();
        return { installed: true };
      }, action);
      if (!result.installed) {
        throw new Error(
          "volliCloudRunnerPower is not installed: an unpackaged cloud launch with VOLLI_SMOKE_CLOUD_RUNNER_POWER=1 and a runner",
        );
      }
      const ms = Math.round(performance.now() - started);
      transcript({ cmd: "runner-power", action, simulated: true, ms });
      return { action, simulated: true, ms };
    }
    case "cloud-checkout-folder": {
      // SETUP + a double at the OS boundary: a scratch-only Git repo (its one
      // remote a local bare repo), handed back by the native folder picker,
      // which no driver can operate. The person still presses the app's own
      // "Choose the folder…" control.
      requireCloud();
      const { dir, origin } = await makeScratchRepo(L.projectsDir, "wake-demo");
      const real = await fs.realpath(dir);
      if (!real.startsWith(`${await fs.realpath(L.scratch)}/`)) {
        throw new Error(`the checkout ${real} is outside this instance's scratch tree`);
      }
      await app.evaluate(({ dialog }, folder) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
      }, resolve(real));
      transcript({ cmd: "cloud-checkout-folder", double: "native folder picker", path: real });
      return { path: real, origin };
    }
    case "cloud-state": {
      // Reads only: the launch marker (who signed in, a non-secret row) and
      // this Mac's runner record for that person.
      requireCloud();
      const userId = launchMarkerUser(await readAppState(L.dbPath, CLOUD_LAUNCH_KEY));
      const runnerId =
        userId === null
          ? null
          : recordedRunnerId(await readAppState(L.dbPath, CLOUD_RUNNER_KEY), userId);
      return { userId, runnerId, restarts };
    }
    case "ping":
      return { id: spec.id };
    case "snapshot": {
      const result = await snapshot(args);
      transcript({ cmd: "snapshot", generation: result.generation, window: result.window });
      return result;
    }
    case "find": {
      const result = await snapshot(args);
      transcript({ cmd: "find", query: args.query, generation: result.generation });
      return { ...result, text: undefined, matches: findInSnapshot(result.text, args.query) };
    }
    case "act":
      return act(args);
    case "wait":
      return waitFor(args);
    case "screenshot":
      return screenshot(args);
    case "ui-zoom": {
      // The View menu's addressed zoom event, delivered to one window's page.
      if (!["in", "out", "reset"].includes(args.step))
        throw new Error("ui-zoom step must be in, out or reset");
      const { page, name } = await pickWindow(args.window);
      const url = page.url();
      await app.evaluate(
        ({ BrowserWindow }, input) => {
          const target = BrowserWindow.getAllWindows().find(
            (w) => w.webContents.getURL() === input.url,
          );
          if (!target) throw new Error("window not found");
          target.webContents.send("volli:ui-zoom-command", input.step);
        },
        { url, step: args.step },
      );
      await page.waitForTimeout(300);
      const scale = await page.evaluate(
        () => getComputedStyle(document.querySelector("[style*=zoom]") ?? document.body).zoom,
      );
      transcript({ cmd: "ui-zoom", window: name, step: args.step, scale });
      return { window: name, scale };
    }
    case "windows":
      return windowsList();
    case "doctor":
      return doctor();
    case "metrics":
      return memory();
    case "stop": {
      const manifest = await finalize(args.reason ?? "stop", {
        keepScratch: Boolean(args.keepScratch),
      });
      setTimeout(() => process.exit(0), 100);
      return stopResult(manifest, { manifestPath: L.manifest, evidence: L.evidence });
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}

/**
 * A Volli Cloud instance's real quit (Tray → Quit Volli), for `stop` and
 * `restart` only. The helper and the seam it reaches live in
 * `lib/cloud-acceptance.mjs`. Both cloud fixtures and explicit real targets
 * use it; local instances and the remote journey's native Quit never do.
 */
async function cloudTrayQuit() {
  requireCloudLaunch();
  const result = await quitCloudLaunchFromTray(app, () => electronExit !== null);
  lastTrayQuit = result;
  transcript({ cmd: "tray-quit", ...result });
  return result;
}

/**
 * A cloud instance's quit, proven. The child handle and pid are taken BEFORE
 * the Tray quit, so the proof is about the process this supervisor launched.
 * An exit is read from that handle (no signal, no Playwright); only a child
 * still running is closed the bounded way, while Playwright can reach it. A
 * missing or mismatched handle throws: never read as a clean quit.
 */
/** A local instance's ordinary quit, proven from the exact child handle. */
async function closeLocalInstance() {
  const child = electronChild;
  const pid = electronPid;
  let close = observedChildExit(child, pid);
  if (close === null) {
    try {
      // A large profile's ordinary quit (host stop, WAL checkpoint) can take
      // seconds; it is given them before any signal.
      close = await closeAppBounded(app, { closeGraceMs: 30_000 });
    } catch (error) {
      close = observedChildExit(child, pid);
      if (close === null) throw error;
    }
  }
  return { trayQuit: null, close };
}

async function closeCloudInstance() {
  requireCloudLaunch();
  const child = electronChild;
  const pid = electronPid;
  const trayQuit = await cloudTrayQuit();
  let close = observedChildExit(child, pid);
  if (close === null) {
    try {
      close = await closeAppBounded(app);
    } catch (error) {
      // It may have exited while the bounded close looked for it; else the fault stands.
      close = observedChildExit(child, pid);
      if (close === null) throw error;
    }
  }
  lastCloudClose = close;
  return { trayQuit, close };
}

function requireCloudLaunch() {
  if (!spec.deployment) requireCloud();
}

// Fixture-only commands must never borrow the real-deployment sign-in.
function requireCloud() {
  if (!spec.cloud || cloud === null) throw new Error("not a Volli Cloud instance (launch --cloud)");
}

process.on("SIGTERM", async () => {
  await finalize("SIGTERM");
  process.exit(0);
});
process.on("SIGINT", async () => {
  await finalize("SIGINT");
  process.exit(0);
});

try {
  await boot();
} catch (error) {
  slog(`launch failed: ${error?.stack ?? error}`);
  writeFileSync(
    join(L.evidence, "failed.json"),
    `${JSON.stringify({ error: String(error?.message ?? error), timings }, null, 2)}\n`,
  );
  await finalize("launch-failed", { keepScratch: false });
  process.exit(1);
}
