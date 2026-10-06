#!/usr/bin/env node
/**
 * VC-445: what N process-bound Pi contexts cost Electron main.
 *
 * VC-366 left one measurement open: main's heap, GC, event-loop delay and
 * renderer→main IPC latency against the number of Pi contexts ACTUALLY LOADED
 * in main, and against how long their histories are. This is that probe and
 * nothing broader — no Browser, terminal, watcher, sleep/wake or soak matrix
 * (VC-318), no model/provider/tool/turn timing (VC-441), no budget-reader or
 * ledger-roster benchmark (VC-403).
 *
 *   pnpm run build
 *   node apps/desktop/e2e/pi-context-scaling-bench.mjs \
 *     --repetitions 5 --output docs/research/perf/pi-context-scaling-vc445
 *
 * ## What runs
 *
 * **prepare** (once per fixture): the BUILT app on a disposable profile (its
 * own `--user-data-dir`, `VOLLI_DB_PATH`, `HOME` and Pi agent dir) creates
 * 4 × 20 project Sessions over the product `sessions.create`/`sessions.attach`
 * routes, one group of 20 per history length. Attaching creates each Session's
 * Pi recovery sidecar. The app quits, and `sidecar-history.ts` re-attaches the
 * real Pi runtime (plain Node, pi-ai's faux provider) to each sidecar and runs
 * real turns with real `read` tool calls against synthetic files until it
 * holds 10 / 100 / 500 / 1,500 entries. The profile is then frozen as
 * `pristine/`.
 *
 * **run**: every launch restores `live/` from `pristine/` by APFS clone (so all
 * absolute paths stay identical), launches the app, and in ONE process:
 *
 *   1. census: every fixture Session is durably open, and NONE is bound;
 *   2. warm: an IPC burst, then an idle window (main loop delay and GC while
 *      the renderer samples IPC echo and Session RPC round trips
 *      concurrently);
 *   3. two forced full GCs (each timed) and the pre-hydration memory snapshot;
 *   4. hydration window: the same instruments while N Sessions are bound, one
 *      after another, by re-selecting their own model (`model.select`), which
 *      makes the Session runtime rehydrate the Pi binding from its sidecar
 *      without starting a turn;
 *   5. census: exactly those N Sessions are now bound (the listing's `live`
 *      flag, computed from the runtime's in-memory binding map);
 *   6. steady window: the instruments again while N contexts are merely held;
 *   7. two forced full GCs, the post-hydration snapshot, the tripwire record.
 *
 * Arms are {1, 5, 10, 20} bound contexts × {10, 100, 500, 1,500} entries, plus
 * a control arm that binds nothing (the noise floor of every delta). Each
 * repetition runs every arm once in a seeded shuffled order, after one
 * discarded warm-up launch.
 *
 * ## No network, no provider, no real content
 *
 * `bench/pi-context-scaling/network-tripwire.cjs` is `--require`d into main
 * (and loaded into this process for the generator): it refuses and records
 * every non-loopback socket and every non-loopback Chromium request. The
 * profile's only credential is a fake `openai` API key, so a provider call
 * would be refused locally and recorded. Provider-looking environment
 * variables are scrubbed before launch. All prose is generated from a fixed
 * vocabulary; the person's own profile, app and Sessions are never touched.
 *
 * MANUALLY RUN: needs a display and the built app. Not wired into `vp test`.
 */
import { execFile, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import os from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

import { _electron } from "playwright-core";

import { seededRandom, seededShuffle } from "./bench/performance/deterministic.mjs";
import { hostMetadata } from "./bench/performance/run.mjs";
import { forceTargetRefusal } from "./bench/performance/fixture.mjs";
import { aggregateRun, armKey, loadThresholdFor } from "./bench/pi-context-scaling/aggregate.mjs";
import { withGenerator } from "./bench/pi-context-scaling/generator.mjs";
import {
  forceGc,
  installMainProbe,
  memorySnapshot,
  startWindow,
  stopWindow,
  tripwireSelfTest,
  tripwireState,
} from "./bench/pi-context-scaling/main-probe.mjs";
import {
  bindingCensus,
  hydrateSessions,
  startRendererSampler,
  stopRendererSampler,
  warmIpc,
} from "./bench/pi-context-scaling/renderer-probe.mjs";
import { markdownTables } from "./bench/pi-context-scaling/tables.mjs";
import {
  APP_DIR,
  ELECTRON,
  REPO,
  assertBuiltRendererLoaded,
  assertProfileIsolated,
  closeAppBounded,
  launchEnvFor,
  makeGitRepo,
  readSeededProjects,
  seedDefaultModel,
  seedProjects,
  sleep,
  smokeExecutableFor,
  waitUntil,
} from "./lib/smoke-kit.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const TRIPWIRE = join(here, "bench", "pi-context-scaling", "network-tripwire.cjs");

// ---- arguments -------------------------------------------------------------

const numberList = (value) => value.split(",").map((item) => Number(item.trim()));

function requireInteger(name, value, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`--${name} must be an integer ≥ ${minimum}`);
  }
}

