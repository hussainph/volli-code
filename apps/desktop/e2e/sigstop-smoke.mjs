/**
 * SIGSTOP warm-park smoke for parallel agent sessions (NOT wired into `vp test`).
 *
 * Question under test (issue #51): can we "warm-park" idle claude sessions by
 * SIGSTOPping their process trees — so macOS compresses/pages-out their memory
 * under pressure — and resume them instantly with SIGCONT, instead of the
 * kill + `claude --resume` cold path (multi-second boot + transcript replay +
 * MCP handshake)?
 *
 * Phases:
 *   1. Boot N claude sessions in raw PTYs (no Electron app involved).
 *   2. SIGSTOP the process trees of all but CONTROL_RUNNING of them.
 *   3. Staged memory pressure (memory_pressure -S -l warn, then critical),
 *      snapshotting per-pid RSS + CMPRS (top) at every stage: do stopped
 *      trees compress/page-out more than the running controls?
 *   4. Resume: keystroke-to-output latency after SIGCONT vs a running control;
 *      queued-keystroke behavior while stopped; one real API turn to prove the
 *      resumed agent is fully functional.
 *
 *   Run (Electron-ABI node-pty needs Electron's node):
 *     ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
 *       apps/desktop/e2e/sigstop-smoke.mjs [N_SESSIONS]
 */
import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const pty = require("node-pty");

const N_SESSIONS = Number(process.argv[2] ?? 8);
const CONTROL_RUNNING = 2; // sessions left running during pressure, for comparison
const SCRATCH =
  process.env.VOLLI_SMOKE_DIR ?? (await fs.mkdtemp(join(os.tmpdir(), "volli-sigstop-smoke-")));
await fs.mkdir(SCRATCH, { recursive: true });
console.log("scratch:", SCRATCH);
console.log(`sessions: ${N_SESSIONS} (${CONTROL_RUNNING} running controls)\n`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- process helpers ---------------------------------------------------------

/** All descendant PIDs of `rootPid` (breadth-first pgrep -P). */
function descendantPids(rootPid) {
  const out = [];
  let frontier = [rootPid];
  while (frontier.length > 0) {
    const next = [];
    for (const pid of frontier) {
      let kids = [];
      try {
        kids = execFileSync("/usr/bin/pgrep", ["-P", String(pid)], { encoding: "utf8" })
          .split("\n")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n) && n > 0);
      } catch {
        // pgrep exits 1 when a pid has no children
      }
      out.push(...kids);
      next.push(...kids);
    }
    frontier = next;
  }
  return out;
}

/** Root + descendants. Stop order: root first (no SIGCHLD reactions), then kids. */
function treePids(rootPid) {
  return [rootPid, ...descendantPids(rootPid)];
}

function signalTree(rootPid, signal) {
  const pids = signal === "SIGCONT" ? treePids(rootPid).toReversed() : treePids(rootPid);
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // process gone
    }
  }
  return pids.length;
}

/** Parses top's K/M/G/B-suffixed memory cells into MB. */
const toMB = (s) => {
  const m = /^([\d.]+)([KMGB])[+-]?$/.exec(s);
  if (!m) return 0;
  const v = Number(m[1]);
  return m[2] === "G" ? v * 1024 : m[2] === "K" ? v / 1024 : m[2] === "B" ? v / (1024 * 1024) : v;
};

/** Per-pid { rssMB, cmprsMB, state } via one `top -l 1` pass. */
function topSnapshot(pids) {
  const want = new Set(pids);
  const result = new Map();
  const raw = execFileSync(
    "/usr/bin/top",
    ["-l", "1", "-stats", "pid,state,mem,cmprs,command", "-o", "pid", "-n", "2000"],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  for (const line of raw.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!want.has(pid)) continue;
    result.set(pid, { state: m[2], rssMB: toMB(m[3]), cmprsMB: toMB(m[4]), command: m[5].trim() });
  }
  return result;
}

function vmStat() {
  const raw = execFileSync("/usr/bin/vm_stat", { encoding: "utf8" });
  const page = Number(/page size of (\d+)/.exec(raw)?.[1] ?? 16384);
  const grab = (name) => {
    const m = new RegExp(`${name}:\\s+(\\d+)`).exec(raw);
    return m ? (Number(m[1]) * page) / (1024 * 1024) : 0;
  };
  const swap = execFileSync("/usr/sbin/sysctl", ["-n", "vm.swapusage"], { encoding: "utf8" });
  return {
    compressorMB: grab("Pages occupied by compressor"),
    swap: swap.trim(),
  };
}

