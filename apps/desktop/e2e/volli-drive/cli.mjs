#!/usr/bin/env node
/**
 * volli-drive — launch and drive an isolated, keychain-free live build of the
 * Volli desktop app, the way Volli's own Browser Tab tools drive a page.
 *
 *   node apps/desktop/e2e/volli-drive/cli.mjs <command> [args]
 *
 * Run `… cli.mjs help` for the command surface. The verify skill
 * (.agents/skills/verify-volli/SKILL.md) is the how-to; this file is the door.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, openSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { ELECTRON } from "../lib/smoke-kit.mjs";
import {
  BUILT_CLI,
  BUILT_MAIN,
  DEFAULT_IDLE_MS,
  REPO,
  assertLaunchable,
  bundleCarriesGuard,
  createRegistry,
  driveHome,
  ensurePrivateDir,
  evidenceRoot,
  findInSnapshot,
  instanceLayout,
  isInstanceId,
  killExactly,
  launchProblems,
  newInstanceId,
  ownedProcesses,
  pidAlive,
  processIdentity,
  processTable,
  readOnlySql,
  supervisorEnv,
} from "./lib/core.mjs";
import { request } from "./lib/protocol.mjs";
import { assertAcceptanceRunner, acceptanceTarballs } from "./lib/remote-acceptance.mjs";

const execFileAsync = promisify(execFile);

const HELP = `volli-drive — drive an isolated, keychain-free live Volli build

  launch [--fixture basic|empty] [--model fake|env] [--idle-min 20]
         [--no-build] [--json]     start an instance (dev build only; packed
                                   apps are refused until VC-705); prints its
                                   id + evidence dir
  list [--json]                    instances on this machine (max 3 live)
  doctor [<id>] [--json]           no id: is the build about to launch guarded? (static)
                                   with id: up? right build? guard active? isolated?
  snapshot <id> [--window w] [--depth n] [--find text]
                                   aria tree with [ref=eN] refs + a generation
  find <id> <text> [--window w]    fresh snapshot, only matching nodes (+ ancestors)
  act <id> --gen N --kind click|type|press|select|hover|scroll|wait
          [--ref eN] [--text t] [--key Enter] [--direction up|down] [--wait-ms n]
          [--find text]            one synthetic action, then a fresh snapshot
  wait <id> --text t [--gone] [--timeout ms] [--find text]
  screenshot <id> [--name label] [--window w]
  windows <id>
  console <id> [--tail n] [--grep s]
  logs <id> [--tail n] [--grep s] [--trace id] [--follow] [--for ms]
  state <id> sql "<SELECT …>"      read-only query on the instance's database
  state <id> cli <volli args…>     the real volli CLI against the instance socket
  metrics <id>                     memory per Electron process
  stop <id> [--keep-scratch]       stop what this instance started; evidence stays

Evidence lives in ${evidenceRoot()}/<id>/ and survives stop.`;

// ---- argv ------------------------------------------------------------------

function parse(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
      const key = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (inline !== undefined) flags[key] = inline;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[key] = argv[++i];
      else flags[key] = true;
    } else positional.push(arg);
  }
  return { positional, flags };
}

const out = (line = "") => process.stdout.write(`${line}\n`);
const fail = (message, code = 1) => {
  process.stderr.write(`volli-drive: ${message}\n`);
  process.exit(code);
};

// ---- instance lookup ---------------------------------------------------------

async function instance(id) {
  if (!isInstanceId(id)) fail(`"${id ?? ""}" is not an instance id (vd-xxxxxx); see \`list\``);
  const entry = await createRegistry().get(id);
  return entry;
}

async function live(id) {
  const entry = await instance(id);
  if (!entry) fail(`no running instance ${id} (evidence, if any: ${join(evidenceRoot(), id)})`);
  return { entry, layout: instanceLayout(entry.scratch, entry.evidence) };
}

async function call(id, cmd, args = {}, timeoutMs) {
  const { layout } = await live(id);
  return request(layout.driveSocket, cmd, args, timeoutMs ? { timeoutMs } : undefined);
}

function printSnapshot(snap, find) {
  out(`generation: ${snap.generation} · window: ${snap.window} · ${snap.url}`);
  if (find) {
    const matches = findInSnapshot(snap.text, find);
    out(matches.length ? matches.join("\n") : `(no node matches "${find}")`);
  } else out(snap.text);
  out(`(saved: ${snap.path})`);
}

// ---- launch --------------------------------------------------------------------

async function gitFacts() {
  const run = async (args) =>
    (await execFileAsync("git", args, { cwd: REPO }).catch(() => ({ stdout: "" }))).stdout.trim();
  return {
    commit: await run(["rev-parse", "HEAD"]),
    dirty: (await run(["status", "--porcelain"])).length > 0,
  };
}

/** Builds when the bundle lacks the harness or predates its sources. */
async function ensureBuilt(flags) {
  if (launchProblems({ build: "dev", bundle: BUILT_MAIN }).length === 0) return;
  if (flags.noBuild)
    fail(`${BUILT_MAIN} is missing, lacks the harness, or is stale; run \`pnpm run build\``);
  process.stderr.write("volli-drive: building the app (pnpm run build)…\n");
  await new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["run", "build"], { cwd: REPO, stdio: ["ignore", 2, 2] });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`build exited ${code}`)),
    );
  });
}