function parseArgs(argv) {
  const options = {
    root: null,
    output: null,
    repetitions: 5,
    bound: [1, 5, 10, 20],
    histories: [10, 100, 500, 1_500],
    windowMs: 6_000,
    settleMs: 6_000,
    echoPauseMs: 5,
    rpcPauseMs: 25,
    seed: 445,
    reuseFixture: false,
    keep: false,
    files: 24,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    const take = () => {
      if (value === undefined) throw new Error(`${flag} needs a value`);
      index += 1;
      return value;
    };
    switch (flag) {
      case "--root":
        options.root = resolve(take());
        break;
      case "--output":
        options.output = resolve(take());
        break;
      case "--repetitions":
        options.repetitions = Number(take());
        break;
      // `--attached` is the flag's first name, kept so the commands recorded
      // in published runs still work: every fixture Session is attached, and
      // what an arm varies is how many are BOUND in main.
      case "--bound":
      case "--attached":
        options.bound = numberList(take());
        break;
      case "--histories":
        options.histories = numberList(take());
        break;
      case "--window-ms":
        options.windowMs = Number(take());
        break;
      case "--settle-ms":
        options.settleMs = Number(take());
        break;
      case "--echo-pause-ms":
        options.echoPauseMs = Number(take());
        break;
      case "--rpc-pause-ms":
        options.rpcPauseMs = Number(take());
        break;
      case "--seed":
        options.seed = Number(take());
        break;
      case "--reuse-fixture":
        options.reuseFixture = true;
        break;
      case "--keep":
        options.keep = true;
        break;
      case "--help":
        console.log(
          "node apps/desktop/e2e/pi-context-scaling-bench.mjs [--repetitions 5] [--output DIR]\n" +
            "  [--bound 1,5,10,20] [--histories 10,100,500,1500] [--window-ms 6000]\n" +
            "  [--settle-ms 6000] [--echo-pause-ms 5] [--rpc-pause-ms 25] [--seed 445]\n" +
            "  [--root DIR --reuse-fixture] [--keep]",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument ${flag}`);
    }
  }
  for (const [name, values] of [
    ["bound", options.bound],
    ["histories", options.histories],
  ]) {
    if (values.length === 0 || values.some((n) => !Number.isSafeInteger(n) || n < 1)) {
      throw new Error(`--${name} must be positive integers`);
    }
  }
  requireInteger("repetitions", options.repetitions, 1);
  requireInteger("window-ms", options.windowMs, 100);
  requireInteger("settle-ms", options.settleMs, 0);
  requireInteger("echo-pause-ms", options.echoPauseMs, 0);
  requireInteger("rpc-pause-ms", options.rpcPauseMs, 0);
  requireInteger("seed", options.seed, 0);
  return options;
}

// ---- isolation -------------------------------------------------------------

/**
 * Provider credentials in the ambient environment would be read by pi-ai's
 * env-key fallback. The bench wants the fake key only, so every variable that
 * looks like a credential is dropped from THIS process before anything is
 * launched; the child inherits the scrubbed environment.
 */
function scrubCredentialEnvironment() {
  const removed = [];
  for (const key of Object.keys(process.env)) {
    if (/API_KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|^AWS_|^AZURE_|^GOOGLE_|^VERTEX/i.test(key)) {
      delete process.env[key];
      removed.push(key);
    }
  }
  delete process.env.ZDOTDIR;
  delete process.env.PI_CODING_AGENT_DIR;
  return removed.length;
}

/** Written into every root this bench creates; the only licence to delete one. */
const ROOT_MARKER = "vc445-bench-root.json";

/**
 * `--root` names a directory this bench will `rm -rf`. Refuse the filesystem
 * root, the home directory, the repository, a symlink and anything that looks
 * like a checkout (VC-353's `forceTargetRefusal`), and refuse any non-empty
 * directory this bench did not create itself.
 */
async function assertDisposableRoot(root) {
  const target = resolve(root);
  const stats = await fs.lstat(target).catch(() => null);
  const entries = stats?.isDirectory() ? await fs.readdir(target) : [];
  const refusal = forceTargetRefusal({
    targetPath: target,
    exists: stats !== null,
    isDirectory: stats?.isDirectory() ?? false,
    isSymlink: stats?.isSymbolicLink() ?? false,
    // The marker check below replaces VC-353's own marker rule.
    isEmpty: true,
    hasPackageJson: entries.includes("package.json"),
    hasGit: entries.includes(".git"),
  });
  if (refusal !== null) throw new Error(`refusing --root: ${refusal}`);
  if (entries.length > 0 && !entries.includes(ROOT_MARKER)) {
    throw new Error(`refusing --root: ${target} is non-empty and was not created by this bench`);
  }
}

function profilePaths(root) {
  const live = join(root, "live");
  return {
    root,
    live,
    pristine: join(root, "pristine"),
    userDataDir: join(live, "ud"),
    dbPath: join(live, "volli.db"),
    home: join(live, "home"),
    agentDir: join(live, "home", ".pi", "agent"),
    fixture: join(root, "fixture.json"),
  };
}

/**
 * smoke-kit's `launch`, plus the tripwire. Playwright deletes `NODE_OPTIONS`
 * from the child's environment, so the tripwire rides Electron's own `-r`
 * preload switch instead — required before the app's main bundle runs.
 */
function launchApp(paths) {
  const environment = launchEnvFor(paths.dbPath, {
    HOME: paths.home,
    ZDOTDIR: paths.home,
    PI_CODING_AGENT_DIR: paths.agentDir,
    VOLLI_QUIET_WINDOWS: "1",
  });
  return _electron.launch({
    executablePath: smokeExecutableFor(ELECTRON, paths.userDataDir, { environment }),
    args: ["-r", TRIPWIRE, APP_DIR, `--user-data-dir=${paths.userDataDir}`],
    env: environment,
  });
}

/**
 * The tripwire must be loaded AND must have refused its own deliberate Node
 * and Chromium requests, or its silence proves nothing.
 */
async function assertTripwireLive(app) {
  const result = await app.evaluate(tripwireSelfTest);
  if (!result.loaded || !result.node || !result.chromium) {
    throw new Error(`the network tripwire is not live in Electron main: ${JSON.stringify(result)}`);
  }
  return result;
}

async function openWindow(app, paths) {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  assertBuiltRendererLoaded(page);
  await assertProfileIsolated(app, paths.userDataDir);
  await waitUntil(
    "the preload bridge and bootstrap",
    () =>
      page.evaluate(async () => {
        if (window.api === undefined) return false;
        const boot = await window.api.data.bootstrap();
        return boot.ok === true;
      }),
    { timeout: 60_000 },
  );
  return page;
}

// ---- host and build facts --------------------------------------------------

const FOOTPRINT_UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

/**
 * macOS's physical footprint of one process (`footprint -p`), in bytes.
 *
 * Recorded beside Electron's working set because the two answer different
 * questions on a machine under memory pressure: working set is what is
 * resident right now, and the OS compressing or purging pages moves it by tens
 * of MiB with no change in what the process holds. The footprint counts
 * compressed dirty memory too, which is what Activity Monitor's Memory column
 * shows and what a process actually costs the machine.
 */
async function footprintBytes(pid) {
  const output = await sh("footprint", ["-p", String(pid)]);
  const match = output?.match(/Footprint:\s+([\d.]+)\s+(B|KB|MB|GB)/);
  return match ? Math.round(Number(match[1]) * FOOTPRINT_UNITS[match[2]]) : null;
}

/**
 * Every live descendant of Electron main, identified by PARENT pid rather than
 * by name (VC-366's first caveat: vitest workers were once counted as agent
 * processes by matching command lines). Taken before and after hydration, so a
 * bound Pi context that spawned anything would show up here.
 */
async function descendantsOf(rootPid) {
  const table = await sh("ps", ["-A", "-o", "pid=,ppid=,comm="]);
  const rows = (table ?? "")
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));
  const found = [];
  const frontier = [rootPid];
  while (frontier.length > 0) {
    const parent = frontier.pop();
    for (const row of rows.filter((candidate) => candidate.ppid === parent)) {
      found.push({ ...row, command: row.command.split("/").at(-1) });
      frontier.push(row.pid);
    }
  }
  return found;
}

async function withFootprints(snapshot) {
  const renderers = snapshot.metrics.filter((metric) => metric.type === "Tab");
  return {
    ...snapshot,
    descendants: await descendantsOf(snapshot.pid),
    footprint: {
      mainBytes: await footprintBytes(snapshot.pid),
      rendererBytes: await Promise.all(renderers.map((metric) => footprintBytes(metric.pid))),
    },
  };
}

async function sh(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 5_000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function hostState() {
  const [pressure, swap, battery] = await Promise.all([
    sh("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
    sh("sysctl", ["-n", "vm.swapusage"]),
    sh("pmset", ["-g", "batt"]),
  ]);
  return {
    epochMs: Date.now(),
    loadavg: os.loadavg().map((value) => Math.round(value * 100) / 100),
    freeMemMiB: Math.round(os.freemem() / 1024 / 1024),
    memoryPressureLevel: pressure === null ? null : Number(pressure),
    swapUsage: swap,
    power: battery?.split("\n")[0] ?? null,
  };
}

async function environmentFacts() {
  const [meta, battery] = await Promise.all([hostMetadata(), sh("pmset", ["-g", "batt"])]);
  const require = createRequire(join(APP_DIR, "package.json"));
  const mainBundle = await fs.stat(join(APP_DIR, "dist-electron", "main.cjs"));
  return {
    machine: {
      model: meta.device.model,
      cpu: meta.device.cpu,
      cores: meta.device.logicalCores,
      memoryGiB: Math.round(meta.device.memoryBytes / 1024 ** 3),
      macos: meta.os.macosVersion,
      macosBuild: meta.os.macosBuild,
      power: battery,
    },
    build: {
      gitSha: meta.git.sha,
      gitDirty: meta.git.dirty,
      electron: require("electron/package.json").version,
      node: meta.node,
      mainBundleBuiltAt: mainBundle.mtime.toISOString(),
      buildKind: "production bundle (pnpm run build), launched unpackaged through Playwright",
    },
  };
}

// ---- prepare ---------------------------------------------------------------

/** Deterministic TypeScript-shaped files for the scripted `read` calls. */
async function writeSyntheticFiles(project, count, seed) {
  const random = seededRandom(seed);
  const words = ["ledger", "cursor", "branch", "turn", "event", "binding", "queue", "reader"];
  const files = [];
  for (let index = 0; index < count; index += 1) {
    const bytes = 1_024 + Math.floor(random() * 15 * 1_024);
    const lines = [];
    let size = 0;
    let line = 0;
    while (size < bytes) {
      const word = words[Math.floor(random() * words.length)];
      const text = `export function ${word}${line}(value: number): number { return value * ${line} + ${Math.floor(random() * 1000)}; }`;
      lines.push(text);
      size += text.length + 1;
      line += 1;
    }
    const path = `src/module-${String(index).padStart(2, "0")}.ts`;
    await fs.mkdir(join(project, "src"), { recursive: true });
    await fs.writeFile(join(project, path), `${lines.join("\n")}\n`);
    files.push(path);
  }
  execFileSync("git", ["add", "-A"], { cwd: project });
  execFileSync("git", ["commit", "-q", "-m", "synthetic fixture files"], { cwd: project });
  return files;
}

async function findSidecars(sessionsRoot) {
  const found = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".jsonl")) found.push(path);
    }
  };
  await walk(sessionsRoot);
  const sidecars = [];
  for (const path of found) {
    const lines = (await fs.readFile(path, "utf8")).split("\n").filter(Boolean);
    const records = lines.flatMap((line) => {
      const parsed = JSON.parse(line);
      return Array.isArray(parsed) ? parsed : [parsed];
    });
    const header = records.find((record) => record.kind === "header");
    const identity = records.find(
      (record) => record.kind === "value" && record.namespace === "volli.identity.v1",
    )?.value;
    if (header === undefined || identity === undefined) {
      throw new Error(`sidecar ${path} has no header or identity`);
    }
    sidecars.push({ path, id: header.id, cwd: header.cwd, identity });
  }
  return sidecars;
}

async function prepare(options, paths) {
  await assertDisposableRoot(paths.root);
  await fs.rm(paths.root, { recursive: true, force: true });
  await fs.mkdir(paths.userDataDir, { recursive: true });
  await fs.writeFile(
    join(paths.root, ROOT_MARKER),
    `${JSON.stringify({ ticket: "VC-445", createdAt: new Date().toISOString() })}\n`,
  );
  await fs.mkdir(paths.agentDir, { recursive: true, mode: 0o700 });
  // The profile's only credential, and a fake one: a request that ever got as
  // far as a provider would carry this string and be refused by the tripwire.
  await fs.writeFile(
    join(paths.agentDir, "auth.json"),
    JSON.stringify({ openai: { type: "api_key", key: "vc445-no-call-fake-key" } }),
    { mode: 0o600 },
  );
  const project = await makeGitRepo(paths.root, "project-");
  const files = await writeSyntheticFiles(project, options.files, options.seed);
  const maxBound = Math.max(...options.bound);

  console.log(`prepare: launching the built app on ${paths.live}`);
  const app = await launchApp(paths);
  let fixture;
  try {
    const page = await openWindow(app, paths);
    await assertTripwireLive(app);
    await seedProjects(page, [
      { id: "vc445-context-scaling", name: "VC-445 Context Scaling", path: project, prefix: "CS" },
    ]);
    const { projects } = await readSeededProjects(page);
    const projectId = projects[0]?.id;
    if (projectId === undefined) throw new Error("the fixture project did not import");
    const inspected = await page.evaluate(async () => {
      const response = await window.api.sessionRpc.request({
        path: "modelAccess.inspect",
        type: "query",
        input: {},
      });
      return response.ok
        ? response.data.models
            .filter((model) => model.providerId === "openai" && model.state === "available")
            .map((model) => ({ modelId: model.modelId, reasoningLevels: model.reasoningLevels }))
        : { error: response.error };
    });
    if (!Array.isArray(inspected) || inspected.length === 0) {
      throw new Error(`no fake-key openai model is available: ${JSON.stringify(inspected)}`);
    }
    const choice =
      inspected.find(
        (model) => model.modelId === "gpt-5-mini" && model.reasoningLevels.includes("low"),
      ) ??
      inspected.find((model) => model.reasoningLevels.includes("low")) ??
      inspected[0];
    const selection = {
      providerId: "openai",
      modelId: choice.modelId,
      reasoningLevel: choice.reasoningLevels.includes("low") ? "low" : choice.reasoningLevels[0],
    };
    await seedDefaultModel(page, selection);

    const groups = {};
    for (const historyEntries of options.histories) {
      groups[historyEntries] = [];
      for (let index = 0; index < maxBound; index += 1) {
        const started = await page.evaluate(
          async ({ pid, title }) => {
            const created = await window.api.sessionRpc.request({
              path: "sessions.create",
              type: "mutation",
              input: { operationId: crypto.randomUUID(), projectId: pid, ticketId: null, title },
            });
            if (!created.ok) return { ok: false, step: "create", error: created.error };
            const attached = await window.api.sessionRpc.request({
              path: "sessions.attach",
              type: "mutation",
              input: { operationId: crypto.randomUUID(), sessionId: created.data.sessionId },
            });
            if (!attached.ok) return { ok: false, step: "attach", error: attached.error };
            return {
              ok: attached.data.state === "ready",
              sessionId: created.data.sessionId,
              state: attached.data.state,
            };
          },
          { pid: projectId, title: `VC-445 h${historyEntries} #${index + 1}` },
        );
        if (!started.ok) throw new Error(`Session start failed: ${JSON.stringify(started)}`);
        groups[historyEntries].push(started.sessionId);
      }
    }
    // Positive control for the census: a FRESH attach binds in this process,
    // so every Session must read live now. The run phase must read 0 after a
    // relaunch even though the ledger still holds all of them open.
    const census = await page.evaluate(bindingCensus, { projectId });
    const expected = options.histories.length * maxBound;
    if (census.live !== expected || census.durableOpen !== expected) {
      throw new Error(
        `prepare census disagrees: ${JSON.stringify({ ...census, liveIds: undefined })}`,
      );
    }
    const tripwire = await app.evaluate(tripwireState);
    if (tripwire.blocked.length + tripwire.chromiumBlocked.length > 0) {
      throw new Error(`prepare tried to reach the network: ${JSON.stringify(tripwire)}`);
    }
    fixture = {
      projectId,
      project,
      files,
      selection,
      groups,
      prepareCensus: { ...census, liveIds: undefined },
      prepareTripwire: tripwire,
    };
  } finally {
    await closeAppBounded(app);
  }

  // ---- grow the sidecars, outside the app, with the real runtime ----
  const sidecars = await findSidecars(join(paths.userDataDir, "pi-sessions"));
  const bySession = new Map(sidecars.map((sidecar) => [sidecar.identity.volliSessionId, sidecar]));
  await withGenerator(async (generator) => {
    const catalogModel = generator.builtinCatalogModel(
      fixture.selection.providerId,
      fixture.selection.modelId,
    );
    const random = seededRandom(options.seed);
    const targets = [];
    for (const historyEntries of options.histories) {
      for (const sessionId of fixture.groups[historyEntries]) {
        const sidecar = bySession.get(sessionId);
        if (sidecar === undefined) throw new Error(`no sidecar for Session ${sessionId}`);
        targets.push({
          sessionId,
          rootThreadId: sidecar.identity.volliThreadId,
          attachmentId: sidecar.identity.volliAttachmentId,
          projectId: fixture.projectId,
          recovery: { runtime: "pi", sessionId: sidecar.id, sessionFilePath: sidecar.path },
          targetEntries: historyEntries,
          seed: Math.floor(random() * 2 ** 31),
          workspacePath: sidecar.cwd,
        });
      }
    }
    const workspaces = new Set(targets.map((target) => target.workspacePath));
    if (workspaces.size !== 1) throw new Error(`sidecars disagree on cwd: ${[...workspaces]}`);
    const generated = await generator.growSidecarHistories({
      sessionDataDir: join(paths.userDataDir, "pi-sessions"),
      workspacePath: [...workspaces][0],
      files: fixture.files,
      model: fixture.selection,
      catalogModel,
      targets,
      onProgress: (done, total, result) => {
        if (done % 10 === 0 || done === total) {
          console.log(`prepare: grew ${done}/${total} sidecars (last ${result.entries} entries)`);
        }
      },
    });
    fixture.sidecars = Object.fromEntries(generated.map((result) => [result.sessionId, result]));
    fixture.generatorTripwire = globalThis.VOLLI_NETWORK_TRIPWIRE?.blocked ?? null;
  });
  await fs.writeFile(paths.fixture, `${JSON.stringify(fixture, null, 2)}\n`);
  execFileSync("cp", ["-cR", paths.live, paths.pristine]);
  return fixture;
}

