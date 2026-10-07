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
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  assertProfileIsolated,
  closeAppBounded,
  launch,
  pathExists,
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
  assertLaunchable,
  bundleCarriesGuard,
  createRegistry,
  electronExtraEnv,
  findInSnapshot,
  instanceLayout,
  killExactly,
  ownedProcesses,
  processIdentity,
  processTable,
  snapshotRefs,
} from "./lib/core.mjs";
import { seedFixture } from "./lib/fixtures.mjs";
import { serve } from "./lib/protocol.mjs";
import {
  assertAcceptanceRunner,
  acceptanceScript,
  prepareRemoteAcceptance,
} from "./lib/remote-acceptance.mjs";

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
let electronPid = null;
/** { pid, pgid, started }: the Electron child, as ps saw it at launch. */
let electronIdentity = null;
let electronExit = null;
let provider = null;
let remoteFixture = null;
let server = null;
let seeded = null;
let stopping = false;
let generation = 0;
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
      name: index === 0 ? "main" : `window-${index}`,
      title: await page.title().catch(() => ""),
      url: page.url(),
    })),
  );
}

async function pickWindow(name) {
  const pages = app.windows();
  if (pages.length === 0) throw new Error("the instance has no open window");
  if (name === undefined || name === "main") return { page: pages[0], name: "main" };
  const list = await windowsList();
  const hit = list.find(
    (w) => w.name === name || w.title.toLowerCase().includes(String(name).toLowerCase()),
  );
  if (!hit) throw new Error(`no window "${name}" (have: ${list.map((w) => w.name).join(", ")})`);
  return { page: pages[hit.index], name: hit.name };
}

function wireWindow(page) {
  const index = () => app.windows().indexOf(page);
  const label = () => (index() === 0 ? "main" : `window-${index()}`);
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

async function snapshot({ window, depth } = {}) {
  const { page, name } = await pickWindow(window);
  const text = await page.ariaSnapshot({ mode: "ai", ...(depth ? { depth: Number(depth) } : {}) });
  generation += 1;
  current = { generation, window: name, refs: snapshotRefs(text) };
  const path = join(L.snapshotsDir, `gen-${String(generation).padStart(4, "0")}-${name}.txt`);
  writeFileSync(path, text);
  return { generation, window: name, url: page.url(), title: await page.title(), path, text };
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
  // Let the renderer commit what the action caused before re-reading it.
  await page.waitForTimeout(Number(args.settleMs ?? 250));
  const fresh = await snapshot({ window: name });
  const result = { action: { kind, ref, key, text, direction, ms: actionMs }, snapshot: fresh };
  transcript({
    cmd: "act",
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

async function waitFor({ text, gone = false, timeout = 15_000, window }) {
  if (!text) throw new Error("wait needs --text");
  const { page } = await pickWindow(window);
  const started = performance.now();
  const needle = String(text).toLowerCase();
  await waitUntil(
    `"${text}" to ${gone ? "disappear" : "appear"}`,
    async () => {
      const tree = (await page.ariaSnapshot({ mode: "ai" })).toLowerCase();
      return gone ? !tree.includes(needle) : tree.includes(needle);
    },
    { timeout: Number(timeout), interval: 200 },
  );
  const ms = Math.round(performance.now() - started);
  const fresh = await snapshot({ window });
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
  if (app && electronExit === null) {
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
    electron: { pid: electronPid, exit: electronExit, close },
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
    provider = await startFakeProvider({
      ...(spec.remoteAcceptance ? { script: acceptanceScript } : {}),
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
  };
  mark("launchStart");
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
  electronPid = child.pid;
  electronIdentity = await processIdentity(electronPid).catch(() => null);
  await registry.update(spec.id, { electronPid, electron: electronIdentity }).catch(() => {});
  child.stdout?.on("data", (chunk) => appendFileSync(L.mainLog, chunk));
  child.stderr?.on("data", (chunk) => appendFileSync(L.mainLog, chunk));
  child.on("exit", (code, signal) => {
    electronExit = { code, signal, at: iso() };
    slog(`electron exited code=${code} signal=${signal}`);
    if (code === HARNESS_VIOLATION_EXIT_CODE) slog("KEYCHAIN GUARD FAILED THE RUN (exit 86)");
    if (!stopping) {
      void finalize(
        code === HARNESS_VIOLATION_EXIT_CODE ? "keychain-violation" : "electron-exited",
        {
          keepScratch: true,
        },
      ).then(() => process.exit(1));
    }
  });
  app.on("window", wireWindow);
  const page = await app.firstWindow();
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
    guard: { trapped: Object.keys(live.trapped), switches: record.chromiumSwitches },
  };
  await recordMembers();
  setInterval(() => void recordMembers(), 10_000).unref();
  writeFileSync(L.readyFile, `${JSON.stringify(ready, null, 2)}\n`);
  transcript({ cmd: "launch", timings, memoryMb: mem?.totalMb });
  armIdle();
}

async function handle(cmd, args) {
  lastCommandAt = Date.now();
  armIdle();
  void recordMembers();
  switch (cmd) {
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
    case "native-quit": {
      // The real application's native Quit menu item, not the menu-bar test
      // controller. No injected live-work count: a local scripted turn holds it.
      const result = await app.evaluate(({ Menu }) => {
        // Serialized into Electron main: this cannot close over supervisor code.
        // oxlint-disable-next-line unicorn/consistent-function-scoping
        const walk = (menu) =>
          menu?.items.flatMap((item) => [item, ...(walk(item.submenu) ?? [])]) ?? [];
        const quit = walk(Menu.getApplicationMenu()).find((item) => item.role === "quit");
        if (!quit) throw new Error("Native Quit menu item missing");
        const label = quit.label;
        quit.click();
        return { label };
      });
      // Production may retain an unacknowledged renderer hidden to protect
      // drafts. Observe native visibility, not Playwright's retained Pages.
      const nativeWindows = await waitUntil(
        "no visible native app windows",
        async () => {
          const measured = await app.evaluate(({ BrowserWindow }) => {
            const windows = BrowserWindow.getAllWindows();
            return {
              visible: windows.filter((window) => window.isVisible()).length,
              retained: windows.length,
            };
          });
          return measured.visible === 0 ? measured : false;
        },
        { timeout: 10_000 },
      );
      current = { generation: ++generation, window: null, refs: new Set() };
      transcript({ cmd: "native-quit", label: result.label, nativeWindows });
      return { ...result, nativeWindows };
    }
    case "native-reopen":
      // macOS activation is the production reopen path (also used by the
      // tray's Open Volli). Never set renderer state or inject a HostLink.
      await app.evaluate(({ app: electronApp }) => electronApp.emit("activate"));
      await app.firstWindow();
      transcript({ cmd: "native-reopen" });
      return snapshot();
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
      return { manifest: L.manifest, evidence: L.evidence, leftovers: manifest?.leftovers ?? [] };
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
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