async function launch(flags) {
  const fixture = flags.fixture ?? "basic";
  const model = flags.model ?? "fake";
  const build = flags.build ?? "dev";
  let remoteAcceptance = null;
  if (flags.remoteAcceptance) {
    assertAcceptanceRunner();
    if (model !== "fake") fail("--remote-acceptance requires --model fake");
    remoteAcceptance = { tarballs: acceptanceTarballs(process.env.VOLLI_HOSTD_DEV_TARBALLS) };
  }
  if (!["fake", "env"].includes(model)) fail("--model is fake or env");
  // Packed mode is disabled: a packaged app's bundle cannot be validated
  // before it runs, so it could start without the guard (VC-705).
  if (build !== "dev" || flags.app)
    fail(`--build ${build}${flags.app ? " --app" : ""}: not yet safe; dev builds only`);
  await ensureBuilt(flags);
  if (!existsSync(ELECTRON))
    fail(`Electron is not installed at ${ELECTRON}; run \`pnpm run ensure:electron\``);
  const started = performance.now();
  const home = driveHome();
  ensurePrivateDir(home);
  const registry = createRegistry(home);
  const id = newInstanceId();
  // Short root: the app binds <userData>/volli.sock, and sun_path caps ~104 bytes.
  const scratch = await fs.realpath(await fs.mkdtemp(`/tmp/${id}-`));
  const evidence = join(evidenceRoot(), id);
  await fs.mkdir(join(evidence, "logs"), { recursive: true });
  const idleMs = flags.idleMin
    ? Number(flags.idleMin) * 60_000
    : Number(process.env.VOLLI_DRIVE_IDLE_MS ?? DEFAULT_IDLE_MS);
  const spec = {
    id,
    scratch,
    evidence,
    driveHome: home,
    fixture,
    model,
    build,
    appBinary: null,
    remoteAcceptance,
    bundle: BUILT_MAIN,
    idleMs,
    ...(await gitFacts()),
    launchedAt: new Date().toISOString(),
  };
  // THE gate, before anything is reserved or spawned (the supervisor checks
  // it again before Electron starts).
  try {
    assertLaunchable(spec);
  } catch (error) {
    await fs.rm(scratch, { recursive: true, force: true });
    fail(error.message);
  }
  try {
    await registry.reserve({
      id,
      scratch,
      evidence,
      reservedAt: Date.now(),
      supervisorPid: null,
      electronPid: null,
      fixture,
      model,
      build,
    });
  } catch (error) {
    await fs.rm(scratch, { recursive: true, force: true });
    fail(error.message);
  }
  const specPath = join(evidence, "spec.json");
  await fs.writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  const log = openSync(join(evidence, "logs", "supervisor.log"), "a");
  const child = spawn(
    process.execPath,
    [new URL("./supervisor.mjs", import.meta.url).pathname, specPath],
    {
      detached: true,
      stdio: ["ignore", log, log],
      env: supervisorEnv(process.env, { model }),
      cwd: REPO,
    },
  );
  child.unref();
  // Identity, not just a pid: stop signals it only while pid AND start time
  // still match. Detached, so it leads its own process group.
  const supervisor = await processIdentity(child.pid).catch(() => null);
  await registry.update(id, { supervisorPid: child.pid, supervisor });

  const layout = instanceLayout(scratch, evidence);
  const deadline = Date.now() + 240_000;
  for (;;) {
    if (existsSync(layout.readyFile)) break;
    if (existsSync(join(evidence, "failed.json")) || !pidAlive(child.pid)) {
      const failed = await fs.readFile(join(evidence, "failed.json"), "utf8").catch(() => "{}");
      await registry.remove(id).catch(() => {});
      fail(
        `launch failed: ${JSON.parse(failed).error ?? "supervisor exited"}\n  evidence: ${evidence}`,
      );
    }
    if (Date.now() > deadline)
      fail(`launch did not become ready in 240s; evidence: ${evidence} (stop ${id})`);
    await new Promise((r) => setTimeout(r, 200));
  }
  const ready = JSON.parse(await fs.readFile(layout.readyFile, "utf8"));
  const cliMs = Math.round(performance.now() - started);
  if (flags.json) {
    out(JSON.stringify({ ...ready, evidence, cliMs }, null, 2));
    return;
  }
  const t = ready.timings;
  out(`instance: ${id}`);
  out(`evidence: ${evidence}`);
  out(
    `timings: electron→first window ${t.firstWindow - t.launchStart}ms · guard verified ${t.guardVerified}ms · ` +
      `fixture ${t.fixtureSeeded - t.guardVerified}ms · ready ${t.ready}ms (CLI wall ${cliMs}ms)`,
  );
  if (ready.memory)
    out(`memory: ${ready.memory.totalMb} MB across ${ready.memory.processes.length} processes`);
  out(
    `keychain guard: ACTIVE — ${ready.guard.trapped.length} safeStorage methods trapped; ${ready.guard.switches.join(" ")}`,
  );
  const s = ready.seeded;
  if (s?.project)
    out(
      `fixture: ${s.fixture} — ${s.project.name} (${s.project.prefix}), tickets ${s.tickets.map((x) => x.displayId).join(", ")}`,
    );
  else out(`fixture: ${s?.fixture}`);
  if (s?.model) out(`model: ${s.model.providerId}/${s.model.modelId} (${model})`);
  out(`next: volli-drive snapshot ${id}`);
}

