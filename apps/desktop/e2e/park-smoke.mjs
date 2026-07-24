/**
 * Live end-to-end smoke for the SIGSTOP warm-park tier (decision #32, issue
 * #51). NOT wired into `vp test` — run standalone against the built app.
 *
 * Question under test: does the real app park exactly the right sessions and
 * wake them invisibly? Specifically:
 *   1. A hidden idle session's shell tree reaches state T (SIGSTOP'd) after
 *      the shrunk idle threshold + two sweep samples.
 *   2. The visible session is never parked, no matter how idle.
 *   3. Selecting a parked session's tab wakes it (state leaves T) within ~2s.
 *   4. A hidden idle session holding a TCP LISTEN socket (dev-server stand-in:
 *      `nc -l`) is never parked.
 *   5. The tab strip shows the parked badge while parked.
 *   6. Breathe duty cycle: a background timer pending in a parked tree still
 *      fires (one sweep late at worst), the session wakes on its output, and
 *      re-parks once the work is done — no silent failure while frozen.
 *
 *   Run:
 *     pnpm -C apps/desktop run build
 *     node apps/desktop/e2e/park-smoke.mjs
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron } from "playwright-core";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const APP_DIR = join(REPO, "apps", "desktop");
const ELECTRON = join(
  APP_DIR,
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
  "Contents",
  "MacOS",
  "Electron",
);

// Shrunk timers: idle after 3s, sweep every 1s → auto-park lands ~5s after the
// last activity (threshold + two quiet CPU samples). The breathe window is
// shrunk too so parked shells spend most of each sweep in state T and the
// state checks stay deterministic.
const PARK_IDLE_MS = 3000;
const PARK_SWEEP_MS = 1000;
const PARK_BREATHE_MS = 300;
const PARK_SETTLE_MS = PARK_IDLE_MS + 4 * PARK_SWEEP_MS + 2000;

const SCRATCH =
  process.env.VOLLI_SMOKE_DIR ?? (await fs.mkdtemp(join(os.tmpdir(), "volli-park-smoke-")));
await fs.mkdir(SCRATCH, { recursive: true });
console.log("scratch:", SCRATCH, "\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

// ---- process helpers ---------------------------------------------------------

/** "T" (stopped), "S"/"R"/… — first letter of ps state, or null when gone. */
function processState(pid) {
  try {
    const out = execFileSync("/bin/ps", ["-o", "state=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    return out === "" ? null : out[0];
  } catch {
    return null; // exited
  }
}

/** Polls until `pid` reaches (or leaves, per `want`) state T; returns final state. */
async function waitForState(pid, want, timeoutMs) {
  const start = Date.now();
  let state = processState(pid);
  while (Date.now() - start < timeoutMs) {
    state = processState(pid);
    if (want === "stopped" && state === "T") return state;
    if (want === "running" && state !== null && state !== "T") return state;
    await sleep(250);
  }
  return state;
}

/** Reads the `$$` pid a tab's shell wrote to its marker file. */
async function shellPidFromMarker(markerPath, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const text = (await fs.readFile(markerPath, "utf8")).trim();
      const pid = Number.parseInt(text, 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // not written yet
    }
    await sleep(200);
  }
  throw new Error(`shell pid marker never appeared: ${markerPath}`);
}

// ---- terminal interaction (same recipe as memory-smoke) -----------------------

async function focusTerminal(page) {
  const box = await page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll("canvas"));
    const visible = canvases.find(
      (c) => c.offsetParent !== null && c.clientWidth > 0 && c.clientHeight > 0,
    );
    if (!visible) return null;
    const r = visible.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!box) throw new Error("no visible terminal canvas to focus");
  await page.mouse.click(box.x, box.y);
  await sleep(200);
}

async function waitForLiveCanvas(page, timeoutMs = 20000) {
  await page.waitForFunction(
    () => {
      const c = Array.from(document.querySelectorAll("canvas")).find(
        (el) => el.offsetParent !== null,
      );
      return c && c.clientWidth > 0 && c.clientHeight > 0;
    },
    { timeout: timeoutMs },
  );
  await sleep(2200); // let restty boot the shell and paint
}

// ---- main --------------------------------------------------------------------