// ---- one launch ------------------------------------------------------------

async function restoreLive(paths) {
  await fs.rm(paths.live, { recursive: true, force: true });
  execFileSync("cp", ["-cR", paths.pristine, paths.live]);
}

async function measuredWindow(app, page, name, options, work) {
  await app.evaluate(startWindow, name);
  await page.evaluate(startRendererSampler, {
    echoPauseMs: options.echoPauseMs,
    rpcPauseMs: options.rpcPauseMs,
  });
  let result = null;
  try {
    result = await work();
  } finally {
    const renderer = await page.evaluate(stopRendererSampler);
    const mainWindow = await app.evaluate(stopWindow);
    result = { main: mainWindow, renderer, ...result };
  }
  return result;
}

async function runLaunch(options, paths, fixture, arm, meta) {
  await restoreLive(paths);
  const hostBefore = await hostState();
  const app = await launchApp(paths);
  try {
    const page = await openWindow(app, paths);
    await sleep(options.settleMs);
    const probe = await app.evaluate(installMainProbe);
    const tripwireSelf = await assertTripwireLive(app);
    const before = await page.evaluate(bindingCensus, { projectId: fixture.projectId });

    // Warm, then an idle window that doubles as the last of the settle, then
    // the baseline snapshot — so "pre" is taken seconds, not a boot, before
    // hydration and the OS's post-boot working-set drift is mostly spent.
    await page.evaluate(warmIpc, { count: 100 });
    const idle = await measuredWindow(app, page, "idle", options, () => sleep(options.windowMs));
    const preGc = await app.evaluate(forceGc);
    await sleep(500);
    const pre = await withFootprints(await app.evaluate(memorySnapshot));

    const sessionIds =
      arm.bound === 0 ? [] : fixture.groups[arm.historyEntries].slice(0, arm.bound);
    const hydration = await measuredWindow(app, page, "hydration", options, async () => ({
      perSession: await page.evaluate(hydrateSessions, {
        sessionIds,
        selection: fixture.selection,
      }),
    }));

    const after = await page.evaluate(bindingCensus, { projectId: fixture.projectId });
    const expected = new Set(sessionIds);
    const unexpectedLive = after.liveIds.filter((id) => !expected.has(id));
    const missingLive = sessionIds.filter((id) => !after.liveIds.includes(id));

    await sleep(500);
    const steady = await measuredWindow(app, page, "steady", options, () =>
      sleep(options.windowMs),
    );

    const postGc = await app.evaluate(forceGc);
    await sleep(500);
    const post = await withFootprints(await app.evaluate(memorySnapshot));
    const tripwire = await app.evaluate(tripwireState);
    const hostAfter = await hostState();
    const sidecars = sessionIds.map((id) => fixture.sidecars[id]);
    const record = {
      ...meta,
      arm,
      mainPid: probe.pid,
      host: { before: hostBefore, after: hostAfter },
      bindings: {
        before: { ...before, liveIds: undefined },
        after: { ...after, liveIds: undefined, unexpectedLive, missingLive },
      },
      sidecarEntries: sidecars.map((sidecar) => sidecar.entries),
      sidecarBytes: sidecars.map((sidecar) => sidecar.bytes),
      memory: { pre, post },
      fullGcPauseMs: { pre: preGc.pausesMs, post: postGc.pausesMs },
      windows: { idle, hydration, steady },
      tripwire,
      tripwireSelfTest: tripwireSelf,
    };
    const failures = [];
    if (before.live !== 0) failures.push(`${before.live} Sessions were bound before hydration`);
    if (before.durableOpen !== before.sessions)
      failures.push("not every fixture Session was durably open");
    if (missingLive.length > 0)
      failures.push(`${missingLive.length} requested Sessions did not bind`);
    if (unexpectedLive.length > 0)
      failures.push(`${unexpectedLive.length} unrequested Sessions bound`);
    if (hydration.perSession.some((entry) => !entry.ok))
      failures.push("a model.select request failed");
    if (tripwire.blocked.length + tripwire.chromiumBlocked.length > 0)
      failures.push("something tried to reach the network");
    record.failures = failures;
    return record;
  } finally {
    await closeAppBounded(app);
  }
}