/**
 * `doctor` with no instance: is the build we are ABOUT to launch guarded?
 * Static only — nothing is launched and no keychain is asked anything.
 */
async function preflight() {
  const carries = bundleCarriesGuard();
  // The same gate launch uses, so preflight cannot pass what launch refuses.
  const problems = launchProblems({ build: "dev", bundle: BUILT_MAIN });
  const bundleStat = await fs.stat(BUILT_MAIN).catch(() => null);
  if (!existsSync(ELECTRON)) problems.push(`Electron is not installed at ${ELECTRON}`);
  const entries = (await createRegistry().list()).filter((e) => e.live);
  const facts = await gitFacts();
  out(`${problems.length === 0 ? "READY" : "NOT READY"} — preflight for ${BUILT_MAIN}`);
  out(
    `  build: ${facts.commit.slice(0, 12)}${facts.dirty ? " (dirty)" : ""}; bundle built ${bundleStat ? bundleStat.mtime.toISOString() : "never"}`,
  );
  out(
    `  harness in bundle: ${carries ? "yes (keychain guard, home containment, shell recorder)" : "NO"}`,
  );
  out(`  live instances: ${entries.length}/3`);
  for (const p of problems) out(`  ✗ ${p}`);
  if (problems.length > 0) process.exitCode = 2;
}

// ---- reads that work after stop -------------------------------------------------

async function readLines(path) {
  return (await fs.readFile(path, "utf8").catch(() => "")).split("\n").filter(Boolean);
}

function evidenceFor(id) {
  if (!isInstanceId(id)) fail(`"${id ?? ""}" is not an instance id`);
  return instanceLayout("/nonexistent", join(evidenceRoot(), id));
}

async function consoleCmd(id, flags) {
  const layout = evidenceFor(id);
  let lines = (await readLines(layout.consoleLog)).map((line) => JSON.parse(line));
  if (flags.grep)
    lines = lines.filter((e) => e.text.toLowerCase().includes(String(flags.grep).toLowerCase()));
  const tail = Number(flags.tail ?? 50);
  for (const e of lines.slice(-tail)) out(`${e.at} [${e.type}] ${e.window}: ${e.text}`);
}

