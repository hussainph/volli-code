/**
 * VC-354 React/Zustand sidebar benchmark.
 *
 * Run the lab in another terminal, then drive both load arms:
 *
 *   pnpm lab
 *   node apps/desktop/e2e/sidebar-store-bench.mjs \
 *     --label before --samples 24 --busy-cores 1 \
 *     --output /tmp/vc354-before.json
 *
 * The page is the shipped `ActiveSessions` component over the deterministic
 * `real` fixture (1,198 Sessions / 392 tickets / 50 worktrees). React Profiler
 * callbacks, commit wall time and Scheduler long tasks are emitted together.
 * The busy arm starts the named number of CPU workers; run before and after
 * back-to-back on one machine because absolute development-build timings are
 * not portable.
 *
 * MANUALLY-RUN (needs `pnpm lab` and Chromium); not wired into `vp test`.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, resolve } from "node:path";

import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const PORT = process.env.VOLLI_LAB_PORT ?? "5174";
const LAB = `http://localhost:${PORT}/lab/#sidebar-performance`;
const LABEL = flag("label", "run");
const SAMPLES = Number.parseInt(flag("samples", "24"), 10);
const BUSY_CORES = Number.parseInt(flag("busy-cores", "1"), 10);
const OUTPUT = flag("output", "");
const CONCURRENT_SESSIONS = Number.parseInt(flag("concurrent-sessions", "0"), 10) || null;

if (!Number.isInteger(SAMPLES) || SAMPLES <= 0) {
  throw new Error(`--samples must be a positive integer (received ${String(SAMPLES)})`);
}
if (!Number.isInteger(BUSY_CORES) || BUSY_CORES < 0) {
  throw new Error(`--busy-cores must be a non-negative integer (received ${String(BUSY_CORES)})`);
}

function resolveBrowser() {
  const override = process.env.VOLLI_CHROME ?? process.env.CHROME_PATH;
  if (override !== undefined && override !== "") return override;
  let registry;
  try {
    registry = chromium.executablePath();
  } catch {
    registry = undefined;
  }
  if (registry !== undefined && existsSync(registry)) return registry;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = candidates.find((path) => existsSync(path));
  if (found !== undefined) return found;
  throw new Error("no Chromium found — install one or set VOLLI_CHROME");
}

async function assertLabIsServing() {
  try {
    const response = await fetch(LAB, { redirect: "follow" });
    if (response.ok) return;
    throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new Error(
      `the lab is not serving ${LAB} (${error instanceof Error ? error.message : String(error)}) — start it with \`pnpm lab\``,
      { cause: error },
    );
  }
}

const cpuProgram = `
  let value = 0x12345678;
  for (;;) {
    for (let at = 0; at < 1000000; at += 1) {
      value = Math.imul(value ^ (value >>> 13), 0x5bd1e995);
    }
    if (value === 42) process.stdout.write("");
  }
`;

function startBusyWorkers(count) {
  return Array.from({ length: count }, () =>
    spawn(process.execPath, ["-e", cpuProgram], { stdio: "ignore" }),
  );
}

function stopBusyWorkers(workers) {
  for (const worker of workers) worker.kill("SIGTERM");
}

function git(...gitArgs) {
  const result = spawnSync("git", gitArgs, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function measuredSourceHash() {
  const hash = createHash("sha256");
  for (const path of [
    "apps/desktop/src/renderer/src/components/sidebar/active-sessions.tsx",
    "apps/desktop/src/renderer/src/components/sidebar/active-session-listing.ts",
    "apps/desktop/src/renderer/lab/scratches/sidebar-performance.tsx",
  ]) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(resolve(path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function rankedRows(scenarios) {
  return Object.entries(scenarios)
    .map(([scenario, result]) => {
      const component = result.profilers.ActiveSessions;
      return {
        scenario,
        writes: result.writes,
        renders: component?.commits ?? 0,
        totalActualMs: component?.totalActualMs ?? 0,
        p95ActualMs: component?.p95ActualMs ?? 0,
        longTasks: result.longTasks.count,
        maxLongTaskMs: result.longTasks.maxMs,
      };
    })
    .toSorted((left, right) => right.totalActualMs - left.totalActualMs);
}

await assertLabIsServing();
const browser = await chromium.launch({ executablePath: resolveBrowser(), headless: true });
const arms = [];

for (const arm of ["idle", "busy"]) {
  const workers = arm === "busy" ? startBusyWorkers(BUSY_CORES) : [];
  if (workers.length > 0) await new Promise((resolveWait) => setTimeout(resolveWait, 750));
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems = [];
  page.on("pageerror", (error) => problems.push(`throw: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (message.location().url.endsWith("/favicon.ico")) return;
    problems.push(`console: ${message.text()}`);
  });

  try {
    await page.goto(LAB, { waitUntil: "networkidle" });
    await page.waitForFunction(() => window.sidebarPerf?.ready === true, null, { timeout: 60_000 });
    const measured = await page.evaluate(
      async (samples) => window.sidebarPerf?.run(samples),
      SAMPLES,
    );
    if (measured === undefined) throw new Error("sidebar performance API returned no report");
    arms.push({
      arm,
      busyCores: workers.length,
      ...measured,
      ranked: rankedRows(measured.scenarios),
      problems,
    });
  } finally {
    await page.close();
    stopBusyWorkers(workers);
  }
}

await browser.close();

const report = {
  benchmark: "vc354-react-zustand-sidebar",
  label: LABEL,
  recordedAt: new Date().toISOString(),
  buildSha: git("rev-parse", "HEAD"),
  dirty: git("status", "--short") !== "",
  measuredSourceSha256: measuredSourceHash(),
  fixture: "real",
  samples: SAMPLES,
  concurrentVolliSessions: CONCURRENT_SESSIONS,
  machine: {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    osVersion: os.version(),
    cpu: os.cpus()[0]?.model ?? "unknown",
    logicalCpus: os.cpus().length,
    memoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    node: process.version,
  },
  arms,
};

console.log(`\nVC-354 sidebar store benchmark — ${LABEL}`);
console.log(`${report.machine.cpu} · ${report.machine.memoryGb} GB · SHA ${report.buildSha}`);
for (const arm of arms) {
  console.log(`\n${arm.arm.toUpperCase()} (${arm.busyCores} synthetic busy cores)`);
  console.log("trigger\twrites\trenders\tReact ms\tp95 ms\tlong tasks\tmax long ms");
  for (const row of arm.ranked) {
    console.log(
      [
        row.scenario,
        row.writes,
        row.renders,
        row.totalActualMs,
        row.p95ActualMs,
        row.longTasks,
        row.maxLongTaskMs,
      ].join("\t"),
    );
  }
  console.log("\npersisted store\tbytes\taction p50\taction p95\tpartialize p95\tJSON p95");
  for (const [name, result] of Object.entries(arm.persistence)) {
    console.log(
      [
        name,
        result.payloadBytes,
        result.actionWallMs.median,
        result.actionWallMs.p95,
        result.partializeMs.p95,
        result.jsonSerializeMs.p95,
      ].join("\t"),
    );
  }
  console.log("\nderivation\tp50 ms\tp95 ms\tmax ms");
  for (const [name, result] of Object.entries(arm.derivation)) {
    console.log([name, result.median, result.p95, result.max].join("\t"));
  }
  if (arm.problems.length > 0) console.log("problems:", arm.problems.slice(0, 5));
}

if (OUTPUT !== "") {
  const path = resolve(OUTPUT);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\nreport: ${path}`);
}