// ---- main ------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv);
  // This process loads the generator (which runs the real Pi runtime), so it
  // wears the same tripwire the app does.
  createRequire(import.meta.url)(TRIPWIRE);
  const scrubbed = scrubCredentialEnvironment();
  const root = options.root ?? (await fs.mkdtemp("/tmp/vc445-"));
  const paths = profilePaths(root);
  const environment = await environmentFacts();
  console.log(`VC-445 bench root ${root} (scrubbed ${scrubbed} credential-looking env vars)`);

  let fixture;
  if (options.reuseFixture) {
    // Every launch deletes and re-clones `live/` inside this root.
    await assertDisposableRoot(paths.root);
    fixture = JSON.parse(await fs.readFile(paths.fixture, "utf8"));
  } else {
    fixture = await prepare(options, paths);
  }

  const arms = [
    { bound: 0, historyEntries: 0 },
    ...options.histories.flatMap((historyEntries) =>
      options.bound.map((bound) => ({ bound, historyEntries })),
    ),
  ];
  const heaviest = {
    bound: Math.max(...options.bound),
    historyEntries: Math.max(...options.histories),
  };
  const schedule = [{ arm: heaviest, rep: 0, warmup: true }];
  for (let rep = 1; rep <= options.repetitions; rep += 1) {
    for (const arm of seededShuffle(arms, options.seed * 1_000 + rep)) {
      schedule.push({ arm, rep, warmup: false });
    }
  }

  const launches = [];
  const startedAt = Date.now();
  for (const [index, entry] of schedule.entries()) {
    const label = `${entry.warmup ? "warm-up" : `rep ${entry.rep}`} ${armKey(entry.arm)}`;
    const record = await runLaunch(options, paths, fixture, entry.arm, {
      launchIndex: index,
      rep: entry.rep,
      warmup: entry.warmup,
    });
    launches.push(record);
    const heapDelta =
      (record.memory.post.processMemory.heapUsed - record.memory.pre.processMemory.heapUsed) /
      1024 /
      1024;
    console.log(
      `[${index + 1}/${schedule.length}] ${label}: live ${record.bindings.after.live}, ` +
        `heap Δ ${heapDelta.toFixed(1)} MiB, load ${record.host.before.loadavg.join("/")}` +
        (record.failures.length > 0 ? ` FAILED: ${record.failures.join("; ")}` : ""),
    );
  }

  const failed = launches.filter((launch) => launch.failures.length > 0);
  const aggregate = {
    ticket: "VC-445",
    generatedAt: new Date().toISOString(),
    durationMinutes: Math.round((Date.now() - startedAt) / 600) / 100,
    command:
      `node ${relative(REPO, fileURLToPath(import.meta.url))} ${process.argv.slice(2).join(" ")}`.trim(),
    environment,
    protocol: {
      repetitions: options.repetitions,
      warmupLaunches: 1,
      windowMs: options.windowMs,
      settleMs: options.settleMs,
      echoPauseMs: options.echoPauseMs,
      rpcPauseMs: options.rpcPauseMs,
      seed: options.seed,
      order:
        "one discarded warm-up launch of the heaviest arm, then each repetition runs every arm once in a seeded shuffle",
      gc: "two forced full GCs 150 ms apart, then 500 ms, before each memory snapshot; forced GCs are excluded from window GC counts",
      hydration:
        "sequential model.select (re-selecting the Session's own model) per Session through window.api.sessionRpc",
      bindingProof:
        "sessions.list live flag (SessionRuntime.openNativeBindings) vs session.projection liveExecutor (ledger)",
    },
    fixture: {
      project: "synthetic git repo, generated TypeScript files",
      files: fixture.files.length,
      selection: fixture.selection,
      sessionsPerHistory: Math.max(...options.bound),
      histories: Object.fromEntries(
        options.histories.map((historyEntries) => {
          const results = fixture.groups[historyEntries].map((id) => fixture.sidecars[id]);
          const pick = (key) => results.map((result) => result[key]);
          return [
            historyEntries,
            {
              entries: { min: Math.min(...pick("entries")), max: Math.max(...pick("entries")) },
              messages: { min: Math.min(...pick("messages")), max: Math.max(...pick("messages")) },
              bytes: { min: Math.min(...pick("bytes")), max: Math.max(...pick("bytes")) },
              turns: { min: Math.min(...pick("turns")), max: Math.max(...pick("turns")) },
            },
          ];
        }),
      ),
      prepareCensus: fixture.prepareCensus,
    },
    failedLaunches: failed.map((launch) => ({
      launchIndex: launch.launchIndex,
      arm: launch.arm,
      failures: launch.failures,
    })),
    ...aggregateRun(launches, { loadThreshold: loadThresholdFor(environment.machine.cores) }),
  };

  if (options.output) {
    await fs.mkdir(options.output, { recursive: true });
    await fs.writeFile(
      join(options.output, "aggregate.json"),
      `${JSON.stringify(aggregate, null, 2)}\n`,
    );
    await fs.writeFile(
      join(options.output, "raw.json.gz"),
      gzipSync(JSON.stringify({ environment, fixture, launches })),
    );
    await fs.writeFile(join(options.output, "tables.md"), markdownTables(aggregate));
    console.log(`wrote ${options.output}`);
  } else {
    console.log(markdownTables(aggregate));
  }
  if (!options.keep && options.root === null) await fs.rm(root, { recursive: true, force: true });
  if (failed.length > 0) {
    console.error(`${failed.length} launch(es) failed their binding checks; see failedLaunches`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
