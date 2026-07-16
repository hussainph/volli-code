/**
 * Memory-load smoke for parallel terminal sessions (NOT wired into `vp test`).
 *
 * Question under test: what does each additional live (model-resident) restty
 * session cost in RAM, and what does a full default scrollback cost — i.e. how
 * much would ghostty's scrollback compression (upstream PR #13264) actually
 * buy us, and where should a `scrollback-limit` cap sit?
 *
 * Phases:
 *   1. Boot the built app (isolated VOLLI_DB_PATH, one seeded workspace).
 *   2. Create N session tabs; type `claude` into each and let it idle.
 *      Snapshot Electron process metrics + host RSS of spawned claudes after
 *      each tab.
 *   3. One extra plain-shell tab: dump ~16MB of text into scrollback, twice,
 *      snapshotting between — the second dump shows whether the engine's
 *      scrollback limit caps residency (delta2 ≈ 0) or keeps growing.
 *
 *   Run:
 *     pnpm -C apps/desktop run build
 *     node apps/desktop/e2e/memory-smoke.mjs [N_SESSIONS]
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

const N_SESSIONS = Number(process.argv[2] ?? 8);
const SCRATCH =
  process.env.VOLLI_SMOKE_DIR ?? (await fs.mkdtemp(join(os.tmpdir(), "volli-memory-smoke-")));
await fs.mkdir(SCRATCH, { recursive: true });
console.log("scratch:", SCRATCH);
console.log("sessions:", N_SESSIONS, "\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- measurement helpers ----------------------------------------------------

/** Electron-side per-process metrics, MB. */
async function appMetrics(app) {
  const raw = await app.evaluate(async ({ app: a }) =>
    a.getAppMetrics().map((m) => ({
      type: m.type,
      pid: m.pid,
      wssMB: m.memory.workingSetSize / 1024,
    })),
  );
  const byType = {};
  for (const m of raw) byType[m.type] = (byType[m.type] ?? 0) + m.wssMB;
  const totalMB = raw.reduce((s, m) => s + m.wssMB, 0);
  return { raw, byType, totalMB };
}

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

/** Host-side RSS (MB) of the app's non-Electron descendants, bucketed. */
function hostProcessSnapshot(rootPid) {
  const pids = descendantPids(rootPid);
  const buckets = { claude: { count: 0, rssMB: 0 }, shellsAndOther: { count: 0, rssMB: 0 } };
  const claudePids = [];
  for (const pid of pids) {
    let line = "";
    try {
      line = execFileSync("/bin/ps", ["-o", "rss=,command=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim();
    } catch {
      continue; // process exited between pgrep and ps
    }
    if (!line) continue;
    const rssKB = Number(line.slice(0, line.indexOf(" ")));
    const command = line.slice(line.indexOf(" ") + 1);
    if (command.includes("Electron.app")) continue; // counted by getAppMetrics
    const isClaude = /(^|\/)claude( |$)/.test(command) || command.includes("claude ");
    const bucket = isClaude ? buckets.claude : buckets.shellsAndOther;
    bucket.count += 1;
    bucket.rssMB += rssKB / 1024;
    if (isClaude) claudePids.push(pid);
  }
  return { ...buckets, claudePids };
}

/** Renderer JS heap via CDP (bytes → MB); wasm memories live outside this. */
async function rendererHeapMB(cdp) {
  try {
    const { metrics } = await cdp.send("Performance.getMetrics");
    const heap = metrics.find((m) => m.name === "JSHeapUsedSize");
    return heap ? heap.value / (1024 * 1024) : null;
  } catch {
    return null;
  }
}

// ---- terminal interaction (from terminal-smoke.mjs) --------------------------

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

async function waitForFileContains(path, needle, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const text = await fs.readFile(path, "utf8");
      if (text.includes(needle)) return text;
    } catch {
      // not written yet
    }
    await sleep(200);
  }
  return null;
}

// ---- main --------------------------------------------------------------------