async function main() {
  const wsDir = await fs.realpath(await fs.mkdtemp(join(SCRATCH, "ws-park-")));
  const projects = [
    {
      id: "ws-park",
      name: "Park Probe",
      path: wsDir,
      ticketPrefix: "PRK",
      colorIndex: 0,
      createdAt: Date.now(),
    },
  ];

  const dbDir = await fs.mkdtemp(join(os.tmpdir(), "volli-park-smoke-db-"));
  const env = {
    ...process.env,
    VOLLI_DB_PATH: join(dbDir, "volli.db"),
    VOLLI_PARK_IDLE_MS: String(PARK_IDLE_MS),
    VOLLI_PARK_SWEEP_MS: String(PARK_SWEEP_MS),
    VOLLI_PARK_BREATHE_MS: String(PARK_BREATHE_MS),
    // The nc/timer sessions run foreground work; without this, teardown's
    // app.close() would hang forever on the busy-session quit confirm.
    VOLLI_SKIP_CLOSE_CONFIRM: "1",
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDECODE") || key.startsWith("CLAUDE_CODE")) delete env[key];
  }

  const app = await _electron.launch({ executablePath: ELECTRON, args: [APP_DIR], env });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // Seed the workspace, reload so bootstrap imports it (firstRun path).
    await page.evaluate((projs) => {
      localStorage.setItem(
        "volli:projects",
        JSON.stringify({ state: { projects: projs, selectedProjectId: projs[0].id }, version: 1 }),
      );
    }, projects);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await sleep(1500);

    // === Setup: two scratch tabs, each writing its shell pid to a marker ======
    await page.getByText("Terminals", { exact: true }).click();
    await waitForLiveCanvas(page); // first visit auto-creates tab 1

    const marker1 = join(SCRATCH, "tab-1.pid");
    await focusTerminal(page);
    await page.keyboard.type(`echo $$ > ${marker1}`);
    await page.keyboard.press("Enter");
    const pid1 = await shellPidFromMarker(marker1);

    await page.getByLabel("New session").click();
    await page.waitForFunction(
      () => document.querySelectorAll('[aria-label^="Close Terminal"]').length === 2,
      undefined,
      { timeout: 10000 },
    );
    await waitForLiveCanvas(page);
    const marker2 = join(SCRATCH, "tab-2.pid");
    await focusTerminal(page);
    await page.keyboard.type(`echo $$ > ${marker2}`);
    await page.keyboard.press("Enter");
    const pid2 = await shellPidFromMarker(marker2);
    console.log(`tab 1 shell pid=${pid1}, tab 2 shell pid=${pid2} (tab 2 active/visible)\n`);

    // === 1+2: hidden idle tab parks; visible idle tab never does ==============
    console.log(`waiting ${PARK_SETTLE_MS}ms for the sweep…`);
    await sleep(PARK_SETTLE_MS);
    const state1 = await waitForState(pid1, "stopped", 5000);
    check("hidden idle session is parked (state T)", state1 === "T", `state=${state1}`);
    check(
      "visible session is NOT parked",
      processState(pid2) !== "T",
      `state=${processState(pid2)}`,
    );

    // === 5: parked badge in the tab strip =====================================
    const badges = await page.locator('[title^="Parked"]').count();
    check("tab strip shows the parked badge", badges >= 1, `count=${badges}`);
    await page.screenshot({ path: join(SCRATCH, "parked.png") });

    // === 3: selecting the parked tab wakes it =================================
    await page.getByText("Terminal 1", { exact: true }).click();
    const woken = await waitForState(pid1, "running", 3000);
    check("selecting the parked tab wakes it within ~2s", woken !== "T", `state=${woken}`);

    // The woken shell must still be functional: run a command end-to-end.
    const marker3 = join(SCRATCH, "after-wake.txt");
    await focusTerminal(page);
    await page.keyboard.type(`echo awake > ${marker3}`);
    await page.keyboard.press("Enter");
    let awake = false;
    for (let i = 0; i < 25 && !awake; i++) {
      awake = await fs
        .readFile(marker3, "utf8")
        .then((t) => t.includes("awake"))
        .catch(() => false);
      await sleep(200);
    }
    check("woken shell still executes commands", awake);

    // === 4: a hidden LISTEN-holding session is never parked ===================
    // Tab 1 (now visible) stays foreground; tab 2 goes hidden holding a
    // listener — the dev-server stand-in that must never be frozen.
    const shell2Was = processState(pid2);
    check("tab 2 alive before listener phase", shell2Was !== null && shell2Was !== "T");
    await page.getByText("Terminal 2", { exact: true }).click();
    await focusTerminal(page);
    await page.keyboard.type("nc -l 39217");
    await page.keyboard.press("Enter");
    await sleep(500);
    await page.getByText("Terminal 1", { exact: true }).click(); // hide tab 2
    console.log(`waiting ${PARK_SETTLE_MS}ms with a LISTEN socket in the hidden tree…`);
    await sleep(PARK_SETTLE_MS);
    check(
      "hidden session with a LISTEN socket is NOT parked",
      processState(pid2) !== "T",
      `state=${processState(pid2)}`,
    );

    // …and tab 1, visible the whole time, is still running.
    check(
      "visible session remained unparked throughout",
      processState(pid1) !== "T",
      `state=${processState(pid1)}`,
    );

    // === 6: breathe — a background timer fires while parked ===================
    // Tab 1 (visible) starts a 12s background timer, then goes hidden: it
    // parks with the timer pending, the timer expires inside the frozen tree,
    // and the next breathe window lets it run — the no-silent-failure
    // guarantee for watchers/timers/pollers that hold no listener.
    const marker4 = join(SCRATCH, "breathe.txt");
    await focusTerminal(page);
    await page.keyboard.type(`(sleep 12 && echo done > ${marker4}) &`);
    await page.keyboard.press("Enter");
    await page.getByText("Terminal 2", { exact: true }).click(); // hide tab 1
    const parkedAgain = await waitForState(pid1, "stopped", PARK_SETTLE_MS + 5000);
    check(
      "hidden session with a pending background timer parks (state T)",
      parkedAgain === "T",
      `state=${parkedAgain}`,
    );
    let breatheDone = false;
    const breatheStart = Date.now();
    while (Date.now() - breatheStart < 25000 && !breatheDone) {
      breatheDone = await fs
        .readFile(marker4, "utf8")
        .then((t) => t.includes("done"))
        .catch(() => false);
      await sleep(300);
    }
    check("background timer fired while parked (breathe duty cycle)", breatheDone);
    // Its output woke the session; once quiet again the sweep re-freezes it.
    const refrozen = await waitForState(pid1, "stopped", PARK_SETTLE_MS + 5000);
    check(
      "session re-parks after the breathed work completes",
      refrozen === "T",
      `state=${refrozen}`,
    );
  } finally {
    await app.close();
  }
}

try {
  await main();
  if (failures > 0) {
    console.error(`\nPARK SMOKE: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nPARK SMOKE COMPLETE — all checks passed");
} catch (error) {
  console.error("\nPARK SMOKE ABORTED:", error?.stack ?? error);
  process.exit(1);
}