/**
 * Main-process stdout/stderr, plus — once VC-699's structured logs land — any
 * `logs/structured/*.jsonl` an instance writes. `--trace` follows one trace id
 * across all of them; until VC-699 it is a literal match on the id.
 */
async function logsCmd(id, flags) {
  const layout = evidenceFor(id);
  const structuredDir = join(layout.logsDir, "structured");
  const files = [layout.mainLog];
  for (const name of await fs.readdir(structuredDir).catch(() => [])) {
    if (name.endsWith(".jsonl")) files.push(join(structuredDir, name));
  }
  const match = (line) =>
    (!flags.grep || line.toLowerCase().includes(String(flags.grep).toLowerCase())) &&
    (!flags.trace || line.includes(String(flags.trace)));
  if (!flags.follow) {
    const lines = [];
    for (const file of files) lines.push(...(await readLines(file)).filter(match));
    for (const line of lines.slice(-Number(flags.tail ?? 80))) out(line);
    return;
  }
  const offsets = new Map(files.map((f) => [f, 0]));
  const until = flags.for ? Date.now() + Number(flags.for) : Infinity;
  while (Date.now() < until) {
    for (const file of files) {
      const text = await fs.readFile(file, "utf8").catch(() => "");
      const from = offsets.get(file);
      if (text.length > from) {
        for (const line of text.slice(from).split("\n").filter(Boolean)) if (match(line)) out(line);
        offsets.set(file, text.length);
      }
    }
    const entry = await createRegistry().get(id);
    if (!entry?.live) break;
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ---- state ----------------------------------------------------------------------

async function stateCmd(id, rest) {
  const [kind, ...args] = rest;
  const { layout } = await live(id);
  if (kind === "sql") {
    const checked = readOnlySql(args.join(" "));
    if (!checked.ok) fail(`refused: ${checked.reason}`);
    const { stdout } = await execFileAsync(
      "sqlite3",
      ["-readonly", "-json", layout.dbPath, checked.sql],
      {
        maxBuffer: 16 * 1024 * 1024,
      },
    ).catch((error) => fail(error.stderr || error.message));
    const rows = stdout.trim() ? JSON.parse(stdout) : [];
    out(JSON.stringify(rows, null, 2));
    return;
  }
  if (kind === "cli") {
    // The real CLI, aimed only at this instance's socket. The outer agent's
    // own VOLLI_SESSION/VOLLI_TOKEN never ride along (supervisorEnv strips
    // them), so the instance sees an unauthenticated actor: reads only.
    const env = {
      ...supervisorEnv(process.env),
      VOLLI_SOCKET: layout.appSocket,
      HOME: layout.home,
    };
    const [file, argv] = existsSync(layout.cliShim)
      ? [layout.cliShim, args]
      : [process.execPath, [BUILT_CLI, ...args]];
    const result = await execFileAsync(file, argv, { env, maxBuffer: 16 * 1024 * 1024 }).catch(
      (e) => e,
    );
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = typeof result.code === "number" ? result.code : 0;
    return;
  }
  fail('state takes `sql "<SELECT …>"` or `cli <volli args…>`');
}

// ---- stop without a supervisor --------------------------------------------------

/** Waits for the recorded supervisor to exit; SIGTERM→SIGKILL it if it does not. */
async function reapSupervisor(entry) {
  if (!entry.supervisor) return [];
  const deadline = Date.now() + 5_000;
  for (;;) {
    const table = await processTable();
    const still = ownedProcesses(table, [entry.supervisor]).filter(
      (p) => p.pid === entry.supervisor.pid,
    );
    if (still.length === 0) return [];
    if (Date.now() > deadline) return killExactly(still, { signal: "SIGTERM", graceMs: 3_000 });
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function stopUnreachable(entry, keepScratch, error) {
  // Recorded identities only: the supervisor, Electron, and the instance
  // members the supervisor recorded as they appeared. A group whose recorded
  // leader is gone claims nothing (ownedProcesses).
  const roots = [entry.supervisor, entry.electron, ...(entry.members ?? [])].filter(Boolean);
  const table = await processTable();
  const targets = ownedProcesses(table, roots);
  const supervisor = targets.filter((p) => p.pid === entry.supervisor?.pid);
  // Supervisor first, gracefully: its SIGTERM handler closes Electron.
  const signalled = await killExactly(supervisor, { signal: "SIGTERM", graceMs: 15_000 });
  // Then everything else we owned, by the identity seen before any kill.
  signalled.push(
    ...(await killExactly(
      targets.filter((p) => p.pid !== entry.supervisor?.pid),
      { signal: "SIGTERM", graceMs: 5_000 },
    )),
  );
  const unverified = [entry.supervisor, entry.electron]
    .filter(Boolean)
    .filter(
      (r) => !table.some((p) => p.pid === r.pid && p.started === r.started) && pidAlive(r.pid),
    );
  if (!keepScratch) await fs.rm(entry.scratch, { recursive: true, force: true });
  await createRegistry().remove(entry.id);
  return {
    evidence: entry.evidence,
    leftovers: signalled,
    note:
      `supervisor unreachable (${error.message}); signalled only recorded, identity-verified processes` +
      (unverified.length > 0
        ? `; left alone pid ${unverified.map((r) => r.pid).join(", ")} (reused by another process)`
        : ""),
  };
}

// ---- dispatch ----------------------------------------------------------------------

const { positional, flags } = parse(process.argv.slice(2));
const [command, id, ...rest] = positional;

// A refusal from the supervisor (stale generation, unknown ref, timeout) is
// an answer, not a crash: one line on stderr and exit 1, never a stack.
async function main() {
  switch (command) {
    case undefined:
    case "help":
    case "--help":
      out(HELP);
      break;
    case "launch":
      await launch(flags);
      break;
    case "list": {
      const entries = await createRegistry().list();
      if (flags.json) out(JSON.stringify(entries, null, 2));
      else if (entries.length === 0) out("no instances");
      else
        for (const e of entries)
          out(
            `${e.id}  ${e.live ? "live " : "dead "} electron=${e.electronPid ?? "-"} supervisor=${e.supervisorPid ?? "-"}  ${e.fixture}/${e.model}/${e.build}  ${e.evidence}`,
          );
      break;
    }
    case "preflight":
    case "doctor": {
      if (command === "preflight" || id === undefined) {
        await preflight();
        break;
      }
      const report = await call(id, "doctor");
      if (flags.json) {
        out(JSON.stringify(report, null, 2));
      } else {
        out(`${report.ok ? "OK" : "PROBLEMS"} — ${report.id}`);
        for (const p of report.problems) out(`  ✗ ${p}`);
        out(
          `  electron pid ${report.electron.pid} ${report.electron.alive ? "running" : "not running"}; supervisor pid ${report.supervisorPid}`,
        );
        out(
          `  build: ${report.build.kind} @ ${report.build.commit.slice(0, 12)}${report.build.dirty ? " (dirty)" : ""}; bundle carries guard: ${report.build.bundleCarriesGuard}; packaged: ${report.build.isPackaged}`,
        );
        const guardLive = report.guard.live;
        out(
          `  keychain guard: ${report.guard.active ? "ACTIVE" : "NOT ACTIVE"} — trapped ${guardLive ? Object.values(guardLive.trapped).filter(Boolean).length : 0}/${guardLive ? Object.keys(guardLive.trapped).length : 0}; mock keychain ${guardLive?.mockKeychainSwitch}; password-store ${guardLive?.passwordStore}; violations ${report.guard.violations.length}`,
        );
        const recorded = guardLive?.recorded ?? {};
        out(
          `  shell recorder: ${Object.values(recorded).filter(Boolean).length}/${Object.keys(recorded).length} of openExternal/openPath/showItemInFolder/trashItem record only; external requests ${report.isolation.externalRequests}`,
        );
        const iso = report.isolation;
        out(
          `  isolation: userData ${iso.userData} (inside: ${iso.userDataInside}); home inside: ${iso.homeInside}; agent home ${iso.agentHome} (inside: ${iso.agentHomeInside}); db inside: ${iso.dbInside}`,
        );
        out(
          `  app socket ${iso.appSocket} (ours: ${iso.appSocketOwned}); fake provider ${iso.providerUrl ?? "-"}`,
        );
        if (report.model) out(`  model: ${report.model.providerId}/${report.model.modelId}`);
        out(`  windows: ${report.windows.map((w) => `${w.name} "${w.title}"`).join(", ")}`);
        if (report.memory) out(`  memory: ${report.memory.totalMb} MB`);
        out(`  evidence: ${report.evidence}`);
      }
      if (!report.ok) process.exitCode = 2;
      break;
    }
    case "snapshot":
      printSnapshot(
        await call(id, "snapshot", { window: flags.window, depth: flags.depth }),
        flags.find,
      );
      break;
    case "find": {
      const query = rest.join(" ") || flags.text;
      if (!query) fail("find needs text");
      const result = await call(id, "find", { query, window: flags.window });
      out(`generation: ${result.generation} · window: ${result.window}`);
      out(result.matches.length ? result.matches.join("\n") : `(no node matches "${query}")`);
      break;
    }
    case "act": {
      const result = await call(id, "act", {
        gen: flags.gen,
        ref: flags.ref,
        kind: flags.kind,
        text: flags.text,
        key: flags.key,
        direction: flags.direction,
        waitMs: flags.waitMs,
        window: flags.window,
      });
      const a = result.action;
      out(
        `acted: ${a.kind}${a.ref ? ` ${a.ref}` : ""}${a.key ? ` ${a.key}` : ""}${a.text !== undefined ? ` "${a.text}"` : ""} (${a.ms}ms)`,
      );
      printSnapshot(result.snapshot, flags.find);
      break;
    }
    case "wait": {
      const result = await call(
        id,
        "wait",
        {
          text: flags.text,
          gone: Boolean(flags.gone),
          timeout: flags.timeout,
          window: flags.window,
        },
        Number(flags.timeout ?? 15_000) + 30_000,
      );
      out(
        `waited: ${result.waitedMs}ms for "${flags.text}" to ${flags.gone ? "disappear" : "appear"}`,
      );
      printSnapshot(result.snapshot, flags.find);
      break;
    }
    case "screenshot": {
      const result = await call(id, "screenshot", { name: flags.name, window: flags.window });
      out(result.path);
      break;
    }
    case "windows":
      for (const w of await call(id, "windows")) out(`${w.name}  "${w.title}"  ${w.url}`);
      break;
    case "metrics": {
      const m = await call(id, "metrics");
      out(`total: ${m.totalMb} MB`);
      for (const p of m.processes)
        out(`  ${p.type.padEnd(10)} pid ${p.pid}  ${Math.round(p.workingSetKb / 1024)} MB`);
      break;
    }
    case "console":
      await consoleCmd(id, flags);
      break;
    case "logs":
      await logsCmd(id, flags);
      break;
    case "state": {
      // Everything after the state kind passes through verbatim (the volli
      // CLI's own --flags included), so it is cut from raw argv, not `parse`.
      const raw = process.argv.slice(2);
      const at = raw.indexOf(id);
      await stateCmd(id, raw.slice(at + 1));
      break;
    }
    case "stop": {
      const entry = await instance(id);
      if (!entry) fail(`no running instance ${id}`);
      const layout = instanceLayout(entry.scratch, entry.evidence);
      let result;
      try {
        result = await request(
          layout.driveSocket,
          "stop",
          { keepScratch: Boolean(flags.keepScratch) },
          { timeoutMs: 60_000 },
        );
        // It exits on its own once it has answered; make sure it did, and
        // reap it (by identity) if it lingers.
        const lingering = await reapSupervisor(entry);
        result = { ...result, leftovers: [...(result.leftovers ?? []), ...lingering] };
      } catch (error) {
        // The supervisor did not answer. Stop what we can PROVE we started —
        // the recorded supervisor and Electron, each only while its pid still
        // has the start time recorded at launch, plus their process groups
        // and descendants — and nothing matched by name or path. The
        // supervisor gets SIGTERM first so it can still write its manifest.
        result = await stopUnreachable(entry, Boolean(flags.keepScratch), error);
      }
      out(`stopped ${id}`);
      if (result.note) out(`  ${result.note}`);
      out(`  evidence kept: ${result.evidence}`);
      out(`  processes signalled: ${result.leftovers.length}`);
      for (const p of result.leftovers)
        out(`    ${p.signal} ${p.pid} ${String(p.command ?? "").slice(0, 100)}`);
      break;
    }
    default:
      fail(`unknown command "${command}"\n\n${HELP}`);
  }
}

main().catch((error) => fail(error?.message ?? String(error)));