// ---- session harness ----------------------------------------------------------

class Session {
  constructor(index, cwd, env) {
    this.index = index;
    this.output = "";
    this.lastDataAt = 0;
    this.term = pty.spawn("claude", [], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd,
      env,
    });
    this.pid = this.term.pid;
    this.term.onData((d) => {
      this.output += d;
      if (this.output.length > 400_000) this.output = this.output.slice(-200_000);
      this.lastDataAt = Date.now();
    });
  }

  write(s) {
    this.term.write(s);
  }

  /** ms until the next PTY data event, or null on timeout. */
  async timeToNextData(timeoutMs = 5000) {
    const start = Date.now();
    const seenAt = this.lastDataAt;
    while (Date.now() - start < timeoutMs) {
      if (this.lastDataAt > seenAt) return this.lastDataAt - start;
      await sleep(5);
    }
    return null;
  }

  async waitForOutput(needle, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.output.includes(needle)) return true;
      await sleep(250);
    }
    return false;
  }
}

// ---- measurement over the whole fleet ------------------------------------------

const sum = (rowsSel, key) => rowsSel.reduce((a, r) => a + r[key], 0);

function fleetSnapshot(label, sessions, stoppedSet, snapshots) {
  const trees = new Map(sessions.map((s) => [s.index, treePids(s.pid)]));
  const top = topSnapshot([...trees.values()].flat());
  const rows = [];
  for (const s of sessions) {
    const pids = trees.get(s.index);
    let rssMB = 0;
    let cmprsMB = 0;
    const states = [];
    for (const pid of pids) {
      const t = top.get(pid);
      if (!t) continue;
      rssMB += t.rssMB;
      cmprsMB += t.cmprsMB;
      states.push(t.state);
    }
    rows.push({
      session: s.index,
      parked: stoppedSet.has(s.index),
      procs: pids.length,
      rssMB: Math.round(rssMB),
      cmprsMB: Math.round(cmprsMB),
      states: [...new Set(states)].join(","),
    });
  }
  const parked = rows.filter((r) => r.parked);
  const running = rows.filter((r) => !r.parked);
  const snap = { label, vm: vmStat(), rows };
  snapshots.push(snap);
  console.log(`\n[snap] ${label}`);
  console.log(
    `  parked : ${parked.length}× rss=Σ${sum(parked, "rssMB")}MB cmprs=Σ${sum(parked, "cmprsMB")}MB`,
  );
  console.log(
    `  running: ${running.length}× rss=Σ${sum(running, "rssMB")}MB cmprs=Σ${sum(running, "cmprsMB")}MB`,
  );
  console.log(`  system : compressor=${snap.vm.compressorMB.toFixed(0)}MB swap=[${snap.vm.swap}]`);
  for (const r of rows) {
    console.log(
      `    s${r.session} ${r.parked ? "PARKED " : "running"} procs=${r.procs} rss=${r.rssMB}MB cmprs=${r.cmprsMB}MB states=${r.states}`,
    );
  }
  return snap;
}

// ---- main -----------------------------------------------------------------------