async function main() {
  const wsDir = await fs.realpath(await fs.mkdtemp(join(SCRATCH, "ws-mem-")));
  const projects = [
    {
      id: "ws-mem",
      name: "Mem Probe",
      path: wsDir,
      ticketPrefix: "MEM",
      colorIndex: 0,
      createdAt: Date.now(),
    },
  ];

  const dbDir = await fs.mkdtemp(join(os.tmpdir(), "volli-memory-smoke-db-"));
  // Strip Claude Code session vars so the nested `claude` instances boot clean.
  // Skip the busy-session quit confirm: the idle claudes count as foreground
  // work, and teardown's app.close() can't answer a native modal.
  const env = {
    ...process.env,
    VOLLI_DB_PATH: join(dbDir, "volli.db"),
    VOLLI_SKIP_CLOSE_CONFIRM: "1",
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDECODE") || key.startsWith("CLAUDE_CODE")) delete env[key];
  }

  const app = await _electron.launch({ executablePath: ELECTRON, args: [APP_DIR], env });
  const snapshots = [];

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const rootPid = app.process().pid;
    const cdp = await page
      .context()
      .newCDPSession(page)
      .catch(() => null);
    if (cdp) await cdp.send("Performance.enable").catch(() => {});

    const snap = async (label) => {
      const s = {
        label,
        app: await appMetrics(app),
        host: hostProcessSnapshot(rootPid),
        rendererHeapMB: cdp ? await rendererHeapMB(cdp) : null,
      };
      snapshots.push(s);
      console.log(
        `[snap] ${label.padEnd(24)} appTotal=${s.app.totalMB.toFixed(0)}MB ` +
          `renderer=${(s.app.byType.Tab ?? 0).toFixed(0)}MB gpu=${(s.app.byType.GPU ?? 0).toFixed(0)}MB ` +
          `jsHeap=${s.rendererHeapMB?.toFixed(0) ?? "?"}MB ` +
          `claude=${s.host.claude.count}×(Σ${s.host.claude.rssMB.toFixed(0)}MB) ` +
          `shells=${s.host.shellsAndOther.count}×(Σ${s.host.shellsAndOther.rssMB.toFixed(0)}MB)`,
      );
      return s;
    };

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

    await snap("baseline (Board, 0 tabs)");

    // === Phase 2: N idle claude sessions =====================================
    await page.getByText("Sessions", { exact: true }).click();
    await waitForLiveCanvas(page); // first visit auto-creates session 1

    for (let i = 1; i <= N_SESSIONS; i++) {
      if (i > 1) {
        await page.getByLabel("New session").click();
        await page.waitForFunction(
          (n) => document.querySelectorAll('[aria-label^="Close Terminal"]').length === n,
          i,
          { timeout: 10000 },
        );
        await waitForLiveCanvas(page);
      }
      await focusTerminal(page);
      await page.keyboard.type("claude");
      await page.keyboard.press("Enter");
      await sleep(6000); // let the TUI boot
      await page.keyboard.press("Enter"); // accept trust dialog if shown
      await sleep(1500);
      await snap(`${i} idle claude tab(s)`);
      if (i === 1 || i === Math.ceil(N_SESSIONS / 2) || i === N_SESSIONS) {
        await page.screenshot({ path: join(SCRATCH, `claude-tab-${i}.png`) });
      }
    }

    await sleep(15000);
    await snap(`${N_SESSIONS} tabs after 15s idle`);

    // === Phase 3: scrollback fill in a plain shell tab ========================
    await page.getByLabel("New session").click();
    await page.waitForFunction(
      (n) => document.querySelectorAll('[aria-label^="Close Terminal"]').length === n,
      N_SESSIONS + 1,
      { timeout: 10000 },
    );
    await waitForLiveCanvas(page);
    await snap("plain tab, empty");

    const line80 = "0123456789".repeat(8);
    for (let round = 1; round <= 2; round++) {
      const marker = join(SCRATCH, `fill-${round}-done.txt`);
      await focusTerminal(page);
      await page.keyboard.type(`yes "${line80}" | head -n 200000; echo done > ${marker}`);
      await page.keyboard.press("Enter");
      const done = await waitForFileContains(marker, "done", 60000);
      if (!done) throw new Error(`scrollback fill round ${round} never finished`);
      await sleep(5000); // let the renderer settle
      await snap(`plain tab +${16 * round}MB output`);
    }
    await page.screenshot({ path: join(SCRATCH, "scrollback-filled.png") });

    await fs.writeFile(join(SCRATCH, "snapshots.json"), JSON.stringify(snapshots, null, 2));
    console.log("\nsnapshots.json:", join(SCRATCH, "snapshots.json"));
  } finally {
    await app.close();
  }
}

try {
  await main();
  console.log("\nMEMORY SMOKE COMPLETE");
} catch (error) {
  console.error("\nMEMORY SMOKE ABORTED:", error?.stack ?? error);
  process.exit(1);
}
