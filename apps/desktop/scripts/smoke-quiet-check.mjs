#!/usr/bin/env node
/**
 * Prove the native quiet-window invariants while the ordinary smoke runner runs.
 *
 * This wraps `run-smokes.mjs`; it does not replace or reschedule it. A JXA
 * sampler polls macOS every 250 ms without Accessibility or Screen Recording
 * permission and attributes only NEW applications whose executable is the dev
 * Electron binary or VOLLI_SMOKE_APP_BINARY.
 *
 * Usage:
 *   node apps/desktop/scripts/smoke-quiet-check.mjs --tier boot --jobs 4
 *   node apps/desktop/scripts/smoke-quiet-check.mjs --assert-stationary-cursor
 *   node apps/desktop/scripts/smoke-quiet-check.mjs --require-host-input
 *
 * The cursor assertion is for an unattended run. The host-input assertion is
 * the complementary attended proof: type and click in another app while the
 * suite runs. It requires native key and click activity while a smoke app is
 * present, and the same report proves that no smoke app became active.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { quietSmokeVerdict } from "./smoke-quiet-check-logic.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(SCRIPT_DIR, "..");
const RUNNER = join(SCRIPT_DIR, "run-smokes.mjs");
const SAMPLER = join(SCRIPT_DIR, "smoke-quiet-sampler.jxa");
const DEV_ELECTRON = join(
  APP_DIR,
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
  "Contents",
  "MacOS",
  "Electron",
);
const SAMPLE_INTERVAL_SECONDS = "0.25";

function usage() {
  process.stdout.write(
    "Usage: node apps/desktop/scripts/smoke-quiet-check.mjs " +
      "[--assert-stationary-cursor | --require-host-input] [run-smokes args...]\n",
  );
}

function parseArgs(argv) {
  let assertStationaryCursor = false;
  let requireHostInput = false;
  const runnerArgs = [];
  for (const arg of argv) {
    if (arg === "--assert-stationary-cursor") assertStationaryCursor = true;
    else if (arg === "--require-host-input") requireHostInput = true;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else runnerArgs.push(arg);
  }
  if (assertStationaryCursor && requireHostInput) {
    throw new Error("choose either --assert-stationary-cursor or --require-host-input");
  }
  return { help: false, assertStationaryCursor, requireHostInput, runnerArgs };
}

function candidateExecutables() {
  const candidates = [DEV_ELECTRON];
  if (process.env.VOLLI_SMOKE_APP_BINARY) {
    candidates.push(resolve(process.env.VOLLI_SMOKE_APP_BINARY));
  }
  const existing = candidates.filter((candidate) => existsSync(candidate));
  if (existing.length === 0) {
    throw new Error(
      "no smoke app executable found; run pnpm -C apps/desktop run ensure:electron " +
        "or set VOLLI_SMOKE_APP_BINARY",
    );
  }
  return existing;
}

function startSampler(stopPath, candidates) {
  const child = spawn(
    "/usr/bin/osascript",
    ["-l", "JavaScript", SAMPLER, stopPath, SAMPLE_INTERVAL_SECONDS, ...candidates],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const closed = once(child, "close");
  let output = "";
  let ready = false;
  let readyResolve;
  let readyReject;
  let readyTimer;
  const readyPromise = new Promise((resolvePromise, rejectPromise) => {
    readyResolve = resolvePromise;
    readyReject = rejectPromise;
    readyTimer = setTimeout(
      () => rejectPromise(new Error("native sampler did not become ready in 5s")),
      5000,
    );
  });
  const collect = (chunk) => {
    output += chunk.toString();
    if (!ready && output.includes("READY")) {
      ready = true;
      clearTimeout(readyTimer);
      readyResolve();
    }
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.once("error", (error) => readyReject(error));
  child.once("close", (code) => {
    if (!ready) {
      clearTimeout(readyTimer);
      readyReject(new Error(`native sampler exited ${code ?? "without a code"}: ${output.trim()}`));
    }
  });
  return { child, closed, output: () => output, ready: readyPromise };
}

let activeRunner = null;
async function runSmokes(runnerArgs) {
  const child = spawn(process.execPath, [RUNNER, ...runnerArgs], {
    cwd: resolve(APP_DIR, "..", ".."),
    env: process.env,
    stdio: "inherit",
  });
  activeRunner = child;
  try {
    const [code, signal] = await once(child, "close");
    return { code: code ?? 1, signal };
  } finally {
    activeRunner = null;
  }
}

function samplerReport(output) {
  const line = output
    .split(/\r?\n/u)
    .toReversed()
    .find((candidate) => candidate.trim().startsWith("{"));
  if (!line) throw new Error(`native sampler produced no report: ${output.trim()}`);
  return JSON.parse(line);
}

function printReport(report, { assertStationaryCursor, requireHostInput }) {
  const { start, end, maxDistanceFromStart } = report.cursor;
  process.stdout.write(
    `\nNative quiet-window sample: ${report.samples} polls; ` +
      `smoke=${report.smokeAppSamples} polls/${report.smokeAppCount} apps; ` +
      `frontmost=${report.frontmostSamples}; active=${report.activeSamples}; ` +
      `regular/Dock=${report.regularPolicySamples}\n` +
      `Cursor: start=${start.map((value) => value.toFixed(1)).join(",")} ` +
      `end=${end.map((value) => value.toFixed(1)).join(",")} ` +
      `max displacement=${maxDistanceFromStart.toFixed(1)}px` +
      `${assertStationaryCursor ? " (asserted stationary)" : " (reported)"}\n` +
      `Host input while smoke apps ran: key=${report.hostKeyInputSamples} ` +
      `click=${report.hostClickInputSamples}` +
      `${requireHostInput ? " (asserted)" : " (reported, not asserted)"}\n`,
  );
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
  process.exit(0);
}
if (process.platform !== "darwin") {
  console.error("smoke-quiet-check is macOS-only");
  process.exit(1);
}

const scratch = await mkdtemp(join(os.tmpdir(), "volli-smoke-quiet-check-"));
const stopPath = join(scratch, "stop");
let sampler;
let executionError = null;
let smokeResult = { code: 1, signal: null };
let interruptedBy = null;
const stopOnSignal = (signal) => {
  interruptedBy = signal;
  writeFileSync(stopPath, "stop\n");
  activeRunner?.kill(signal);
};
const onInterrupt = () => stopOnSignal("SIGINT");
const onTerminate = () => stopOnSignal("SIGTERM");
process.once("SIGINT", onInterrupt);
process.once("SIGTERM", onTerminate);
try {
  try {
    sampler = startSampler(stopPath, candidateExecutables());
    await sampler.ready;
    smokeResult = await runSmokes(args.runnerArgs);
  } catch (error) {
    executionError = error;
  } finally {
    await writeFile(stopPath, "stop\n").catch(() => undefined);
  }

  try {
    if (!sampler) throw new Error("native sampler did not start");
    await sampler.closed;
    const report = samplerReport(sampler.output());
    printReport(report, args);
    const verdict = quietSmokeVerdict(report, {
      assertStationaryCursor: args.assertStationaryCursor,
      requireHostInput: args.requireHostInput,
    });
    if (verdict.ok) process.stdout.write("QUIET WINDOW CHECK PASSED\n");
    else {
      for (const failure of verdict.failures)
        process.stderr.write(`QUIET WINDOW CHECK FAILED: ${failure}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`QUIET WINDOW CHECK FAILED: ${error?.message ?? error}`);
    process.exitCode = 1;
  }

  if (executionError) {
    console.error(`smoke-quiet-check failed: ${executionError?.message ?? executionError}`);
    process.exitCode = 1;
  }
} finally {
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onTerminate);
  await rm(scratch, { recursive: true, force: true });
}

if (smokeResult.code !== 0) process.exitCode = smokeResult.code;
if (interruptedBy) {
  console.error(`smoke-quiet-check interrupted by ${interruptedBy}`);
  process.exitCode = 1;
}
if (smokeResult.signal) {
  console.error(`smoke runner exited on ${smokeResult.signal}`);
  process.exitCode = 1;
}