async function main() {
  const snapshots = [];
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: undefined };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDECODE") || key.startsWith("CLAUDE_CODE") || env[key] === undefined)
      delete env[key];
  }

  // One shared cwd so the trust prompt behaves identically for every session.
  const wsDir = await fs.realpath(await fs.mkdtemp(join(SCRATCH, "ws-")));

  console.log("phase 1: booting sessions…");
  const sessions = [];
  for (let i = 0; i < N_SESSIONS; i++) {
    sessions.push(new Session(i, wsDir, env));
    await sleep(400); // stagger spawns a little
  }
  await sleep(8000); // let TUIs boot
  for (const s of sessions) s.write("\r"); // accept trust dialog if shown
  await sleep(4000);
  const booted = sessions.filter((s) => s.output.length > 0);
  console.log(
    `booted ${booted.length}/${N_SESSIONS} sessions (pids: ${sessions.map((s) => s.pid).join(", ")})`,
  );
  if (booted.length < N_SESSIONS) throw new Error("not all sessions produced output");
  await sleep(8000); // settle: MCP servers up, idle at prompt

  const stoppedSet = new Set(sessions.slice(0, N_SESSIONS - CONTROL_RUNNING).map((s) => s.index));
  fleetSnapshot("baseline: all running, idle", sessions, new Set(), snapshots);

  // === Phase 2: park all but the controls ======================================
  console.log("\nphase 2: SIGSTOP process trees…");
  for (const s of sessions) {
    if (stoppedSet.has(s.index)) {
      const n = signalTree(s.pid, "SIGSTOP");
      console.log(`  s${s.index}: stopped ${n} processes`);
    }
  }
  await sleep(2000);
  fleetSnapshot("parked (pre-pressure)", sessions, stoppedSet, snapshots);

  // Queued-keystroke probe: input to a stopped session must not produce output…
  const probe = sessions[0];
  probe.write("q");
  const leaked = await probe.timeToNextData(2000);
  console.log(
    `\nqueued-input probe: output while stopped -> ${leaked === null ? "none (good)" : `LEAKED after ${leaked}ms`}`,
  );

  // === Phase 3: staged REAL memory pressure ====================================
  // -S (simulate) only fakes the notification level; the compressor only works
  // on genuine page shortage, so allocate for real: first hold free memory at
  // 10%, then push to the "warn" notification level. No "critical" — this runs
  // on a live dev machine.
  const stages = [
    { label: "free≈10%", args: ["-p", "10"] },
    { label: "warn level", args: ["-l", "warn"] },
  ];
  for (const stage of stages) {
    console.log(`\nphase 3: memory_pressure ${stage.args.join(" ")} (45s)…`);
    const mp = spawn("/usr/bin/memory_pressure", stage.args, { stdio: "ignore" });
    await sleep(45000);
    fleetSnapshot(`under real pressure (${stage.label}, 45s)`, sessions, stoppedSet, snapshots);
    mp.kill("SIGINT");
    await sleep(5000);
  }
  await sleep(10000);
  fleetSnapshot("post-pressure (released)", sessions, stoppedSet, snapshots);

  // === Phase 4: resume =========================================================
  console.log("\nphase 4: resume…");

  // Keystroke latency on a running control (baseline).
  const control = sessions[N_SESSIONS - 1];
  control.write("x");
  const controlLatency = await control.timeToNextData(5000);
  control.write("\x7f"); // backspace to clean up

  // SIGCONT latency: continue the tree, then time keystroke -> output.
  const resumed = sessions[0];
  const t0 = Date.now();
  signalTree(resumed.pid, "SIGCONT");
  const contMs = Date.now() - t0;
  // The queued "q" from the stopped-input probe should flush now.
  const flushMs = await resumed.timeToNextData(5000);
  resumed.write("\x7f\x7f"); // clear probe chars
  resumed.write("y");
  const resumedLatency = await resumed.timeToNextData(5000);
  resumed.write("\x7f");
  console.log(`  control keystroke latency (running): ${controlLatency}ms`);
  console.log(
    `  SIGCONT delivery: ${contMs}ms; queued-input flush: ${flushMs}ms; keystroke after resume: ${resumedLatency}ms`,
  );

  // Full-turn probe: the resumed agent must still complete a real API turn.
  console.log("  full-turn probe on resumed session (1 tiny API call)…");
  resumed.write("Reply with exactly SIGSTOP_OK and nothing else\r");
  const turnStart = Date.now();
  const ok = await resumed.waitForOutput("SIGSTOP_OK", 90000);
  console.log(
    `  full turn after resume: ${ok ? `completed in ${((Date.now() - turnStart) / 1000).toFixed(1)}s` : "FAILED/TIMEOUT"}`,
  );

  // Wake the rest, verify all trees resume to running state.
  for (const s of sessions)
    if (stoppedSet.has(s.index) && s !== resumed) signalTree(s.pid, "SIGCONT");
  await sleep(3000);
  fleetSnapshot("all resumed", sessions, new Set(), snapshots);

  const report = {
    nSessions: N_SESSIONS,
    controlRunning: CONTROL_RUNNING,
    resume: { controlLatency, contMs, flushMs, resumedLatency, fullTurnOk: ok },
    snapshots,
  };
  await fs.writeFile(join(SCRATCH, "sigstop-report.json"), JSON.stringify(report, null, 2));
  console.log("\nreport:", join(SCRATCH, "sigstop-report.json"));

  // Teardown: exit claudes cleanly.
  for (const s of sessions) {
    try {
      s.term.kill();
    } catch {
      /* already gone */
    }
  }
}

try {
  await main();
  console.log("\nSIGSTOP SMOKE COMPLETE");
  process.exit(0);
} catch (error) {
  console.error("\nSIGSTOP SMOKE ABORTED:", error?.stack ?? error);
  process.exit(1);
}
